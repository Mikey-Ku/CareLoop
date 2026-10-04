import type Relay from "@relaymessenger/sdk";
import type { Call, CallWebhookEvent } from "@relaymessenger/sdk";
import { ElevenLabsCall, type ElevenLabsEvent } from "@relaymessenger/elevenlabs";
import { getCallSession, addCallTranscript, createCallSession, patchCallSession, callTranscript, type CallSessionRow } from "../db/calls.ts";
import { getCheckinPatient } from "../db/checkins.ts";
import { type Config } from "../config.ts";
import type { Db } from "../db/index.ts";
import type { HealthRecord } from "../finchnode/types.ts";
import type { LlmClient } from "../llm/types.ts";
import { emptyCallVitals, loadScreeningContext, runScreening, type ScreeningDeps } from "./screening.ts";
import { RelayPresageBridge } from "./video.ts";
import type { ScreeningResult, TranscriptTurn } from "./types.ts";

export type CallLog = (event: string, fields?: Record<string, unknown>) => void;
export const RELAY_ANSWER_DEADLINE_MS = 32_000;

export function withinRelayAnswerDeadline(ringingAt: string, answeredAt: string, deadlineMs = RELAY_ANSWER_DEADLINE_MS): boolean {
  const elapsed = Date.parse(answeredAt) - Date.parse(ringingAt);
  return Number.isFinite(elapsed) && elapsed >= 0 && elapsed <= deadlineMs;
}

export type CallServiceOptions = {
  db: Db;
  config: Config;
  relay: Relay;
  loadSnapshot: (subject: string) => Promise<HealthRecord>;
  llm?: LlmClient;
  log?: CallLog;
  now?: () => string;
};

type ActiveCall = {
  call: Call;
  patientId: string;
  subject: string;
  transcript: TranscriptTurn[];
  bridge?: RelayPresageBridge;
  elevenLabs?: ElevenLabsCall;
  screening?: ScreeningResult;
  ending: boolean;
};

export type CallEventHandler = { handle(event: CallWebhookEvent): Promise<void> };

export class CallService implements CallEventHandler {
  readonly #options: CallServiceOptions;
  readonly #log: CallLog;
  readonly #now: () => string;
  readonly #active = new Map<string, ActiveCall>();

  constructor(options: CallServiceOptions) {
    this.#options = options;
    this.#log = options.log ?? (() => {});
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  /** Called from the durable inbox. It intentionally does not await a call's lifetime. */
  async handle(event: CallWebhookEvent): Promise<void> {
    if (event.event_type === "call.created") {
      void this.#start(event.data.call).catch((error) => this.#log("call_start_failed", { call_id: event.data.call.id, error: summary(error) }));
      return;
    }
    if (event.event_type === "call.updated") {
      const call = event.data.call;
      const active = this.#active.get(call.id);
      if (active) active.call = call;
      if (call.status === "in-progress") patchCallSession(this.#options.db, call.id, { status: "in_progress", answeredAt: call.answered_at ?? this.#now() });
      return;
    }
    await this.end(event.data.call.id);
  }

  async end(callId: string): Promise<void> {
    const active = this.#active.get(callId);
    if (!active) {
      patchCallSession(this.#options.db, callId, { status: "ended", phase: "complete", endedAt: this.#now() });
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

  /** Backend operation for an ElevenLabs tool. It returns the same approved result persisted after the call. */
  async screen(callId: string): Promise<ScreeningResult> {
    const active = this.#active.get(callId);
    const stored = getCallSession(this.#options.db, callId);
    if (!active && !stored) throw new Error("unknown call");
    if (active?.screening) return active.screening;
    const session = stored ?? active!;
    const patient = getCheckinPatient(this.#options.db, session.patientId);
    if (!patient) throw new Error("patient is not available");
    const transcript = active?.transcript ?? callTranscript(this.#options.db, callId);
    let result: ScreeningResult;
    let context: Awaited<ReturnType<typeof loadScreeningContext>>;
    try {
      context = await loadScreeningContext(this.#screeningDeps(), {
        patientId: patient.id,
        subject: patient.finchnodePatientId,
        checkinDate: this.#now().slice(0, 10),
      });
    } catch (error) {
      result = {
        callId,
        patientId: patient.id,
        symptoms: [],
        vitals: active?.bridge ? active.bridge.result() : emptyCallVitals(),
        finchEvidence: [{ source: "system", detail: "FinchNode context was unavailable for this call" }],
        concernLevel: "high",
        recommendedHumanAction: "contact_clinician_today",
        uncertainty: [`FinchNode lookup failed: ${summary(error)}`],
        patientResponseText: "Thank you for sharing that with me. I could not access your available care record just now, so I will not guess. A human member of your care team should review what you told me.",
        caregiverSummary: "FinchNode context was unavailable. Human review is required.",
      };
      patchCallSession(this.#options.db, callId, { phase: "failed", screeningJson: JSON.stringify(result), error: summary(error) });
      if (active) active.screening = result;
      return result;
    }
    try {
      result = await runScreening(this.#screeningDeps(), {
        callId,
        patientId: patient.id,
        transcript,
        currentVitals: active?.bridge ? active.bridge.result() : emptyCallVitals(),
        contextPacket: context.packet,
        recentMemories: context.recentMemories,
        symptomObservations: context.symptomObservations,
      });
    } catch (error) {
      result = {
        callId,
        patientId: patient.id,
        symptoms: [],
        vitals: active?.bridge ? active.bridge.result() : emptyCallVitals(),
        finchEvidence: [{ source: "system", detail: "Gemini screening was unavailable" }],
        concernLevel: "moderate",
        recommendedHumanAction: "monitor_and_document",
        uncertainty: [`Gemini screening failed: ${summary(error)}`],
        patientResponseText: "Thank you for explaining that. I have recorded what you shared, but I could not complete the evidence review. A human member of your care team should review it.",
        caregiverSummary: "Gemini was unavailable. Review the structured transcript, vitals, and FinchNode context manually.",
      };
    }
    patchCallSession(this.#options.db, callId, { phase: result.concernLevel === "emergency" || result.concernLevel === "crisis" ? "emergency" : "screening", screeningJson: JSON.stringify(result) });
    if (active) active.screening = result;
    return result;
  }

  #screeningDeps(): ScreeningDeps {
    return { db: this.#options.db, loadSnapshot: this.#options.loadSnapshot, ...(this.#options.llm ? { llm: this.#options.llm } : {}), now: this.#now };
  }

  async #start(call: Call): Promise<void> {
    const patient = this.#patientForCall(call);
    if (!patient) {
      this.#log("call_unknown_patient", { call_id: call.id });
      return;
    }
    const active: ActiveCall = { call, patientId: patient.id, subject: patient.finchnodePatientId, transcript: [], ending: false };
    this.#active.set(call.id, active);
    createCallSession(this.#options.db, { callId: call.id, patientId: patient.id, relayChatId: call.chat_id, at: this.#now() });
    if (!this.#options.config.calls.elevenLabsApiKey || !this.#options.config.calls.elevenLabsAgentId) {
      patchCallSession(this.#options.db, call.id, { status: "failed", phase: "failed", error: "ElevenLabs is not configured" });
      this.#log("call_skipped_not_configured", { call_id: call.id });
      this.#active.delete(call.id);
      return;
    }

    try {
      const bridge = await ElevenLabsCall.connect({
        relay: this.#options.relay,
        callId: call.id,
        elevenlabs: {
          apiKey: this.#options.config.calls.elevenLabsApiKey,
          agentId: this.#options.config.calls.elevenLabsAgentId,
          initiationData: {
            dynamic_variables: { patient_name: patient.preferredName, screening_operation: "screen_symptoms" },
            conversation_config_override: { agent: { first_message: `Hello ${patient.preferredName}. I’m here to listen and help organize what you are experiencing for your care team.` } },
          },
        },
        onEvent: (event) => this.#onElevenLabsEvent(active, event),
        onWarning: (message) => this.#log("call_bridge_warning", { call_id: call.id, message }),
      });
      active.elevenLabs = bridge;
      if (call.ringing_at && !withinRelayAnswerDeadline(call.ringing_at, this.#now())) {
        throw new Error(`Relay answer deadline exceeded (${RELAY_ANSWER_DEADLINE_MS} ms)`);
      }
      active.bridge = this.#options.config.calls.presageApiKey
        ? new RelayPresageBridge(bridge.transport, { apiKey: this.#options.config.calls.presageApiKey, quietDurationMs: this.#options.config.calls.quietMeasurementMs, log: (event, fields) => this.#log(event, { call_id: call.id, ...fields }) })
        : undefined;
      active.bridge?.start();
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

  #onElevenLabsEvent(active: ActiveCall, event: ElevenLabsEvent): void {
    const transcript = transcriptEvent(event);
    if (!transcript) return;
    active.transcript.push(transcript);
    addCallTranscript(this.#options.db, { callId: active.call.id, speaker: transcript.speaker, text: transcript.text, at: this.#now() });
    if (event.type === "client_tool_call" || event.type === "server_tool_call") this.#log("call_tool_event", { call_id: active.call.id, tool: toolName(event) });
  }

  async #finish(active: ActiveCall): Promise<void> {
    if (this.#active.get(active.call.id) !== active) return;
    const vitals = active.bridge ? await active.bridge.stop() : emptyCallVitals();
    try {
      if (!active.screening) await this.screen(active.call.id);
    } catch (error) {
      this.#log("call_screening_failed", { call_id: active.call.id, error: summary(error) });
    }
    if (active.screening) {
      active.screening = { ...active.screening, vitals };
      patchCallSession(this.#options.db, active.call.id, { screeningJson: JSON.stringify(active.screening) });
    }
    patchCallSession(this.#options.db, active.call.id, { status: "ended", phase: active.screening?.concernLevel === "emergency" || active.screening?.concernLevel === "crisis" ? "emergency" : "complete", endedAt: this.#now(), measurementEndedAt: active.bridge?.quiet.status === "complete" ? this.#now() : undefined });
    this.#active.delete(active.call.id);
  }

  #patientForCall(call: Call): { id: string; finchnodePatientId: string; preferredName: string } | undefined {
    const rows = this.#options.db.prepare(`SELECT id, finchnode_patient_id AS finchnodePatientId, preferred_name AS preferredName, relay_handle AS relayHandle FROM patients`).all() as { id: string; finchnodePatientId: string; preferredName: string; relayHandle: string | null }[];
    const exact = rows.find((row) => row.relayHandle?.replace(/^@/, "").toLowerCase() === call.from.handle.replace(/^@/, "").toLowerCase());
    return exact ?? (rows.length === 1 ? exact ?? rows[0] : undefined);
  }
}

function transcriptEvent(event: ElevenLabsEvent): TranscriptTurn | undefined {
  const type = event.type.toLowerCase();
  const speaker = type.includes("user") || type.includes("patient") ? "patient" : type.includes("agent") ? "agent" : undefined;
  if (!speaker) return undefined;
  const body = event[`${type}_event`];
  const text = firstString(body) ?? firstString(event);
  return text ? { speaker, text } : undefined;
}

function firstString(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (!value || typeof value !== "object") return undefined;
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (/transcript|response|text|message|agent|user/i.test(key) && typeof nested === "string" && nested.trim()) return nested.trim();
    if (/event|data|message/i.test(key)) {
      const found = firstString(nested);
      if (found) return found;
    }
  }
  return undefined;
}

function toolName(event: ElevenLabsEvent): string {
  const body = event[`${event.type}_event`];
  return firstString(body && typeof body === "object" ? (body as Record<string, unknown>).tool_name : undefined) ?? "unknown";
}

function summary(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
