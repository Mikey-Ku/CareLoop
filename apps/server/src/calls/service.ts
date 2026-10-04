import type Relay from "@relaymessenger/sdk";
import type { Call, CallWebhookEvent } from "@relaymessenger/sdk";
import { RelayCallTransport } from "@relaymessenger/sdk/calls";
import type { CheckinEngine, SpokenTurn } from "../checkin/engine-types.ts";
import { crisisReply, urgentReply, type UnderstoodItem } from "../checkin/copy.ts";
import type { ContextPacket } from "../context/packet.ts";
import { getCallSession, addCallTranscript, createCallSession, patchCallSession, callTranscript } from "../db/calls.ts";
import { getCheckinPatient } from "../db/checkins.ts";
import { familyChats } from "../db/family.ts";
import { addVisitQuestion } from "../db/notes.ts";
import { addVitalsReading } from "../db/vitals.ts";
import { normalizeHandle, type Config } from "../config.ts";
import type { Db } from "../db/index.ts";
import type { HealthRecord } from "../finchnode/types.ts";
import { linkPatientChat } from "../relay/inbox.ts";
import type { VitalsResult } from "../vitals/types.ts";
import type { CallScreeningLlmOutput, LlmClient } from "../llm/types.ts";
import { QUIET_MINUTE_PROMPT, cantHearYou, heartRateReadback, noReadingReadback, noVideoReadback, stillMeasuring, wrongCallerDecline } from "./copy.ts";
import { emergencyDecision } from "./emergency.ts";
import { callResult, emptyCallVitals, loadUsualRange } from "./screening.ts";
import { RelayPresageBridge } from "./video.ts";
import type { ScreeningResult, TranscriptTurn } from "./types.ts";
import type { CameraCallbackPatient } from "./camera-callback.ts";
import { ElevenLabsRealtimeStt, ElevenLabsTts, isBargeIn, relayAudioToStt } from "./audio.ts";
import { ConversationOrchestrator } from "./orchestrator.ts";

// A video check-in call (docs/CALLS.md). Relay carries the call, ElevenLabs provides streaming STT/TTS,
// and Gemini plans evidence-grounded turns using bounded FinchNode context. The server retains control:
// - Only her Relay handle gets the call; anyone else gets a short polite decline and nothing from her record.
// - Each of her turns gets the safety screen as it arrives; a hit takes the typed safety path at once
//   (engine.screenSpokenTurn: her reply, every family chat alerted, a follow-up).
// - Gemini's approved patient wording is validated and stored with its structured screening summary;
//   deterministic safety replies still use fixed copy and always take precedence.
// - After the call her turns go through the same understanding pass and ladder as typed words
//   (engine.recordSpokenCheckin) and she gets ONE message saying what was noted.
// - The server ends the call after CALL_MAX_MINUTES.

export type CallLog = (event: string, fields?: Record<string, unknown>) => void;
export const RELAY_ANSWER_DEADLINE_MS = 32_000;
/** Longest wait for her check-in context before answering (Relay's answer deadline is 32 s). */
export const CALL_CONTEXT_TIMEOUT_MS = 5_000;
/** Before the greeting: the longest wait for her audio to arrive, and the silence written ahead of the first words. */
export const GREETING_PEER_AUDIO_WAIT_MS = 2_000;
export const GREETING_LEAD_IN_MS = 300;
/** One log line about her video this long after the call is answered (call_video_state). */
export const VIDEO_STATE_LOG_MS = 5_000;

export function withinRelayAnswerDeadline(ringingAt: string, answeredAt: string, deadlineMs = RELAY_ANSWER_DEADLINE_MS): boolean {
  const elapsed = Date.parse(answeredAt) - Date.parse(ringingAt);
  return Number.isFinite(elapsed) && elapsed >= 0 && elapsed <= deadlineMs;
}

/** What the call needs from the check-in engine. */
export type CallEngine = Pick<CheckinEngine, "callCheckinContext" | "screenSpokenTurn" | "recordSpokenCheckin">;

export type CallServiceOptions = {
  db: Db;
  config: Config;
  relay: Relay;
  loadSnapshot: (subject: string) => Promise<HealthRecord>;
  /** The check-in engine: without it the call still screens for safety but records nothing. */
  engine?: CallEngine;
  /** Gemini client for adaptive turn planning. */
  llm?: LlmClient;
  /** Her check-in date now (YYYY-MM-DD, her time zone or CLOCK_DATE). Defaults to the UTC date. */
  today?: () => string;
  log?: CallLog;
  now?: () => string;
  /** The real clock, for Relay's own timestamps (the 32-second answer deadline). Defaults to `now`. */
  wallNow?: () => string;
  /** Injectable media clients keep call lifecycle tests offline. */
  transportFactory?: (relay: Relay, callId: string) => RelayCallTransport;
  sttFactory?: (options: ConstructorParameters<typeof ElevenLabsRealtimeStt>[0]) => ElevenLabsRealtimeStt;
  ttsFactory?: (transport: RelayCallTransport, options: ConstructorParameters<typeof ElevenLabsTts>[1]) => ElevenLabsTts;
  bridgeFactory?: (transport: RelayCallTransport, options: ConstructorParameters<typeof RelayPresageBridge>[1]) => RelayPresageBridge;
  /**
   * The camera reading as a call-back (CAMERA_CALLBACK=on; the agent passes runCameraCallback). With Presage
   * configured it replaces the quiet window: offered on every call, camera on or not, and run once a call whose
   * goodbye promised it is recorded, unless the call reached the urgent or crisis level.
   */
  cameraCallBack?: (patient: CameraCallbackPatient) => Promise<unknown>;
};

type ActiveCall = {
  call: Call;
  patientId: string;
  subject: string;
  firstName: string;
  day: string;
  transcript: TranscriptTurn[];
  bridge?: RelayPresageBridge;
  transport?: RelayCallTransport;
  /** The transcriber in use: replaced once by #sttLost when its session ends under the call. */
  stt?: ElevenLabsRealtimeStt;
  sttReconnected?: boolean;
  tts?: ElevenLabsTts;
  conversation?: ConversationOrchestrator;
  /** Highest safety level seen so far (4 urgent, 5 crisis). */
  safetyLevel: number;
  /** Per-turn safety screens in flight; waited for before the call is recorded. */
  screens: Promise<void>[];
  ending: boolean;
  mediaClosed?: boolean;
  finishing?: Promise<void>;
  maxTimer?: ReturnType<typeof setTimeout>;
  videoStateTimer?: ReturnType<typeof setTimeout>;
  readingSaved: boolean;
  /** Her goodbye promised the camera check call-back. */
  callBack?: boolean;
  /** Undefined until asked; null when her record couldn't be read (no comparison then). */
  usualRange?: ContextPacket["usualRange"] | null;
  geminiScreening?: CallScreeningLlmOutput;
};

export type CallEventHandler = { handle(event: CallWebhookEvent): Promise<void> };

/** A stable id for one transcript turn: it dedupes the safety path between the live screen and the end of the call. */
export const turnId = (callId: string, index: number) => `call:${callId}:turn:${index}`;

export class CallService implements CallEventHandler {
  readonly #options: CallServiceOptions;
  readonly #log: CallLog;
  readonly #now: () => string;
  readonly #wallNow: () => string;
  readonly #today: () => string;
  readonly #active = new Map<string, ActiveCall>();
  /** A camera check call-back is ringing or being read: one at a time, since each rings her one phone. */
  #callingBack = false;

  constructor(options: CallServiceOptions) {
    this.#options = options;
    this.#log = options.log ?? (() => {});
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#wallNow = options.wallNow ?? this.#now;
    this.#today = options.today ?? (() => this.#now().slice(0, 10));
  }

  /** Called from the durable inbox. It never awaits a call's lifetime or its end-of-call work. */
  async handle(event: CallWebhookEvent): Promise<void> {
    if (event.event_type === "call.created") {
      void this.#start(event.data.call).catch((error) => this.#log("call_start_failed", { call_id: event.data.call.id, error: summary(error) }));
      return;
    }
    if (event.event_type === "call.updated") {
      const call = event.data.call;
      const active = this.#active.get(call.id);
      if (active) active.call = call;
      if (call.status === "in-progress") patchCallSession(this.#options.db, call.id, { status: "in_progress", answeredAt: this.#now() });
      return;
    }
    const callId = event.data.call.id;
    void this.end(callId).catch((error) => this.#log("call_end_failed", { call_id: callId, error: summary(error) }));
  }

  async end(callId: string): Promise<void> {
    const active = this.#active.get(callId);
    if (!active) {
      if (getCallSession(this.#options.db, callId)?.status !== "failed") patchCallSession(this.#options.db, callId, { status: "ended", phase: "complete", endedAt: this.#now() });
      return;
    }
    active.ending = true;
    active.bridge?.quiet.interrupt();
    active.conversation?.close();
    this.#closeMedia(active);
    await this.#finish(active);
  }

  async beginQuietMeasurement(callId: string, permissionGranted: boolean): Promise<{ status: string; durationMs: number }> {
    const active = this.#active.get(callId);
    if (!active?.bridge) throw new Error("call is not connected to a video track");
    active.bridge.beginQuietMeasurement(permissionGranted);
    patchCallSession(this.#options.db, callId, { phase: permissionGranted ? "quiet_measurement" : "interview", measurementStartedAt: permissionGranted ? this.#now() : undefined });
    return { status: active.bridge.quiet.status, durationMs: active.bridge.quiet.durationMs };
  }

  /** Internal deterministic safety/ladder screen for local callers. The live call needs no HTTP tool. */
  async screen(callId: string): Promise<ScreeningResult> {
    const active = this.#active.get(callId);
    const stored = getCallSession(this.#options.db, callId);
    if (!active && !stored) throw new Error("unknown call");
    const patientId = active?.patientId ?? stored!.patientId;
    const patient = getCheckinPatient(this.#options.db, patientId);
    if (!patient) throw new Error("patient is not available");
    const day = active?.day ?? this.#today();
    const transcript = active?.transcript ?? callTranscript(this.#options.db, callId);
    const read = await this.#read(callId, patientId, day, transcript, { assessOnly: true });
    const level = Math.max(read.level, active?.safetyLevel ?? 0);
    const result = callResult({
      callId,
      patientId,
      day,
      level,
      items: read.items,
      safety: read.safety,
      vitals: active?.bridge ? active.bridge.result() : emptyCallVitals(),
      firstName: patient.preferredName,
      familyNames: this.#familyNames(patientId),
      uncertainty: read.uncertainty,
    });
    patchCallSession(this.#options.db, callId, { phase: level >= 4 ? "emergency" : "screening", screeningJson: JSON.stringify(result) });
    return result;
  }

  /** Internal read-back helper used by offline tests/tools; live TTS uses the orchestrator directly. */
  async vitalsReadback(callId: string): Promise<{ status: string; patientResponseText: string }> {
    const active = this.#active.get(callId);
    if (!active) throw new Error("unknown call");
    if (!active.bridge) return { status: "no_video", patientResponseText: noVideoReadback() };
    const quiet = active.bridge.quiet;
    if (quiet.status === "waiting_for_permission") return { status: "not_started", patientResponseText: QUIET_MINUTE_PROMPT };
    if (quiet.status === "measuring" && quiet.remainingMs(Date.now()) > 0) return { status: "measuring", patientResponseText: stillMeasuring() };
    const vitals = active.bridge.result();
    this.#saveReading(active, vitals);
    const reading = vitals.heartRate === null && vitals.breathingRate === null ? noReadingReadback() : heartRateReadback(vitals, await this.#usualRange(active));
    const ladder = await this.screen(callId);
    const line = ladder.level === 0 ? "" : ladder.patientResponseText;
    return { status: vitals.heartRate === null ? "no_reading" : "reading", patientResponseText: [reading, line].filter(Boolean).join(" ") };
  }

  async #start(call: Call): Promise<void> {
    if (this.#active.has(call.id)) {
      this.#log("call_duplicate_start_ignored", { call_id: call.id });
      return;
    }
    if (call.from.kind === "agent") {
      // A call this agent placed itself (the camera check call-back): its recorder takes it, so it is not declined.
      this.#log("call_outbound_ignored", { call_id: call.id });
      return;
    }
    const patient = this.#patientForCall(call);
    if (!patient) {
      this.#log("call_wrong_caller", { call_id: call.id });
      await this.#decline(call);
      return;
    }
    const day = this.#today();
    const active: ActiveCall = {
      call,
      patientId: patient.id,
      subject: patient.finchnodePatientId,
      firstName: patient.preferredName,
      day,
      transcript: [],
      safetyLevel: 0,
      screens: [],
      ending: false,
      readingSaved: false,
    };
    this.#active.set(call.id, active);
    createCallSession(this.#options.db, { callId: call.id, patientId: patient.id, relayChatId: call.chat_id, at: this.#now() });
    const calls = this.#options.config.calls;
    if (!calls.elevenLabsApiKey || !calls.elevenLabsVoiceId || !this.#options.llm?.callTurn) {
      const missing = !calls.elevenLabsApiKey || !calls.elevenLabsVoiceId ? "ElevenLabs API or voice" : "Gemini call-turn operation";
      patchCallSession(this.#options.db, call.id, { status: "failed", phase: "failed", error: `${missing} is not configured`, endedAt: this.#now() });
      this.#log("call_skipped_not_configured", { call_id: call.id, integration: missing });
      await this.#callUnavailable(call);
      this.#active.delete(call.id);
      return;
    }

    this.#linkChat(call, patient.id);
    try {
      const context = await this.#context(patient, day);
      active.firstName = context.firstName;
      const transport = (this.#options.transportFactory ?? ((relay, callId) => new RelayCallTransport({ relay, callId })))(this.#options.relay, call.id);
      const sttOptions: ConstructorParameters<typeof ElevenLabsRealtimeStt>[0] = {
        apiKey: calls.elevenLabsApiKey,
        modelId: calls.elevenLabsSttModel,
        ...(calls.elevenLabsSttLanguage ? { languageCode: calls.elevenLabsSttLanguage } : {}),
        vadSilenceSecs: calls.elevenLabsSttVadSilenceSecs,
        log: (event, fields) => this.#log(event, { call_id: call.id, ...fields }),
      };
      const openStt = () => (this.#options.sttFactory ?? ((options) => new ElevenLabsRealtimeStt(options)))(sttOptions);
      const stt = openStt();
      const ttsOptions: ConstructorParameters<typeof ElevenLabsTts>[1] = {
        apiKey: calls.elevenLabsApiKey,
        voiceId: calls.elevenLabsVoiceId,
        modelId: calls.elevenLabsTtsModel,
        outputFormat: calls.elevenLabsTtsOutputFormat,
        gain: calls.elevenLabsTtsGain,
        log: (event, fields) => this.#log(event, { call_id: call.id, ...fields }),
      };
      const tts = (this.#options.ttsFactory ?? ((target, options) => new ElevenLabsTts(target, options)))(transport, ttsOptions);
      active.transport = transport;
      active.stt = stt;
      active.tts = tts;
      transport.on("audio", (frame) => {
        try {
          active.stt?.send(relayAudioToStt(frame));
        } catch (error) {
          this.#log("call_audio_rejected", { call_id: call.id, error: summary(error) });
        }
      });
      transport.on("error", (error) => this.#log("call_transport_error", { call_id: call.id, error: summary(error) }));
      transport.on("ended", () => void this.end(call.id));
      // Whether her camera is on, from the transport's own events (the Presage bridge listens to the same
      // ones). The camera reading is only offered while it is: an audio-only call is never asked.
      let videoOn = Boolean(transport.remoteVideoTrack);
      const setVideo = (on: boolean, source: string) => {
        if (on === videoOn) return;
        videoOn = on;
        this.#log("call_video_changed", { call_id: call.id, on, source });
      };
      transport.on("trackSubscribed", () => setVideo(true, "trackSubscribed"));
      transport.on("trackUnsubscribed", () => setVideo(false, "trackUnsubscribed"));
      transport.on("remoteVideo", (enabled) => setVideo(enabled, "remoteVideo"));
      let offerSkippedLogged = false;
      // The handlers go on every transcriber the call uses, the one it starts with and a reconnected one.
      const wireStt = (target: ElevenLabsRealtimeStt): ElevenLabsRealtimeStt =>
        target
          // She may talk over the assistant, but a cough, a noise or her first "hello?" must not cut it off mid-word.
          // It takes two real words (isBargeIn). Those also mean a reply Gemini is still planning is out of date
          // (noteSpeech). The greeting (it says this is an AI) and a fixed safety reply are never interrupted.
          .onPartial((text) => {
            if (!isBargeIn(text)) return;
            active.conversation?.noteSpeech();
            if (tts.isSpeaking && active.conversation?.greeted && active.safetyLevel < 4) tts.cancel();
          })
          .onCommitted((text) => this.#onPatientTranscript(active, text))
          .onClose((reason) => {
            void this.#sttLost(active, reason, () => wireStt(openStt())).catch((error) => this.#log("call_stt_recovery_failed", { call_id: active.call.id, error: summary(error) }));
          });
      wireStt(stt);
      const elapsedSinceRinging = call.ringing_at ? Date.parse(this.#wallNow()) - Date.parse(call.ringing_at) : 0;
      const connectBudget = call.ringing_at ? RELAY_ANSWER_DEADLINE_MS - elapsedSinceRinging - 500 : RELAY_ANSWER_DEADLINE_MS - 500;
      if (connectBudget <= 0) throw new Error(`Relay answer deadline exceeded (${RELAY_ANSWER_DEADLINE_MS} ms)`);
      let connectTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.all([transport.connect(), stt.connect()]),
          new Promise<never>((_resolve, reject) => {
            connectTimer = setTimeout(() => reject(new Error(`Relay answer deadline exceeded (${RELAY_ANSWER_DEADLINE_MS} ms)`)), connectBudget);
          }),
        ]);
      } finally {
        clearTimeout(connectTimer);
      }
      // A call-back takes the reading on its own call, so this call needs no Presage session.
      const callBack = calls.presageApiKey ? this.#options.cameraCallBack : undefined;
      active.bridge = calls.presageApiKey && !callBack
        ? (this.#options.bridgeFactory ?? ((target, options) => new RelayPresageBridge(target, options)))(transport, {
            apiKey: calls.presageApiKey,
            quietDurationMs: calls.quietMeasurementMs,
            minConfidence: calls.vitalsMinConfidence,
            maxFrameGapMs: calls.maxFrameGapMs,
            log: (event, fields) => this.#log(event, { call_id: call.id, ...fields }),
          })
        : undefined;
      active.bridge?.start();
      active.conversation = new ConversationOrchestrator({
        callId: call.id,
        patientId: patient.id,
        subject: patient.finchnodePatientId,
        firstName: context.firstName,
        transcript: active.transcript,
        initialContext: context,
        llm: this.#options.llm,
        loadSnapshot: this.#options.loadSnapshot,
        getVitals: () => active.bridge?.result() ?? emptyCallVitals(),
        canMeasure: () => Boolean(callBack) || (Boolean(active.bridge) && videoOn),
        cameraNeedsVideo: () => Boolean(active.bridge) && !videoOn,
        ...(callBack ? { cameraCallBack: () => { active.callBack = true; } } : {}),
        measurementActive: () => active.bridge?.measuring() ?? true,
        quietMeasurementMs: calls.quietMeasurementMs,
        speak: (text) => tts.speak(text),
        beforeGreeting: async () => {
          // The greeting used to start the instant the call was answered, and came out rough. Let her audio
          // arrive (its rejection, a timeout or an ended call, is ignored), then a short silence, played out
          // before speaking because speak() clears whatever is still queued.
          await transport.waitForPeerAudio(GREETING_PEER_AUDIO_WAIT_MS).catch(() => {});
          await transport.writeAudio({ samples: new Int16Array((48_000 * GREETING_LEAD_IN_MS) / 1000), sampleRate: 48_000, channelCount: 1 });
          await transport.waitForPlayout();
        },
        recordAgentTurn: (text) => this.#recordTurn(active, { speaker: "agent", text }),
        beginQuietMeasurement: () => {
          if (!active.bridge) return;
          active.bridge.beginQuietMeasurement(true);
          patchCallSession(this.#options.db, call.id, { phase: "quiet_measurement", measurementStartedAt: this.#now() });
        },
        onCameraOfferSkipped: () => {
          // Asked only when canMeasure() said no, so with Presage configured her video is what is missing.
          if (!active.bridge || offerSkippedLogged) return;
          offerSkippedLogged = true;
          this.#log("call_camera_offer_skipped", { call_id: call.id, reason: "no_video" });
        },
        onComplete: (screening) => {
          if (screening) active.geminiScreening = screening;
          patchCallSession(this.#options.db, call.id, { phase: "screening" });
          try {
            active.transport?.end();
          } catch (error) {
            this.#log("call_end_failed", { call_id: call.id, error: summary(error) }); // she already hung up: the room is gone and there is nothing left to end
          }
        },
        log: (event, fields) => this.#log(event, { call_id: call.id, ...fields }),
      });
      // The call's length is ours: the server ends it after CALL_MAX_MINUTES.
      active.maxTimer = setTimeout(() => this.#timeUp(active), calls.maxMinutes * 60_000);
      active.maxTimer.unref?.();
      // One look at her video a few seconds in, so a call with no camera offer can be told why (log only).
      active.videoStateTimer = setTimeout(() => this.#logVideoState(active, transport, videoOn), VIDEO_STATE_LOG_MS);
      active.videoStateTimer.unref?.();
      patchCallSession(this.#options.db, call.id, { status: "in_progress", phase: "interview", answeredAt: this.#now() });
      this.#log("call_answered", { call_id: call.id });
      active.conversation.start();
      await new Promise<void>((resolve) => {
        transport.on("ended", () => resolve());
        transport.on("close", () => resolve());
      });
    } catch (error) {
      patchCallSession(this.#options.db, call.id, { status: "failed", phase: "failed", error: summary(error), endedAt: this.#now() });
      this.#log("call_bridge_failed", { call_id: call.id, error: summary(error) });
    } finally {
      active.conversation?.close();
      this.#closeMedia(active);
      await this.#finish(active);
    }
  }

  /**
   * She may call before she has ever typed, so her chat isn't linked and "Here's what I noted from our
   * call" and her family's alerts would have nowhere to go. Link the call's chat the way the inbox links
   * her on her first message. A chat she already has is left alone. Never fails the call.
   */
  #linkChat(call: Call, patientId: string): void {
    try {
      if (getCheckinPatient(this.#options.db, patientId)?.relayChatId) return;
      if (linkPatientChat(this.#options.db, call.from.handle, call.chat_id)) this.#log("call_patient_chat_linked", { call_id: call.id });
    } catch (error) {
      this.#log("call_chat_link_failed", { call_id: call.id, error: summary(error) });
    }
  }

  /** Her first name, today's unanswered questions, yesterday's topics, memories, family names; bounded so the call still answers in time. */
  async #context(patient: { id: string; preferredName: string }, day: string) {
    const fallback = { firstName: patient.preferredName, questions: [], yesterday: [], memories: [], familyNames: this.#familyNames(patient.id) };
    const engine = this.#options.engine;
    if (!engine) return fallback;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        engine.callCheckinContext(patient.id, day),
        new Promise<typeof fallback>((resolve) => {
          timer = setTimeout(() => resolve(fallback), CALL_CONTEXT_TIMEOUT_MS);
        }),
      ]);
    } catch (error) {
      this.#log("call_context_failed", { error: summary(error) });
      return fallback;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Her speech-to-text session ended under a live call (the socket closed, or Scribe reported a fatal event).
   * Audio sent into it is dropped, so the call would go deaf without a word. Reconnect once; if that fails,
   * say so in fixed words and end the call.
   */
  async #sttLost(active: ActiveCall, reason: string, reopen: () => ElevenLabsRealtimeStt): Promise<void> {
    if (active.ending || active.mediaClosed || active.safetyLevel >= 4) return; // over, or the emergency reply is the last word
    const lost = active.stt;
    let failure: unknown;
    if (!active.sttReconnected) {
      active.sttReconnected = true;
      let next: ElevenLabsRealtimeStt | undefined;
      try {
        next = reopen();
        active.stt = next; // closed with the call's media, even while it is still connecting
        lost?.close();
        await next.connect();
        this.#log("call_stt_reconnected", { call_id: active.call.id, reason });
        return;
      } catch (error) {
        failure = error;
        next?.close();
      }
    }
    // An emergency may have been heard while the reconnect was pending (the lost session can still deliver its
    // last words): its reply is then the last word, and the end of the call is the emergency path's.
    if (active.ending || active.mediaClosed || active.safetyLevel >= 4) return;
    this.#log("call_stt_lost", { call_id: active.call.id, reason, ...(failure === undefined ? {} : { error: summary(failure) }) });
    active.conversation?.close();
    const sentence = cantHearYou(active.firstName, this.#familyNames(active.patientId));
    this.#recordTurn(active, { speaker: "agent", text: sentence });
    try {
      await active.tts?.speak(sentence);
    } catch (error) {
      this.#log("call_stt_lost_speech_failed", { call_id: active.call.id, error: summary(error) });
    }
    if (active.safetyLevel >= 4) return; // an emergency cut the sentence short: its reply is being said, and it ends the call after
    active.transport?.end();
  }

  #timeUp(active: ActiveCall): void {
    if (active.ending) return;
    this.#log("call_time_limit", { call_id: active.call.id, minutes: this.#options.config.calls.maxMinutes });
    try {
      active.transport?.end();
    } catch {
      active.transport?.close();
    }
  }

  #logVideoState(active: ActiveCall, transport: RelayCallTransport, on: boolean): void {
    const stats = videoCounters(transport);
    this.#log("call_video_state", { call_id: active.call.id, on, has_track: Boolean(transport.remoteVideoTrack), camera_configured: Boolean(active.bridge), ...(stats ? { stats } : {}) });
  }

  #recordTurn(active: ActiveCall, turn: TranscriptTurn): void {
    active.transcript.push({ ...turn, at: this.#now() });
    addCallTranscript(this.#options.db, { callId: active.call.id, speaker: turn.speaker, text: turn.text, at: this.#now() });
  }

  #closeMedia(active: ActiveCall): void {
    if (active.mediaClosed) return;
    active.mediaClosed = true;
    clearTimeout(active.videoStateTimer);
    active.stt?.close();
    active.tts?.close();
    active.transport?.close();
  }

  async #onPatientTranscript(active: ActiveCall, text: string): Promise<void> {
    const turn: SpokenTurn = { id: turnId(active.call.id, active.transcript.length), text };
    this.#recordTurn(active, { speaker: "patient", text });
    const emergency = emergencyDecision([{ speaker: "patient", text }]);
    if (emergency) {
      active.safetyLevel = Math.max(active.safetyLevel, emergency.level);
      patchCallSession(this.#options.db, active.call.id, { phase: "emergency" });
      this.#log("call_safety_hit", { call_id: active.call.id, kind: emergency.hit.kind });
      active.screens.push(Promise.resolve(this.#options.engine?.screenSpokenTurn(active.patientId, turn)).then(() => {}).catch((error) => {
        this.#log("call_safety_send_failed", { call_id: active.call.id, error: summary(error) });
      }));
      // Nothing but the fixed reply is spoken from here: a Gemini turn still in flight must not talk over it.
      active.conversation?.close();
      active.tts?.cancel();
      const response = emergency.level >= 5
        ? crisisReply(active.firstName, this.#familyNames(active.patientId))
        : urgentReply(active.firstName, this.#familyNames(active.patientId));
      this.#recordTurn(active, { speaker: "agent", text: response });
      void active.tts?.speak(response).finally(() => active.transport?.end()).catch((error) => this.#log("call_emergency_speech_failed", { call_id: active.call.id, error: summary(error) }));
      return;
    }
    const screen = this.#screenTurn(active, turn);
    active.screens.push(screen.then(async (isEmergency) => {
      if (isEmergency) return;
      await active.conversation?.handlePatientTurn(text);
    }));
  }

  /** The safety screen on one turn as it arrives; a hit takes the typed safety path at once. Never throws. */
  async #screenTurn(active: ActiveCall, turn: SpokenTurn): Promise<boolean> {
    const decision = emergencyDecision([{ speaker: "patient", text: turn.text }]);
    if (!decision) return false;
    active.safetyLevel = Math.max(active.safetyLevel, decision.level);
    patchCallSession(this.#options.db, active.call.id, { phase: "emergency" });
    this.#log("call_safety_hit", { call_id: active.call.id, kind: decision.hit.kind });
    try {
      await this.#options.engine?.screenSpokenTurn(active.patientId, turn);
    } catch (error) {
      this.#log("call_safety_send_failed", { call_id: active.call.id, error: summary(error) });
    }
    return true;
  }

  /** The ladder over her turns: the engine's understanding pass, or the safety screen alone without one. */
  async #read(
    callId: string,
    patientId: string,
    day: string,
    transcript: readonly { speaker: string; text: string }[],
    options: { assessOnly: boolean; reading?: VitalsResult },
  ): Promise<{ level: number; items: UnderstoodItem[]; safety?: string; summaryMessageId?: string; uncertainty: string[] }> {
    const turns: SpokenTurn[] = transcript.flatMap((t, i) => (t.speaker === "patient" ? [{ id: turnId(callId, i), text: t.text }] : []));
    const local = emergencyDecision(transcript.map((t) => ({ speaker: t.speaker === "patient" ? "patient" : "agent", text: t.text })));
    const floor = { level: local?.level ?? 0, items: [] as UnderstoodItem[], ...(local ? { safety: local.hit.kind } : {}) };
    const engine = this.#options.engine;
    if (!engine || turns.length === 0) return { ...floor, uncertainty: engine ? [] : ["No check-in engine: only the safety screen ran."] };
    try {
      const r = await engine.recordSpokenCheckin(patientId, day, turns, {
        callId,
        assessOnly: options.assessOnly,
        ...(options.reading ? { reading: { heartRate: options.reading.heartRate, breathingRate: options.reading.breathingRate } } : {}),
      });
      return {
        level: Math.max(floor.level, r.level),
        items: r.items,
        ...(r.safety ?? floor.safety ? { safety: r.safety ?? floor.safety } : {}),
        ...(r.summaryMessageId ? { summaryMessageId: r.summaryMessageId } : {}),
        uncertainty: [],
      };
    } catch (error) {
      this.#log("call_record_failed", { call_id: callId, error: summary(error) });
      return { ...floor, uncertainty: [`Recording what she said failed: ${summary(error)}`] };
    }
  }

  /** Runs once per call, however many times it is asked for (the bridge closing and call.ended both ask). */
  #finish(active: ActiveCall): Promise<void> {
    active.finishing ??= this.#doFinish(active);
    return active.finishing;
  }

  async #doFinish(active: ActiveCall): Promise<void> {
    const callId = active.call.id;
    clearTimeout(active.maxTimer);
    try {
      const vitals = active.bridge ? await active.bridge.stop() : emptyCallVitals();
      this.#saveReading(active, vitals);
      this.#saveMedicineQuestions(active);
      await Promise.allSettled(active.screens);
      const read = await this.#read(callId, active.patientId, active.day, active.transcript, { assessOnly: false, reading: vitals });
      const level = Math.max(read.level, active.safetyLevel);
      const result = callResult({
        callId,
        patientId: active.patientId,
        day: active.day,
        level,
        items: read.items,
        safety: read.safety,
        vitals,
        firstName: active.firstName,
        familyNames: this.#familyNames(active.patientId),
        uncertainty: read.uncertainty,
        summaryMessageId: read.summaryMessageId,
      });
      const failed = getCallSession(this.#options.db, callId)?.status === "failed";
      patchCallSession(this.#options.db, callId, {
        ...(failed ? {} : { status: "ended" as const, phase: level >= 4 ? ("emergency" as const) : ("complete" as const) }),
        endedAt: this.#now(),
        screeningJson: JSON.stringify(active.geminiScreening ? { ...result, geminiScreening: active.geminiScreening } : result),
        measurementEndedAt: active.bridge?.quiet.status === "complete" ? this.#now() : undefined,
      });
      if (active.callBack && !failed && level < 4) this.#callBack(active);
    } catch (error) {
      this.#log("call_finish_failed", { call_id: callId, error: summary(error) });
    } finally {
      this.#active.delete(callId);
    }
  }

  /** The camera check call-back her goodbye promised, once the call is recorded. Never awaited, and one at a time. */
  #callBack(active: ActiveCall): void {
    const run = this.#options.cameraCallBack;
    if (!run) return;
    if (this.#callingBack) {
      this.#log("call_back_skipped", { call_id: active.call.id, reason: "another_call_back_running" });
      return;
    }
    this.#callingBack = true;
    this.#log("call_back_started", { call_id: active.call.id });
    void run({ id: active.patientId, chatId: active.call.chat_id, handle: active.call.from.handle })
      .catch((error) => this.#log("call_back_failed", { call_id: active.call.id, error: summary(error) }))
      .finally(() => { this.#callingBack = false; });
  }

  /** Each accepted camera reading goes to vitals_readings once per call (method relay_call). */
  #saveReading(active: ActiveCall, vitals: VitalsResult): void {
    if (active.readingSaved || (vitals.heartRate === null && vitals.breathingRate === null)) return;
    addVitalsReading(this.#options.db, {
      patientId: active.patientId,
      takenAt: vitals.measuredAt ?? this.#now(),
      heartRate: vitals.heartRate,
      breathingRate: vitals.breathingRate,
      method: "relay_call",
      confidence: vitals.heartRate !== null ? vitals.heartRateConfidence : vitals.breathingRateConfidence,
    });
    active.readingSaved = true;
  }

  /**
   * The voice answers a medicine question with the fixed MEDICINE_QUESTION_REPLY ("I'll add it to your
   * list"); her turn before it goes on her questions for the next visit, so that is true.
   */
  #saveMedicineQuestions(active: ActiveCall): void {
    active.transcript.forEach((turn, i) => {
      if (turn.speaker !== "agent" || !/doctor or pharmacist/i.test(turn.text) || !/add it to your list/i.test(turn.text)) return;
      const asked = active.transcript.slice(0, i).reverse().find((t) => t.speaker === "patient");
      if (asked) addVisitQuestion(this.#options.db, { patientId: active.patientId, text: asked.text, createdAt: this.#now() });
    });
  }

  /** Her usual range, read once per call; a record that can't be read means no comparison. */
  async #usualRange(active: ActiveCall): Promise<ContextPacket["usualRange"] | null> {
    if (active.usualRange !== undefined) return active.usualRange;
    try {
      active.usualRange = await loadUsualRange(this.#options.loadSnapshot, active.subject, active.day);
    } catch (error) {
      this.#log("call_usual_range_unavailable", { call_id: active.call.id, error: summary(error) });
      active.usualRange = null;
    }
    return active.usualRange;
  }

  #familyNames(patientId: string): string[] {
    return familyChats(this.#options.db, patientId).map((f) => f.displayName || f.handle);
  }

  /** Only her own Relay handle gets the call. */
  #patientForCall(call: Call): { id: string; finchnodePatientId: string; preferredName: string } | undefined {
    const caller = normalizeHandle(call.from.handle);
    if (!caller) return undefined;
    const rows = this.#options.db.prepare(`SELECT id, finchnode_patient_id AS finchnodePatientId, preferred_name AS preferredName, relay_handle AS relayHandle FROM patients`).all() as {
      id: string;
      finchnodePatientId: string;
      preferredName: string;
      relayHandle: string | null;
    }[];
    return rows.find((row) => row.relayHandle !== null && normalizeHandle(row.relayHandle) === caller);
  }

  /** Anyone else: the call is ended with a short polite message in their chat. Nothing from her record is read. Never throws. */
  async #decline(call: Call): Promise<void> {
    const relay = this.#options.relay;
    try {
      await relay.chats.messages.send(call.chat_id, { message: { parts: [{ type: "text", value: wrongCallerDecline() }], idempotency_key: `call:${call.id}:decline` } });
    } catch (error) {
      this.#log("call_decline_message_failed", { call_id: call.id, error: summary(error) });
    }
    try {
      await relay.calls.end(call.id);
    } catch (error) {
      this.#log("call_decline_end_failed", { call_id: call.id, error: summary(error) });
    }
  }

  async #callUnavailable(call: Call): Promise<void> {
    try {
      await this.#options.relay.chats.messages.send(call.chat_id, {
        message: { parts: [{ type: "text", value: "Sorry, the check-in call is unavailable right now. Please try again later." }], idempotency_key: `call:${call.id}:unavailable` },
      });
    } catch (error) {
      this.#log("call_unavailable_message_failed", { call_id: call.id, error: summary(error) });
    }
    try {
      await this.#options.relay.calls.end(call.id);
    } catch (error) {
      this.#log("call_unavailable_end_failed", { call_id: call.id, error: summary(error) });
    }
  }
}

/** The transport's video counters for the log: finite numbers and short strings per direction, never a frame. Undefined when it cannot say. */
function videoCounters(transport: RelayCallTransport): Record<string, Record<string, number | string>> | undefined {
  try {
    if (typeof transport.videoStats !== "function") return undefined;
    const stats = transport.videoStats() as unknown as Record<string, unknown> | null;
    if (typeof stats !== "object" || stats === null) return undefined;
    const kept: Record<string, Record<string, number | string>> = {};
    for (const direction of ["inbound", "outbound"]) {
      const counters = stats[direction];
      if (typeof counters !== "object" || counters === null) continue;
      kept[direction] = Object.fromEntries(Object.entries(counters).filter(([, value]) => (typeof value === "number" && Number.isFinite(value)) || (typeof value === "string" && value.length <= 32)));
    }
    return kept;
  } catch {
    return undefined;
  }
}

function summary(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
