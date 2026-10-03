import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createCheckinEngine } from "../checkin/engine.ts";
import type { CheckinEngine, Clock, EngineDeps } from "../checkin/engine-types.ts";
import { PAPER_CONFIRM_BUTTONS, paperReadback } from "../checkin/paper-check.ts";
import { loadConfig, resolveCheckinDate, type Config } from "../config.ts";
import { getSharing, openDatabase, setSharing, upsertPatient, type Db, type SharingLevel } from "../db/index.ts";
import { ConsentInactiveError, FinchNodeClient } from "../finchnode/client.ts";
import { FIXTURES_DIR, REPO_ROOT, hasRecordedSnapshot, loadRecorded, loadRxNavCache, replayFetch } from "../finchnode/fixtures.ts";
import { normalizeHealthRecord, type PatientRecord } from "../finchnode/normalize.ts";
import type { HealthRecord } from "../finchnode/types.ts";
import { FakeMessenger } from "../relay/fake-messenger.ts";
import type { InboundMessage, SentMessage } from "../relay/messenger.ts";
import { diffPaper, type ExtractedPaper } from "../rules/paper-diff.ts";
import { HELP_LINES, painter, renderMessage, renderTable, type Painter, type Style } from "./sim-render.ts";

// Terminal simulator of the daily check-in (npm run simulate). Drives the real
// check-in engine with a FakeMessenger, a simulated clock and recorded FinchNode
// fixtures, so the team can run a whole morning without phones. The core here is
// process-free so tests can drive it; src/cli/simulate.ts adds argv and stdin.

export const DEFAULT_SUBJECT = "patient-demo-polypharmacy";
export const DEFAULT_DB_PATH = join(REPO_ROOT, "data", "simulator.db");
export const PAPER_FIXTURE = join(FIXTURES_DIR, "papers", "harriet-discharge.extracted.json");
export const SHARING_LEVELS: readonly SharingLevel[] = ["status", "status_vitals", "all"];

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
  output: (line: string) => void;
  color?: boolean;
  config?: Config;
  /** Injected snapshot reader (tests); defaults to fixtures or the live API. */
  loadSnapshot?: (subject: string) => Promise<HealthRecord>;
};

export type InputResult = "ok" | "error" | "quit";

export type Simulator = {
  readonly patientId: string;
  readonly seniorName: string;
  readonly day: string;
  readonly messenger: FakeMessenger;
  readonly db: Db;
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
  const patientId = (givenName ?? subject).toLowerCase().replace(/[^a-z0-9-]+/g, "-");
  const seniorChat = `chat:${patientId}`;
  const familyChat = `chat:${patientId}:family`;
  const dataAsOf = record?.dataAsOf ?? undefined;

  let day = options.day ?? resolveCheckinDate(config.clockDate, dataAsOf);
  if (!isDay(day)) throw new SimUsageError(`--day must be YYYY-MM-DD, got "${day}"`);

  const db = openDatabase(options.dbPath);
  upsertPatient(db, {
    id: patientId,
    finchnodePatientId: subject,
    preferredName: seniorName,
    relayChatId: seniorChat,
    familyChatId: familyChat,
    checkinTime: config.checkinTime,
    ...(options.sharing ? { sharing: options.sharing } : {}),
  });

  const clock = new SimClock(day);
  const chatLabel = (chatId: string) =>
    chatId === seniorChat ? `${seniorName}'s phone` : chatId === familyChat ? "Family group" : chatId;
  const messenger = new FakeMessenger({
    now: () => clock.now(),
    onSend: (m: SentMessage) => {
      out("");
      for (const line of renderMessage(m, chatLabel(m.chatId), paint, m.chatId === familyChat)) out(line);
    },
  });
  const deps: EngineDeps = { db, messenger, clock, loadSnapshot };
  const engine: CheckinEngine = createCheckinEngine(deps, { missedCheckinTime: config.missedCheckinTime, rxnav });

  // The engine dedupes inbound messages by id across the DB, so ids must be unique per run.
  const runId = randomUUID().slice(0, 8);
  let inboundCount = 0;
  let paperCount = 0;
  /** Set while her paper read-back waits for "Yes". */
  let pendingPaper: { paper: ExtractedPaper } | undefined;

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
    if (pendingPaper) {
      const pending = pendingPaper;
      pendingPaper = undefined;
      await answerPaper(pending.paper, text);
      return;
    }
    await engine.handleInbound(message);
  }

  async function answerPaper(paper: ExtractedPaper, text: string): Promise<void> {
    const confirm = PAPER_CONFIRM_BUTTONS[0] ?? "Yes";
    const key = `${patientId}:${day}:sim-paper:${paperCount}`;
    if (text.trim().toLowerCase() !== confirm.toLowerCase() && text.trim().toLowerCase() !== "yes") {
      note("Paper check stopped: she didn't confirm the read-back, so nothing was compared.");
      return;
    }
    const fresh = normalizeHealthRecord(await loadSnapshot(subject), { rxnav });
    const result = diffPaper(fresh, paper);
    await messenger.send(seniorChat, { text: result.message }, `${key}:result`);
    note(`R6 ${result.status}${result.severity ? ` (${result.severity})` : ""}. Local to the simulator: not stored as a flag until run 6.`);
  }

  async function paperCommand(): Promise<void> {
    const paper = JSON.parse(readFileSync(PAPER_FIXTURE, "utf8")) as ExtractedPaper;
    paperCount += 1;
    await messenger.send(
      seniorChat,
      { text: paperReadback(paper), buttons: [...PAPER_CONFIRM_BUTTONS] },
      `${patientId}:${day}:sim-paper:${paperCount}:readback`,
    );
    pendingPaper = { paper };
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
        const level = args[0];
        if (!level || !isSharingLevel(level)) {
          note(`usage: /sharing ${SHARING_LEVELS.join("|")} (now ${getSharing(db, patientId)})`, "red");
          return "error";
        }
        setSharing(db, patientId, level);
        note(`Sharing level set to ${level}.`);
        return "ok";
      }
      case "/paper":
        await paperCommand();
        return "ok";
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
    pendingPaper = undefined;
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
      await sendAsSenior(input, latestInSeniorChat()?.messageId);
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
    async start() {
      const sharing = getSharing(db, patientId) ?? "status";
      out(paint(`Check-in simulator: ${seniorName} (${subject}), patient id ${patientId}, sharing ${sharing}`, "bold"));
      out(`Check-in date ${day}, data as-of ${dataAsOf ?? (consentEnded ? "unknown (record consent ended)" : "unknown")}, ${live ? "live FinchNode demo API" : "recorded fixtures"}`);
      out(paint("Synthetic data only. Type a button number or text as her, or /help.", "dim"));
      await startDay();
    },
    handle,
    close() {
      db.close();
    },
  };
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
