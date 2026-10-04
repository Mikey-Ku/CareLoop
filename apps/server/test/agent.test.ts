import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AgentStartError,
  CHECKIN_JOB,
  MEDS_EVENING_JOB,
  MEDS_MORNING_JOB,
  MISSED_JOB,
  REFILL_JOB,
  MISSING_HANDLE_MESSAGE,
  MISSING_TOKEN_MESSAGE,
  llmStatus,
  main as agentMain,
  parseFollowUpDelay,
  startAgent,
  type AgentDeps,
  type RelayOps,
  type RunningAgent,
} from "../src/agent.ts";
import { snapshotLoader } from "../src/cli/simulator.ts";
import { formatLine, main as relayCheckMain, runRelayCheck } from "../src/cli/relay-check.ts";
import { loadConfig, type Config } from "../src/config.ts";
import { getCheckin } from "../src/db/checkins.ts";
import { addFamilyRelay, familyChats, familyMembers, linkFamilyMember, syncFamilyMembers, waitingFamilyRelays } from "../src/db/family.ts";
import { nextFollowUp, scheduleFollowUp } from "../src/db/follow-ups.ts";
import { getSharing, openDatabase, setSharing, upsertPatient, type Db } from "../src/db/index.ts";
import { familyRelay, followUpQuestion, smallTalkFallback } from "../src/checkin/copy.ts";
import { FakeLlmClient } from "../src/llm/fake.ts";
import { patientIdFor } from "../src/patient-id.ts";
import { FakeMessenger } from "../src/relay/fake-messenger.ts";
import type { RelayClient } from "../src/relay/relay-client.ts";

const SUBJECT = "patient-demo-polypharmacy";
const TOKEN = "relay_tok_SECRET_agent_test";
// CLOCK_DATE pins the check-in date to 2026-09-01; these set the wall clock (America/Detroit, EDT = UTC-4).
const BEFORE_CHECKIN = new Date("2026-09-01T10:00:00Z"); // 06:00
const LATE_START = new Date("2026-09-01T14:00:00Z"); // 10:00, after 09:00 and before 12:00
const AFTER_MISSED = new Date("2026-09-01T16:30:00Z"); // 12:30
const LATE_START_LINE = "[agent] Late start: it's past the 09:00 check-in time and before 12:00, with no check-in for 2026-09-01 yet; running it now";

type Calls = {
  order: string[];
  inbox: { patientHandle: string; signal: AbortSignal | undefined }[];
};

/** Relay operations that record what the agent asked for, never touching the network. */
function fakeOps(calls: Calls, overrides: Partial<RelayOps> = {}): Partial<RelayOps> {
  return {
    assertNoWebhookSubscriptions: async () => {
      calls.order.push("assertNoWebhookSubscriptions");
    },
    runRelayInbox: (options) => {
      calls.order.push("runRelayInbox");
      calls.inbox.push({ patientHandle: options.patientHandle, signal: options.signal });
      // Like the real inbox: holds until the signal aborts.
      return new Promise<void>((resolve) => options.signal?.addEventListener("abort", () => resolve()));
    },
    ...overrides,
  };
}

function testConfig(env: Record<string, string> = {}): Config {
  return loadConfig({
    RELAY_AGENT_TOKEN: TOKEN,
    PATIENT_RELAY_HANDLE: "@Harriet",
    FAMILY_RELAY_HANDLES: "sarah",
    DATABASE_PATH: ":memory:",
    CLOCK_DATE: "2026-09-01",
    ...env,
  });
}

const running: RunningAgent[] = [];
const dbs: Db[] = [];

afterEach(async () => {
  for (const agent of running.splice(0)) await agent.stop();
  for (const db of dbs.splice(0)) db.close();
});

function setup(options: { env?: Record<string, string>; deps?: Partial<AgentDeps>; ops?: Partial<RelayOps>; db?: Db } = {}) {
  const config = testConfig(options.env);
  const db = options.db ?? openDatabase(":memory:");
  if (!options.db) dbs.push(db);
  const messenger = new FakeMessenger();
  const lines: string[] = [];
  const calls: Calls = { order: [], inbox: [] };
  const deps: AgentDeps = {
    config,
    db,
    relay: {} as RelayClient, // every Relay call goes through the fake ops
    messenger,
    loadSnapshot: snapshotLoader(config, false),
    log: (line) => lines.push(line),
    // A fixed wall clock before CHECKIN_TIME, so no test depends on the time of day it runs.
    now: () => BEFORE_CHECKIN,
    port: 0,
    linkPollMs: 5,
    relayOps: fakeOps(calls, options.ops),
    ...options.deps,
  };
  const start = async () => {
    const agent = await startAgent(deps);
    running.push(agent);
    return agent;
  };
  return { config, db, messenger, lines, calls, start };
}

function link(db: Db, chatId = "chat_harriet"): void {
  db.prepare("UPDATE patients SET relay_chat_id = ? WHERE id = 'harriet'").run(chatId);
}

/** Her row as a previous run left it: linked to her chat. */
function linkedBeforeStart(db: Db): void {
  upsertPatient(db, { id: "harriet", finchnodePatientId: SUBJECT, preferredName: "Harriet", relayHandle: "harriet", relayChatId: "chat_harriet" });
}

describe("startAgent", () => {
  it("seeds her patient row, checks webhooks before the inbox, and serves /health", async () => {
    const { db, lines, calls, start } = setup();
    const agent = await start();

    expect(agent.patientId).toBe("harriet");
    const row = db.prepare("SELECT * FROM patients").get() as Record<string, unknown>;
    expect(row).toMatchObject({
      id: "harriet",
      finchnode_patient_id: SUBJECT,
      preferred_name: "Harriet",
      relay_handle: "harriet",
      relay_chat_id: null,
      checkin_time: "09:00",
      timezone: "America/Detroit",
    });
    expect(calls.order).toEqual(["assertNoWebhookSubscriptions", "runRelayInbox"]);
    expect(calls.inbox[0]?.patientHandle).toBe("harriet");

    const res = await fetch(`http://127.0.0.1:${agent.port}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });

    expect(agent.scheduler.upcoming().map((u) => u.name)).toEqual([CHECKIN_JOB, MISSED_JOB, MEDS_MORNING_JOB, MEDS_EVENING_JOB, REFILL_JOB]);
    expect(lines).toContain("[agent] Waiting for @harriet to send the agent a message in Relay");
    expect(lines.join("\n")).not.toContain(TOKEN);
  });

  it("skips the check-in while she isn't linked", async () => {
    const { db, messenger, lines, start } = setup();
    const agent = await start();
    await agent.scheduler.runNow(CHECKIN_JOB);
    expect(messenger.sent).toEqual([]);
    expect(getCheckin(db, "harriet", "2026-09-01")).toBeUndefined();
    expect(lines).toContain("[agent] Waiting for @harriet to send the agent a message in Relay; skipping the 2026-09-01 check-in");
  });

  it("once she's linked, runs --checkin-now on the pinned date", async () => {
    const { db, messenger, lines, start } = setup({ deps: { checkinNow: true } });
    const agent = await start();
    expect(messenger.sent).toEqual([]);

    link(db);
    await agent.linked;

    expect(getCheckin(db, "harriet", "2026-09-01")?.status).toBe("sent");
    expect(messenger.sent.length).toBeGreaterThan(0);
    expect(messenger.sent.every((m) => m.chatId === "chat_harriet")).toBe(true);
    expect(lines).toContain("[agent] @harriet is linked to the agent");
    expect(lines.some((l) => l.startsWith("[agent] check-in 2026-09-01: sent with"))).toBe(true);
  });

  it("runs the check-in at once when she was linked before the restart, keeping her chat, family links and sharing", async () => {
    const first = setup({ deps: { checkinNow: true } });
    upsertPatient(first.db, {
      id: "harriet",
      finchnodePatientId: SUBJECT,
      preferredName: "Harriet",
      relayHandle: "harriet",
      relayChatId: "chat_harriet",
    });
    syncFamilyMembers(first.db, "harriet", ["sarah"]);
    linkFamilyMember(first.db, "sarah", "chat_sarah", "Sarah", "2026-08-31T12:00:00Z");
    setSharing(first.db, "harriet", "all");
    const agent = await first.start();
    await agent.linked;

    expect(first.db.prepare("SELECT relay_chat_id FROM patients WHERE id = 'harriet'").get()).toEqual({ relay_chat_id: "chat_harriet" });
    expect(familyChats(first.db, "harriet")).toEqual([{ handle: "sarah", displayName: "Sarah", chatId: "chat_sarah" }]);
    expect(getSharing(first.db, "harriet")).toBe("all");
    expect(getCheckin(first.db, "harriet", "2026-09-01")?.status).toBe("sent");
    expect(first.lines).toContain("[agent] family @sarah is linked (chat chat_sarah)");
  });

  it("drops the old chat link when PATIENT_RELAY_HANDLE changes", async () => {
    const { db, lines, start } = setup({ env: { PATIENT_RELAY_HANDLE: "harriet2" } });
    upsertPatient(db, { id: "harriet", finchnodePatientId: SUBJECT, preferredName: "Harriet", relayHandle: "harriet", relayChatId: "chat_old" });
    await start();
    expect(db.prepare("SELECT relay_handle, relay_chat_id FROM patients").get()).toEqual({ relay_handle: "harriet2", relay_chat_id: null });
    expect(lines.some((l) => l.includes("changed from @harriet to @harriet2"))).toBe(true);
  });

  it("adds each FAMILY_RELAY_HANDLES member and logs a wait for each one who hasn't messaged the agent, without blocking", async () => {
    const { db, messenger, lines, start } = setup({ env: { FAMILY_RELAY_HANDLES: "sarah, @Tom" }, deps: { checkinNow: true } });
    const agent = await start();
    expect(familyMembers(db, "harriet").map((m) => [m.handle, m.chatId])).toEqual([
      ["sarah", null],
      ["tom", null],
    ]);
    expect(lines).toContain("[agent] Waiting for @sarah to message the agent (family member; family messages skip them until then)");
    expect(lines).toContain("[agent] Waiting for @tom to message the agent (family member; family messages skip them until then)");

    // Her check-in doesn't wait for them; nothing goes to a family chat until one is linked.
    link(db);
    await agent.linked;
    expect(getCheckin(db, "harriet", "2026-09-01")?.status).toBe("sent");
    await agent.scheduler.runNow(MISSED_JOB);
    expect(messenger.sent.every((m) => m.chatId === "chat_harriet")).toBe(true);

    // Sarah messages the agent (the inbox links her chat): the next family message reaches her.
    linkFamilyMember(db, "sarah", "chat_sarah", null, "2026-09-01T12:00:00Z");
    await agent.engine.startDay("harriet", "2026-09-02");
    await agent.engine.runMissedCheckin("harriet", "2026-09-02");
    expect(messenger.sent.filter((m) => m.chatId === "chat_sarah")).toHaveLength(1);
  });

  it("keeps a family member removed from FAMILY_RELAY_HANDLES and says so", async () => {
    const { db, lines, start } = setup({ env: { FAMILY_RELAY_HANDLES: "sarah" } });
    upsertPatient(db, { id: "harriet", finchnodePatientId: SUBJECT, preferredName: "Harriet", relayHandle: "harriet" });
    syncFamilyMembers(db, "harriet", ["sarah", "tom"]);
    linkFamilyMember(db, "tom", "chat_tom", null, "2026-08-31T12:00:00Z");
    await start();
    expect(familyChats(db, "harriet").map((f) => f.handle)).toEqual(["tom"]);
    expect(lines.some((l) => l.startsWith("[agent] @tom is no longer in FAMILY_RELAY_HANDLES but stays a family member"))).toBe(true);
  });

  it("has no family members when no family handles are set, and never adds the senior as one", async () => {
    const none = setup({ env: { FAMILY_RELAY_HANDLES: "" } });
    await none.start();
    expect(familyMembers(none.db, "harriet")).toEqual([]);

    const self = setup({ env: { FAMILY_RELAY_HANDLES: "@harriet,sarah" } });
    await self.start();
    expect(familyMembers(self.db, "harriet").map((m) => m.handle)).toEqual(["sarah"]);
    expect(self.lines).toContain("[agent] FAMILY_RELAY_HANDLES lists the senior @harriet; she is not added as a family member");
  });

  it("the missed check-in job marks an unanswered check-in missed", async () => {
    const { db, start } = setup({ deps: { checkinNow: true } });
    const agent = await start();
    link(db);
    await agent.linked;
    await agent.scheduler.runNow(MISSED_JOB);
    expect(getCheckin(db, "harriet", "2026-09-01")?.status).toBe("missed");
  });

  it("late start: linked, after CHECKIN_TIME and before MISSED_CHECKIN_TIME with no check-in yet, runs it once", async () => {
    const { db, messenger, lines, start } = setup({ deps: { now: () => LATE_START } });
    linkedBeforeStart(db);
    const agent = await start();
    await agent.linked;
    expect(lines.filter((l) => l === LATE_START_LINE)).toHaveLength(1);
    expect(getCheckin(db, "harriet", "2026-09-01")?.status).toBe("sent");
    expect(messenger.sent).toHaveLength(1);
    await agent.stop();

    // Started again the same morning: the check-in exists, so no second catch-up.
    const again = setup({ db, deps: { now: () => LATE_START } });
    await (await again.start()).linked;
    expect(again.lines).not.toContain(LATE_START_LINE);
    expect(again.messenger.sent).toEqual([]);
  });

  it("late start also covers her linking after CHECKIN_TIME, once", async () => {
    const { db, lines, start } = setup({ deps: { now: () => LATE_START } });
    const agent = await start();
    expect(lines).not.toContain(LATE_START_LINE);
    link(db);
    await agent.linked;
    expect(lines.filter((l) => l === LATE_START_LINE)).toHaveLength(1);
    expect(getCheckin(db, "harriet", "2026-09-01")?.status).toBe("sent");
  });

  it("no late-start check-in after MISSED_CHECKIN_TIME, or before CHECKIN_TIME", async () => {
    for (const at of [AFTER_MISSED, BEFORE_CHECKIN]) {
      const { db, messenger, lines, start } = setup({ deps: { now: () => at } });
      linkedBeforeStart(db);
      await (await start()).linked;
      expect(lines).not.toContain(LATE_START_LINE);
      expect(getCheckin(db, "harriet", "2026-09-01")).toBeUndefined();
      expect(messenger.sent).toEqual([]);
    }
  });

  it("refuses to start with webhook subscriptions, before opening the socket", async () => {
    const { calls, start } = setup({
      ops: {
        assertNoWebhookSubscriptions: async () => {
          throw new Error("This agent has 1 webhook subscription(s)");
        },
      },
    });
    await expect(start()).rejects.toThrow("webhook subscription");
    expect(calls.inbox).toEqual([]);
  });

  it("refuses to start without PATIENT_RELAY_HANDLE", async () => {
    const { start } = setup({ env: { PATIENT_RELAY_HANDLE: "" } });
    const error = await start().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AgentStartError);
    expect((error as Error).message).toBe(MISSING_HANDLE_MESSAGE);
  });

  it("stop() aborts the inbox, stops the scheduler and closes the server", async () => {
    const { calls, start } = setup();
    const agent = await start();
    await agent.stop();
    expect(calls.inbox[0]?.signal?.aborted).toBe(true);
    expect(agent.scheduler.upcoming()).toEqual([]);
    expect(agent.server.listening).toBe(false);
    await agent.stop(); // idempotent
  });

  it("logs that free text is off without an LLM, and the engine answers typed text with the fixed reply", async () => {
    const { db, messenger, lines, start } = setup();
    linkedBeforeStart(db);
    const agent = await start();
    await agent.linked;
    expect(lines).toContain("[agent] free text off: GEMINI_API_KEY is not set (buttons only)");
    await agent.engine.handleInbound({ chatId: "chat_harriet", messageId: "in_1", text: "hello there", at: BEFORE_CHECKIN.toISOString() });
    expect(messenger.lastIn("chat_harriet")?.text).toBe(smallTalkFallback("Harriet"));
  });

  it("passes the LLM to the engine and logs it", async () => {
    const llm = new FakeLlmClient({ smallTalk: () => ({ text: "Hello, Harriet. Nice to hear from you.", memories: [], complaints: [] }) });
    const { db, messenger, lines, start } = setup({ deps: { llm } });
    linkedBeforeStart(db);
    const agent = await start();
    await agent.linked;
    expect(lines).toContain("[agent] free text on: fake");
    await agent.engine.handleInbound({ chatId: "chat_harriet", messageId: "in_1", text: "hello there", at: BEFORE_CHECKIN.toISOString() });
    expect(messenger.lastIn("chat_harriet")?.text).toBe("Hello, Harriet. Nice to hear from you.");
    expect(llm.smallTalkCalls.map((c) => c.message)).toEqual(["hello there"]);
  });

  it("llmStatus names the provider and models, or why free text is off, never the key", () => {
    const withKey = testConfig({ GEMINI_API_KEY: "gem_SECRET_key", GEMINI_MODELS: "gemini-a,gemini-b" });
    const on = llmStatus(withKey, new FakeLlmClient());
    expect(on).toMatch(/^free text on: gemini gemini-a, gemini-b/);
    expect(on).not.toContain("SECRET");
    expect(llmStatus(withKey, undefined)).toBe("free text off: no LLM client (buttons only)");
    expect(llmStatus(testConfig(), undefined)).toMatch(/^free text off: .*buttons only/);
    expect(llmStatus(testConfig(), new FakeLlmClient())).toBe("free text on: fake");
  });

  it("names the patient like the simulator", () => {
    expect(patientIdFor("Harriet", SUBJECT)).toBe("harriet");
    expect(patientIdFor(undefined, SUBJECT)).toBe(SUBJECT);
    expect(patientIdFor("Mary Ann", SUBJECT)).toBe("mary-ann");
  });
});

describe("follow-up job", () => {
  it("every tick sends due follow-ups and passes on waiting family messages; stop() ends it", async () => {
    const { db, messenger, lines, start } = setup({ deps: { followUpPollMs: 5 } });
    linkedBeforeStart(db);
    syncFamilyMembers(db, "harriet", ["sarah"]);
    linkFamilyMember(db, "sarah", "chat_sarah", "Sarah", BEFORE_CHECKIN.toISOString());
    // Due before the agent's wall clock (06:00 EDT on 2026-09-01).
    scheduleFollowUp(db, { patientId: "harriet", checkinId: null, reason: "crisis", createdAt: "2026-09-01T06:00:00Z", dueAt: "2026-09-01T09:00:00Z" });
    addFamilyRelay(db, { patientId: "harriet", text: "Tell Sarah I love her", createdAt: "2026-09-01T06:00:00Z", passedOnAt: null });
    const agent = await start();
    await vi.waitFor(() => expect(messenger.lastIn("chat_harriet")?.text).toBe(followUpQuestion("Harriet", "crisis")));
    await vi.waitFor(() => expect(messenger.lastIn("chat_sarah")?.text).toBe(familyRelay("Harriet", "Tell Sarah I love her")));
    expect(nextFollowUp(db, "harriet")).toBeUndefined();
    expect(waitingFamilyRelays(db, "harriet")).toEqual([]);
    expect(lines).toContain("[agent] sent 1 follow-up check-in(s)");
    expect(lines).toContain("[agent] passed on 1 message(s) she left for her family");
    // Never her words in the log.
    expect(lines.join("\n")).not.toContain("love her");
    await agent.stop();
    scheduleFollowUp(db, { patientId: "harriet", checkinId: null, reason: "crisis", createdAt: "2026-09-01T06:00:00Z", dueAt: "2026-09-01T09:00:00Z" });
    const sent = messenger.sent.length;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(messenger.sent.length).toBe(sent);
  });

  it("passes the follow-up delay to the engine", async () => {
    const { db, start } = setup({ deps: { followUpDelayMinutes: 2 } });
    linkedBeforeStart(db);
    const agent = await start();
    await agent.engine.handleInbound({ chatId: "chat_harriet", messageId: "in_1", text: "I have chest pain", at: BEFORE_CHECKIN.toISOString() });
    // With CLOCK_DATE the data clock starts at CHECKIN_TIME (09:00 EDT) on that day: due 2 minutes later.
    expect(nextFollowUp(db, "harriet")?.dueAt).toBe("2026-09-01T13:02:00.000Z");
  });

  it("with CLOCK_DATE, what the agent records lands on that day, even in a late-night session", async () => {
    const lateNight = new Date("2026-10-04T03:45:00Z"); // 23:45 on Oct 3 in Detroit
    const { db, start } = setup({ deps: { now: () => lateNight, followUpDelayMinutes: 2 } });
    linkedBeforeStart(db);
    const agent = await start();
    await agent.engine.handleInbound({ chatId: "chat_harriet", messageId: "in_1", text: "I have chest pain", at: lateNight.toISOString() });
    expect(nextFollowUp(db, "harriet")?.dueAt).toBe("2026-09-01T13:02:00.000Z");
  });

  it("FOLLOW_UP_DELAY_MINUTES: unset or blank uses the default, a positive number is used, anything else is refused", async () => {
    expect(parseFollowUpDelay(undefined)).toBeUndefined();
    expect(parseFollowUpDelay(" ")).toBeUndefined();
    expect(parseFollowUpDelay("2")).toBe(2);
    expect(parseFollowUpDelay("0.5")).toBe(0.5);
    for (const bad of ["0", "-3", "soon"]) expect(parseFollowUpDelay(bad)).toBeNull();
    const errors: string[] = [];
    const original = console.error;
    console.error = (line: string) => errors.push(line);
    try {
      expect(await agentMain([], { RELAY_AGENT_TOKEN: TOKEN, PATIENT_RELAY_HANDLE: "harriet", FOLLOW_UP_DELAY_MINUTES: "soon" })).toBe(1);
    } finally {
      console.error = original;
    }
    expect(errors).toEqual(['error: FOLLOW_UP_DELAY_MINUTES must be a positive number of minutes, got "soon"']);
  });
});

describe("agent main()", () => {
  it("exits 1 with a one-line message when RELAY_AGENT_TOKEN is missing", async () => {
    const errors: string[] = [];
    const original = console.error;
    console.error = (line: string) => errors.push(line);
    try {
      expect(await agentMain([], { PATIENT_RELAY_HANDLE: "harriet" })).toBe(1);
    } finally {
      console.error = original;
    }
    expect(errors).toEqual([`error: ${MISSING_TOKEN_MESSAGE}`]);
  });

  it("exits 2 on an unknown flag", async () => {
    const original = console.error;
    console.error = () => {};
    try {
      expect(await agentMain(["--nope"], {})).toBe(2);
    } finally {
      console.error = original;
    }
  });
});

// ---- relay:check ----

function page<T>(rows: T[]) {
  return Object.assign(
    (async function* () {
      yield* rows;
    })(),
    { data: rows },
  );
}

function fakeRelay(options: { webhooks?: number; chats?: { id: string; is_group: boolean; handles: string[] }[]; badToken?: boolean }): RelayClient {
  const chats = (options.chats ?? []).map((c) => ({ ...c, handles: c.handles.map((handle) => ({ kind: "user", handle })) }));
  return {
    chats: {
      listChats: async () => {
        if (options.badToken) throw new Error("401 Unauthorized");
        return page(chats);
      },
    },
    me: { retrieve: async () => ({ handle: "checkin-agent", owner: null, owner_people: [{ handle: "michael" }] }) },
    webhookSubscriptions: {
      list: async () => ({ subscriptions: Array.from({ length: options.webhooks ?? 0 }, (_, i) => ({ id: `wh_${i}`, target_url: "https://x" })) }),
    },
  } as unknown as RelayClient;
}

describe("relay:check", () => {
  it("is all green when the token works, no webhooks, and she and the family member have messaged the agent", async () => {
    const config = testConfig();
    const db = openDatabase(":memory:");
    dbs.push(db);
    upsertPatient(db, {
      id: "harriet",
      finchnodePatientId: SUBJECT,
      preferredName: "Harriet",
      relayHandle: "harriet",
      relayChatId: "c1",
    });
    const relay = fakeRelay({
      chats: [
        { id: "c1", is_group: false, handles: ["Harriet"] },
        { id: "c2", is_group: false, handles: ["sarah"] },
        // A group chat is not a family chat.
        { id: "g1", is_group: true, handles: ["tom"] },
      ],
    });
    const lines = await runRelayCheck({ config, relay, db });
    expect(lines.map(formatLine)).toEqual([
      "[ok]   Agent Token works: agent @checkin-agent, owned by @michael (https://api.relayapp.im)",
      "[ok]   No webhook subscriptions, so Relay delivers over the WebSocket",
      "[ok]   Senior @harriet is linked (chat c1)",
      "[ok]   Family @sarah is linked (chat c2)",
    ]);
  });

  it("one line per family member: linked, or not messaged the agent yet", async () => {
    const relay = fakeRelay({
      chats: [
        { id: "c2", is_group: false, handles: ["sarah"] },
        { id: "g1", is_group: true, handles: ["tom"] },
      ],
    });
    const lines = await runRelayCheck({ config: testConfig({ FAMILY_RELAY_HANDLES: "sarah,tom" }), relay, db: undefined });
    expect(lines.slice(3).map(formatLine)).toEqual([
      "[ok]   Family @sarah is linked (chat c2)",
      "[todo] Family @tom hasn't messaged the agent yet: send it any message from their phone",
    ]);
    expect(lines.map((l) => l.text).join("\n")).not.toMatch(/group/i);
  });

  it("flags webhooks and lists what is still to do", async () => {
    const lines = await runRelayCheck({ config: testConfig(), relay: fakeRelay({ webhooks: 1 }), db: undefined });
    expect(lines.map((l) => l.status)).toEqual(["ok", "fail", "todo", "todo"]);
    expect(lines[1]?.text).toContain("webhook subscription");
    expect(lines[2]?.text).toContain("has not written to the agent yet");
    expect(lines[3]?.text).toContain("Family @sarah hasn't messaged the agent yet");
  });

  it("stops after a token that doesn't work", async () => {
    const lines = await runRelayCheck({ config: testConfig(), relay: fakeRelay({ badToken: true }) });
    expect(lines).toHaveLength(1);
    expect(lines[0]?.status).toBe("fail");
    expect(lines[0]?.text).not.toContain(TOKEN);
  });

  it("without a token prints what's missing and exits 1", async () => {
    const out: string[] = [];
    expect(await relayCheckMain({}, (l) => out.push(l))).toBe(1);
    expect(out[0]).toBe("Relay check: .env is missing:");
    expect(out.join("\n")).toContain("RELAY_AGENT_TOKEN");
    expect(out.join("\n")).toContain("PATIENT_RELAY_HANDLE");
  });
});
