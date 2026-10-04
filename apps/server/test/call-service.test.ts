import type { Call, CallWebhookEvent } from "@relaymessenger/sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { connect } = vi.hoisted(() => ({ connect: vi.fn() }));
vi.mock("@relaymessenger/elevenlabs", () => ({ ElevenLabsCall: { connect: (options: unknown) => connect(options) } }));

import { CallService } from "../src/calls/service.ts";
import { familyUrgentAlert } from "../src/checkin/copy.ts";
import { createCheckinEngine } from "../src/checkin/engine.ts";
import { createCallSession, getCallSession } from "../src/db/calls.ts";
import { linkFamilyMember, syncFamilyMembers } from "../src/db/family.ts";
import { openDatabase, upsertPatient, type Db } from "../src/db/index.ts";
import { observationsBetween } from "../src/db/observations.ts";
import { loadConfig } from "../src/config.ts";
import { loadRxNavCache, loadSnapshot } from "../src/finchnode/fixtures.ts";
import { FakeLlmClient } from "../src/llm/fake.ts";
import { FakeMessenger } from "../src/relay/fake-messenger.ts";

// The call service with ElevenLabs faked: synthetic data only, no network.

const P = "harriet";
const ME = "chat_harriet";
const SARAH = "chat_sarah";
const DAY = "2026-09-01";
const NOW = `${DAY}T09:00:00.000Z`;

function callFrom(handle: string, id = "call-1"): Call {
  return {
    id,
    chat_id: `chat-${handle}`,
    from: { id: `person-${handle}`, handle, kind: "user" },
    to: [{ id: "agent-1", handle: "agent", kind: "agent" }],
    status: "ringing",
    revision: 1,
    created_at: NOW,
    ringing_at: NOW,
    answered_at: null,
    ended_at: null,
  } as Call;
}

const created = (call: Call) => ({ event_type: "call.created", event_id: `event-${call.id}`, data: { call } }) as CallWebhookEvent;

type Connected = { options: { elevenlabs: { initiationData: Record<string, any> }; onEvent: (event: unknown) => void }; end: ReturnType<typeof vi.fn> };

function fakeBridge(): { bridge: object; finish: () => void; end: ReturnType<typeof vi.fn> } {
  let finish!: () => void;
  const closed = new Promise<void>((resolve) => (finish = resolve));
  const end = vi.fn(() => finish());
  return { bridge: { transport: {}, conversationId: "conv-1", closed, end, close: vi.fn(() => finish()) }, finish, end };
}

let db: Db;
let messenger: FakeMessenger;
let connected: Connected[];

function relayFake() {
  return {
    calls: { end: vi.fn(async () => ({})) },
    chats: { messages: { send: vi.fn(async () => ({ message: { id: "m1", created_at: NOW }, chat_id: "x" })) } },
  };
}

function setup(options: { loadSnapshot?: (subject: string) => Promise<any>; withEngine?: boolean } = {}) {
  const load = options.loadSnapshot ?? (async (s: string) => loadSnapshot(s));
  const llm = new FakeLlmClient({ extractCheckin: () => ({ answers: [], symptoms: [], memories: [] }), classifyMessage: () => ({ kind: "chat", confidence: "low", complaints: [], memories: [] }) });
  const engine = createCheckinEngine({ db, messenger, clock: { now: () => NOW }, loadSnapshot: load, llm }, { rxnav: loadRxNavCache() });
  const relay = relayFake();
  const config = loadConfig({ ELEVENLABS_API_KEY: "test", ELEVENLABS_AGENT_ID: "agent", PATIENT_TIMEZONE: "America/Detroit" });
  const service = new CallService({ db, config, relay: relay as never, loadSnapshot: load, ...(options.withEngine === false ? {} : { engine }), today: () => DAY, now: () => NOW });
  return { service, relay, engine, llm };
}

beforeEach(() => {
  vi.clearAllMocks();
  db = openDatabase(":memory:");
  upsertPatient(db, { id: P, finchnodePatientId: "patient-demo-polypharmacy", preferredName: "Harriet", relayHandle: "harriet", relayChatId: ME });
  syncFamilyMembers(db, P, ["sarah"]);
  linkFamilyMember(db, "sarah", SARAH, "Sarah", `${DAY}T08:00:00.000Z`);
  messenger = new FakeMessenger({ now: () => NOW });
  connected = [];
  connect.mockImplementation(async (options: Connected["options"]) => {
    const fake = fakeBridge();
    connected.push({ options, end: fake.end });
    return fake.bridge;
  });
});

const say = (c: Connected, text: string) => c.options.onEvent({ type: "user_transcript", user_transcript_event: { user_transcript: text } });

async function answered(service: CallService, call = callFrom("harriet")): Promise<Connected> {
  await service.handle(created(call));
  await vi.waitFor(() => expect(connected).toHaveLength(1));
  return connected[0]!;
}

describe("CallService", () => {
  it("answers with the AI disclosure first, today's questions and her family's names, nothing more from her record", async () => {
    const { service } = setup();
    const c = await answered(service);
    const data = c.options.elevenlabs.initiationData;
    expect(data.conversation_config_override.agent.first_message).toBe("Hi Harriet, I'm an AI check-in assistant. This will take about three minutes. How are you feeling today?");
    expect(data.dynamic_variables.todays_questions).toMatch(/dizzy/i);
    expect(data.dynamic_variables.closing_line).toMatch(/Sarah/);
    expect(JSON.stringify(data)).not.toMatch(/apixaban|metformin|creatinine|fibrillation/i);
    await service.end("call-1");
  });

  it("screens each spoken turn as it arrives: an emergency alerts every family chat at once", async () => {
    const { service } = setup();
    const c = await answered(service);
    say(c, "I have chest pain right now");
    await vi.waitFor(() => expect(messenger.inChat(SARAH).map((m) => m.text)).toContain(familyUrgentAlert({ seniorName: "Harriet", sharing: "status", words: "I have chest pain right now" })));
    expect(observationsBetween(db, P, DAY, DAY).map((o) => [o.topic, o.level])).toContainEqual(["urgent_symptom", 4]);
    await service.end("call-1");
    // Once per turn: the end of the call doesn't alert again.
    expect(messenger.inChat(SARAH)).toHaveLength(1);
  });

  it("never answers from a stale screening: a later chest pain turn is read on the next tool call", async () => {
    const { service } = setup();
    const c = await answered(service);
    say(c, "I'm doing fine today, thanks");
    const first = await service.screen("call-1");
    expect(first.level).toBe(0);
    expect(first.patientResponseText).not.toMatch(/911/);
    say(c, "actually I have chest pain");
    const second = await service.screen("call-1");
    expect(second.level).toBe(4);
    expect(second.patientResponseText).toMatch(/call 911 right away/);
    expect(second.patientResponseText).toMatch(/Sarah/);
    await service.end("call-1");
  });

  it("anyone but her gets a short polite decline: no call answered, nothing read from her record", async () => {
    const load = vi.fn(async (s: string) => loadSnapshot(s));
    const { service, relay, llm } = setup({ loadSnapshot: load });
    await service.handle(created(callFrom("stranger", "call-x")));
    await vi.waitFor(() => expect(relay.calls.end).toHaveBeenCalledWith("call-x"));
    expect(relay.chats.messages.send).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(relay.chats.messages.send.mock.calls[0])).toMatch(/only take check-in calls/);
    expect(JSON.stringify(relay.chats.messages.send.mock.calls[0])).not.toMatch(/Harriet/);
    expect(connect).not.toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();
    expect(llm.calls).toEqual([]);
    expect(getCallSession(db, "call-x")).toBeUndefined();
  });

  it("records an ElevenLabs connection failure without blocking the inbox caller", async () => {
    connect.mockImplementationOnce(async () => {
      throw new Error("ElevenLabs websocket unavailable");
    });
    const { service } = setup();
    const started = Date.now();
    await service.handle(created(callFrom("harriet", "call-fail")));
    expect(Date.now() - started).toBeLessThan(1000);
    await vi.waitFor(() => expect(getCallSession(db, "call-fail")?.error).toMatch(/ElevenLabs websocket unavailable/));
    await vi.waitFor(() => expect(getCallSession(db, "call-fail")?.endedAt).not.toBeNull());
    expect(getCallSession(db, "call-fail")?.status).toBe("failed");
  });

  it("marks an already-ended call complete without media persistence", async () => {
    createCallSession(db, { callId: "call-ended", patientId: P, relayChatId: ME, at: NOW });
    const { service } = setup();
    await service.end("call-ended");
    expect(getCallSession(db, "call-ended")?.status).toBe("ended");
    expect(db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND (name LIKE '%audio%' OR name LIKE '%video%')`).all()).toEqual([]);
  });
});
