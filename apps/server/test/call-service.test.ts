import type { Call, CallWebhookEvent } from "@relaymessenger/sdk";
import type { RelayCallTransport } from "@relaymessenger/sdk/calls";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CallService } from "../src/calls/service.ts";
import { callTranscript, getCallSession } from "../src/db/calls.ts";
import { openDatabase, upsertPatient, type Db } from "../src/db/index.ts";
import { loadConfig } from "../src/config.ts";
import { loadSnapshot } from "../src/finchnode/fixtures.ts";
import { FakeLlmClient } from "../src/llm/fake.ts";
import type { CallTurnLlmOutput } from "../src/llm/types.ts";

const PATIENT = "harriet";
const DATE = "2026-10-04";
const NOW = `${DATE}T12:00:00.000Z`;

function relayCall(handle: string, id = "call-1"): Call {
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

class FakeTransport {
  readonly listeners = new Map<string, ((...args: any[]) => void)[]>();
  readonly writeAudio = vi.fn(async () => {});
  readonly clearAudio = vi.fn();
  readonly waitForPlayout = vi.fn(async () => {});
  readonly connect = vi.fn(async () => {});
  readonly close = vi.fn(() => this.emit("close"));
  readonly end = vi.fn(() => this.emit("ended"));

  on(event: string, listener: (...args: any[]) => void): this {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    return this;
  }

  emit(event: string, ...args: any[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }
}

class FakeStt {
  committed: ((text: string) => void | Promise<void>) | undefined;
  readonly connect = vi.fn(async () => {});
  readonly send = vi.fn();
  readonly close = vi.fn();
  onCommitted(handler: (text: string) => void | Promise<void>): this { this.committed = handler; return this; }
  onPartial(): this { return this; }
  emit(text: string): void { void this.committed?.(text); }
}

class FakeTts {
  readonly spoken: string[] = [];
  readonly speak = vi.fn(async (text: string) => { this.spoken.push(text); });
  readonly cancel = vi.fn();
  readonly close = vi.fn();
  isSpeaking = false;
}

let db: Db;
let transport: FakeTransport;
let stt: FakeStt;
let tts: FakeTts;
let llm: FakeLlmClient;
let relay: { calls: { end: ReturnType<typeof vi.fn> }; chats: { messages: { send: ReturnType<typeof vi.fn> } } };

function setup(options: { wallNow?: () => string; callTurn?: (input: Parameters<NonNullable<FakeLlmClient["callTurn"]>>[0]) => CallTurnLlmOutput | Error } = {}) {
  transport = new FakeTransport();
  stt = new FakeStt();
  tts = new FakeTts();
  relay = { calls: { end: vi.fn(async () => ({})) }, chats: { messages: { send: vi.fn(async () => ({})) } } };
  llm = new FakeLlmClient({ callTurn: options.callTurn });
  const service = new CallService({
    db,
    config: loadConfig({ ELEVENLABS_API_KEY: "test-key", ELEVENLABS_VOICE_ID: "voice-test", PATIENT_TIMEZONE: "America/Detroit" }),
    relay: relay as never,
    loadSnapshot: async (subject) => loadSnapshot(subject),
    llm,
    today: () => DATE,
    now: () => NOW,
    wallNow: options.wallNow ?? (() => NOW),
    transportFactory: () => transport as unknown as RelayCallTransport,
    sttFactory: () => stt as never,
    ttsFactory: () => tts as never,
  });
  return service;
}

async function start(service: CallService, call = relayCall("harriet")): Promise<void> {
  await service.handle(created(call));
  await vi.waitFor(() => expect(tts.spoken.length).toBeGreaterThan(0));
}

beforeEach(() => {
  db = openDatabase(":memory:");
  upsertPatient(db, { id: PATIENT, finchnodePatientId: "patient-demo-polypharmacy", preferredName: "Harriet", relayHandle: "harriet", relayChatId: "chat-harriet" });
});

describe("direct STT/Gemini/TTS Relay call", () => {
  it("answers the authorized call and starts with a clear, warm disclosure", async () => {
    const service = setup();
    await start(service);
    expect(transport.connect).toHaveBeenCalledOnce();
    expect(tts.spoken[0]).toMatch(/Hi Harriet, I'm an AI check-in assistant/i);
    expect(getCallSession(db, "call-1")?.status).toBe("in_progress");
    await service.end("call-1");
  });

  it("sends committed transcripts to Gemini and speaks its approved next turn", async () => {
    const service = setup({ callTurn: () => ({
      acknowledgment: "Thank you for explaining.",
      patientResponseText: "I appreciate you sharing that.",
      nextQuestion: "When did this begin?",
      nextAction: "ask_follow_up",
      informationCollected: ["The patient has discomfort"],
      missingInformation: ["onset"],
      evidence: [{ source: "transcript", detail: "Patient said they have discomfort." }],
      uncertainty: [],
    }) });
    await start(service);
    stt.emit("My chest has felt uncomfortable today.");
    await vi.waitFor(() => expect(llm.calls.some((call) => call.method === "callTurn")).toBe(true));
    await vi.waitFor(() => expect(tts.spoken.at(-1)).toContain("When did this begin?"));
    expect(callTranscript(db, "call-1").map((turn) => turn.speaker)).toContain("patient");
    const input = llm.calls.find((call) => call.method === "callTurn");
    expect(JSON.stringify(input)).not.toMatch(/base64|audio bytes|raw frame/i);
    await service.end("call-1");
  });

  it("uses fixed emergency wording immediately without calling Gemini", async () => {
    const service = setup();
    await start(service);
    stt.emit("I have chest pain right now");
    await vi.waitFor(() => expect(tts.spoken.at(-1)).toMatch(/call 911 right away/i));
    expect(llm.calls.some((call) => call.method === "callTurn")).toBe(false);
    expect(transport.end).toHaveBeenCalledOnce();
  });

  it("declines a caller who does not match the configured patient without reading their record", async () => {
    const service = setup();
    await service.handle(created(relayCall("stranger", "call-stranger")));
    await vi.waitFor(() => expect(relay.calls.end).toHaveBeenCalledWith("call-stranger"));
    expect(transport.connect).not.toHaveBeenCalled();
    expect(getCallSession(db, "call-stranger")).toBeUndefined();
  });

  it("fails cleanly when Relay connection would answer after its 32-second deadline", async () => {
    const service = setup({ wallNow: () => new Date(Date.parse(NOW) + 33_000).toISOString() });
    await service.handle(created(relayCall("harriet", "call-late")));
    await vi.waitFor(() => expect(getCallSession(db, "call-late")?.status).toBe("failed"));
    expect(getCallSession(db, "call-late")?.error).toMatch(/deadline exceeded/);
  });

  it("stores transcript text only and closes all media clients on interruption", async () => {
    const service = setup();
    await start(service);
    stt.emit("I feel a little dizzy");
    await vi.waitFor(() => expect(callTranscript(db, "call-1").some((turn) => turn.speaker === "patient")).toBe(true));
    await service.end("call-1");
    expect(stt.close).toHaveBeenCalledOnce();
    expect(tts.close).toHaveBeenCalledOnce();
    expect(transport.close).toHaveBeenCalledOnce();
    expect(db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND (name LIKE '%audio%' OR name LIKE '%video%')`).all()).toEqual([]);
  });
});
