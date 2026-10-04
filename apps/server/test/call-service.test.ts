import type { Call, CallWebhookEvent } from "@relaymessenger/sdk";
import type { RelayCallTransport } from "@relaymessenger/sdk/calls";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ElevenLabsRealtimeStt, ElevenLabsTts } from "../src/calls/audio.ts";
import { CAMERA_CALLBACK_OFFER, CAMERA_CALLBACK_SOON, CAMERA_GUIDANCE, CAMERA_OFFER_AT_END, CAMERA_STILL_OFF, callClosing, cantHearYou } from "../src/calls/copy.ts";
import { emptyCallVitals } from "../src/calls/screening.ts";
import { CallService, type CallEngine, type CallServiceOptions } from "../src/calls/service.ts";
import { createCheckinEngine } from "../src/checkin/engine.ts";
import { crisisReply, urgentReply } from "../src/checkin/copy.ts";
import { callTranscript, getCallSession } from "../src/db/calls.ts";
import { getCheckinPatient } from "../src/db/checkins.ts";
import { linkFamilyMember, syncFamilyMembers } from "../src/db/family.ts";
import { openDatabase, upsertPatient, type Db } from "../src/db/index.ts";
import { loadConfig } from "../src/config.ts";
import { loadRxNavCache, loadSnapshot } from "../src/finchnode/fixtures.ts";
import { FakeLlmClient } from "../src/llm/fake.ts";
import type { CallTurnLlmInput, CallTurnLlmOutput } from "../src/llm/types.ts";
import { FakeMessenger } from "../src/relay/fake-messenger.ts";

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
  readonly writeAudio = vi.fn(async (_frame: { samples: Int16Array; sampleRate: number; channelCount: number }) => {});
  readonly clearAudio = vi.fn();
  readonly waitForPlayout = vi.fn(async () => {});
  readonly waitForPeerAudio = vi.fn(async (_timeoutMs: number) => {});
  /** Her video track once it has reached the call; the tests set it, or emit the events. */
  remoteVideoTrack: object | undefined = undefined;
  /** Her video's counters as the SDK's videoStats() reports them. Fakes that say nothing leave it unset. */
  videoStats: (() => unknown) | undefined = undefined;
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

/** The Presage bridge as the service uses it, without a real session. */
class FakeBridge {
  readonly quiet = { interrupt: vi.fn(), status: "waiting_for_permission", durationMs: 30_000, remainingMs: () => 0 };
  readonly start = vi.fn();
  readonly stop = vi.fn(async () => emptyCallVitals());
  readonly result = vi.fn(() => emptyCallVitals());
  readonly beginQuietMeasurement = vi.fn();
  readonly measuring = vi.fn(() => this.quiet.status !== "interrupted");
}

class FakeStt {
  committed: ((text: string) => void | Promise<void>) | undefined;
  partial: ((text: string) => void | Promise<void>) | undefined;
  closed: ((reason: string) => void) | undefined;
  readonly connect = vi.fn(async () => {});
  readonly send = vi.fn();
  readonly close = vi.fn();
  onCommitted(handler: (text: string) => void | Promise<void>): this { this.committed = handler; return this; }
  onPartial(handler: (text: string) => void | Promise<void>): this { this.partial = handler; return this; }
  onClose(handler: (reason: string) => void): this { this.closed = handler; return this; }
  emit(text: string): void { void this.committed?.(text); }
  emitPartial(text: string): void { void this.partial?.(text); }
  /** Her session ended on its own (not through close()): what the real adapter reports to onClose. */
  emitClose(reason = "closed"): void { this.closed?.(reason); }
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
let bridge: FakeBridge;
let llm: FakeLlmClient;
/** What the service handed the voice and the transcriber when the last call was answered. */
let ttsOptions: ConstructorParameters<typeof ElevenLabsTts>[1] | undefined;
let sttOptions: ConstructorParameters<typeof ElevenLabsRealtimeStt>[0] | undefined;
/** The transcribers the service gets, in order: `stt` first, then whatever a test queues for a reconnect. */
let sttsToHandOut: (FakeStt | Error)[];
let sttsHandedOut: FakeStt[];
let logs: { event: string; [field: string]: unknown }[];
let relay: { calls: { end: ReturnType<typeof vi.fn> }; chats: { messages: { send: ReturnType<typeof vi.fn> } } };

function setup(options: { wallNow?: () => string; callTurn?: (input: Parameters<NonNullable<FakeLlmClient["callTurn"]>>[0]) => CallTurnLlmOutput | Error; env?: Record<string, string>; engine?: CallEngine; cameraCallBack?: CallServiceOptions["cameraCallBack"] } = {}) {
  transport = new FakeTransport();
  stt = new FakeStt();
  sttsToHandOut = [stt];
  sttsHandedOut = [];
  logs = [];
  tts = new FakeTts();
  bridge = new FakeBridge();
  relay = { calls: { end: vi.fn(async () => ({})) }, chats: { messages: { send: vi.fn(async () => ({})) } } };
  llm = new FakeLlmClient({ callTurn: options.callTurn });
  const service = new CallService({
    db,
    config: loadConfig({ ELEVENLABS_API_KEY: "test-key", ELEVENLABS_VOICE_ID: "voice-test", PATIENT_TIMEZONE: "America/Detroit", ...options.env }),
    relay: relay as never,
    loadSnapshot: async (subject) => loadSnapshot(subject),
    llm,
    ...(options.engine ? { engine: options.engine } : {}),
    ...(options.cameraCallBack ? { cameraCallBack: options.cameraCallBack } : {}),
    today: () => DATE,
    now: () => NOW,
    wallNow: options.wallNow ?? (() => NOW),
    transportFactory: () => transport as unknown as RelayCallTransport,
    sttFactory: (options) => {
      sttOptions = options;
      const next = sttsToHandOut.shift() ?? new FakeStt();
      if (next instanceof Error) throw next; // a factory that fails
      sttsHandedOut.push(next);
      return next as never;
    },
    log: (event, fields) => { logs.push({ event, ...fields }); },
    ttsFactory: (_transport, options) => ((ttsOptions = options), tts as never),
    bridgeFactory: () => bridge as never,
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

const modelPlan = (overrides: Partial<CallTurnLlmOutput> = {}): CallTurnLlmOutput => ({
  acknowledgment: "Thank you for telling me.",
  patientResponseText: "I appreciate you sharing that.",
  nextQuestion: null,
  nextAction: "complete_screening",
  informationCollected: [],
  missingInformation: [],
  evidence: [],
  uncertainty: [],
  ...overrides,
});

describe("her transcription is lost under a live call", () => {
  const events = () => logs.map((entry) => entry.event);

  it("reconnects once with the same settings and handlers, and the call carries on", async () => {
    const service = setup({ callTurn: () => modelPlan({ nextAction: "ask_follow_up", nextQuestion: "When did the swelling start?" }) });
    const second = new FakeStt();
    sttsToHandOut.push(second);
    await start(service);
    stt.emitClose("closed"); // the first session ended on its own
    await vi.waitFor(() => expect(events()).toContain("call_stt_reconnected"));
    expect(sttsHandedOut).toEqual([stt, second]);
    expect(second.connect).toHaveBeenCalledOnce();
    expect(stt.close).toHaveBeenCalled(); // the lost one is let go
    transport.emit("audio", { samples: Int16Array.from([100, 300]), sampleRate: 48_000, channelCount: 1 });
    expect(second.send).toHaveBeenCalledOnce(); // her audio goes to the new session
    expect(stt.send).not.toHaveBeenCalled();
    second.emit("My ankles are a bit swollen."); // and what it hears is handled as before
    await vi.waitFor(() => expect(tts.spoken.at(-1)).toContain("When did the swelling start?"));
    expect(transport.end).not.toHaveBeenCalled();
    await service.end("call-1");
    expect(second.close).toHaveBeenCalled();
  });

  it("says one fixed sentence and ends the call when it cannot reconnect", async () => {
    const service = setup();
    const second = new FakeStt();
    second.connect.mockRejectedValueOnce(new Error("ElevenLabs STT connection timed out"));
    sttsToHandOut.push(second);
    await start(service);
    stt.emitClose("quota_exceeded");
    await vi.waitFor(() => expect(transport.end).toHaveBeenCalledOnce());
    expect(tts.spoken.at(-1)).toBe(cantHearYou("Harriet", []));
    expect(events()).toContain("call_stt_lost");
    expect(events()).not.toContain("call_stt_reconnected");
    expect(logs.find((entry) => entry.event === "call_stt_lost")).toMatchObject({ reason: "quota_exceeded" });
    expect(second.close).toHaveBeenCalled(); // the session that never came up is cleaned up
    expect(callTranscript(db, "call-1").at(-1)).toMatchObject({ speaker: "agent", text: cantHearYou("Harriet", []) });
  });

  it("a transcriber that cannot even be created counts as a failed reconnect, and nothing is left unhandled", async () => {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);
    process.on("unhandledRejection", onRejection);
    try {
      const service = setup();
      sttsToHandOut.push(new Error("the factory failed"));
      await start(service);
      stt.emitClose();
      await vi.waitFor(() => expect(transport.end).toHaveBeenCalledOnce());
      expect(tts.spoken.at(-1)).toBe(cantHearYou("Harriet", []));
      expect(logs.find((entry) => entry.event === "call_stt_lost")).toMatchObject({ error: "Error: the factory failed" });
      await new Promise((resolve) => setImmediate(resolve));
      expect(rejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", onRejection);
    }
  });

  it("reconnects only once per call: a second loss says the sentence and ends it", async () => {
    const service = setup();
    const second = new FakeStt();
    sttsToHandOut.push(second);
    await start(service);
    stt.emitClose();
    await vi.waitFor(() => expect(events()).toContain("call_stt_reconnected"));
    second.emitClose("session_time_limit_exceeded");
    await vi.waitFor(() => expect(transport.end).toHaveBeenCalledOnce());
    expect(tts.spoken.at(-1)).toBe(cantHearYou("Harriet", []));
    expect(sttsHandedOut).toHaveLength(2); // no third attempt
  });

  it("an emergency heard while the reconnect is pending: its reply is the last word, and 'I can't hear you' is never said", async () => {
    const service = setup();
    const second = new FakeStt();
    let failReconnect!: (error: Error) => void;
    second.connect.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { failReconnect = reject; }));
    sttsToHandOut.push(second);
    await start(service);
    let finishEmergencyReply!: () => void;
    tts.speak.mockImplementationOnce(async (text: string) => {
      tts.spoken.push(text);
      await new Promise<void>((resolve) => { finishEmergencyReply = resolve; }); // the reply takes a while to play, as it does
    });
    stt.emitClose("closed"); // the reconnect starts and stays pending
    await vi.waitFor(() => expect(sttsHandedOut).toHaveLength(2));
    stt.emit("I have chest pain right now"); // the lost session still delivers her last words
    await vi.waitFor(() => expect(tts.spoken.at(-1)).toBe(urgentReply("Harriet", [])));
    failReconnect(new Error("ElevenLabs STT connection timed out")); // and the reconnect fails while that reply is playing
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(tts.spoken).not.toContain(cantHearYou("Harriet", []));
    expect(tts.spoken.at(-1)).toBe(urgentReply("Harriet", []));
    expect(events()).not.toContain("call_stt_lost");
    expect(transport.end).not.toHaveBeenCalled(); // the reply is still being said
    finishEmergencyReply();
    await vi.waitFor(() => expect(transport.end).toHaveBeenCalledOnce()); // the emergency path ends the call after its reply
  });

  it("an emergency heard while 'I can't hear you' is being said: the call is not ended under the emergency reply", async () => {
    const service = setup();
    const second = new FakeStt();
    second.connect.mockRejectedValueOnce(new Error("ElevenLabs STT connection timed out"));
    sttsToHandOut.push(second);
    await start(service);
    let endSentence!: () => void;
    tts.speak.mockImplementationOnce(async (text: string) => {
      tts.spoken.push(text);
      await new Promise<void>((resolve) => { endSentence = resolve; }); // the sentence takes a while
    });
    tts.cancel.mockImplementation(() => endSentence?.()); // cancel() stops it, as the real voice does
    stt.emitClose("closed");
    await vi.waitFor(() => expect(tts.spoken.at(-1)).toBe(cantHearYou("Harriet", [])));
    second.emit("I have chest pain right now"); // she says it while the sentence plays
    await vi.waitFor(() => expect(tts.spoken.at(-1)).toBe(urgentReply("Harriet", [])));
    await new Promise((resolve) => setImmediate(resolve));
    expect(transport.end).toHaveBeenCalledOnce(); // by the emergency path, after its reply: not also by the lost-session path
  });

  it("does nothing once the call is over, or after an emergency reply, which ends the call itself", async () => {
    const over = setup();
    await start(over);
    await over.end("call-1");
    stt.emitClose();
    await new Promise((resolve) => setImmediate(resolve));
    expect(sttsHandedOut).toEqual([stt]);
    expect(events()).not.toContain("call_stt_lost");

    const emergency = setup();
    await start(emergency, relayCall("harriet", "call-2"));
    const speakCalls = tts.speak.mock.calls.length;
    stt.emit("I have chest pain right now");
    await vi.waitFor(() => expect(tts.spoken.at(-1)).toBe(urgentReply("Harriet", [])));
    stt.emitClose();
    await new Promise((resolve) => setImmediate(resolve));
    expect(sttsHandedOut).toEqual([stt]);
    expect(tts.speak.mock.calls.length).toBe(speakCalls + 1); // only the emergency reply
  });
});

describe("her talking over the assistant", () => {
  /** The next thing the assistant says takes a few seconds to play, as real speech does. */
  const playsForAWhile = () => {
    let end!: () => void;
    tts.speak.mockImplementationOnce(async (text) => {
      tts.spoken.push(text);
      tts.isSpeaking = true;
      await new Promise<void>((resolve) => { end = resolve; });
      tts.isSpeaking = false;
    });
    return () => end();
  };
  const settle = () => new Promise((resolve) => setImmediate(resolve));

  it("cannot cut off the greeting; after it a cough or one word does not either, two real words do", async () => {
    const service = setup();
    const endGreeting = playsForAWhile();
    await service.handle(created(relayCall("harriet")));
    await vi.waitFor(() => expect(tts.spoken).toHaveLength(1));
    stt.emitPartial("Hello, can you hear me");
    expect(tts.cancel).not.toHaveBeenCalled(); // the AI disclosure plays to the end
    endGreeting();
    await settle();
    tts.isSpeaking = true; // the assistant is speaking again
    for (const partial of ["(coughs)", "Hello?", "(coughs) hello", "[noise]", ""]) stt.emitPartial(partial);
    expect(tts.cancel).not.toHaveBeenCalled();
    stt.emitPartial("wait a moment");
    expect(tts.cancel).toHaveBeenCalledOnce();
    await service.end("call-1");
  });

  it("does nothing while the assistant is silent", async () => {
    const service = setup();
    await start(service);
    await settle();
    stt.emitPartial("wait a moment please");
    expect(tts.cancel).not.toHaveBeenCalled();
    await service.end("call-1");
  });

  it("cannot cut off a fixed safety reply either", async () => {
    const service = setup();
    await start(service);
    await settle();
    const endReply = playsForAWhile();
    stt.emit("I have chest pain right now");
    await vi.waitFor(() => expect(tts.spoken.at(-1)).toBe(urgentReply("Harriet", [])));
    tts.cancel.mockClear(); // the service itself stops what was playing before the reply
    stt.emitPartial("yes it hurts a lot and my arm too");
    expect(tts.cancel).not.toHaveBeenCalled();
    endReply();
    await vi.waitFor(() => expect(transport.end).toHaveBeenCalledOnce());
  });
});

describe("a reply Gemini is still planning when she keeps talking", () => {
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  /** Gemini's planning is held until the test releases each call. */
  const slowGemini = () => {
    const inputs: CallTurnLlmInput[] = [];
    const releases: ((output: CallTurnLlmOutput) => void)[] = [];
    llm.callTurn = (input) => new Promise<CallTurnLlmOutput>((resolve) => { inputs.push(input); releases.push(resolve); });
    return { inputs, releases };
  };
  const asks = (question: string) => modelPlan({ nextAction: "ask_follow_up", nextQuestion: question });

  it("is dropped when she says more, and her next turn answers everything she said", async () => {
    const service = setup();
    await start(service);
    const { inputs, releases } = slowGemini();
    stt.emit("My ankles are a bit swollen.");
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    stt.emitPartial("and I have also been"); // two real words: she is talking again
    releases[0]!(asks("When did the swelling start?"));
    await settle();
    expect(tts.spoken).toHaveLength(1); // only the greeting
    stt.emit("and I have also been very tired.");
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    releases[1]!(asks("How long have you felt tired?"));
    await vi.waitFor(() => expect(tts.spoken.at(-1)).toContain("How long have you felt tired?"));
    expect(inputs[1]!.transcript.filter((turn) => turn.speaker === "patient").map((turn) => turn.text)).toEqual(["My ankles are a bit swollen.", "and I have also been very tired."]);
    expect(tts.spoken.join(" ")).not.toContain("swelling start");
    await service.end("call-1");
  });

  it("is still spoken when all she made was noise, a cough or a lone word", async () => {
    const service = setup();
    await start(service);
    const { releases } = slowGemini();
    stt.emit("My ankles are a bit swollen.");
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    for (const noise of ["(coughs)", "hm", "[noise]", "(laughs softly"]) stt.emitPartial(noise);
    releases[0]!(asks("When did the swelling start?"));
    await vi.waitFor(() => expect(tts.spoken.at(-1)).toContain("When did the swelling start?"));
    await service.end("call-1");
  });
});

describe("her audio goes to the transcriber", () => {
  it("at Relay's own 48 kHz, only downmixed to mono", async () => {
    const service = setup();
    await start(service);
    transport.emit("audio", { samples: Int16Array.from([100, 300, -100, 100]), sampleRate: 48_000, channelCount: 2 });
    expect([...stt.send.mock.calls[0]![0]]).toEqual([200, 0]);
    await service.end("call-1");
  });
});

describe("the camera reading is offered only while her video is on, and without it she is told how to turn it on", () => {
  const withCamera = { PRESAGE_API_KEY: "presage-test-key" }; // a bridge exists, as on the demo machine
  const endsTheCall = () => modelPlan();
  const turn = "My ankles are a bit swollen.";

  it("an audio-only call is not offered the reading but told how to turn her camera on, and may say no", async () => {
    const service = setup({ callTurn: endsTheCall, env: withCamera });
    await start(service);
    stt.emit(turn);
    await vi.waitFor(() => expect(tts.spoken.at(-1)).toBe(CAMERA_GUIDANCE));
    expect(tts.spoken).not.toContain(CAMERA_OFFER_AT_END);
    expect(transport.end).not.toHaveBeenCalled(); // the call waits for her answer
    stt.emit("No thanks.");
    await vi.waitFor(() => expect(transport.end).toHaveBeenCalledOnce());
    expect(tts.spoken.at(-1)).toBe(callClosing("Harriet", []));
    expect(bridge.beginQuietMeasurement).not.toHaveBeenCalled();
  });

  it("she turns her camera on after the guidance and says ready: the quiet reading starts", async () => {
    const service = setup({ callTurn: endsTheCall, env: withCamera });
    await start(service);
    stt.emit(turn);
    await vi.waitFor(() => expect(tts.spoken.at(-1)).toBe(CAMERA_GUIDANCE));
    transport.emit("remoteVideo", true);
    stt.emit("Ready.");
    await vi.waitFor(() => expect(bridge.beginQuietMeasurement).toHaveBeenCalledOnce());
    expect(tts.spoken.at(-1)).toMatch(/face and upper chest/i);
    await service.end("call-1");
  });

  it("she says ready but her camera is still off: she is told once more, then the call goes on without the reading", async () => {
    const service = setup({ callTurn: endsTheCall, env: withCamera });
    await start(service);
    stt.emit(turn);
    await vi.waitFor(() => expect(tts.spoken.at(-1)).toBe(CAMERA_GUIDANCE));
    stt.emit("Ready.");
    await vi.waitFor(() => expect(tts.spoken.at(-1)).toBe(CAMERA_STILL_OFF));
    stt.emit("Ready now.");
    await vi.waitFor(() => expect(transport.end).toHaveBeenCalledOnce());
    expect(tts.spoken.at(-1)).toBe(callClosing("Harriet", []));
    expect(bridge.beginQuietMeasurement).not.toHaveBeenCalled();
  });

  it("she hangs up as the call is being ended: ending a room that is gone is logged, not thrown", async () => {
    const service = setup({ callTurn: endsTheCall });
    transport.end.mockImplementation(() => { throw new Error("Relay Call room is not connected."); });
    await start(service);
    stt.emit(turn);
    await vi.waitFor(() => expect(transport.end).toHaveBeenCalledOnce());
    expect(logs.find((entry) => entry.event === "call_end_failed")).toMatchObject({ error: "Error: Relay Call room is not connected." });
    expect(logs.some((entry) => entry.event === "call_turn_failed")).toBe(false);
    await service.end("call-1");
  });

  it("a call without Presage is never offered it, video or not", async () => {
    const service = setup({ callTurn: endsTheCall });
    await start(service);
    transport.emit("remoteVideo", true);
    stt.emit(turn);
    await vi.waitFor(() => expect(transport.end).toHaveBeenCalledOnce());
    expect(tts.spoken).not.toContain(CAMERA_OFFER_AT_END);
  });

  it.each([
    ["her video track is there when the call starts", () => { transport.remoteVideoTrack = {}; }, () => {}],
    ["her video track arrives", () => {}, () => transport.emit("trackSubscribed", {})],
    ["her camera is turned on", () => {}, () => transport.emit("remoteVideo", true)],
  ])("with her video on (%s) she is offered it before the goodbye", async (_how, before, after) => {
    const service = setup({ callTurn: endsTheCall, env: withCamera });
    before();
    await start(service);
    after();
    stt.emit(turn);
    await vi.waitFor(() => expect(tts.spoken.at(-1)).toBe(CAMERA_OFFER_AT_END));
    expect(transport.end).not.toHaveBeenCalled();
  });

  it.each([
    ["turns her camera off", () => transport.emit("remoteVideo", false)],
    ["loses her video track", () => transport.emit("trackUnsubscribed", {})],
  ])("a call where she %s before the goodbye gets the guidance, not the offer", async (_how, cameraOff) => {
    let turns = 0;
    const service = setup({ callTurn: () => (turns += 1) === 1 ? modelPlan({ nextAction: "ask_follow_up", nextQuestion: "When did the swelling start?" }) : modelPlan(), env: withCamera });
    await start(service);
    transport.emit("remoteVideo", true);
    stt.emit(turn);
    await vi.waitFor(() => expect(tts.spoken.at(-1)).toContain("When did the swelling start?"));
    cameraOff();
    stt.emit("Since Monday.");
    await vi.waitFor(() => expect(tts.spoken.at(-1)).toBe(CAMERA_GUIDANCE));
    expect(tts.spoken).not.toContain(CAMERA_OFFER_AT_END);
  });
});

describe("her video is logged, so a call with no camera offer can be explained", () => {
  const withCamera = { PRESAGE_API_KEY: "presage-test-key" };
  const videoLogs = () => logs.filter((entry) => entry.event.startsWith("call_video_") || entry.event === "call_camera_offer_skipped");
  const skipped = () => logs.filter((entry) => entry.event === "call_camera_offer_skipped");
  const endsTheCall = () => modelPlan();
  afterEach(() => vi.useRealTimers());

  it.each([
    ["trackSubscribed", [true, "trackSubscribed"], () => transport.emit("trackSubscribed", {})],
    ["remoteVideo", [true, "remoteVideo"], () => transport.emit("remoteVideo", true)],
  ] as const)("logs her video turning on, with the event that said so (%s)", async (_event, [on, source], emitIt) => {
    const service = setup();
    await start(service);
    emitIt();
    expect(videoLogs()).toEqual([{ event: "call_video_changed", call_id: "call-1", on, source }]);
    await service.end("call-1");
  });

  it.each([
    ["remoteVideo", () => transport.emit("remoteVideo", false)],
    ["trackUnsubscribed", () => transport.emit("trackUnsubscribed", {})],
  ])("logs her video turning off, with the event that said so (%s)", async (source, emitIt) => {
    const service = setup();
    transport.remoteVideoTrack = {};
    await start(service);
    emitIt();
    expect(videoLogs()).toEqual([{ event: "call_video_changed", call_id: "call-1", on: false, source }]);
    await service.end("call-1");
  });

  it("logs only a change: an event that repeats what is already so says nothing", async () => {
    const service = setup();
    await start(service);
    transport.emit("remoteVideo", false); // off already
    transport.emit("trackUnsubscribed", {});
    transport.emit("remoteVideo", true);
    transport.emit("trackSubscribed", {}); // on already
    transport.emit("remoteVideo", true);
    expect(videoLogs().map((entry) => [entry.on, entry.source])).toEqual([[true, "remoteVideo"]]);
    transport.emit("remoteVideo", false);
    expect(videoLogs().map((entry) => [entry.on, entry.source])).toEqual([[true, "remoteVideo"], [false, "remoteVideo"]]);
    await service.end("call-1");
  });

  describe("the state line, 5 seconds after the call is answered", () => {
    const counters = { codec: "vp8", rtpPackets: 410, framesAssembled: 90, framesDecoded: 88, decodeErrors: 0, firstFrameAt: 1_790_000_000_000, lastFrameAt: 1_790_000_004_000, width: 640, height: 480 };
    const stateLines = () => logs.filter((entry) => entry.event === "call_video_state");
    /** `prepare` sets up the fake transport (setup() makes a new one) before the call is answered. */
    const startWithFakeTimers = async (options: Parameters<typeof setup>[0] = {}, prepare: () => void = () => {}) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const service = setup(options);
      prepare();
      await start(service);
      return service;
    };

    it("says once whether her video is on, whether a track reached the agent, whether Presage is set up, and the receive counters", async () => {
      const service = await startWithFakeTimers({ env: withCamera }, () => {
        transport.remoteVideoTrack = {};
        transport.videoStats = () => ({ outbound: undefined, inbound: counters });
      });
      await vi.advanceTimersByTimeAsync(4_000);
      expect(stateLines()).toEqual([]);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(stateLines()).toEqual([{ event: "call_video_state", call_id: "call-1", on: true, has_track: true, camera_configured: true, stats: { inbound: counters } }]);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(stateLines()).toHaveLength(1);
      await service.end("call-1");
    });

    it("reports a call with no camera as it is: off, no track, and no counters when the transport has none to give", async () => {
      const service = await startWithFakeTimers();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(stateLines()).toEqual([{ event: "call_video_state", call_id: "call-1", on: false, has_track: false, camera_configured: false }]);
      await service.end("call-1");
    });

    it("reads her video as it is at that moment, from the events, apart from whether a track is there", async () => {
      const service = await startWithFakeTimers({ env: withCamera }, () => { transport.remoteVideoTrack = {}; });
      transport.emit("remoteVideo", false); // her camera went off; the track object is still there
      await vi.advanceTimersByTimeAsync(5_000);
      expect(stateLines()).toMatchObject([{ on: false, has_track: true }]);
      await service.end("call-1");
    });

    it.each([
      ["a transport that throws", () => { throw new Error("transport closed"); }],
      ["one that returns nothing usable", () => null],
    ])("still logs when the counters cannot be read: %s", async (_how, videoStats) => {
      const service = await startWithFakeTimers({}, () => { transport.videoStats = videoStats; });
      await vi.advanceTimersByTimeAsync(5_000);
      expect(stateLines()).toEqual([{ event: "call_video_state", call_id: "call-1", on: false, has_track: false, camera_configured: false }]);
      await service.end("call-1");
    });

    it("keeps only finite numbers and short strings, in the two directions, and never a frame", async () => {
      const frame = new Uint8Array([1, 2, 3, 4]);
      const service = await startWithFakeTimers({}, () => {
        transport.videoStats = () => ({
          inbound: { ...counters, bytes: Number.POSITIVE_INFINITY, lost: Number.NaN, rawFrame: frame, nested: { frames: 3 }, note: "x".repeat(200), none: undefined, flag: true },
          outbound: undefined,
          frames: [frame],
        });
      });
      await vi.advanceTimersByTimeAsync(5_000);
      expect(stateLines()).toEqual([{ event: "call_video_state", call_id: "call-1", on: false, has_track: false, camera_configured: false, stats: { inbound: counters } }]);
      await service.end("call-1");
    });

    it.each([
      ["she hangs up", (service: CallService) => service.end("call-1")],
      ["Relay says the call ended", () => transport.emit("ended")],
    ])("says nothing when the call is over first (%s)", async (_how, endIt) => {
      const service = await startWithFakeTimers();
      await endIt(service);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(stateLines()).toEqual([]);
      await service.end("call-1");
    });

    it("never keeps the process alive", async () => {
      const timers = vi.spyOn(globalThis, "setTimeout");
      try {
        const service = setup();
        await start(service);
        const index = timers.mock.calls.findIndex(([, delay]) => delay === 5_000);
        expect(index).toBeGreaterThanOrEqual(0);
        expect((timers.mock.results[index]!.value as NodeJS.Timeout).hasRef()).toBe(false);
        await service.end("call-1");
      } finally {
        timers.mockRestore();
      }
    });
  });

  describe("the camera offer that was not made", () => {
    const turn = "My ankles are a bit swollen.";

    it("Presage is set up but her video is off: one line says why, she is told how to turn the camera on, and a no gets the goodbye", async () => {
      const service = setup({ callTurn: endsTheCall, env: withCamera });
      await start(service);
      stt.emit(turn);
      await vi.waitFor(() => expect(tts.spoken.at(-1)).toBe(CAMERA_GUIDANCE));
      expect(skipped()).toEqual([{ event: "call_camera_offer_skipped", call_id: "call-1", reason: "no_video" }]);
      expect(tts.spoken).not.toContain(CAMERA_OFFER_AT_END);
      stt.emit("No thanks.");
      await vi.waitFor(() => expect(transport.end).toHaveBeenCalledOnce());
      expect(tts.spoken.at(-1)).toBe(callClosing("Harriet", []));
      expect(skipped()).toHaveLength(1);
    });

    it("her camera turned off before the goodbye counts the same", async () => {
      let turns = 0;
      const service = setup({ callTurn: () => (turns += 1) === 1 ? modelPlan({ nextAction: "ask_follow_up", nextQuestion: "When did the swelling start?" }) : modelPlan(), env: withCamera });
      await start(service);
      transport.emit("remoteVideo", true);
      stt.emit(turn);
      await vi.waitFor(() => expect(tts.spoken.at(-1)).toContain("When did the swelling start?"));
      expect(skipped()).toEqual([]); // not yet: nothing has been skipped
      transport.emit("remoteVideo", false);
      stt.emit("Since Monday.");
      await vi.waitFor(() => expect(tts.spoken.at(-1)).toBe(CAMERA_GUIDANCE));
      expect(skipped()).toEqual([{ event: "call_camera_offer_skipped", call_id: "call-1", reason: "no_video" }]);
      stt.emit("No thanks.");
      await vi.waitFor(() => expect(transport.end).toHaveBeenCalledOnce());
    });

    it("once per call, even when the goodbye could not be spoken and the call carried on to a second one", async () => {
      const service = setup({ callTurn: endsTheCall, env: withCamera });
      await start(service);
      tts.speak.mockRejectedValueOnce(new Error("ElevenLabs TTS returned HTTP 500")); // the camera guidance, which comes first with her video off
      stt.emit(turn);
      await vi.waitFor(() => expect(tts.spoken.at(-1)).toMatch(/did not catch that/i));
      expect(transport.end).not.toHaveBeenCalled();
      stt.emit("Since Monday.");
      await vi.waitFor(() => expect(tts.spoken.at(-1)).toBe(CAMERA_GUIDANCE)); // not heard the first time, so said now
      stt.emit("No thanks.");
      await vi.waitFor(() => expect(transport.end).toHaveBeenCalledOnce());
      expect(llm.calls.filter((call) => call.method === "callTurn")).toHaveLength(3); // the end was reached twice, then her no to the guidance is a turn that ends it
      expect(skipped()).toHaveLength(1);
    });

    it("says nothing when Presage is not set up: there was no reading to offer", async () => {
      const service = setup({ callTurn: endsTheCall });
      await start(service);
      stt.emit(turn);
      await vi.waitFor(() => expect(transport.end).toHaveBeenCalledOnce());
      expect(skipped()).toEqual([]);
    });

    it("says nothing when the offer was made, nor after she turns it down", async () => {
      const service = setup({ callTurn: endsTheCall, env: withCamera });
      await start(service);
      transport.emit("remoteVideo", true);
      stt.emit(turn);
      await vi.waitFor(() => expect(tts.spoken.at(-1)).toBe(CAMERA_OFFER_AT_END));
      stt.emit("No thanks.");
      await vi.waitFor(() => expect(transport.end).toHaveBeenCalledOnce());
      expect(skipped()).toEqual([]);
    });

    it("says nothing when she has to go: that call is never offered the reading, video or not", async () => {
      const service = setup({ callTurn: () => modelPlan({ nextAction: "end_call" }), env: withCamera });
      await start(service);
      stt.emit("I have to go now.");
      await vi.waitFor(() => expect(transport.end).toHaveBeenCalledOnce());
      expect(skipped()).toEqual([]);
    });
  });

  it("logs no media and no secret, whatever the transport reports", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const service = setup({ callTurn: endsTheCall, env: { ...withCamera, GEMINI_API_KEY: "gemini-secret-key" } });
    transport.videoStats = () => ({ inbound: { codec: "h264", framesDecoded: 3, rawFrame: new Uint8Array(8), frameBase64: "AAECAwQFBgc=".repeat(10) }, outbound: undefined });
    await start(service);
    transport.emit("remoteVideo", true);
    await vi.advanceTimersByTimeAsync(5_000);
    stt.emit("My ankles are a bit swollen.");
    await vi.waitFor(() => expect(tts.spoken.at(-1)).toBe(CAMERA_OFFER_AT_END));
    const lines = videoLogs();
    expect(lines.map((entry) => entry.event)).toEqual(["call_video_changed", "call_video_state"]);
    const text = JSON.stringify(lines);
    for (const secret of ["presage-test-key", "gemini-secret-key", "test-key", "voice-test"]) expect(text).not.toContain(secret);
    expect(text).not.toMatch(/AAECAwQFBgc|rawFrame|base64|"0":|samples/i);
    expect(Object.keys(lines[1]!).sort()).toEqual(["call_id", "camera_configured", "event", "has_track", "on", "stats"]);
    await service.end("call-1");
  });
});

describe("her chat is linked from the call", () => {
  const unlinked = (relayChatId: string | null = null) =>
    upsertPatient(db, { id: PATIENT, finchnodePatientId: "patient-demo-polypharmacy", preferredName: "Harriet", relayHandle: "harriet", relayChatId });
  const chatOf = () => getCheckinPatient(db, PATIENT)?.relayChatId;
  const realEngine = () => {
    const messenger = new FakeMessenger({ now: () => NOW });
    const engine = createCheckinEngine({ db, messenger, clock: { now: () => NOW }, loadSnapshot: async (subject) => loadSnapshot(subject), llm: new FakeLlmClient() }, { rxnav: loadRxNavCache() });
    return { messenger, engine };
  };

  it("when she called before she ever typed, the call's chat becomes her chat", async () => {
    unlinked();
    expect(chatOf()).toBeNull();
    const service = setup();
    await start(service);
    expect(chatOf()).toBe("chat-harriet");
    await service.end("call-1");
  });

  it("leaves a chat she already has alone", async () => {
    unlinked("chat-earlier");
    const service = setup();
    await start(service);
    expect(chatOf()).toBe("chat-earlier");
    await service.end("call-1");
  });

  it("never links a stranger's chat as hers", async () => {
    unlinked();
    const service = setup();
    await service.handle(created(relayCall("stranger", "call-stranger")));
    await vi.waitFor(() => expect(relay.calls.end).toHaveBeenCalledWith("call-stranger"));
    expect(chatOf()).toBeNull();
  });

  it("so the post-call message can reach her", async () => {
    unlinked();
    const { messenger, engine } = realEngine();
    const service = setup({ engine });
    await start(service);
    stt.emit("My knee aches a bit today.");
    await vi.waitFor(() => expect(callTranscript(db, "call-1").some((turn) => turn.speaker === "patient")).toBe(true));
    await service.end("call-1");
    expect(messenger.inChat("chat-harriet").map((message) => message.text)).toEqual([expect.stringMatching(/^Here's what I noted from our call/)]);
  });

  it("and an emergency on the call reaches her chat as well as her family", async () => {
    unlinked();
    syncFamilyMembers(db, PATIENT, ["sarah"]);
    linkFamilyMember(db, "sarah", "chat-sarah", "Sarah", NOW);
    const { messenger, engine } = realEngine();
    const service = setup({ engine });
    await start(service);
    stt.emit("I have chest pain right now");
    await vi.waitFor(() => expect(transport.end).toHaveBeenCalledOnce());
    await service.end("call-1");
    expect(messenger.inChat("chat-harriet").map((message) => message.text)).toContain(urgentReply("Harriet", ["Sarah"]));
    expect(messenger.inChat("chat-sarah")).toHaveLength(1);
  });
});

describe("the start of the call", () => {
  const firstCall = (mock: { mock: { invocationCallOrder: number[] } }) => mock.mock.invocationCallOrder[0]!;

  it("waits for her audio, writes 300 ms of silence and lets it play, and only then greets", async () => {
    const service = setup();
    await start(service);
    expect(transport.waitForPeerAudio).toHaveBeenCalledWith(2000);
    const frame = transport.writeAudio.mock.calls[0]![0];
    expect(frame).toMatchObject({ sampleRate: 48_000, channelCount: 1 });
    expect(frame.samples).toHaveLength(14_400);
    expect(frame.samples.every((sample) => sample === 0)).toBe(true);
    expect(firstCall(transport.waitForPeerAudio)).toBeLessThan(firstCall(transport.writeAudio));
    expect(firstCall(transport.writeAudio)).toBeLessThan(firstCall(transport.waitForPlayout));
    expect(firstCall(transport.waitForPlayout)).toBeLessThan(firstCall(tts.speak)); // speak() clears what is queued, so the silence must have played
    expect(tts.spoken[0]).toMatch(/Hi Harriet, I'm an AI check-in assistant/i);
    await service.end("call-1");
  });

  it("greets anyway when her audio never arrives", async () => {
    const service = setup();
    transport.waitForPeerAudio.mockRejectedValueOnce(new Error("Timed out waiting for the person's audio"));
    await start(service);
    expect(tts.spoken[0]).toMatch(/Hi Harriet, I'm an AI check-in assistant/i);
    await service.end("call-1");
  });

  it("says nothing when the call ends while it waits for her audio", async () => {
    const service = setup();
    let giveUp!: (error: Error) => void;
    transport.waitForPeerAudio.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { giveUp = reject; }));
    await service.handle(created(relayCall("harriet")));
    await vi.waitFor(() => expect(transport.waitForPeerAudio).toHaveBeenCalled());
    await service.end("call-1");
    giveUp(new Error("Relay Call ended before the person's audio arrived."));
    await new Promise((resolve) => setImmediate(resolve));
    expect(tts.speak).not.toHaveBeenCalled();
  });
});

describe("the voice and the transcriber are set up from the configuration", () => {
  it("the voice gets the soft limiter gain: 1.6 unless ELEVENLABS_TTS_GAIN says otherwise", async () => {
    await start(setup());
    expect(ttsOptions?.gain).toBe(1.6);
    await start(setup({ env: { ELEVENLABS_TTS_GAIN: "2.2" } }), relayCall("harriet", "call-2"));
    expect(ttsOptions?.gain).toBe(2.2);
  });

  it("the transcriber gets the speech wait (0.7 s) and her language (en), unless the settings say otherwise", async () => {
    await start(setup());
    expect(sttOptions).toMatchObject({ vadSilenceSecs: 0.7, languageCode: "en" });
    await start(setup({ env: { ELEVENLABS_STT_VAD_SILENCE_SECS: "1.1", ELEVENLABS_STT_LANGUAGE: "" } }), relayCall("harriet", "call-2"));
    expect(sttOptions?.vadSilenceSecs).toBe(1.1);
    expect(sttOptions).not.toHaveProperty("languageCode"); // empty: auto-detect
  });
});

describe("what a call says at its end and in an emergency is fixed copy", () => {
  it("Gemini ending the call: she hears the fixed goodbye, not its words", async () => {
    const service = setup({ callTurn: () => modelPlan({ patientResponseText: "It would be wise to contact your clinician today. Do you have any other symptoms?" }) });
    await start(service);
    stt.emit("I have had a bit of a cough.");
    await vi.waitFor(() => expect(transport.end).toHaveBeenCalledOnce());
    expect(tts.spoken.at(-1)).toBe(callClosing("Harriet", []));
    expect(tts.spoken.slice(1).join(" ")).not.toMatch(/clinician|\?/); // after the greeting, which asks how she is
  });

  it.each([
    ["an urgent symptom", "I have chest pain right now", urgentReply("Harriet", [])],
    ["a crisis", "I don't want to live anymore", crisisReply("Harriet", [])],
  ])("%s the fixed screen catches: exactly the text check-in's reply, and Gemini is never asked", async (_kind, words, reply) => {
    const service = setup();
    await start(service);
    stt.emit(words);
    await vi.waitFor(() => expect(transport.end).toHaveBeenCalledOnce());
    expect(tts.spoken.at(-1)).toBe(reply);
    expect(llm.calls.some((call) => call.method === "callTurn")).toBe(false);
  });

  it("a Gemini turn still being planned when an emergency arrives never speaks over the fixed reply", async () => {
    const service = setup();
    await start(service);
    let release!: (output: CallTurnLlmOutput) => void;
    llm.callTurn = () => new Promise<CallTurnLlmOutput>((resolve) => { release = resolve; });
    stt.emit("My ankles are a little swollen today.");
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    // The fixed reply takes a few seconds to play, as real speech does; the call ends only after it.
    let finishReply!: () => void;
    tts.speak.mockImplementationOnce(async (text) => {
      tts.spoken.push(text);
      await new Promise<void>((resolve) => { finishReply = resolve; });
    });
    stt.emit("Now I have chest pain right now");
    await vi.waitFor(() => expect(tts.spoken.at(-1)).toBe(urgentReply("Harriet", [])));
    release(modelPlan({ nextAction: "ask_follow_up", nextQuestion: "When did the swelling start?" }));
    await new Promise((resolve) => setImmediate(resolve)); // let the late turn finish
    expect(tts.spoken.at(-1)).toBe(urgentReply("Harriet", []));
    expect(tts.spoken.join(" ")).not.toContain("swelling start");
    finishReply();
    await vi.waitFor(() => expect(transport.end).toHaveBeenCalledOnce());
  });

  it("the call still ends when the voice fails on the emergency reply, and nothing is left unhandled", async () => {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);
    process.on("unhandledRejection", onRejection);
    try {
      const service = setup();
      await start(service);
      tts.speak.mockRejectedValueOnce(new Error("ElevenLabs TTS returned HTTP 500"));
      stt.emit("I have chest pain right now");
      await vi.waitFor(() => expect(transport.end).toHaveBeenCalledOnce());
      await new Promise((resolve) => setImmediate(resolve));
      expect(rejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", onRejection);
    }
  });
});

describe("a call this agent placed itself (the camera check call-back)", () => {
  it("is left to its recorder: not declined like a stranger's call, and no media session is opened", async () => {
    const service = setup();
    const outbound = { ...relayCall("harriet", "call-out"), from: { id: "agent-1", handle: "agent", kind: "agent" }, to: [{ id: "person-harriet", handle: "harriet", kind: "user" }] } as unknown as Call;
    await service.handle(created(outbound));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(logs.some((entry) => entry.event === "call_outbound_ignored" && entry.call_id === "call-out")).toBe(true);
    expect(relay.chats.messages.send).not.toHaveBeenCalled();
    expect(transport.connect).not.toHaveBeenCalled();

    await service.handle(created(relayCall("stranger", "call-stranger"))); // someone else's call is still declined
    await vi.waitFor(() => expect(relay.chats.messages.send).toHaveBeenCalledOnce());
  });
});

describe("the camera reading as a call-back (CAMERA_CALLBACK=on)", () => {
  const withCamera = { PRESAGE_API_KEY: "presage-test-key" };
  const turn = "My ankles are a bit swollen.";
  /** The call is recorded (the call-back, if any, starts right after). */
  const recorded = () => vi.waitFor(() => expect(getCallSession(db, "call-1")?.status).toBe("ended"));

  it("an audio-only call is offered it; her yes is the goodbye, and once the call is recorded she is called back", async () => {
    let statusWhenCalled: string | undefined;
    const cameraCallBack = vi.fn(async () => { statusWhenCalled = getCallSession(db, "call-1")?.status; });
    const service = setup({ callTurn: () => modelPlan(), env: withCamera, cameraCallBack });
    await start(service);
    stt.emit(turn);
    await vi.waitFor(() => expect(tts.spoken.at(-1)).toBe(CAMERA_CALLBACK_OFFER)); // her camera is off, and it is still offered
    expect(tts.spoken).not.toContain(CAMERA_GUIDANCE);
    stt.emit("Yes please.");
    await vi.waitFor(() => expect(transport.end).toHaveBeenCalledOnce());
    expect(tts.spoken.at(-1)).toBe(`${CAMERA_CALLBACK_SOON} ${callClosing("Harriet", [])}`);
    await vi.waitFor(() => expect(cameraCallBack).toHaveBeenCalledOnce());
    expect(cameraCallBack).toHaveBeenCalledWith({ id: PATIENT, chatId: "chat-harriet", handle: "harriet" });
    expect(statusWhenCalled).toBe("ended"); // the call is recorded first
    expect(bridge.start).not.toHaveBeenCalled(); // no Presage session on this call
    expect(logs.some((entry) => entry.event === "call_back_started")).toBe(true);
  });

  it("her no: the plain goodbye and no call-back", async () => {
    const cameraCallBack = vi.fn(async () => {});
    const service = setup({ callTurn: () => modelPlan(), env: withCamera, cameraCallBack });
    await start(service);
    stt.emit(turn);
    await vi.waitFor(() => expect(tts.spoken.at(-1)).toBe(CAMERA_CALLBACK_OFFER));
    stt.emit("No thanks.");
    await vi.waitFor(() => expect(transport.end).toHaveBeenCalledOnce());
    await recorded();
    expect(cameraCallBack).not.toHaveBeenCalled();
  });

  it("not after a call the after-call reading puts at the urgent level, even with her yes", async () => {
    const cameraCallBack = vi.fn(async () => {});
    const engine = {
      callCheckinContext: async () => ({ firstName: "Harriet", questions: [], yesterday: [], memories: [], familyNames: [] }),
      screenSpokenTurn: async () => undefined,
      recordSpokenCheckin: async () => ({ level: 4, items: [] }),
    } as unknown as CallEngine;
    const service = setup({ callTurn: () => modelPlan(), env: withCamera, cameraCallBack, engine });
    await start(service);
    stt.emit(turn);
    await vi.waitFor(() => expect(tts.spoken.at(-1)).toBe(CAMERA_CALLBACK_OFFER));
    stt.emit("Yes please.");
    await vi.waitFor(() => expect(transport.end).toHaveBeenCalledOnce());
    await recorded();
    expect(tts.spoken.at(-1)).toBe(`${CAMERA_CALLBACK_SOON} ${callClosing("Harriet", [])}`); // she was told, and the reading overrides it
    expect(getCallSession(db, "call-1")?.phase).toBe("emergency");
    expect(cameraCallBack).not.toHaveBeenCalled();
  });

  it("without Presage there is no reading to call back for: the call has no camera offer", async () => {
    const cameraCallBack = vi.fn(async () => {});
    const service = setup({ callTurn: () => modelPlan(), cameraCallBack });
    await start(service);
    stt.emit(turn);
    await vi.waitFor(() => expect(transport.end).toHaveBeenCalledOnce());
    expect(tts.spoken).not.toContain(CAMERA_CALLBACK_OFFER);
    await recorded();
    expect(cameraCallBack).not.toHaveBeenCalled();
  });
});

describe("after every call her doctor and emergency contact get the day's summary", () => {
  const turn = "My ankles are a bit swollen.";
  const engineWith = (callFinished: CallEngine["callFinished"]) =>
    ({
      callCheckinContext: async () => ({ firstName: "Harriet", questions: [], yesterday: [], memories: [], familyNames: [] }),
      screenSpokenTurn: async () => undefined,
      recordSpokenCheckin: async () => ({ level: 0, items: [] }),
      callFinished,
    }) as unknown as CallEngine;
  const recorded = () => vi.waitFor(() => expect(getCallSession(db, "call-1")?.status).toBe("ended"));

  it("a call she spoke on: once the call is recorded", async () => {
    const callFinished = vi.fn(async () => {});
    const service = setup({ callTurn: () => modelPlan(), engine: engineWith(callFinished) });
    await start(service);
    stt.emit(turn);
    await vi.waitFor(() => expect(transport.end).toHaveBeenCalledOnce());
    await recorded();
    await vi.waitFor(() => expect(callFinished).toHaveBeenCalledWith(PATIENT, DATE, "call-1"));
    expect(callFinished).toHaveBeenCalledOnce();
  });

  it("with a camera check call-back: only after it is done, so its reading is in the summary", async () => {
    let release!: () => void;
    const cameraCallBack = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    const callFinished = vi.fn(async () => {});
    const service = setup({ callTurn: () => modelPlan(), env: { PRESAGE_API_KEY: "presage-test-key" }, engine: engineWith(callFinished), cameraCallBack });
    await start(service);
    stt.emit(turn);
    await vi.waitFor(() => expect(tts.spoken.at(-1)).toBe(CAMERA_CALLBACK_OFFER));
    stt.emit("Yes please.");
    await recorded();
    await vi.waitFor(() => expect(cameraCallBack).toHaveBeenCalledOnce());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(callFinished).not.toHaveBeenCalled();
    release();
    await vi.waitFor(() => expect(callFinished).toHaveBeenCalledWith(PATIENT, DATE, "call-1"));
  });

  it("a call she never spoke on sends nothing", async () => {
    const callFinished = vi.fn(async () => {});
    const service = setup({ callTurn: () => modelPlan(), engine: engineWith(callFinished) });
    await start(service);
    await service.end("call-1");
    await recorded();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(callFinished).not.toHaveBeenCalled();
  });
});
