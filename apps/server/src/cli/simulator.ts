import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { extname, isAbsolute, join, resolve } from "node:path";
import { createCheckinEngine } from "../checkin/engine.ts";
import type { CheckinEngine, Clock, EngineDeps } from "../checkin/engine-types.ts";
import { SHARING_BUTTONS, SHARING_MENU_BUTTON } from "../checkin/copy.ts";
import { loadConfig, normalizeHandle, resolveCheckinDate, type Config } from "../config.ts";
import { familyChats, linkFamilyMember, syncFamilyMembers, type FamilyChat } from "../db/family.ts";
import { nextFollowUp } from "../db/follow-ups.ts";
import { nextNudge } from "../db/meds.ts";
import { getSharing, openDatabase, upsertPatient, type Db, type SharingLevel } from "../db/index.ts";
import { latestPaperScan, type PaperScanRow } from "../db/paper-scans.ts";
import { ConsentInactiveError, FinchNodeClient } from "../finchnode/client.ts";
import { FIXTURES_DIR, REPO_ROOT, hasRecordedSnapshot, loadRecorded, loadRxNavCache, replayFetch } from "../finchnode/fixtures.ts";
import { normalizeHealthRecord, type PatientRecord } from "../finchnode/normalize.ts";
import type { HealthRecord } from "../finchnode/types.ts";
import {
  LlmUnavailableError,
  MESSAGE_KINDS,
  type Amount,
  type Change,
  type CheckinExtraction,
  type ImageReading,
  type LlmClient,
  type MessageClassification,
  type MessageKind,
  type SymptomMention,
} from "../llm/types.ts";
import { BUTTON_LEVELS, TYPED_LEVELS } from "../checkin/severity.ts";
import { patientIdFor } from "../patient-id.ts";
import { FakeMessenger } from "../relay/fake-messenger.ts";
import type { InboundMessage, SentMessage } from "../relay/messenger.ts";
import type { ExtractedPaper } from "../rules/paper-diff.ts";
import { EXAMPLE_CONTACTS_PATH, parseCareContacts } from "../care/contacts.ts";
import { startCareRuntime } from "../care/runtime.ts";
import { GeminiCareWriter } from "../care/writer.ts";
import { FakeCareMessenger, type FakeCareText } from "../photon/fake-care-messenger.ts";
import { CARE_HELP_LINES, HELP_LINES, clockTime, painter, renderMessage, renderTable, type Painter, type Style } from "./sim-render.ts";

// Terminal simulator of the daily check-in (npm run simulate). Drives the real
// check-in engine with a FakeMessenger, a simulated clock and recorded FinchNode
// fixtures, so the team can run a whole morning without phones. The core here is
// process-free so tests can drive it; src/cli/simulate.ts adds argv and stdin.
//
// Like Relay, there is no family group: each family member (--family, default
// "sarah") has their own family chat with the agent, printed as its own pane
// ("Sarah's phone (family)"). In Relay they link it by messaging the agent first;
// here they start pre-linked.
//
// Free text: with `llm` (npm run simulate -- --llm, real Gemini from .env) what she
// types is read as in the agent; without it, buttons only and fixed replies (the safety
// screen and an explicit yes on a red-flag question still work, as they need no LLM).
// `/as <kind> [answer] [| topic, amount, change]...` stands in for the LLM on the next typed
// message, so demo scripts show each kind of reaction (and each severity level) offline and the
// same way every run. `/as extract [questionId=answer; ...] [| topic, amount, change]...` does the
// same for the understanding pass on her next typed message in the check-in (her open reply to the
// greeting, or what she types while a question waits).
//
// Follow-ups: after a red flag or a safety hit the engine schedules a follow-up check-in
// some hours later; /later jumps the clock to it (or to a medicines re-reminder) and runs the job.
//
// Medication helper: /meds sends the morning medicines reminder now, /evening the evening one (the
// clock moves to 20:00), /refills runs the refill check, /photo <file> sends a photo as hers. Offline,
// `/photo <file> --as label:<name>,<strength>,<instructions>` (or `--as papers`, `--as unreadable`,
// `--as other`) stands in for the LLM's reading of it, so the demo runs the same way every time.

export const DEFAULT_SUBJECT = "patient-demo-polypharmacy";
export const DEFAULT_DB_PATH = join(REPO_ROOT, "data", "simulator.db");
export const PAPER_FIXTURE = join(FIXTURES_DIR, "papers", "harriet-discharge.extracted.json");
export const SHARING_LEVELS: readonly SharingLevel[] = ["status", "status_vitals", "all"];
/** Family members when --family isn't given. */
export const DEFAULT_FAMILY: readonly string[] = ["sarah"];

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export class SimUsageError extends Error {}

export function isDay(value: string): boolean {
  return DAY.test(value) && !Number.isNaN(Date.parse(value));
}

export function isSharingLevel(value: string): value is SharingLevel {
  return (SHARING_LEVELS as readonly string[]).includes(value);
}

/** The day after a YYYY-MM-DD date. */
export function nextDay(day: string): string {
  return new Date(Date.parse(day) + 86_400_000).toISOString().slice(0, 10);
}

/** Pinned to a check-in date at 09:00 local time; moves a minute per input. */
export class SimClock implements Clock {
  private day: string;
  private minutes = 9 * 60;

  constructor(day: string) {
    this.day = day;
  }

  now(): string {
    const [y, m, d] = this.day.split("-").map(Number) as [number, number, number];
    return new Date(y, m - 1, d, 0, this.minutes).toISOString();
  }

  setDay(day: string): void {
    this.day = day;
    this.minutes = 9 * 60;
  }

  /** Jump forward to a time of day (never backwards). */
  setTime(hour: number, minute = 0): void {
    this.minutes = Math.max(this.minutes, hour * 60 + minute);
  }

  /** Jump forward to an instant (ISO), at least; never backwards. */
  jumpTo(iso: string): void {
    const [y, m, d] = this.day.split("-").map(Number) as [number, number, number];
    const minutes = Math.ceil((Date.parse(iso) - new Date(y, m - 1, d).getTime()) / 60_000);
    if (Number.isFinite(minutes)) this.minutes = Math.max(this.minutes, minutes);
  }

  tick(): void {
    this.minutes += 1;
  }
}

/** Reads one snapshot: recorded fixture replayed through the real client, or the live demo API. */
export function snapshotLoader(config: Config, live: boolean): (subject: string) => Promise<HealthRecord> {
  return async (subject) => {
    const { baseUrl, apiKey } = config.finchnode;
    if (live) return new FinchNodeClient({ baseUrl, apiKey }).getHealthRecord(subject);
    if (!hasRecordedSnapshot(subject)) throw new SimUsageError(`no recorded fixture for "${subject}". Use --live to ask FinchNode.`);
    const client = new FinchNodeClient({ baseUrl, fetch: replayFetch(loadRecorded(`records/${subject}`)), maxRetries: 0 });
    return client.getHealthRecord(subject);
  };
}

export type SimulatorOptions = {
  subject?: string;
  /** Check-in date; defaults to resolveCheckinDate(CLOCK_DATE, data as-of). */
  day?: string;
  dbPath: string;
  live?: boolean;
  sharing?: SharingLevel;
  /** Family members' handles, each with their own pre-linked family chat. Defaults to DEFAULT_FAMILY; [] for none. */
  family?: readonly string[];
  output: (line: string) => void;
  /** Text the care summaries over (fake) Photon on their own when a day ends, as the agent does. /summary works either way. */
  photon?: boolean;
  color?: boolean;
  config?: Config;
  /** Injected snapshot reader (tests); defaults to fixtures or the live API. */
  loadSnapshot?: (subject: string) => Promise<HealthRecord>;
  /** Reads what she types (--llm: createLlmClient(config); tests: FakeLlmClient). Without it: buttons only. */
  llm?: LlmClient | undefined;
};

export type InputResult = "ok" | "error" | "quit";

export type Simulator = {
  readonly patientId: string;
  readonly seniorName: string;
  readonly day: string;
  readonly messenger: FakeMessenger;
  readonly db: Db;
  /** Each linked family member's chat, in --family order. */
  readonly family: readonly FamilyChat[];
  /** Care summaries and replies texted over (fake) Photon to the example doctor and emergency contact. */
  readonly photon: FakeCareMessenger;
  /** Banner and the day's startDay. */
  start(): Promise<void>;
  /** One line typed as Harriet: a button number, free text or a /command. */
  handle(input: string): Promise<InputResult>;
  close(): void;
};

export async function createSimulator(options: SimulatorOptions): Promise<Simulator> {
  const config = options.config ?? loadConfig();
  const subject = options.subject ?? DEFAULT_SUBJECT;
  const live = options.live ?? false;
  const paint: Painter = painter(options.color ?? false);
  const out = options.output;
  const note = (text: string, style: Style = "dim") => out(paint(`[sim] ${text}`, style));
  const loadSnapshot = options.loadSnapshot ?? snapshotLoader(config, live);
  const rxnav = loadRxNavCache();

  // Who she is, from her record (given name, data as-of). A record whose consent
  // already ended still gets a patient row, so the engine's consent-ended path runs.
  let record: PatientRecord | undefined;
  let consentEnded = false;
  try {
    record = normalizeHealthRecord(await loadSnapshot(subject), { rxnav });
  } catch (error) {
    if (!(error instanceof ConsentInactiveError)) throw error;
    consentEnded = true;
  }
  const givenName = record?.demographics?.givenName ?? record?.demographics?.name?.split(" ")[0];
  const seniorName = givenName ?? subject;
  const patientId = patientIdFor(givenName, subject);
  const seniorChat = `chat:${patientId}`;
  const dataAsOf = record?.dataAsOf ?? undefined;

  let day = options.day ?? resolveCheckinDate(config.clockDate, dataAsOf);
  if (!isDay(day)) throw new SimUsageError(`--day must be YYYY-MM-DD, got "${day}"`);

  const clock = new SimClock(day);
  const db = openDatabase(options.dbPath);
  upsertPatient(db, {
    id: patientId,
    finchnodePatientId: subject,
    preferredName: seniorName,
    relayChatId: seniorChat,
    checkinTime: config.checkinTime,
    ...(options.sharing ? { sharing: options.sharing } : {}),
  });

  // Family members, each in their own chat, linked as if they had already messaged the agent.
  const familyHandles = [...new Set((options.family ?? DEFAULT_FAMILY).map(normalizeHandle).filter(Boolean))];
  const synced = syncFamilyMembers(db, patientId, familyHandles);
  for (const handle of familyHandles) linkFamilyMember(db, handle, `chat:${patientId}:family:${handle}`, displayName(handle), clock.now());
  // Rows from an earlier run's --family stay linked, as in the agent (syncFamilyMembers never deletes).
  const family = familyChats(db, patientId);
  const familyLabels = new Map(family.map((f) => [f.chatId, `${f.displayName ?? f.handle}'s phone (family)`]));

  const chatLabel = (chatId: string) => (chatId === seniorChat ? `${seniorName}'s phone` : (familyLabels.get(chatId) ?? chatId));
  const messenger = new FakeMessenger({
    now: () => clock.now(),
    onSend: (m: SentMessage) => {
      out("");
      for (const line of renderMessage(m, chatLabel(m.chatId), paint, familyLabels.has(m.chatId))) out(line);
    },
    onActivity: (event) => {
      if (event.kind === "set") note(`${chatLabel(event.chatId)} shows "${event.label}".`);
    },
  });
  // Care summaries over Photon, faked: the example contacts. With --llm the texts are worded by the
  // LLM (src/care/writer.ts) inside their fixed parts; without it, the fixed templates.
  const careContacts = parseCareContacts(readFileSync(EXAMPLE_CONTACTS_PATH, "utf8"), EXAMPLE_CONTACTS_PATH);
  const photonLabel = (phone: string) =>
    phone === careContacts.doctor.phone
      ? `${careContacts.doctor.name}'s phone (Photon, doctor)`
      : `${careContacts.emergencyContact.name}'s phone (Photon, emergency contact)`;
  const photon = new FakeCareMessenger({
    onSend: (t: FakeCareText) => {
      out("");
      out(paint(`--- ${photonLabel(t.phone)}, ${clockTime(clock.now())} ---`, "bold", "yellow"));
      for (const line of t.text.split("\n")) out(line);
    },
  });
  const care = startCareRuntime({
    db,
    patientId,
    contacts: careContacts,
    clock,
    messenger: photon,
    ...(options.llm ? { writer: new GeminiCareWriter(options.llm) } : {}),
    log: (line) => note(line.replace(/^\[care\] /, "Photon: ")),
  });
  let photonCount = 0;
  const autoPhoton = options.photon ?? false;
  // `/as <kind>` readings wait here; while one does, it stands in for the LLM (small talk still
  // goes to the real LLM if there is one).
  // `/as extract` readings for the understanding pass wait in `extractions` the same way. While only an
  // extraction waits, the model's kind (read alongside it) has no stand-in and counts as unavailable,
  // which changes nothing; while only an `/as <kind>` waits, the extraction counts as unavailable and
  // the kind alone is used, as before.
  const scripted: MessageClassification[] = [];
  const extractions: CheckinExtraction[] = [];
  const images: ImageReading[] = [];
  const scriptLlm: LlmClient = {
    provider: "script",
    classifyMessage: async () => {
      const next = scripted.shift();
      if (!next) throw new LlmUnavailableError("sim: no /as reading left");
      return next;
    },
    extractCheckin: async () => {
      const next = extractions.shift();
      if (!next) throw new LlmUnavailableError("sim: no /as extract reading left");
      return next;
    },
    smallTalk: (input, o) => (options.llm ? options.llm.smallTalk(input, o) : Promise.reject(new LlmUnavailableError("sim: no LLM"))),
    mapAnswer: (input, o) => (options.llm ? options.llm.mapAnswer(input, o) : Promise.reject(new LlmUnavailableError("sim: no LLM"))),
    readImage: async (input, o) => {
      const next = images.shift();
      if (next) return next;
      return options.llm ? options.llm.readImage(input, o) : Promise.reject(new LlmUnavailableError("sim: no /photo --as reading left"));
    },
    writeCareMessage: (input, o) => (options.llm ? options.llm.writeCareMessage(input, o) : Promise.reject(new LlmUnavailableError("sim: no LLM"))),
  };
  const deps: EngineDeps = {
    db,
    messenger,
    clock,
    loadSnapshot,
    // Read by the engine on each message.
    get llm() {
      return scripted.length > 0 || extractions.length > 0 || images.length > 0 ? scriptLlm : options.llm;
    },
  };
  const engine: CheckinEngine = createCheckinEngine(deps, {
    missedCheckinTime: config.missedCheckinTime,
    rxnav,
    medsNudgeMinutes: config.meds.nudgeMinutes,
    refillRemindDays: config.meds.refillRemindDays,
    ...(autoPhoton ? { onDayFinished: care.onDayFinished } : {}),
  });

  // The engine dedupes inbound messages by id across the DB, so ids must be unique per run.
  const runId = randomUUID().slice(0, 8);
  let inboundCount = 0;
  let paperCount = 0;
  let photoCount = 0;

  const latestInSeniorChat = (): SentMessage | undefined => messenger.lastIn(seniorChat);
  const latestWithButtons = (): SentMessage | undefined => {
    const inChat = messenger.inChat(seniorChat);
    for (let i = inChat.length - 1; i >= 0; i--) if (inChat[i]?.buttons?.length) return inChat[i];
    return undefined;
  };

  async function startDay(): Promise<void> {
    const result = await engine.startDay(patientId, day);
    if (result.kind === "sent") note(`Check-in for ${day} sent with ${result.questionIds.length} questions: ${result.questionIds.join(", ")}.`);
    else if (result.kind === "already_started")
      note(`The check-in for ${day} already started in this database. Try /next, another --day, or --reset.`, "yellow");
    else note(`Record consent for ${subject} has ended; the engine stopped reading her record.`, "yellow");
  }

  async function sendAsSenior(text: string, replyTo: string | undefined): Promise<void> {
    inboundCount += 1;
    const message: InboundMessage = {
      chatId: seniorChat,
      messageId: `sim-${runId}-${inboundCount}`,
      text,
      ...(replyTo ? { replyTo } : {}),
      at: clock.now(),
    };
    const sharingBefore = getSharing(db, patientId);
    const paperBefore = latestPaperScan(db, patientId);
    const followUpBefore = nextFollowUp(db, patientId);
    await engine.handleInbound(message);
    const sharingAfter = getSharing(db, patientId);
    if (sharingAfter !== sharingBefore) note(`Sharing level set to ${sharingAfter}.`);
    notePaperChange(paperBefore, latestPaperScan(db, patientId));
    const followUp = nextFollowUp(db, patientId);
    if (followUp && followUp.id !== followUpBefore?.id)
      note(`Follow-up check-in scheduled for ${clockTime(followUp.dueAt)} (${followUp.reason}). Type /later to jump there.`);
  }

  /**
   * /as <kind> [answer] [| topic, amount, change]...: the next typed message is read as `kind` (and, for
   * "answer", that button), with the symptoms after each "|" (amount none, a_little, a_lot or unknown;
   * change new, worse, same, better or unknown; both default to unknown). A question id as the topic
   * ties the symptom to that question.
   */
  function asCommand(args: string[]): InputResult {
    const [head = "", ...parts] = args.join(" ").split("|").map((p) => p.trim());
    const [kind, ...rest] = head.split(/\s+/).filter(Boolean);
    const usage = () => {
      note(`usage: /as <${MESSAGE_KINDS.join("|")}> [answer] [| topic, ${Object.keys(TYPED_LEVELS).join("|")}, new|worse|same|better|unknown]`, "red");
      note("   or: /as extract [questionId=answer; ...] [| topic, amount, change]... (her next typed message in the check-in)", "red");
      return "error" as const;
    };
    if (!kind || !(kind === "extract" || (MESSAGE_KINDS as readonly string[]).includes(kind))) return usage();
    const symptoms: SymptomMention[] = [];
    for (const part of parts) {
      const [topic = "", amount = "unknown", change = "unknown"] = part.split(",").map((x) => x.trim());
      if (!topic || !(amount in TYPED_LEVELS) || !["new", "worse", "same", "better", "unknown"].includes(change)) return usage();
      symptoms.push({ topic, ...(topic in BUTTON_LEVELS ? { questionId: topic } : {}), amount: amount as Amount, change: change as Change, words: topic });
    }
    const said = symptoms.map((m) => `${m.topic} (${m.amount.replace("_", " ")}, ${m.change})`).join(", ");
    if (kind === "extract") {
      // questionId=answer pairs, split on ";" since some answers have commas ("Yes, it was hard").
      const answers: CheckinExtraction["answers"] = [];
      for (const pair of rest.join(" ").split(";").map((p) => p.trim()).filter(Boolean)) {
        const [questionId = "", ...label] = pair.split("=").map((x) => x.trim());
        const answer = Object.keys(BUTTON_LEVELS[questionId] ?? {}).find((b) => b.toLowerCase() === label.join("=").toLowerCase());
        if (!answer) return usage();
        answers.push({ questionId, answer, confidence: "high" });
      }
      extractions.push({ answers, symptoms, memories: [] });
      const read = answers.map((a) => `${a.questionId} "${a.answer}"`).join(", ");
      note(`Her next open reply is read as ${read ? `answering ${read}` : "answering nothing"}${said ? `, mentioning ${said}` : ""} (a stand-in for the LLM).`);
      return "ok";
    }
    const answer = rest.join(" ");
    scripted.push({ kind: kind as MessageKind, confidence: "high", complaints: [], memories: [], ...(answer ? { answer } : {}), symptoms });
    note(`Her next typed message is read as ${kind}${answer ? ` "${answer}"` : ""}${said ? `, mentioning ${said}` : ""} (a stand-in for the LLM).`);
    return "ok";
  }

  /** /later: jump the clock to the next follow-up check-in or medicines re-reminder and run their jobs. */
  async function laterCommand(): Promise<InputResult> {
    const due = [nextFollowUp(db, patientId)?.dueAt, nextNudge(db, patientId)?.nudgeDueAt].filter((d): d is string => typeof d === "string").sort();
    if (due.length === 0) {
      note("No follow-up check-in or medicines re-reminder is waiting.");
      return "ok";
    }
    clock.jumpTo(due[0]!);
    const sent = await engine.runDueFollowUps(clock.now());
    const nudged = await engine.runMedsNudges(clock.now());
    const parts = [`${sent} follow-up check-in${sent === 1 ? "" : "s"}`, ...(nudged > 0 ? [`${nudged} medicines re-reminder${nudged === 1 ? "" : "s"}`] : [])];
    note(`Later, ${clockTime(clock.now())}: ${parts.join(" and ")} sent.`);
    return "ok";
  }

  /** /meds and /evening: the medicines reminder now (the evening one moves the clock to MEDS_EVENING_TIME). */
  async function medsCommand(slot: "morning" | "evening"): Promise<InputResult> {
    if (slot === "evening") {
      const [hour, minute] = config.meds.eveningTime.split(":").map(Number);
      clock.setTime(hour ?? 20, minute ?? 0);
    }
    const result = await engine.sendMedsReminder(patientId, day, slot);
    const said: Record<typeof result, string> = {
      sent: `${slot} medicines reminder sent.`,
      already_sent: `the ${slot} medicines reminder for ${day} already went out in this database.`,
      nothing_to_send: `no medicines are scheduled for the ${slot}, so no reminder.`,
      no_record: "record consent has ended, so there is no medication list to remind from.",
    };
    note(`Medicines, ${clockTime(clock.now())}: ${said[result]}`, result === "sent" ? "dim" : "yellow");
    return "ok";
  }

  /** /refills: the morning refill check now. */
  async function refillsCommand(): Promise<InputResult> {
    const sent = await engine.runRefillCheck(patientId, day);
    note(sent > 0 ? `Refill check for ${day}: ${sent} reminder${sent === 1 ? "" : "s"} sent.` : `Refill check for ${day}: no fill runs out within ${config.meds.refillRemindDays} days.`);
    return "ok";
  }

  /**
   * /photo <file> [--as label:<name>,<strength>,<instructions> | papers | unreadable | other]: a photo sent
   * as hers. With --as the reading is a stand-in for the LLM (the file may then be missing); without it
   * the real LLM reads it (--llm), else she gets the "can't read photos yet" reply.
   */
  async function photoCommand(args: string[]): Promise<InputResult> {
    const usage = () => {
      note("usage: /photo <file.png> [--as label:<name>,<strength>,<instructions> | papers | unreadable | other]", "red");
      return "error" as const;
    };
    const asAt = args.indexOf("--as");
    const fileArg = (asAt < 0 ? args : args.slice(0, asAt)).join(" ").trim();
    const spec = asAt < 0 ? undefined : args.slice(asAt + 1).join(" ").trim();
    if (!fileArg) return usage();
    let reading: ImageReading | undefined;
    if (spec !== undefined) {
      if (spec === "papers") {
        const paper = JSON.parse(readFileSync(PAPER_FIXTURE, "utf8")) as ExtractedPaper;
        reading = { kind: "discharge_papers", paper: { organization: paper.organization, date: paper.date, medications: paper.medications } };
      } else if (spec === "unreadable") reading = { kind: "unreadable", reason: "sim stand-in" };
      else if (spec === "other") reading = { kind: "other", description: "sim stand-in" };
      else if (spec.startsWith("label:")) {
        const [medicineName = "", strength = "", ...rest] = spec.slice("label:".length).split(",").map((x) => x.trim());
        if (!medicineName) return usage();
        const instructions = rest.join(", ").trim();
        reading = {
          kind: "medicine_label",
          label: { medicineName, ...(strength ? { strength } : {}), ...(instructions ? { instructions } : {}), confidence: "high" },
        };
      } else return usage();
    }
    const path = [isAbsolute(fileArg) ? fileArg : resolve(fileArg), join(REPO_ROOT, fileArg)].find((p) => existsSync(p));
    if (!path && !reading) {
      note(`no such file: ${fileArg}`, "red");
      return "error";
    }
    const image = path ? new Uint8Array(readFileSync(path)) : new Uint8Array();
    const mimeType = MIME_TYPES[extname(fileArg).toLowerCase()] ?? "image/jpeg";
    if (reading) images.push(reading);
    photoCount += 1;
    clock.tick();
    out(paint(`   (sends a photo: ${fileArg})`, "green"));
    const outcome = await engine.handlePhoto(patientId, image, mimeType, `sim-${runId}-photo-${photoCount}`);
    images.length = 0; // an unused stand-in never reads a later photo
    note(`Photo ${photoCount}: ${outcome}${reading ? " (read by the --as stand-in)" : ""}.`);
    return "ok";
  }

  /** What the engine did with her paper check, for the person running the demo. */
  function notePaperChange(before: PaperScanRow | undefined, after: PaperScanRow | undefined): void {
    if (!after || (before?.id === after.id && before.phase === after.phase)) return;
    const outcome = after.outcome;
    if (after.phase === "rejected") note("Paper check stopped: she said the read-back was wrong, so nothing was compared.");
    else if (outcome && outcome.outcome !== "rejected")
      note(
        outcome.outcome === "flag"
          ? `R6 flag (${outcome.discrepancies.length} discrepanc${outcome.discrepancies.length === 1 ? "y" : "ies"}), stored as flag ${outcome.flagId}. See /flags.`
          : `R6 ${outcome.outcome}${outcome.reason ? ` (${outcome.reason})` : ""}: nothing stored as a flag.`,
      );
  }

  async function paperCommand(): Promise<void> {
    const paper = JSON.parse(readFileSync(PAPER_FIXTURE, "utf8")) as ExtractedPaper;
    // The engine dedupes by attachment id; a fresh id per /paper makes each one a new check.
    paperCount += 1;
    const { scanId } = await engine.startPaperCheck(patientId, paper, `sim-${runId}-paper-${paperCount}`);
    note(`Paper check ${scanId}: read-back sent from ${PAPER_FIXTURE.slice(REPO_ROOT.length + 1)}.`);
  }

  function flagsCommand(): void {
    const rows = db
      .prepare(
        `SELECT id, rule_id, status, COALESCE(severity, '') AS severity, COALESCE(offered_on, '') AS offered,
                COALESCE(told_on, '') AS told, message
         FROM flags WHERE patient_id = ? ORDER BY id`,
      )
      .all(patientId) as Record<string, string | number>[];
    if (rows.length === 0) return note("No flags stored yet.");
    const lines = renderTable(
      ["id", "rule", "status", "severity", "offered", "told", "message"],
      rows.map((r) => [r.id, r.rule_id, r.status, r.severity, r.offered, r.told, r.message].map(String)),
    );
    for (const line of lines) out(line);
  }

  function dbCommand(): void {
    const tables = (
      db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all() as {
        name: string;
      }[]
    ).map((t) => t.name);
    const rows = tables.map((name) => {
      const { n } = db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get() as { n: number };
      return [name, String(n)];
    });
    for (const line of renderTable(["table", "rows"], rows)) out(line);
  }

  async function command(line: string): Promise<InputResult> {
    const [name, ...args] = line.trim().split(/\s+/);
    switch (name) {
      case "/help":
        for (const l of HELP_LINES) out(l);
        for (const l of CARE_HELP_LINES) out(l);
        return "ok";
      case "/quit":
      case "/exit":
        return "quit";
      case "/noon": {
        const [hour, minute] = config.missedCheckinTime.split(":").map(Number);
        clock.setTime(hour ?? 12, minute ?? 0);
        const result = await engine.runMissedCheckin(patientId, day);
        note(result === "marked_missed" ? `Noon: the ${day} check-in was missed; family told.` : `Noon: nothing to do for ${day}.`);
        if ((await engine.runMedsMissed(patientId, day)) === "marked_missed") note(`Noon: the ${day} morning medicines reminder was not confirmed (family status at "all" only).`);
        if (autoPhoton) await care.afterMissedCheckin(day);
        return "ok";
      }
      case "/summary": {
        const result = await care.service.sendSummaries(day);
        note(`Care summary ${result.summaryId} for ${day}: doctor ${result.doctor}, emergency contact ${result.family}.`);
        return "ok";
      }
      case "/doctor":
      case "/family": {
        const text = line.trim().slice(name.length).trim();
        if (!text) {
          note(`usage: ${name} <text they text back>`, "red");
          return "error";
        }
        const from = name === "/doctor" ? careContacts.doctor : careContacts.emergencyContact;
        clock.tick();
        photonCount += 1;
        out("");
        out(paint(`${from.name}> ${text}`, "bold", "yellow"));
        const result = await care.service.handleInbound({ messageId: `sim-${runId}-photon-${photonCount}`, fromPhone: from.phone, text, at: clock.now() });
        if (result === "duplicate") note("Photon: already handled that text.");
        return result === "failed" ? "error" : "ok";
      }
      case "/next":
        return goToDay(nextDay(day));
      case "/day": {
        const target = args[0];
        if (!target || !isDay(target)) {
          note("usage: /day YYYY-MM-DD", "red");
          return "error";
        }
        return goToDay(target);
      }
      case "/flags":
        flagsCommand();
        return "ok";
      case "/sharing": {
        // Same path as her typing "Sharing", then (with a level) tapping that level's button.
        const level = args[0];
        if (level !== undefined && !isSharingLevel(level)) {
          note(`usage: /sharing [${SHARING_LEVELS.join("|")}] (now ${getSharing(db, patientId)})`, "red");
          return "error";
        }
        clock.tick();
        out(paint(`   (types "${SHARING_MENU_BUTTON}")`, "green"));
        await sendAsSenior(SHARING_MENU_BUTTON, undefined);
        if (level) {
          const menu = latestInSeniorChat();
          const label = SHARING_BUTTONS[level];
          clock.tick();
          out(paint(`   (taps "${label}")`, "green"));
          await sendAsSenior(label, menu?.messageId);
        }
        return "ok";
      }
      case "/paper":
        await paperCommand();
        return "ok";
      case "/later":
        return laterCommand();
      case "/meds":
        return medsCommand("morning");
      case "/evening":
        return medsCommand("evening");
      case "/refills":
        return refillsCommand();
      case "/photo":
        return photoCommand(args);
      case "/as":
        return asCommand(args);
      case "/db":
        dbCommand();
        return "ok";
      default:
        note(`unknown command ${name}. Type /help.`, "red");
        return "error";
    }
  }

  async function goToDay(target: string): Promise<InputResult> {
    day = target;
    clock.setDay(day);
    out("");
    out(paint(`===== ${day} =====`, "bold", "yellow"));
    await startDay();
    return "ok";
  }

  async function handle(raw: string): Promise<InputResult> {
    const input = raw.trim();
    if (input === "") return "ok";
    try {
      if (input.startsWith("/")) return await command(input);
      clock.tick();
      if (/^\d+$/.test(input)) {
        const target = latestWithButtons();
        const label = target?.buttons?.[Number(input) - 1];
        if (!target || !label) {
          note(target ? `no button ${input} on her latest message (it has ${target.buttons?.length ?? 0}).` : "no buttons to tap yet.", "red");
          return "error";
        }
        out(paint(`   (taps "${label}")`, "green"));
        await sendAsSenior(label, target.messageId);
        return "ok";
      }
      // Typed text replies to nothing, as in Relay without a swipe-reply; only a tap names its message.
      await sendAsSenior(input, undefined);
      return "ok";
    } catch (error) {
      note(`error: ${error instanceof Error ? error.message : String(error)}`, "red");
      return "error";
    }
  }

  return {
    patientId,
    seniorName,
    get day() {
      return day;
    },
    messenger,
    db,
    family,
    photon,
    async start() {
      const sharing = getSharing(db, patientId) ?? "status";
      out(paint(`Check-in simulator: ${seniorName} (${subject}), patient id ${patientId}, sharing ${sharing}`, "bold"));
      out(`Check-in date ${day}, data as-of ${dataAsOf ?? (consentEnded ? "unknown (record consent ended)" : "unknown")}, ${live ? "live FinchNode demo API" : "recorded fixtures"}`);
      out(paint("Synthetic data only. Type a button number or text as her, or /help.", "dim"));
      note(
        options.llm
          ? `Free text on: what she types is read by ${options.llm.provider} (synthetic data only).`
          : "Free text off: buttons only, and a fixed reply to messages outside a check-in. Add --llm to read typed replies with Gemini.",
      );
      if (family.length === 0) note("No family members (--family is empty), so family messages go nowhere.");
      else note(`Family, each in their own chat with the agent (pre-linked here): ${family.map((f) => `${familyLabels.get(f.chatId)} @${f.handle}`).join(", ")}.`);
      for (const handle of synced.notConfigured)
        note(`@${handle} is not in --family but is still linked from an earlier run in this database (--reset clears it).`, "yellow");
      await startDay();
    },
    handle,
    close() {
      void care.stop();
      db.close();
    },
  };
}

/** A photo's type from its file extension, as Relay would report it. */
const MIME_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".heic": "image/heic",
  ".heif": "image/heif",
};

/** "sarah" -> "Sarah": the name a family pane is labelled with. */
export function displayName(handle: string): string {
  return handle.charAt(0).toUpperCase() + handle.slice(1);
}

export type RunSimulationOptions = SimulatorOptions & {
  /** One input per entry: button numbers, free text or /commands. Lines starting with # are comments. */
  inputs: string[];
  /** Echo each input as "Harriet> ..." (scripted mode). Default true. */
  echo?: boolean;
};

/** Parse a script file's text into inputs (comments and blank lines dropped). */
export function parseScript(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== "" && !l.startsWith("#"));
}

/**
 * Run a whole scripted session: banner, startDay, then each input in turn.
 * Returns the exit code: 0 when every input ran, 1 when any input failed.
 */
export async function runSimulation(options: RunSimulationOptions): Promise<number> {
  const sim = await createSimulator(options);
  const paint = painter(options.color ?? false);
  let failures = 0;
  try {
    await sim.start();
    for (const input of parseScript(options.inputs.join("\n"))) {
      if (options.echo ?? true) {
        options.output("");
        options.output(paint(`${sim.seniorName}> ${input}`, "bold", "green"));
      }
      const result = await sim.handle(input);
      if (result === "error") failures += 1;
      if (result === "quit") break;
    }
  } finally {
    sim.close();
  }
  return failures === 0 ? 0 : 1;
}
