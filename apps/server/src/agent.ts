import type { Server } from "node:http";
import type Relay from "@relaymessenger/sdk";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createApp } from "./app.ts";
import { doctorReportRoute } from "./report/index.ts";
import { loadCareConfig } from "./care/config.ts";
import { connectCareRuntime, type CareRuntime } from "./care/runtime.ts";
import { createCheckinEngine } from "./checkin/engine.ts";
import type { CheckinEngine, Clock } from "./checkin/engine-types.ts";
import { snapshotLoader } from "./cli/simulator.ts";
import { ConfigError, loadConfig, type Config } from "./config.ts";
import { errorSummary } from "./errors.ts";
import { getInstanceId } from "./db/app-meta.ts";
import { getCheckin, getCheckinPatient } from "./db/checkins.ts";
import { familyMembers, syncFamilyMembers } from "./db/family.ts";
import { activePatients, openDatabase, upsertPatient, type Db } from "./db/index.ts";
import { ConsentInactiveError } from "./finchnode/client.ts";
import { loadRxNavCache } from "./finchnode/fixtures.ts";
import { normalizeHealthRecord } from "./finchnode/normalize.ts";
import type { HealthRecord } from "./finchnode/types.ts";
import { createLlmClient, describeLlm } from "./llm/index.ts";
import type { LlmClient } from "./llm/types.ts";
import { assertNoWebhookSubscriptions, runRelayInbox } from "./relay/inbox.ts";
import type { Messenger } from "./relay/messenger.ts";
import { createRelayClient, type RelayClient, type RelayLog } from "./relay/relay-client.ts";
import { RelayMessenger } from "./relay/relay-messenger.ts";
import { CallService } from "./calls/service.ts";
import { patientIdFor } from "./patient-id.ts";
import { createDailyScheduler, localDate, zonedInstant, type CancelTimer, type DailyScheduler, type SchedulerJob } from "./scheduler.ts";

// `npm run agent`: the real Relay agent for one senior. Opens the database,
// links her FinchNode record, holds the Relay WebSocket inbox, runs the daily
// check-in (CHECKIN_TIME) and missed check-in (MISSED_CHECKIN_TIME) jobs in her
// time zone, and serves /health. startAgent takes every dependency so tests
// run it without a token or network; main() below builds the real ones.
//
// Family: there is no family group (a Relay chat holds at most one person,
// docs/adr/0001-family-chats-not-a-group.md). Each FAMILY_RELAY_HANDLES member
// gets a family_members row; their own chat with the agent is linked when they
// first message it (src/relay/inbox.ts), and family messages go to each linked chat.
//
// Free text: with an LLM configured (GEMINI_API_KEY, src/llm) what she types is read
// (src/checkin/engine.ts "Typed messages"); without one the check-in runs on buttons only,
// plus the safety screen and an explicit yes on a red-flag question.
//
// Follow-ups: every minute the agent sends follow-up check-ins that are due (after a red
// flag or a safety hit, FOLLOW_UP_DELAY_MINUTES later, default 180) and passes on family
// messages she left while no family chat was linked yet.
//
// Medication helper (src/meds): the morning reminder (MEDS_MORNING_TIME, default 08:00) and the
// refill check run each morning, the evening reminder at MEDS_EVENING_TIME (20:00); the one
// re-reminder after "Not yet" (MEDS_NUDGE_MINUTES) goes out from the every-minute job; the missed
// check-in job also marks an unanswered morning reminder missed. Photos she sends are downloaded
// by the inbox and read by the engine (handlePhoto).

export const CHECKIN_JOB = "checkin";
export const MISSED_JOB = "missed-checkin";
export const MEDS_MORNING_JOB = "meds-morning";
export const MEDS_EVENING_JOB = "meds-evening";
export const REFILL_JOB = "refill-check";
const LINK_POLL_MS = 3_000;
/** How often the follow-up job runs. */
export const FOLLOW_UP_POLL_MS = 60_000;

export const MISSING_TOKEN_MESSAGE =
  "RELAY_AGENT_TOKEN is not set. Put the agent's Agent Token in .env (see FEEDBACK.md \"Relay setup\" and README.md), then run npm run agent again.";
export const MISSING_HANDLE_MESSAGE =
  "PATIENT_RELAY_HANDLE is not set. Put the senior's Relay handle in .env (see FEEDBACK.md \"Relay setup\"), then run npm run agent again.";

/** The Relay functions the agent calls; injected so tests can fake them. */
export type RelayOps = {
  assertNoWebhookSubscriptions: typeof assertNoWebhookSubscriptions;
  runRelayInbox: typeof runRelayInbox;
};

export type AgentDeps = {
  config: Config;
  db: Db;
  relay: RelayClient;
  /** The concrete Relay SDK client used by the WebRTC call transport. */
  callRelay?: Relay;
  /** Defaults to a RelayMessenger over `relay`. */
  messenger?: Messenger;
  /** Reads what she types instead of tapping (main passes createLlmClient(config)). Without it: buttons only. */
  llm?: LlmClient | undefined;
  /** FinchNode snapshot reader (the live client in production). */
  loadSnapshot: (subject: string) => Promise<HealthRecord>;
  /**
   * Run startDay as soon as the senior is linked (--checkin-now). Without it, startDay
   * still runs once when she is linked between CHECKIN_TIME and MISSED_CHECKIN_TIME
   * with no check-in for today yet (late-start catch-up).
   */
  checkinNow?: boolean;
  /** Send the morning medicines reminder and run the refill check as soon as she's linked (--meds-now), for demos. */
  medsNow?: boolean;
  log?: (line: string) => void;
  /** Current time for the scheduler and stored rows. */
  now?: () => Date;
  /** Timer for the scheduler and the link watcher. Defaults to setTimeout. */
  setTimer?: (fn: () => void, ms: number) => CancelTimer;
  /** How often to look for her first message while she isn't linked. */
  linkPollMs?: number;
  /** How often to send due follow-ups and waiting family messages. Defaults to FOLLOW_UP_POLL_MS. */
  followUpPollMs?: number;
  /** Minutes from a red flag or safety hit to its follow-up (main reads FOLLOW_UP_DELAY_MINUTES). Defaults to the engine's 180. */
  followUpDelayMinutes?: number;
  /** Port for /health; defaults to config.port. 0 picks a free one (tests). */
  port?: number;
  relayOps?: Partial<RelayOps>;
  /**
   * Care summaries over Photon (src/care/runtime.ts), built once the patient id is known.
   * Undefined (or returning undefined) leaves them off.
   */
  care?: (ctx: { patientId: string; db: Db; clock: Clock; log: (line: string) => void; llm: LlmClient | undefined }) => Promise<CareRuntime | undefined>;
};

export type RunningAgent = {
  patientId: string;
  engine: CheckinEngine;
  scheduler: DailyScheduler;
  server: Server;
  /** The port /health is served on. */
  port: number;
  /** Settles when the Relay inbox ends: after stop(), or rejected when the socket fails for good. */
  inboxDone: Promise<void>;
  /** Resolves the first time her Relay chat is linked (and --checkin-now or the late-start catch-up ran). */
  linked: Promise<void>;
  stop(): Promise<void>;
};

type LocalPatient = {
  id: string;
  finchnodePatientId: string;
  preferredName: string;
  relayHandle: string | null;
  relayChatId: string | null;
  checkinTime: string;
  timezone: string;
};

/** A small facade over one scheduler per patient's time zone. */
function combinedScheduler(schedulers: DailyScheduler[]): DailyScheduler {
  return {
    start() {
      for (const scheduler of schedulers) scheduler.start();
    },
    stop() {
      for (const scheduler of schedulers) scheduler.stop();
    },
    async runNow(name) {
      await Promise.all(schedulers.map((scheduler) => scheduler.runNow(name)));
    },
    upcoming() {
      return schedulers.flatMap((scheduler) => scheduler.upcoming());
    },
  };
}

function localPatients(db: Db): LocalPatient[] {
  const active = activePatients(db);
  if (active.length === 0) return [];
  const checkinTimes = new Map(
    (
      db
        .prepare(`SELECT id, checkin_time AS checkinTime FROM patients WHERE onboarding_status = 'active'`)
        .all() as { id: string; checkinTime: string | null }[]
    ).map((row) => [row.id, row.checkinTime]),
  );
  return active.map((patient) => ({
    ...patient,
    checkinTime: checkinTimes.get(patient.id) ?? "09:00",
    timezone: patient.timezone ?? "America/Detroit",
  }));
}

export class AgentStartError extends Error {
  override name = "AgentStartError";
}

export async function startAgent(deps: AgentDeps): Promise<RunningAgent> {
  const { config, db, relay } = deps;
  const log = deps.log ?? ((line: string) => console.log(line));
  const now = deps.now ?? (() => new Date());
  const setTimer =
    deps.setTimer ??
    ((fn: () => void, ms: number): CancelTimer => {
      const t = setTimeout(fn, ms);
      return () => clearTimeout(t);
    });
  const ops: RelayOps = { assertNoWebhookSubscriptions, runRelayInbox, ...deps.relayOps };
  const { finchnodeSubject: subject, relayHandle } = config.patient;
  const timezone = config.patient.timezone;
  const multiUser = relayHandle === undefined;
  // With CLOCK_DATE (demos), what the agent records lands on that day: its data clock starts at
  // CHECKIN_TIME on CLOCK_DATE and runs forward in real time, so even a late-night session stays on
  // the pinned day. Without it, the data clock is the real clock. Job times, the late start and
  // Relay's call deadlines always use the real clock.
  const startedAtMs = now().getTime();
  const dataAnchorMs = config.clockDate ? zonedInstant(config.clockDate, config.checkinTime, timezone) : undefined;
  const dataNow = dataAnchorMs === undefined ? now : () => new Date(dataAnchorMs + (now().getTime() - startedAtMs));
  let patients: LocalPatient[];
  let patientId: string;
  let carePatientId: string | undefined;

  if (!multiUser) {
    // 1. Who she is: her record's given name names the patient row, as in the simulator.
    const identified = await identifyPatient(db, subject, deps.loadSnapshot, log, new URL(config.finchnode.baseUrl).host);
    patientId = identified.patientId;
    carePatientId = patientId;

    // 2. Patient row. Keep what the inbox stored (her chat id) and her sharing level.
    const existing = db
      .prepare(`SELECT relay_handle AS relayHandle, relay_chat_id AS relayChatId FROM patients WHERE id = ?`)
      .get(patientId) as { relayHandle: string | null; relayChatId: string | null } | undefined;
    const handleChanged = Boolean(existing?.relayHandle && existing.relayHandle !== relayHandle);
    if (handleChanged) log(`[agent] PATIENT_RELAY_HANDLE changed from @${existing?.relayHandle} to @${relayHandle}; her old chat link is dropped`);
    upsertPatient(db, {
      id: patientId,
      finchnodePatientId: subject,
      preferredName: identified.preferredName,
      relayHandle,
      relayChatId: handleChanged ? null : (existing?.relayChatId ?? null),
      checkinTime: config.checkinTime,
      timezone,
    });
    patients = localPatients(db).filter((patient) => patient.id === patientId);
    log(`[agent] patient ${patientId} (${identified.preferredName}) ready in ${config.databasePath}`);

    // 2b. Family members from FAMILY_RELAY_HANDLES. Links made earlier are kept. Each one links
    // their own chat by messaging the agent; until then family messages skip them (non-blocking).
    const familyHandles = config.patient.familyHandles.filter((h) => h !== relayHandle);
    if (familyHandles.length < config.patient.familyHandles.length)
      log(`[agent] FAMILY_RELAY_HANDLES lists the senior @${relayHandle}; she is not added as a family member`);
    const family = syncFamilyMembers(db, patientId, familyHandles);
    for (const handle of family.notConfigured)
      log(`[agent] @${handle} is no longer in FAMILY_RELAY_HANDLES but stays a family member (still linked if it was); delete their family_members row to stop it`);
    for (const member of familyMembers(db, patientId)) {
      if (member.chatId) log(`[agent] family @${member.handle} is linked (chat ${member.chatId})`);
      else log(`[agent] Waiting for @${member.handle} to message the agent (family member; family messages skip them until then)`);
    }
  } else {
    patients = localPatients(db);
    patientId = patients[0]?.id ?? "";
    log(
      `[agent] starting in multi-user mode: ${patients.length} active local patient account(s), ` +
        `check-in times from each account, missed check-in ${config.missedCheckinTime}, medicines ${config.meds.morningTime} and ${config.meds.eveningTime}`,
    );
  }

  if (!multiUser) {
    log(
      `[agent] starting: subject ${subject}, senior @${relayHandle}, ` +
        `${config.patient.familyHandles.filter((h) => h !== relayHandle).length} family handle(s), ` +
        `check-in ${config.checkinTime} and missed check-in ${config.missedCheckinTime}, medicines ${config.meds.morningTime} and ${config.meds.eveningTime} ${timezone}` +
        (config.clockDate ? `, demo check-in date pinned to ${config.clockDate} (records stamped from ${config.checkinTime} that day)` : "") +
        `, Relay ${config.relay.apiUrl}`,
    );
  }

  // 3. Engine over Relay, with free text when an LLM is configured.
  const relayLog: RelayLog = (event, fields) => log(`[relay] ${event}${fields ? ` ${JSON.stringify(fields)}` : ""}`);
  const clock: Clock = { now: () => dataNow().toISOString() };
  const messenger = deps.messenger ?? new RelayMessenger(relay, { log: relayLog, instanceId: getInstanceId(db) });
  log(`[agent] ${llmStatus(config, deps.llm)}`);
  // 3a. Care summaries to her doctor and emergency contact over Photon, when configured.
  // In multi-user mode, keep one runtime per account so a finished check-in is delivered to
  // the right patient's care contacts. The callback is optional in tests and in deployments
  // without Photon.
  const careByPatient = new Map<string, CareRuntime>();
  for (const patient of patients) {
    if (!deps.care) break;
    try {
      const runtime = await deps.care({ patientId: patient.id, db, clock, log, llm: deps.llm });
      if (runtime) careByPatient.set(patient.id, runtime);
    } catch (error) {
      log(`[agent] care summaries for ${patient.id} are off: ${errorSummary(error)}`);
    }
    if (carePatientId !== undefined) break;
  }
  const onDayFinished = careByPatient.size > 0 ? async (event: Parameters<NonNullable<CareRuntime["onDayFinished"]>>[0]) => careByPatient.get(event.patientId)?.onDayFinished(event) : undefined;
  const engine = createCheckinEngine(
    { db, messenger, clock, loadSnapshot: deps.loadSnapshot, llm: deps.llm },
    {
      missedCheckinTime: config.missedCheckinTime,
      medsNudgeMinutes: config.meds.nudgeMinutes,
      refillRemindDays: config.meds.refillRemindDays,
      ...(deps.followUpDelayMinutes !== undefined ? { followUpDelayMinutes: deps.followUpDelayMinutes } : {}),
      ...(onDayFinished ? { onDayFinished } : {}),
    },
  );

  const calls = deps.callRelay
    ? new CallService({
        db,
        config,
        relay: deps.callRelay,
        loadSnapshot: deps.loadSnapshot,
        engine,
        llm: deps.llm,
        today: (forPatientId?: string) => {
          const patient = patients.find((candidate) => candidate.id === forPatientId) ?? patients[0];
          return config.clockDate ?? localDate(now(), patient?.timezone ?? timezone);
        },
        log: (event, fields) => log(`[calls] ${event}${fields ? ` ${JSON.stringify(fields)}` : ""}`),
        now: () => dataNow().toISOString(),
        wallNow: () => now().toISOString(),
      })
    : undefined;

  // 4. WebSocket delivery needs zero webhook subscriptions.
  await ops.assertNoWebhookSubscriptions(relay);
  log("[agent] Relay: no webhook subscriptions, WebSocket delivery is available");
  const isLinked = (id: string) => Boolean(getCheckinPatient(db, id)?.relayChatId);

  // 5. Inbox: holds the socket until stop().
  const abort = new AbortController();
  const inboxDone = ops.runRelayInbox({
    relay,
    db,
    engine,
    messenger,
    patientHandle: relayHandle ?? "",
    defaultCheckinTime: config.checkinTime,
    defaultTimezone: timezone,
    signal: abort.signal,
    log: relayLog,
    ...(calls ? { callHandler: calls } : {}),
  });
  inboxDone.then(
    () => log("[agent] Relay inbox closed"),
    (error: unknown) => log(`[agent] Relay inbox stopped: ${errorSummary(error)}`),
  );
  log(`[agent] Relay inbox listening${relayHandle ? ` for @${relayHandle}` : " for all active local patient accounts"}`);

  // 6. Daily jobs. Legacy mode has one scheduler; multi-user mode has one per account so
  // each account's check-in time zone and configured check-in time are honored.
  function jobsFor(patient: LocalPatient): SchedulerJob[] {
    const shouldRun = () => multiUser || isLinked(patient.id);
    return [
      {
        name: CHECKIN_JOB,
        time: patient.checkinTime,
        run: async (day) => {
          if (!shouldRun()) {
            log(`[agent] Waiting for @${relayHandle} to send the agent a message in Relay; skipping the ${day} check-in`);
            return;
          }
          const result = await engine.startDay(patient.id, day);
          log(`[agent] check-in ${day}: ${describeDay(result)}`);
        },
      },
      {
        name: MISSED_JOB,
        time: config.missedCheckinTime,
        run: async (day) => {
          if (!shouldRun()) return;
          const result = await engine.runMissedCheckin(patient.id, day);
          log(`[agent] missed check-in ${day}: ${result === "marked_missed" ? "marked missed, family told" : "nothing to do"}`);
          const meds = await engine.runMedsMissed(patient.id, day);
          if (meds === "marked_missed") log(`[agent] morning medicines ${day}: not confirmed, marked missed`);
          await careByPatient.get(patient.id)?.afterMissedCheckin(day);
        },
      },
      {
        name: MEDS_MORNING_JOB,
        time: config.meds.morningTime,
        run: async (day) => {
          if (!shouldRun()) return;
          log(`[agent] morning medicines reminder ${day}: ${await engine.sendMedsReminder(patient.id, day, "morning")}`);
        },
      },
      {
        name: MEDS_EVENING_JOB,
        time: config.meds.eveningTime,
        run: async (day) => {
          if (!shouldRun()) return;
          log(`[agent] evening medicines reminder ${day}: ${await engine.sendMedsReminder(patient.id, day, "evening")}`);
        },
      },
      {
        name: REFILL_JOB,
        time: config.meds.morningTime,
        run: async (day) => {
          if (!shouldRun()) return;
          const sent = await engine.runRefillCheck(patient.id, day);
          log(`[agent] refill check ${day}: ${sent} reminder(s) sent`);
        },
      },
    ];
  }
  const schedulers: DailyScheduler[] = [];
  const schedulerByPatient = new Map<string, DailyScheduler>();
  const lateStarts = new Set<string>();
  let schedulerStarted = false;
  const makeScheduler = (patient: LocalPatient): DailyScheduler =>
    createDailyScheduler({
      timezone: patient.timezone,
      clockDate: config.clockDate,
      clock: now,
      setTimer,
      log,
      jobs: jobsFor(patient),
    });
  function reconcileSchedulers(): void {
    const current = multiUser ? localPatients(db) : patients;
    if (multiUser) patients = current;
    const activeIds = new Set(current.map((patient) => patient.id));
    for (const [id, accountScheduler] of schedulerByPatient) {
      if (activeIds.has(id)) continue;
      accountScheduler.stop();
      schedulerByPatient.delete(id);
      const index = schedulers.indexOf(accountScheduler);
      if (index >= 0) schedulers.splice(index, 1);
      log(`[agent] stopped scheduler for inactive patient ${id}`);
    }
    for (const patient of current) {
      if (schedulerByPatient.has(patient.id)) continue;
      const accountScheduler = makeScheduler(patient);
      schedulerByPatient.set(patient.id, accountScheduler);
      schedulers.push(accountScheduler);
      if (schedulerStarted) accountScheduler.start();
      log(`[agent] scheduled active patient ${patient.id} (${patient.preferredName})`);
      if (schedulerStarted && multiUser) {
        const localDay = localDate(now(), patient.timezone);
        const checkinAt = zonedInstant(localDay, patient.checkinTime, patient.timezone);
        const missedAt = zonedInstant(localDay, config.missedCheckinTime, patient.timezone);
        const day = config.clockDate ?? localDay;
        if (now().getTime() >= checkinAt && now().getTime() < missedAt && !getCheckin(db, patient.id, day) && !lateStarts.has(patient.id)) {
          lateStarts.add(patient.id);
          void accountScheduler.runNow(CHECKIN_JOB).finally(() => lateStarts.delete(patient.id));
          log(`[agent] Late start: newly linked patient ${patient.id} is past the ${patient.checkinTime} check-in time and before ${config.missedCheckinTime}; running it now`);
        }
      }
    }
  }
  reconcileSchedulers();
  const scheduler = combinedScheduler(schedulers);
  scheduler.start();
  schedulerStarted = true;

  // 6b. Follow-ups and waiting family messages, every minute. One run at a time; a failure is
  // logged (never her words) and the next run tries again.
  let ticking = false;
  async function followUpTick(): Promise<void> {
    if (ticking) return;
    ticking = true;
    try {
      reconcileSchedulers();
      const sent = await engine.runDueFollowUps(dataNow().toISOString());
      if (sent > 0) log(`[agent] sent ${sent} follow-up check-in(s)`);
      const nudged = await engine.runMedsNudges(dataNow().toISOString());
      if (nudged > 0) log(`[agent] sent ${nudged} medicines re-reminder(s)`);
      const passed = multiUser
        ? (await Promise.all(localPatients(db).map((patient) => engine.passOnFamilyMessages(patient.id)))).reduce((sum, count) => sum + count, 0)
        : await engine.passOnFamilyMessages(patientId);
      if (passed > 0) log(`[agent] passed on ${passed} message(s) she left for her family`);
    } catch (error) {
      log(`[agent] follow-up job failed: ${errorSummary(error)}`);
    } finally {
      ticking = false;
    }
  }

  // 7. /health.
  const server = await listen(
    createApp({
      config,
      doctorReport: doctorReportRoute(db),
    }),
    deps.port ?? config.port,
  );
  const port = (server.address() as AddressInfo).port;
  log(`[agent] health check on http://localhost:${port}/health`);
  log(`[agent] doctor report on http://localhost:${port}/report/<patient id> (her first name in lower case, e.g. /report/harriet)`);
  const followUpTimer = setInterval(() => void followUpTick(), deps.followUpPollMs ?? FOLLOW_UP_POLL_MS);

  // 8. Once she's linked: --checkin-now, else the late-start catch-up. The scheduler only
  // fires at CHECKIN_TIME, so an agent started (or linked) after it would skip today.
  let cancelWatch: CancelTimer | undefined;
  let stopping = false;
  async function onLinked(): Promise<void> {
    if (multiUser) {
      if (deps.medsNow) {
        await scheduler.runNow(MEDS_MORNING_JOB);
        await scheduler.runNow(REFILL_JOB);
      }
      if (deps.checkinNow) await scheduler.runNow(CHECKIN_JOB);
      return;
    }
    log(`[agent] @${relayHandle} is linked to the agent`);
    if (deps.medsNow) {
      await scheduler.runNow(MEDS_MORNING_JOB);
      await scheduler.runNow(REFILL_JOB);
    }
    if (deps.checkinNow) {
      await scheduler.runNow(CHECKIN_JOB);
      return;
    }
    if (deps.medsNow) return;
    const at = now();
    const localDay = localDate(at, timezone);
    const day = config.clockDate ?? localDay;
    const checkinAt = zonedInstant(localDay, config.checkinTime, timezone);
    const missedAt = zonedInstant(localDay, config.missedCheckinTime, timezone);
    if (at.getTime() >= checkinAt && at.getTime() < missedAt && !getCheckin(db, patientId, day)) {
      log(
        `[agent] Late start: it's past the ${config.checkinTime} check-in time and before ${config.missedCheckinTime}, ` +
          `with no check-in for ${day} yet; running it now`,
      );
      await scheduler.runNow(CHECKIN_JOB);
    }
  }
  const linked = new Promise<void>((resolve) => {
    if (multiUser || isLinked(patientId)) {
      void onLinked().finally(resolve);
      return;
    }
    log(`[agent] Waiting for @${relayHandle} to send the agent a message in Relay`);
    const poll = () => {
      cancelWatch = undefined;
      if (stopping) return;
      if (isLinked(patientId)) {
        void onLinked().finally(resolve);
        return;
      }
      cancelWatch = setTimer(poll, deps.linkPollMs ?? LINK_POLL_MS);
    };
    cancelWatch = setTimer(poll, deps.linkPollMs ?? LINK_POLL_MS);
  });

  let stopped: Promise<void> | undefined;
  return {
    patientId,
    engine,
    scheduler,
    server,
    port,
    inboxDone,
    linked,
    stop() {
      stopped ??= (async () => {
        stopping = true;
        cancelWatch?.();
        clearInterval(followUpTimer);
        scheduler.stop();
        abort.abort();
        await inboxDone.catch(() => {});
        await Promise.all([...careByPatient.values()].map((runtime) => runtime.stop()));
        await closeServer(server);
        log("[agent] stopped");
      })();
      return stopped;
    },
  };
}

async function identifyPatient(
  db: Db,
  subject: string,
  loadSnapshot: (subject: string) => Promise<HealthRecord>,
  log: (line: string) => void,
  source = "FinchNode",
): Promise<{ patientId: string; preferredName: string }> {
  try {
    const record = normalizeHealthRecord(await loadSnapshot(subject), { rxnav: loadRxNavCache() });
    const givenName = record.demographics?.givenName ?? record.demographics?.name?.split(" ")[0];
    log(`[agent] FinchNode (${source}): read ${subject}: ${record.conditions.length} conditions, ${record.medications.length} medicines, ${record.labs.length} labs (data as-of ${record.dataAsOf ?? "unknown"})`);
    return { patientId: patientIdFor(givenName, subject), preferredName: givenName ?? subject };
  } catch (error) {
    // Consent ended: still start, so the engine's consent-ended path tells her. FinchNode down: reuse her row.
    const row = db.prepare(`SELECT id, preferred_name AS preferredName FROM patients WHERE finchnode_patient_id = ?`).get(subject) as
      | { id: string; preferredName: string }
      | undefined;
    if (error instanceof ConsentInactiveError) {
      log(`[agent] record consent for ${subject} has ended; the check-in will say so`);
      return row ? { patientId: row.id, preferredName: row.preferredName } : { patientId: patientIdFor(undefined, subject), preferredName: subject };
    }
    if (row) {
      log(`[agent] could not read FinchNode for ${subject} (${errorSummary(error)}); using patient ${row.id} from the database`);
      return { patientId: row.id, preferredName: row.preferredName };
    }
    throw error;
  }
}

/** What free text runs on, for the startup log: provider and models, or why it is off. Never a key. */
export function llmStatus(config: Config, llm: LlmClient | undefined): string {
  const configured = describeLlm(config);
  const on = configured.startsWith("free text on");
  if (!llm) return on ? "free text off: no LLM client (buttons only)" : configured;
  return on ? configured : `free text on: ${llm.provider}`;
}

function describeDay(result: Awaited<ReturnType<CheckinEngine["startDay"]>>): string {
  if (result.kind === "sent") return `sent with ${result.questionIds.length} question(s): ${result.questionIds.join(", ")}`;
  if (result.kind === "already_started") return "already started";
  return "record consent has ended; she was told";
}

function listen(app: ReturnType<typeof createApp>, port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, (err?: Error) => (err ? reject(err) : resolve(server)));
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeIdleConnections();
  });
}

/** FOLLOW_UP_DELAY_MINUTES: undefined when unset or blank (use the default), null when invalid. */
export function parseFollowUpDelay(raw: string | undefined): number | undefined | null {
  if (raw === undefined || raw.trim() === "") return undefined;
  const minutes = Number(raw);
  return Number.isFinite(minutes) && minutes > 0 ? minutes : null;
}

// ---- process entry point ----

const USAGE = "usage: npm run agent [-- --checkin-now] [--meds-now]";

export async function main(argv: string[] = process.argv.slice(2), env: Record<string, string | undefined> = process.env): Promise<number> {
  let checkinNow = false;
  let medsNow = false;
  try {
    ({
      values: { "checkin-now": checkinNow = false, "meds-now": medsNow = false },
    } = parseArgs({ args: argv, options: { "checkin-now": { type: "boolean" }, "meds-now": { type: "boolean" } }, strict: true }));
  } catch (error) {
    console.error(`error: ${errorSummary(error)}\n${USAGE}`);
    return 2;
  }

  let config: Config;
  try {
    config = loadConfig(env);
  } catch (error) {
    console.error(error instanceof ConfigError ? `error: ${error.message}` : `error: ${errorSummary(error)}`);
    return 1;
  }
  const token = config.relay.agentToken;
  if (!token) {
    console.error(`error: ${MISSING_TOKEN_MESSAGE}`);
    return 1;
  }
  // FOLLOW_UP_DELAY_MINUTES: optional, for demos (say 2); the engine's default otherwise.
  const followUpDelayMinutes = parseFollowUpDelay(env.FOLLOW_UP_DELAY_MINUTES);
  if (followUpDelayMinutes === null) {
    console.error(`error: FOLLOW_UP_DELAY_MINUTES must be a positive number of minutes, got "${env.FOLLOW_UP_DELAY_MINUTES}"`);
    return 1;
  }

  const db = openDatabase(config.databasePath);
  const relay = createRelayClient({ agentToken: token, apiUrl: config.relay.apiUrl });
  let agent: RunningAgent;
  try {
    agent = await startAgent({
      config,
      db,
      relay,
      callRelay: relay as unknown as Relay,
      loadSnapshot: snapshotLoader(config, true),
      llm: createLlmClient(config),
      checkinNow,
      medsNow,
      ...(followUpDelayMinutes !== undefined ? { followUpDelayMinutes } : {}),
      care: (ctx) => connectCareRuntime({ config: loadCareConfig(env), ...ctx }),
    });
  } catch (error) {
    console.error(`[agent] could not start: ${errorSummary(error)}`);
    db.close();
    return 1;
  }

  return new Promise<number>((resolve) => {
    let exiting = false;
    const shutdown = (code: number, why: string) => {
      if (exiting) return;
      exiting = true;
      console.log(`[agent] ${why}, shutting down`);
      setTimeout(() => {
        console.error("[agent] shutdown took too long, exiting");
        process.exit(code || 1);
      }, 10_000).unref();
      void agent.stop().finally(() => {
        db.close();
        resolve(code);
      });
    };
    process.once("SIGINT", () => shutdown(0, "SIGINT received"));
    process.once("SIGTERM", () => shutdown(0, "SIGTERM received"));
    // The inbox only ends by itself when the socket can't continue (bad token, a webhook was added).
    agent.inboxDone.then(
      () => shutdown(0, "Relay inbox ended"),
      () => shutdown(1, "Relay inbox failed"),
    );
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const code = await main();
  process.exitCode = code;
  // Anything the SDK left open must not keep a stopped agent alive.
  setTimeout(() => process.exit(code), 1_000).unref();
}
