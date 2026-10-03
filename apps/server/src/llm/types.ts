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

export type LlmCallOptions = {
  /** Aborts the whole call, including retries and model fallbacks. */
  signal?: AbortSignal;
};

export interface LlmClient {
  /** "gemini", "anthropic" or "fake". */
  readonly provider: string;
  mapAnswer(input: MapAnswerInput, options?: LlmCallOptions): Promise<AnswerMapping>;
  smallTalk(input: SmallTalkInput, options?: LlmCallOptions): Promise<SmallTalkReply>;
}

/** Every model in the chain failed or the time budget ran out. Callers fall back to buttons or a template. */
export class LlmUnavailableError extends Error {
  override name = "LlmUnavailableError";
}
