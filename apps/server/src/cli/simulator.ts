import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createCheckinEngine } from "../checkin/engine.ts";
import type { CheckinEngine, Clock, EngineDeps } from "../checkin/engine-types.ts";
import { SHARING_BUTTONS, SHARING_MENU_BUTTON } from "../checkin/copy.ts";
import { loadConfig, normalizeHandle, resolveCheckinDate, type Config } from "../config.ts";
import { familyChats, linkFamilyMember, syncFamilyMembers, type FamilyChat } from "../db/family.ts";
import { nextFollowUp } from "../db/follow-ups.ts";
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
import { HELP_LINES, clockTime, painter, renderMessage, renderTable, type Painter, type Style } from "./sim-render.ts";

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
// same for her open reply to the greeting (the check-in's opening question).
//
// Follow-ups: after a red flag or a safety hit the engine schedules a follow-up check-in
// some hours later; /later jumps the clock to it and runs the follow-up job.

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
  // `/as <kind>` readings wait here; while one does, it stands in for the LLM (small talk still
  // goes to the real LLM if there is one).
  // `/as extract` readings of her open reply wait in `extractions` the same way. While only an
  // extraction waits, the model's kind (read alongside it for a crisis) has no stand-in and counts as
  // unavailable, which changes nothing.
  const scripted: MessageClassification[] = [];
  const extractions: CheckinExtraction[] = [];
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
  };
  const deps: EngineDeps = {
    db,
    messenger,
    clock,
    loadSnapshot,
    // Read by the engine on each message.
    get llm() {
      return scripted.length > 0 || extractions.length > 0 ? scriptLlm : options.llm;
    },
  };
  const engine: CheckinEngine = createCheckinEngine(deps, { missedCheckinTime: config.missedCheckinTime, rxnav });

  // The engine dedupes inbound messages by id across the DB, so ids must be unique per run.
  const runId = randomUUID().slice(0, 8);
  let inboundCount = 0;
  let paperCount = 0;

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
      note("   or: /as extract [questionId=answer; ...] [| topic, amount, change]... (her open reply to the greeting)", "red");
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

  /** /later: jump the clock to the next follow-up check-in and run the follow-up job. */
  async function laterCommand(): Promise<InputResult> {
    const next = nextFollowUp(db, patientId);
    if (!next) {
      note("No follow-up check-in is waiting.");
      return "ok";
    }
    clock.jumpTo(next.dueAt);
    const sent = await engine.runDueFollowUps(clock.now());
    note(`Later, ${clockTime(clock.now())}: ${sent} follow-up check-in${sent === 1 ? "" : "s"} sent.`);
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
        return "ok";
      case "/quit":
      case "/exit":
        return "quit";
      case "/noon": {
        const [hour, minute] = config.missedCheckinTime.split(":").map(Number);
        clock.setTime(hour ?? 12, minute ?? 0);
        const result = await engine.runMissedCheckin(patientId, day);
        note(result === "marked_missed" ? `Noon: the ${day} check-in was missed; family told.` : `Noon: nothing to do for ${day}.`);
        return "ok";
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
      db.close();
    },
  };
}

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
