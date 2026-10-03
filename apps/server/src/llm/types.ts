// What the app needs from any LLM provider (Gemini today, Claude possible).
// The LLM only reads and words. It never decides what is medically risky:
// fixed rules act on the answer she taps or that the mapping picks, and a
// red-flag question always goes back to her for a one-tap confirm.

export type Confidence = "high" | "medium" | "low";

export type MapAnswerInput = {
  /** The pending question, as she saw it. */
  question: string;
  /** The question's button labels; the mapping must be one of these or "unclear". */
  options: string[];
  /** What she typed. */
  reply: string;
};

export type AnswerMapping = {
  /** One of the input options exactly, or "unclear". */
  answer: string;
  confidence: Confidence;
  /** Other things she mentioned about how she feels, in her own words (saved as memories, never acted on). */
  otherComplaints: string[];
};

export type SmallTalkInput = {
  seniorName: string;
  /** What she typed when no question was waiting. */
  message: string;
  /** A few things she told us before, newest first (memories). */
  memories?: string[];
};

export type SmallTalkReply = {
  /** A short, warm reply. The caller checks it before sending and falls back to a template. */
  text: string;
  /** Facts about her life worth remembering ("my granddaughter visits Sunday"), in her words. */
  memories: string[];
  /** Health complaints she mentioned, in her words. When any are present the caller sends a fixed reply instead of `text`. */
  complaints: string[];
};

/**
 * What kind of message she sent. The LLM sorts; fixed rules react (src/checkin/reactions).
 * crisis and urgent_symptom are also caught by a fixed phrase screen (src/safety/screen.ts):
 * either one triggers the reaction, so a model miss never hides an emergency.
 */
export type MessageKind =
  | "answer" // answers the pending question
  | "more_detail" // wants to explain more, or describes how the symptom felt
  | "medicine_question" // asks about her medicines (stop, change, side effects)
  | "feeling_low" // lonely, sad, grieving, worried
  | "urgent_symptom" // chest pain, a fall, can't breathe, fainting, heavy bleeding now
  | "crisis" // thoughts of self-harm or not wanting to live
  | "family_message" // something meant for her family ("tell Sarah I love her")
  | "chat"; // anything else: news, plans, off-topic

export const MESSAGE_KINDS: readonly MessageKind[] = [
  "answer",
  "more_detail",
  "medicine_question",
  "feeling_low",
  "urgent_symptom",
  "crisis",
  "family_message",
  "chat",
];

export type ClassifyInput = {
  seniorName: string;
  message: string;
  /** The question waiting for an answer, if any. */
  pending?: { question: string; options: string[] } | undefined;
};

export type MessageClassification = {
  kind: MessageKind;
  /** kind "answer" only: one of pending.options exactly, or "unclear". */
  answer?: string | undefined;
  confidence: Confidence;
  /** Health complaints she mentioned, her words. */
  complaints: string[];
  /** Life facts worth remembering, her words. */
  memories: string[];
  /** kind "family_message" only: what to pass on, her words. */
  forFamily?: string | undefined;
  /** Symptoms she mentioned with how much and whether new or worse; rules set the level. Empty when none. */
  symptoms?: SymptomMention[] | undefined;
};

/** How much of a symptom she describes. */
export type Amount = "none" | "a_little" | "a_lot" | "unknown";
/** Compared with her usual. */
export type Change = "new" | "worse" | "same" | "better" | "unknown";

/** One symptom she mentioned, extracted from her words. Rules turn these into a ladder level (docs/DESIGN.md "Severity ladder"). */
export type SymptomMention = {
  /** A question id from the bank when it matches one of today's questions, else a short topic in plain words ("knee pain", "cough"). */
  topic: string;
  questionId?: string | undefined;
  amount: Amount;
  change: Change;
  /** Her words for it, trimmed. */
  words: string;
};

export type ExtractCheckinInput = {
  seniorName: string;
  /** Her reply to the open question ("How are you feeling today?"). */
  message: string;
  /** Today's questions, each with its button labels. */
  questions: { id: string; question: string; options: string[] }[];
};

export type CheckinExtraction = {
  /** One entry per question she clearly answered; questions she didn't cover are left out. answer is one of that question's options exactly. */
  answers: { questionId: string; answer: string; confidence: Confidence }[];
  /** Every symptom she mentioned, including ones today's questions don't cover. */
  symptoms: SymptomMention[];
  memories: string[];
};

export type LlmCallOptions = {
  /** Aborts the whole call, including retries and model fallbacks. */
  signal?: AbortSignal;
};

export interface LlmClient {
  /** "gemini", "anthropic" or "fake". */
  readonly provider: string;
  mapAnswer(input: MapAnswerInput, options?: LlmCallOptions): Promise<AnswerMapping>;
  smallTalk(input: SmallTalkInput, options?: LlmCallOptions): Promise<SmallTalkReply>;
  /** Sort one typed message. Never decides risk on its own: the fixed phrase screen runs first and wins. */
  classifyMessage(input: ClassifyInput, options?: LlmCallOptions): Promise<MessageClassification>;
  /** Pull answers to all of today's questions, and every symptom, out of her reply to the open question. */
  extractCheckin(input: ExtractCheckinInput, options?: LlmCallOptions): Promise<CheckinExtraction>;
}

/** Every model in the chain failed or the time budget ran out. Callers fall back to buttons or a template. */
export class LlmUnavailableError extends Error {
  override name = "LlmUnavailableError";
}
