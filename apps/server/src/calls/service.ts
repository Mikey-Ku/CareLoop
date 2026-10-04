import type Relay from "@relaymessenger/sdk";
import type { Call, CallWebhookEvent } from "@relaymessenger/sdk";
import { ElevenLabsCall, type ElevenLabsEvent } from "@relaymessenger/elevenlabs";
import type { CheckinEngine, SpokenTurn } from "../checkin/engine-types.ts";
import type { UnderstoodItem } from "../checkin/copy.ts";
import type { ContextPacket } from "../context/packet.ts";
import { getCallSession, addCallTranscript, correctLastAgentTurn, createCallSession, patchCallSession, callTranscript } from "../db/calls.ts";
import { getCheckinPatient } from "../db/checkins.ts";
import { familyChats } from "../db/family.ts";
import { addVisitQuestion } from "../db/notes.ts";
import { addVitalsReading } from "../db/vitals.ts";
import { normalizeHandle, type Config } from "../config.ts";
import type { Db } from "../db/index.ts";
import type { HealthRecord } from "../finchnode/types.ts";
import type { VitalsResult } from "../vitals/types.ts";
import { QUIET_MINUTE_PROMPT, callClosing, callFirstMessage, heartRateReadback, noReadingReadback, noVideoReadback, stillMeasuring, wrongCallerDecline } from "./copy.ts";
import { emergencyDecision } from "./emergency.ts";
import { callResult, emptyCallVitals, loadUsualRange } from "./screening.ts";
import { RelayPresageBridge } from "./video.ts";
import { andList } from "../text.ts";
import type { ScreeningResult, TranscriptTurn } from "./types.ts";

// A video check-in call (docs/CALLS.md). Relay rings, ElevenLabs holds a short warm conversation
// (it says it is an AI, asks today's unanswered questions, guides a quiet Presage reading, says the
// heart rate back, points her to family), and the server keeps the rules:
// - Only her Relay handle gets the call; anyone else gets a short polite decline and nothing from her record.
// - Each of her turns gets the safety screen as it arrives; a hit takes the typed safety path at once
//   (engine.screenSpokenTurn: her reply, every family chat alerted, a follow-up).
// - What the voice reads back about her health is fixed copy by ladder level (src/calls/copy.ts), from
//   a fresh reading of everything she said so far (never cached), and nothing a model wrote.
// - After the call her turns go through the same understanding pass and ladder as typed words
//   (engine.recordSpokenCheckin) and she gets ONE message saying what was noted.
// - The server ends the call after CALL_MAX_MINUTES.

export type CallLog = (event: string, fields?: Record<string, unknown>) => void;
export const RELAY_ANSWER_DEADLINE_MS = 32_000;
/** Longest wait for her check-in context before answering (Relay's answer deadline is 32 s). */
export const CALL_CONTEXT_TIMEOUT_MS = 5_000;

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
  /** Her check-in date now (YYYY-MM-DD, her time zone or CLOCK_DATE). Defaults to the UTC date. */
  today?: () => string;
  log?: CallLog;
  now?: () => string;
  /** The real clock, for Relay's own timestamps (the 32-second answer deadline). Defaults to `now`. */
  wallNow?: () => string;
};

type ActiveCall = {
  call: Call;
  patientId: string;
  subject: string;
  firstName: string;
  day: string;
  transcript: TranscriptTurn[];
  bridge?: RelayPresageBridge;
  elevenLabs?: ElevenLabsCall;
  /** Highest safety level seen so far (4 urgent, 5 crisis). */
  safetyLevel: number;
  /** Per-turn safety screens in flight; waited for before the call is recorded. */
  screens: Promise<void>[];
  ending: boolean;
  finishing?: Promise<void>;
  maxTimer?: ReturnType<typeof setTimeout>;
  readingSaved: boolean;
  /** Undefined until asked; null when her record couldn't be read (no comparison then). */
  usualRange?: ContextPacket["usualRange"] | null;
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
    active.elevenLabs?.close();
    await this.#finish(active);
  }

  async beginQuietMeasurement(callId: string, permissionGranted: boolean): Promise<{ status: string; durationMs: number }> {
    const active = this.#active.get(callId);
    if (!active?.bridge) throw new Error("call is not connected to a video track");
    active.bridge.beginQuietMeasurement(permissionGranted);
    patchCallSession(this.#options.db, callId, { phase: permissionGranted ? "quiet_measurement" : "interview", measurementStartedAt: permissionGranted ? this.#now() : undefined });
    return { status: active.bridge.quiet.status, durationMs: active.bridge.quiet.durationMs };
  }

  /**
   * The ElevenLabs tool: the ladder's reading of everything she has said so far, read fresh every time
   * (a later "chest pain" is never missed), as fixed copy. Safety acts for real; nothing else is recorded
   * until the call ends.
   */
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

  /**
   * The ElevenLabs tool after the quiet minute: the heart rate as a camera estimate (an in or out of usual
   * range phrase only when her record says to compare: never with AFib), breathing said, never compared,
   * then the ladder's one line about what she said. The reading is saved once per call.
   */
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
    if (!calls.elevenLabsApiKey || !calls.elevenLabsAgentId) {
      patchCallSession(this.#options.db, call.id, { status: "failed", phase: "failed", error: "ElevenLabs is not configured" });
      this.#log("call_skipped_not_configured", { call_id: call.id });
      this.#active.delete(call.id);
      return;
    }

    try {
      const context = await this.#context(patient, day);
      active.firstName = context.firstName;
      const bridge = await ElevenLabsCall.connect({
        relay: this.#options.relay,
        callId: call.id,
        elevenlabs: {
          apiKey: calls.elevenLabsApiKey,
          agentId: calls.elevenLabsAgentId,
          initiationData: {
            dynamic_variables: {
              call_id: call.id,
              patient_id: patient.id,
              patient_name: context.firstName,
              todays_questions: context.questions.map((q) => q.text).join(" | ") || "none",
              yesterday: context.yesterday.join("; ") || "nothing",
              recent_memories: context.memories.join("; ") || "none",
              family_names: andList(context.familyNames) || "none",
              quiet_prompt: QUIET_MINUTE_PROMPT,
              closing_line: callClosing(context.firstName, context.familyNames),
              max_minutes: String(calls.maxMinutes),
              screening_operation: "screen_symptoms",
            },
            conversation_config_override: { agent: { first_message: callFirstMessage(context.firstName) } },
          },
        },
        onEvent: (event) => this.#onElevenLabsEvent(active, event),
        onWarning: (message) => this.#log("call_bridge_warning", { call_id: call.id, message }),
      });
      active.elevenLabs = bridge;
      if (call.ringing_at && !withinRelayAnswerDeadline(call.ringing_at, this.#wallNow())) {
        throw new Error(`Relay answer deadline exceeded (${RELAY_ANSWER_DEADLINE_MS} ms)`);
      }
      active.bridge = calls.presageApiKey
        ? new RelayPresageBridge(bridge.transport, {
            apiKey: calls.presageApiKey,
            quietDurationMs: calls.quietMeasurementMs,
            minConfidence: calls.vitalsMinConfidence,
            log: (event, fields) => this.#log(event, { call_id: call.id, ...fields }),
          })
        : undefined;
      active.bridge?.start();
      // The call's length is ours: the server ends it after CALL_MAX_MINUTES.
      active.maxTimer = setTimeout(() => this.#timeUp(active), calls.maxMinutes * 60_000);
      active.maxTimer.unref?.();
      patchCallSession(this.#options.db, call.id, { status: "in_progress", phase: "interview", answeredAt: this.#now(), conversationId: bridge.conversationId ?? null });
      this.#log("call_answered", { call_id: call.id });
      await bridge.closed;
    } catch (error) {
      patchCallSession(this.#options.db, call.id, { status: "failed", phase: "failed", error: summary(error), endedAt: this.#now() });
      this.#log("call_bridge_failed", { call_id: call.id, error: summary(error) });
    } finally {
      await this.#finish(active);
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

  #timeUp(active: ActiveCall): void {
    if (active.ending) return;
    this.#log("call_time_limit", { call_id: active.call.id, minutes: this.#options.config.calls.maxMinutes });
    try {
      active.elevenLabs?.end();
    } catch {
      active.elevenLabs?.close();
    }
  }

  /**
   * Only final turns are kept: her `user_transcript` (the one event that gets the per-turn safety screen)
   * and the voice's `agent_response`. A correction rewrites the voice's last turn; it is never a new turn.
   */
  #onElevenLabsEvent(active: ActiveCall, event: ElevenLabsEvent): void {
    const read = readAgentEvent(event);
    if (!read) return;
    if (read.kind === "tool") {
      this.#log("call_tool_event", { call_id: active.call.id, type: read.type, tool: read.tool });
      return;
    }
    if (read.kind === "correction") {
      this.#correctAgentTurn(active, read.original, read.corrected);
      return;
    }
    const index = active.transcript.length;
    active.transcript.push(read.turn);
    addCallTranscript(this.#options.db, { callId: active.call.id, speaker: read.turn.speaker, text: read.turn.text, at: this.#now() });
    if (read.turn.speaker === "patient") active.screens.push(this.#screenTurn(active, { id: turnId(active.call.id, index), text: read.turn.text }));
  }

  /**
   * She talked over the voice, so ElevenLabs sends what it actually said. The voice's latest turn takes the
   * corrected text, in memory and in call_transcript_turns, but only when it is the turn being corrected.
   */
  #correctAgentTurn(active: ActiveCall, original: string, corrected: string): void {
    const index = active.transcript.findLastIndex((t) => t.speaker === "agent");
    const last = active.transcript[index];
    if (!last || squash(last.text) !== squash(original)) return;
    active.transcript[index] = { ...last, text: corrected };
    correctLastAgentTurn(this.#options.db, { callId: active.call.id, text: corrected });
  }

  /** The safety screen on one turn as it arrives; a hit takes the typed safety path at once. Never throws. */
  async #screenTurn(active: ActiveCall, turn: SpokenTurn): Promise<void> {
    const decision = emergencyDecision([{ speaker: "patient", text: turn.text }]);
    if (!decision) return;
    active.safetyLevel = Math.max(active.safetyLevel, decision.level);
    patchCallSession(this.#options.db, active.call.id, { phase: "emergency" });
    this.#log("call_safety_hit", { call_id: active.call.id, kind: decision.hit.kind });
    try {
      await this.#options.engine?.screenSpokenTurn(active.patientId, turn);
    } catch (error) {
      this.#log("call_safety_send_failed", { call_id: active.call.id, error: summary(error) });
    }
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
        screeningJson: JSON.stringify(result),
        measurementEndedAt: active.bridge?.quiet.status === "complete" ? this.#now() : undefined,
      });
    } catch (error) {
      this.#log("call_finish_failed", { call_id: callId, error: summary(error) });
    } finally {
      this.#active.delete(callId);
    }
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
}

/**
 * The ElevenLabs Agents server events the call reads, with only the fields used here (read as unknown: the
 * bridge forwards them unchecked). Shapes from the ElevenLabs Agents WebSocket AsyncAPI, as generated in
 * @elevenlabs/types (generated/types/asyncapi-types.ts). Every other type is ignored, never stored and never
 * screened: tentative_user_transcript, internal_tentative_agent_response, agent_chat_response_part,
 * agent_reasoning_response_part, audio, ping and the rest. A correction with no corrected text is ignored too.
 */
type AgentEvent =
  | { type: "user_transcript"; user_transcription_event?: { user_transcript?: unknown } }
  | { type: "agent_response"; agent_response_event?: { agent_response?: unknown } }
  | { type: "agent_response_correction"; agent_response_correction_event?: { original_agent_response?: unknown; corrected_agent_response?: unknown } }
  | { type: "agent_tool_request"; agent_tool_request?: { tool_name?: unknown } }
  | { type: "agent_tool_response"; agent_tool_response?: { tool_name?: unknown } };

type AgentEventRead =
  | { kind: "turn"; turn: TranscriptTurn }
  | { kind: "correction"; original: string; corrected: string }
  | { kind: "tool"; type: string; tool: string };

function readAgentEvent(event: ElevenLabsEvent): AgentEventRead | undefined {
  const e = event as AgentEvent;
  switch (e.type) {
    case "user_transcript": {
      const text = nonEmpty(e.user_transcription_event?.user_transcript);
      return text ? { kind: "turn", turn: { speaker: "patient", text } } : undefined;
    }
    case "agent_response": {
      const text = nonEmpty(e.agent_response_event?.agent_response);
      return text ? { kind: "turn", turn: { speaker: "agent", text } } : undefined;
    }
    case "agent_response_correction": {
      const original = nonEmpty(e.agent_response_correction_event?.original_agent_response);
      const corrected = nonEmpty(e.agent_response_correction_event?.corrected_agent_response);
      return original && corrected ? { kind: "correction", original, corrected } : undefined;
    }
    case "agent_tool_request":
    case "agent_tool_response": {
      const body = e.type === "agent_tool_request" ? e.agent_tool_request : e.agent_tool_response;
      const tool = nonEmpty(body?.tool_name);
      return tool ? { kind: "tool", type: e.type, tool } : undefined;
    }
    default:
      return undefined;
  }
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

const squash = (text: string) => text.replace(/\s+/g, " ").trim();

function summary(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
