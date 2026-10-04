import type { Call, CallWebhookEvent } from "@relaymessenger/sdk";
import type { RelayCallTransport } from "@relaymessenger/sdk/calls";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ElevenLabsRealtimeStt, ElevenLabsTts } from "../src/calls/audio.ts";
import { CAMERA_OFFER_AT_END, callClosing } from "../src/calls/copy.ts";
import { emptyCallVitals } from "../src/calls/screening.ts";
import { CallService, type CallEngine } from "../src/calls/service.ts";
import { createCheckinEngine } from "../src/checkin/engine.ts";
import { crisisReply, urgentReply } from "../src/checkin/copy.ts";
import { callTranscript, getCallSession } from "../src/db/calls.ts";
import { getCheckinPatient } from "../src/db/checkins.ts";
import { linkFamilyMember, syncFamilyMembers } from "../src/db/family.ts";
import { openDatabase, upsertPatient, type Db } from "../src/db/index.ts";
import { loadConfig } from "../src/config.ts";
import { loadRxNavCache, loadSnapshot } from "../src/finchnode/fixtures.ts";
import { FakeLlmClient } from "../src/llm/fake.ts";
import type { CallTurnLlmOutput } from "../src/llm/types.ts";
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
let bridge: FakeBridge;
let llm: FakeLlmClient;
/** What the service handed the voice and the transcriber when the last call was answered. */
let ttsOptions: ConstructorParameters<typeof ElevenLabsTts>[1] | undefined;
let sttOptions: ConstructorParameters<typeof ElevenLabsRealtimeStt>[0] | undefined;
let relay: { calls: { end: ReturnType<typeof vi.fn> }; chats: { messages: { send: ReturnType<typeof vi.fn> } } };

function setup(options: { wallNow?: () => string; callTurn?: (input: Parameters<NonNullable<FakeLlmClient["callTurn"]>>[0]) => CallTurnLlmOutput | Error; env?: Record<string, string>; engine?: CallEngine } = {}) {
  transport = new FakeTransport();
  stt = new FakeStt();
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
    today: () => DATE,
    now: () => NOW,
    wallNow: options.wallNow ?? (() => NOW),
    transportFactory: () => transport as unknown as RelayCallTransport,
    sttFactory: (options) => ((sttOptions = options), stt as never),
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

describe("the camera reading is offered only while her video is on", () => {
  const withCamera = { PRESAGE_API_KEY: "presage-test-key" }; // a bridge exists, as on the demo machine
  const endsTheCall = () => modelPlan();
  const turn = "My ankles are a bit swollen.";

  it("an audio-only call is never offered it", async () => {
    const service = setup({ callTurn: endsTheCall, env: withCamera });
    await start(service);
    stt.emit(turn);
    await vi.waitFor(() => expect(transport.end).toHaveBeenCalledOnce());
    expect(tts.spoken.at(-1)).toBe(callClosing("Harriet", []));
    expect(tts.spoken).not.toContain(CAMERA_OFFER_AT_END);
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
  ])("a call where she %s before the goodbye gets no offer", async (_how, cameraOff) => {
    let turns = 0;
    const service = setup({ callTurn: () => (turns += 1) === 1 ? modelPlan({ nextAction: "ask_follow_up", nextQuestion: "When did the swelling start?" }) : modelPlan(), env: withCamera });
    await start(service);
    transport.emit("remoteVideo", true);
    stt.emit(turn);
    await vi.waitFor(() => expect(tts.spoken.at(-1)).toContain("When did the swelling start?"));
    cameraOff();
    stt.emit("Since Monday.");
    await vi.waitFor(() => expect(transport.end).toHaveBeenCalledOnce());
    expect(tts.spoken.at(-1)).toBe(callClosing("Harriet", []));
    expect(tts.spoken).not.toContain(CAMERA_OFFER_AT_END);
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
