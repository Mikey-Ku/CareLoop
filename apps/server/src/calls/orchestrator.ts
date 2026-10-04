import { crisisReply, urgentReply } from "../checkin/copy.ts";
import { guardSpoken } from "../context/guard.ts";
import type { CallCheckinContext } from "../checkin/engine-types.ts";
import type { HealthRecord } from "../finchnode/types.ts";
import type { CallScreeningLlmOutput, CallTurnLlmOutput, LlmClient } from "../llm/types.ts";
import type { VitalsResult } from "../vitals/types.ts";
import { CAMERA_GUIDANCE, CAMERA_OFFER_AT_END, CAMERA_STILL_OFF, QUIET_COUNTDOWN_SECONDS, QUIET_RETRY_OFFER, callClosing, callFirstMessage, quietCountdown, quietMeasurementPrompt } from "./copy.ts";
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
  /**
   * Whether the camera reading is possible right now, asked on every turn: Presage is configured and her
   * video is on (the call service watches the transport). An audio-only call, or a camera turned off, gets no offer.
   */
  canMeasure: () => boolean;
  /**
   * The camera reading is set up but her camera is off (asked each turn): before the goodbye she is told how
   * to turn it on, once. Absent: never.
   */
  cameraNeedsVideo?: () => boolean;
  /**
   * Whether the quiet window is still running (not cut short, for example by a stalled camera), asked every
   * second of it: when it is not, the window ends at once instead of counting down to nothing. Absent: always.
   */
  measurementActive?: () => boolean;
  quietMeasurementMs: number;
  speak: (text: string) => Promise<void>;
  /**
   * Awaited before the greeting, the first utterance of the call only (the call service waits for her
   * audio to arrive and writes a short silence). The greeting is spoken even if this rejects, and not at
   * all if the call has ended meanwhile.
   */
  beforeGreeting?: () => Promise<void>;
  recordAgentTurn: (text: string) => void;
  beginQuietMeasurement: () => void;
  /** The call ended with no camera offer because canMeasure() said no (not because she declined or it was taken): the service logs why. */
  onCameraOfferSkipped?: () => void;
  onComplete: (screening?: CallScreeningLlmOutput) => void;
  log?: (event: string, fields?: Record<string, unknown>) => void;
};

/** The same few words committed again within this long are one answer, not two. */
const REPEATED_TURN_MS = 3_000;
/** Said in place of the model's acknowledgment when it may not be said (src/context/guard.ts guardSpoken). */
const FALLBACK_ACKNOWLEDGMENT = "Thank you for telling me.";
/** Asked when the model's question may not be said and no unanswered check-in question is left. */
const OPEN_QUESTION = "Is there anything else you would like to tell me about how you are feeling?";
const CAMERA_QUESTION = "Would you be comfortable taking a quiet camera measurement?";

/** Stateful, one-question-at-a-time conversation planner for direct STT/TTS calls. */
export class ConversationOrchestrator {
  readonly #options: ConversationOrchestratorOptions;
  readonly #log: NonNullable<ConversationOrchestratorOptions["log"]>;
  #queue = Promise.resolve();
  #summary = "";
  #lastQuestion: string | undefined;
  #started = false;
  #greeted = false;
  /** Moves when she adds to what she said (a newer turn is queued, or she starts speaking again): see #stale. */
  #turnSeq = 0;
  #lastTurn = { key: "", at: 0 };
  #completed = false;
  #waitingForMeasurementConsent = false;
  /** She was told how to turn her camera on and her answer is awaited; the reading starts on her "ready". */
  #waitingForCameraOn = false;
  #cameraGuided = false;
  #cameraStillOffAsked = false;
  /** She was asked "yes or no" once more after an answer that was neither; a second one is taken as no. */
  #consentReasked = false;
  /** A reading with nothing usable is offered once more, once. */
  #retryOffered = false;
  #waitingForRetry = false;
  #measurementDeclined = false;
  /** She said yes and the quiet reading was started: it is never offered or asked for again. */
  #measurementDone = false;
  #measurementTimer: ReturnType<typeof setTimeout> | undefined;
  #countdownTimer: ReturnType<typeof setInterval> | undefined;
  /** Her FinchNode record, read on the first turn that needs it (see #loadContext). */
  #record: Promise<HealthRecord> | undefined;
  #phase: "interview" | "quiet_measurement" | "screening" = "interview";

  constructor(options: ConversationOrchestratorOptions) {
    this.#options = options;
    this.#log = options.log ?? (() => {});
  }

  start(): void {
    if (this.#started) return;
    this.#started = true;
    void this.#greet().catch((error) => {
      this.#log("call_greeting_failed", { error: summary(error) });
      this.#completed = true;
      this.#options.onComplete();
    });
  }

  /** The greeting, which says this is an AI, has been spoken (or failed, or was dropped): until then the call service lets nothing cut it off. */
  get greeted(): boolean {
    return this.#greeted;
  }

  async #greet(): Promise<void> {
    try {
      if (this.#options.beforeGreeting) {
        try {
          await this.#options.beforeGreeting();
        } catch (error) {
          this.#log("call_greeting_lead_in_failed", { error: summary(error) }); // a missing lead-in never costs her the greeting
        }
        if (this.#completed) return; // the call ended while we waited: nobody to greet
      }
      await this.#speak(callFirstMessage(this.#options.firstName));
    } finally {
      this.#greeted = true;
    }
  }

  handlePatientTurn(text: string): Promise<void> {
    if (this.#isRepeat(text)) return this.#queue; // not a new answer: the turn in progress stays current
    const seq = text.trim() ? ++this.#turnSeq : this.#turnSeq;
    this.#queue = this.#queue.then(() => this.#handlePatientTurn(text, seq)).catch(async (error) => {
      this.#log("call_turn_failed", { error: summary(error) });
      // The call is over (nobody to speak to), or she has said more since (the newer turn answers, and an apology
      // for the old one would talk over it).
      if (this.#completed || this.#stale(seq)) return;
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

  /** The speech-to-text can commit one short answer twice ("No." "No."); the second would read as an answer to whatever is asked next. */
  #isRepeat(text: string): boolean {
    const key = text.toLowerCase().replace(/[^a-z0-9' ]+/g, " ").trim().replace(/\s+/g, " ");
    const now = Date.now();
    const repeat = key !== "" && key.split(" ").length <= 3 && key === this.#lastTurn.key && now - this.#lastTurn.at < REPEATED_TURN_MS;
    if (!repeat) this.#lastTurn = { key, at: now };
    return repeat;
  }

  /**
   * She started speaking again (the call service calls this when a partial transcript has two real words).
   * Whatever Gemini is still planning for her earlier words is out of date: its reply is dropped, and her
   * next committed turn answers everything she said.
   */
  noteSpeech(): void {
    this.#turnSeq += 1;
  }

  close(): void {
    this.#completed = true;
    clearTimeout(this.#measurementTimer);
    clearInterval(this.#countdownTimer);
  }

  async #handlePatientTurn(text: string, seq: number): Promise<void> {
    if (this.#completed || !text.trim()) return;
    // Keep transcription/audit of speech during the quiet window, but don't break the measurement or
    // make Gemini talk over the patient. The complete transcript is reconsidered after the window.
    if (this.#phase === "quiet_measurement") return;
    if (this.#waitingForCameraOn) {
      this.#waitingForCameraOn = false;
      const ready = !negative(text) && (affirmative(text) || cameraIsOn(text));
      if (ready && this.#options.canMeasure()) {
        await this.#startMeasurement(); // her camera is on and she said ready: that is her yes
        return;
      }
      if (!negative(text) && !this.#cameraStillOffAsked) {
        this.#cameraStillOffAsked = true;
        this.#waitingForCameraOn = true;
        await this.#speak(CAMERA_STILL_OFF);
        return;
      }
      // A no, or a camera that never came on: there is no reading.
      this.#measurementDeclined = true;
      await this.#speak("Of course. We can skip the camera measurement.");
    }
    if (this.#waitingForRetry) {
      this.#waitingForRetry = false;
      if (!negative(text) && (affirmative(text) || /\btry again\b/i.test(text)) && this.#options.canMeasure()) {
        await this.#startMeasurement(); // her camera is still on and she said yes
        return;
      }
      await this.#speak("Of course. We can skip the camera measurement.");
    }
    if (this.#waitingForMeasurementConsent) {
      this.#waitingForMeasurementConsent = false;
      if (affirmative(text)) {
        await this.#startMeasurement();
        return;
      }
      if (!negative(text) && !this.#consentReasked) {
        this.#consentReasked = true;
        this.#waitingForMeasurementConsent = true;
        await this.#speak("Would you like to try the quiet camera measurement? You can say yes or no.");
        return;
      }
      // A no, or a second answer that is not a yes: there is no reading.
      this.#measurementDeclined = true;
      await this.#speak("Of course. We can skip the camera measurement.");
    }
    if (asksToRepeat(text)) {
      await this.#speak(`Of course. ${this.#lastQuestion ?? "How are you feeling today?"}`);
      return;
    }
    await this.#planTurn(this.#phase, seq);
  }

  /**
   * Turns are queued, so a second committed transcript (a slow speaker pausing mid-sentence) would wait for
   * the first turn's whole Gemini call and spoken reply, and the reply would answer half of what she said.
   * A turn is stale once she has added to it since it was queued: it is dropped without a word and without
   * touching the summary or the last question, and the newer turn runs with everything she said.
   */
  #stale(seq: number | undefined): boolean {
    return seq !== undefined && seq !== this.#turnSeq;
  }

  async #planTurn(interviewPhase: "interview" | "quiet_measurement" | "screening", seq?: number): Promise<void> {
    if (this.#completed || this.#stale(seq)) return;
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
      canMeasure: this.#canMeasure,
      interviewPhase: interviewPhase === "quiet_measurement" ? "screening" : interviewPhase,
    });
    if (this.#completed || this.#stale(seq)) return;
    this.#summary = summarize(decision.informationCollected, decision.missingInformation, decision.uncertainty);
    // What the model wrote is said only if it passes the output guard (no dosing, instructions, diagnosis,
    // reassurance, 911 or 988); a sentence that does not is replaced by a fixed one.
    const acknowledgment = guardSpoken(decision.acknowledgment) ?? FALLBACK_ACKNOWLEDGMENT;
    if (decision.nextAction === "ask_follow_up" && decision.nextQuestion) {
      const question = this.#question(decision.nextQuestion);
      this.#lastQuestion = question;
      if (isRepeatedQuestion(question, this.#options.transcript)) {
        await this.#speak("Thank you. I have that information, so I will ask about the next detail instead. What changed most recently?");
        return;
      }
      await this.#speak(`${acknowledgment} ${question}`);
      return;
    }
    if ((decision.nextAction === "request_measurement_permission" || decision.nextAction === "start_quiet_measurement") && this.#canMeasure) {
      this.#waitingForMeasurementConsent = true;
      const question = (decision.nextQuestion && guardSpoken(decision.nextQuestion)) || CAMERA_QUESTION;
      this.#lastQuestion = question;
      await this.#speak(`${acknowledgment} ${question}`);
      return;
    }
    if (decision.nextAction === "complete_screening" && this.#canMeasure) {
      // Gemini has what it needs, but the reading only happens if she is asked, and Gemini asks only
      // sometimes. So the offer is ours: once, in fixed words, before the goodbye. Her answer takes the
      // consent path above; after the reading or her no, the next turn that ends the call says goodbye.
      // Not for end_call: she said she has to go, and gets the goodbye without another question.
      this.#waitingForMeasurementConsent = true;
      await this.#speak(CAMERA_OFFER_AT_END);
      return;
    }
    if (decision.nextAction === "complete_screening" && this.#needsCameraOn) {
      // The reading is set up but her camera is off: how to turn it on, once, in fixed words, before the goodbye.
      // No offer was made because her video is off, which the call service logs.
      this.#options.onCameraOfferSkipped?.();
      await this.#speak(CAMERA_GUIDANCE);
      this.#cameraGuided = true; // only once it was said: a voice failure leaves her unguided, and the next turn guides her
      this.#waitingForCameraOn = true;
      return;
    }
    if (decision.nextAction === "complete_screening" || decision.nextAction === "emergency" || decision.nextAction === "end_call") {
      if (decision.nextAction === "complete_screening" && !this.#measurementDeclined && !this.#measurementDone) this.#options.onCameraOfferSkipped?.();
      // The screening is stored with the call and runs while the goodbye is spoken; none of its words, and
      // none of the model's, are ever said. The goodbye or the emergency words are ours (src/calls/copy.ts).
      const screening = this.#finalScreening();
      await this.#speak(this.#farewell(decision.nextAction));
      this.#completed = true;
      this.#options.onComplete(await screening);
      return;
    }
    this.#lastQuestion = undefined;
    const reply = decision.patientResponseText.trim();
    if (!reply) return;
    const spoken = guardSpoken(reply);
    if (spoken) {
      await this.#speak(spoken);
      return;
    }
    const question = this.#question(null);
    this.#lastQuestion = question;
    await this.#speak(`${FALLBACK_ACKNOWLEDGMENT} ${question}`);
  }

  /** From a timer: nothing awaits it, so a failure (she hung up while the call was ending) is logged, never thrown. */
  #endMeasurement(): void {
    void this.#afterMeasurement().catch((error) => this.#log("call_turn_failed", { error: summary(error) }));
  }

  async #afterMeasurement(): Promise<void> {
    clearInterval(this.#countdownTimer);
    if (this.#completed) return;
    this.#phase = "screening";
    const vitals = this.#options.getVitals();
    const noReading = vitals.heartRate === null && vitals.breathingRate === null;
    if (noReading && !this.#retryOffered && this.#options.canMeasure()) {
      this.#retryOffered = true;
      this.#waitingForRetry = true;
      await this.#speak(QUIET_RETRY_OFFER);
      return;
    }
    await this.#speak(noReading
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

  /** She said yes (or ready) to the quiet reading: the prompt, the window, and the readback when it ends. */
  async #startMeasurement(): Promise<void> {
    this.#phase = "quiet_measurement";
    this.#measurementDone = true;
    await this.#speak(quietMeasurementPrompt(Math.round(this.#options.quietMeasurementMs / 1000)));
    this.#options.beginQuietMeasurement();
    this.#measurementTimer = setTimeout(() => this.#endMeasurement(), this.#options.quietMeasurementMs + 500);
    this.#measurementTimer.unref?.();
    this.#runCountdown();
  }

  /**
   * Once a second of the quiet window: says how many seconds are left at the marks (copy.ts), and ends the
   * window at once, with the usual "no clear reading" words, if it was cut short, instead of counting down
   * to nothing.
   */
  #runCountdown(): void {
    const total = Math.round(this.#options.quietMeasurementMs / 1000);
    const marks = QUIET_COUNTDOWN_SECONDS.filter((left) => left <= total - 5);
    let elapsed = 0;
    clearInterval(this.#countdownTimer);
    this.#countdownTimer = setInterval(() => {
      elapsed += 1;
      if (this.#completed || this.#phase !== "quiet_measurement" || elapsed >= total) {
        clearInterval(this.#countdownTimer);
        return;
      }
      if (this.#options.measurementActive && !this.#options.measurementActive()) {
        clearInterval(this.#countdownTimer);
        clearTimeout(this.#measurementTimer);
        this.#endMeasurement();
        return;
      }
      const left = total - elapsed;
      if (marks.includes(left)) void this.#speak(quietCountdown(left)).catch((error) => this.#log("call_countdown_failed", { error: summary(error) }));
    }, 1000);
    this.#countdownTimer.unref?.();
  }

  /** The reading is set up, her camera is off, and she has not been told yet, said no, or had it taken. */
  get #needsCameraOn(): boolean {
    return Boolean(this.#options.cameraNeedsVideo?.()) && !this.#cameraGuided && !this.#measurementDeclined && !this.#measurementDone;
  }

  /** The camera reading is possible now, she hasn't said no, and it hasn't been taken: so it can be offered, and never twice. */
  get #canMeasure(): boolean {
    return this.#options.canMeasure() && !this.#measurementDeclined && !this.#measurementDone;
  }

  /**
   * What she hears as the call ends. Gemini's "emergency" alone does not make her hear 911 or 988: those words
   * are said only when the fixed screen over her turns hits too (the call service runs it on every turn and
   * speaks the same replies itself, so this is the rare second look). 988 for a crisis, 911 otherwise, with an
   * empty family list so they claim no alert: nobody has been told yet. Without a hit the call ends with the
   * goodbye, and the ladder after the call, where the model's reading can raise the level, decides who is
   * told, in fixed words as well. (Without the empty list the replies say "I've let your family know".)
   */
  #farewell(action: CallTurnLlmOutput["nextAction"]): string {
    if (action === "emergency") {
      const rule = emergencyDecision(this.#options.transcript);
      if (rule) return rule.level >= 5 ? crisisReply(this.#options.firstName, []) : urgentReply(this.#options.firstName, []);
      this.#log("call_model_emergency_unconfirmed");
    }
    return callClosing(this.#options.firstName, this.#options.initialContext.familyNames);
  }

  /** The question to ask: the model's if it passes the guard, else the next unanswered check-in question not yet asked, else an open one. */
  #question(modelQuestion: string | null): string {
    const safe = modelQuestion ? guardSpoken(modelQuestion) : undefined;
    if (safe) return safe;
    const next = this.#options.initialContext.questions.find((q) => !isRepeatedQuestion(q.text, this.#options.transcript));
    return next?.text ?? OPEN_QUESTION;
  }

  async #loadContext(): Promise<unknown> {
    // Her record is read once per call: a call lasts minutes, and fetching it again on every turn cost
    // 0.1 to 0.3 s each. A failed read is not kept, so the next turn tries again.
    let loading: Promise<HealthRecord> | undefined;
    try {
      loading = this.#record ??= this.#options.loadSnapshot(this.#options.subject);
      const record = await loading;
      return {
        dataAsOf: record.meta.dataAsOf,
        syncStatus: record.meta.syncStatus,
        conditions: record.data.conditions.slice(0, 30).map(({ name, status, onsetDate }) => ({ name, status, onsetDate })),
        medications: record.data.medications.slice(0, 30).map(({ name, dosage, status }) => ({ name, dosage, status })),
        labs: record.data.labs.slice(0, 50).map(({ name, value, unit, date, referenceRange, interpretation }) => ({ name, value, unit, date, referenceRange, interpretation })),
        vitals: record.data.vitals.slice(0, 30).map(({ name, value, unit, date, referenceRange }) => ({ name, value, unit, date, referenceRange })),
      };
    } catch (error) {
      if (loading && this.#record === loading) this.#record = undefined;
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
  return /^(yes|yeah|yep|yup|sure|okay|ok|alright|all right|sounds good|let's do it|why not|that's fine|i agree|go ahead)\b/i.test(text.trim());
}

/** "Sorry, what did you ask?", "pardon", "can you say that again": the whole utterance, not a sentence that merely starts so. */
function asksToRepeat(text: string): boolean {
  return /^(?:sorry|excuse me|oh)?[\s,.]*(?:what|pardon|huh|come again|what did you (?:say|ask)|(?:can|could) you (?:say|repeat) that(?: again)?|say that again|i (?:didn'?t|couldn'?t) (?:catch|hear) (?:that|you))[\s?.!]*$/i.test(text.trim());
}

/** "Ready", "it's on", "done": she turned her camera on, as asked. */
function cameraIsOn(text: string): boolean {
  return /^(ready|i'?m ready|it'?s on|it is on|its on|done|all set|i turned it on|camera'?s on|on now)\b/i.test(text.trim());
}

function negative(text: string): boolean {
  return /^(no|nope|nah|not now|not today|not really|maybe later|skip|i'd rather not|i would rather not|i do not|i don't|don't|do not)\b/i.test(text.trim());
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
