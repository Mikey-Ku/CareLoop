import { crisisReply, urgentReply } from "../checkin/copy.ts";
import type { CallCheckinContext } from "../checkin/engine-types.ts";
import type { HealthRecord } from "../finchnode/types.ts";
import type { CallScreeningLlmOutput, LlmClient } from "../llm/types.ts";
import type { VitalsResult } from "../vitals/types.ts";
import { callClosing, callFirstMessage, quietMeasurementPrompt } from "./copy.ts";
import { emergencyDecision } from "./emergency.ts";
import type { TranscriptTurn } from "./types.ts";

export type ConversationOrchestratorOptions = {
  callId: string;
  patientId: string;
  subject: string;
  firstName: string;
  transcript: TranscriptTurn[];
  initialContext: CallCheckinContext;
  llm?: LlmClient;
  loadSnapshot: (subject: string) => Promise<HealthRecord>;
  getVitals: () => VitalsResult;
  canMeasure: boolean;
  quietMeasurementMs: number;
  speak: (text: string) => Promise<void>;
  recordAgentTurn: (text: string) => void;
  beginQuietMeasurement: () => void;
  onComplete: (screening?: CallScreeningLlmOutput) => void;
  log?: (event: string, fields?: Record<string, unknown>) => void;
};

/** Stateful, one-question-at-a-time conversation planner for direct STT/TTS calls. */
export class ConversationOrchestrator {
  readonly #options: ConversationOrchestratorOptions;
  readonly #log: NonNullable<ConversationOrchestratorOptions["log"]>;
  #queue = Promise.resolve();
  #summary = "";
  #lastQuestion: string | undefined;
  #started = false;
  #completed = false;
  #waitingForMeasurementConsent = false;
  #measurementDeclined = false;
  #measurementTimer: ReturnType<typeof setTimeout> | undefined;
  #phase: "interview" | "quiet_measurement" | "screening" = "interview";

  constructor(options: ConversationOrchestratorOptions) {
    this.#options = options;
    this.#log = options.log ?? (() => {});
  }

  start(): void {
    if (this.#started) return;
    this.#started = true;
    void this.#speak(callFirstMessage(this.#options.firstName)).catch((error) => {
      this.#log("call_greeting_failed", { error: summary(error) });
      this.#completed = true;
      this.#options.onComplete();
    });
  }

  handlePatientTurn(text: string): Promise<void> {
    this.#queue = this.#queue.then(() => this.#handlePatientTurn(text)).catch(async (error) => {
      this.#log("call_turn_failed", { error: summary(error) });
      if (this.#completed) return; // the call is over: nobody to speak to
      try {
        await this.#speak("I am sorry, I did not catch that clearly. Please tell me once more.");
      } catch (speechError) {
        this.#log("call_fallback_speech_failed", { error: summary(speechError) });
        this.#completed = true;
        this.#options.onComplete();
      }
    });
    return this.#queue;
  }

  close(): void {
    this.#completed = true;
    clearTimeout(this.#measurementTimer);
  }

  async #handlePatientTurn(text: string): Promise<void> {
    if (this.#completed || !text.trim()) return;
    // Keep transcription/audit of speech during the quiet window, but don't break the measurement or
    // make Gemini talk over the patient. The complete transcript is reconsidered after the window.
    if (this.#phase === "quiet_measurement") return;
    if (this.#waitingForMeasurementConsent) {
      this.#waitingForMeasurementConsent = false;
      if (affirmative(text)) {
        this.#phase = "quiet_measurement";
        await this.#speak(quietMeasurementPrompt(Math.round(this.#options.quietMeasurementMs / 1000)));
        this.#options.beginQuietMeasurement();
        this.#measurementTimer = setTimeout(() => void this.#afterMeasurement(), this.#options.quietMeasurementMs + 500);
        this.#measurementTimer.unref?.();
        return;
      }
      if (negative(text)) {
        this.#measurementDeclined = true;
        await this.#speak("Of course. We can skip the camera measurement.");
      } else {
        this.#waitingForMeasurementConsent = true;
        await this.#speak("Would you like to try the quiet camera measurement? You can say yes or no.");
        return;
      }
    }
    if (asksToRepeat(text)) {
      await this.#speak(`Of course. ${this.#lastQuestion ?? "How are you feeling today?"}`);
      return;
    }
    await this.#planTurn(this.#phase);
  }

  async #planTurn(interviewPhase: "interview" | "quiet_measurement" | "screening"): Promise<void> {
    if (this.#completed) return;
    const llm = this.#options.llm;
    if (!llm?.callTurn) {
      await this.#speak("Thank you for telling me. I have noted what you shared, and a human member of your care team can review it.");
      this.#completed = true;
      return;
    }
    const finchContext = await this.#loadContext();
    const decision = await llm.callTurn({
      callId: this.#options.callId,
      patientId: this.#options.patientId,
      seniorName: this.#options.firstName,
      transcript: this.#options.transcript.map(({ speaker, text: value }) => ({ speaker, text: value })),
      conversationSummary: [
        this.#summary,
        `Today's unanswered check-in questions: ${this.#options.initialContext.questions.map((q) => q.text).join(" | ") || "none"}.`,
        `Yesterday's topics: ${this.#options.initialContext.yesterday.join("; ") || "none"}.`,
      ].join(" "),
      knownSymptoms: [],
      unansweredQuestions: this.#options.initialContext.questions.map((q) => q.text),
      ...(this.#lastQuestion ? { lastQuestionAsked: this.#lastQuestion } : {}),
      currentVitals: this.#options.getVitals(),
      finchContext,
      recentMemories: [...this.#options.initialContext.memories],
      canMeasure: this.#options.canMeasure && !this.#measurementDeclined,
      interviewPhase: interviewPhase === "quiet_measurement" ? "screening" : interviewPhase,
    });
    if (this.#completed) return;
    this.#summary = summarize(decision.informationCollected, decision.missingInformation, decision.uncertainty);
    this.#lastQuestion = decision.nextQuestion ?? undefined;
    if (decision.nextAction === "ask_follow_up" && decision.nextQuestion) {
      if (isRepeatedQuestion(decision.nextQuestion, this.#options.transcript)) {
        await this.#speak("Thank you. I have that information, so I will ask about the next detail instead. What changed most recently?");
        return;
      }
      await this.#speak(`${decision.acknowledgment} ${decision.nextQuestion}`);
      return;
    }
    if ((decision.nextAction === "request_measurement_permission" || decision.nextAction === "start_quiet_measurement") && this.#options.canMeasure && !this.#measurementDeclined) {
      this.#waitingForMeasurementConsent = true;
      const question = decision.nextQuestion ?? "Would you be comfortable taking a quiet camera measurement?";
      await this.#speak(`${decision.acknowledgment} ${question}`);
      return;
    }
    if (decision.nextAction === "complete_screening" || decision.nextAction === "emergency" || decision.nextAction === "end_call") {
      // The screening is stored with the call and runs while the goodbye is spoken; none of its words, and
      // none of the model's, are ever said. The goodbye or the emergency words are ours (src/calls/copy.ts).
      const screening = this.#finalScreening();
      await this.#speak(decision.nextAction === "emergency" ? this.#emergencyWords() : callClosing(this.#options.firstName, this.#options.initialContext.familyNames));
      this.#completed = true;
      this.#options.onComplete(await screening);
      return;
    }
    const spoken = decision.patientResponseText.trim();
    if (spoken) await this.#speak(spoken);
  }

  async #afterMeasurement(): Promise<void> {
    if (this.#completed) return;
    this.#phase = "screening";
    const vitals = this.#options.getVitals();
    await this.#speak(vitals.heartRate === null && vitals.breathingRate === null
      ? "I couldn't get a clear camera reading this time. That's okay."
      : `The camera estimate is about ${vitals.heartRate === null ? "" : `${Math.round(vitals.heartRate)} beats a minute for your heart rate`}${vitals.heartRate !== null && vitals.breathingRate !== null ? " and " : ""}${vitals.breathingRate === null ? "" : `${Math.round(vitals.breathingRate)} breaths a minute for your breathing`}. This is an estimate, not a medical test.`);
    await this.#planTurn("screening");
  }

  async #speak(text: string): Promise<void> {
    const spoken = text.replace(/\s+/g, " ").trim();
    if (!spoken) return;
    this.#options.recordAgentTurn(spoken);
    await this.#options.speak(spoken);
  }

  /**
   * What she hears when Gemini declares an emergency: the text check-in's fixed replies, 988 for a crisis
   * (the fixed screen over her turns decides, never the model) and 911 otherwise. Nobody has been told yet,
   * so no family member is named; the ladder after the call decides who is alerted.
   */
  #emergencyWords(): string {
    const crisis = (emergencyDecision(this.#options.transcript)?.level ?? 0) >= 5;
    return crisis ? crisisReply(this.#options.firstName) : urgentReply(this.#options.firstName);
  }

  async #loadContext(): Promise<unknown> {
    try {
      const record = await this.#options.loadSnapshot(this.#options.subject);
      return {
        dataAsOf: record.meta.dataAsOf,
        syncStatus: record.meta.syncStatus,
        conditions: record.data.conditions.slice(0, 30).map(({ name, status, onsetDate }) => ({ name, status, onsetDate })),
        medications: record.data.medications.slice(0, 30).map(({ name, dosage, status }) => ({ name, dosage, status })),
        labs: record.data.labs.slice(0, 50).map(({ name, value, unit, date, referenceRange, interpretation }) => ({ name, value, unit, date, referenceRange, interpretation })),
        vitals: record.data.vitals.slice(0, 30).map(({ name, value, unit, date, referenceRange }) => ({ name, value, unit, date, referenceRange })),
      };
    } catch (error) {
      this.#log("call_finch_context_failed", { error: summary(error) });
      return { unavailable: true };
    }
  }

  async #finalScreening(): Promise<CallScreeningLlmOutput | undefined> {
    const llm = this.#options.llm;
    if (!llm?.screenCall) return undefined;
    try {
      return await llm.screenCall({
        patientId: this.#options.patientId,
        transcript: this.#options.transcript.map(({ speaker, text }) => ({ speaker, text })),
        vitals: this.#options.getVitals(),
        finchContext: await this.#loadContext(),
        recentMemories: [...this.#options.initialContext.memories],
        symptomObservations: [],
      });
    } catch (error) {
      this.#log("call_final_screening_failed", { error: summary(error) });
      return undefined;
    }
  }
}

function affirmative(text: string): boolean {
  return /^(yes|yeah|yep|sure|okay|ok|that's fine|i agree|go ahead)\b/i.test(text.trim());
}

/** "Sorry, what did you ask?", "pardon", "can you say that again": the whole utterance, not a sentence that merely starts so. */
function asksToRepeat(text: string): boolean {
  return /^(?:sorry|excuse me|oh)?[\s,.]*(?:what|pardon|huh|come again|what did you (?:say|ask)|(?:can|could) you (?:say|repeat) that(?: again)?|say that again|i (?:didn'?t|couldn'?t) (?:catch|hear) (?:that|you))[\s?.!]*$/i.test(text.trim());
}

function negative(text: string): boolean {
  return /^(no|nope|not now|i'd rather not|don't|do not)\b/i.test(text.trim());
}

function isRepeatedQuestion(question: string, transcript: readonly TranscriptTurn[]): boolean {
  const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const candidate = normalize(question);
  return transcript.some((turn) => turn.speaker === "agent" && normalize(turn.text).includes(candidate));
}

function summarize(collected: string[], missing: string[], uncertainty: string[]): string {
  return JSON.stringify({ collected: collected.slice(0, 8), missing: missing.slice(0, 8), uncertainty: uncertainty.slice(0, 8) });
}

function summary(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
