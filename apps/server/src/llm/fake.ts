import type {
  AnswerMapping,
  CheckinExtraction,
  ClassifyInput,
  ExtractCheckinInput,
  LlmCallOptions,
  LlmClient,
  MapAnswerInput,
  MessageClassification,
  SmallTalkInput,
  SmallTalkReply,
} from "./types.ts";
import { LlmUnavailableError } from "./types.ts";

// A deterministic LlmClient for tests and offline runs. Each method answers
// from a scripted function; returning an Error makes the call throw it, so a
// test can play "Gemini is down" with `() => new LlmUnavailableError("down")`.

export type FakeLlmScript = {
  mapAnswer?: (input: MapAnswerInput) => AnswerMapping | Error;
  smallTalk?: (input: SmallTalkInput) => SmallTalkReply | Error;
  classifyMessage?: (input: ClassifyInput) => MessageClassification | Error;
  extractCheckin?: (input: ExtractCheckinInput) => CheckinExtraction | Error;
};

export type FakeLlmCall =
  | { method: "mapAnswer"; input: MapAnswerInput }
  | { method: "smallTalk"; input: SmallTalkInput }
  | { method: "classifyMessage"; input: ClassifyInput }
  | { method: "extractCheckin"; input: ExtractCheckinInput };

export class FakeLlmClient implements LlmClient {
  readonly provider = "fake";
  /** Every call in order, with the input it got. */
  readonly calls: FakeLlmCall[] = [];
  private readonly script: FakeLlmScript;

  constructor(script: FakeLlmScript = {}) {
    this.script = script;
  }

  async mapAnswer(input: MapAnswerInput, options?: LlmCallOptions): Promise<AnswerMapping> {
    this.calls.push({ method: "mapAnswer", input });
    throwIfAborted(options);
    const result = this.script.mapAnswer
      ? this.script.mapAnswer(input)
      : { answer: "unclear", confidence: "low" as const, otherComplaints: [] };
    if (result instanceof Error) throw result;
    return { ...result, otherComplaints: [...result.otherComplaints] };
  }

  async smallTalk(input: SmallTalkInput, options?: LlmCallOptions): Promise<SmallTalkReply> {
    this.calls.push({ method: "smallTalk", input });
    throwIfAborted(options);
    if (!this.script.smallTalk) throw new LlmUnavailableError("fake: no smallTalk script");
    const result = this.script.smallTalk(input);
    if (result instanceof Error) throw result;
    return { ...result, memories: [...result.memories], complaints: [...result.complaints] };
  }

  /** Unscripted: plain chat with low confidence, so the caller takes its safest default path. */
  async classifyMessage(input: ClassifyInput, options?: LlmCallOptions): Promise<MessageClassification> {
    this.calls.push({ method: "classifyMessage", input });
    throwIfAborted(options);
    const result: MessageClassification | Error = this.script.classifyMessage
      ? this.script.classifyMessage(input)
      : { kind: "chat", confidence: "low", complaints: [], memories: [] };
    if (result instanceof Error) throw result;
    return {
      ...result,
      complaints: [...result.complaints],
      memories: [...result.memories],
      ...(result.symptoms ? { symptoms: result.symptoms.map((s) => ({ ...s })) } : {}),
    };
  }

  /** Unscripted: nothing extracted, so the caller asks today's questions with buttons. */
  async extractCheckin(input: ExtractCheckinInput, options?: LlmCallOptions): Promise<CheckinExtraction> {
    this.calls.push({ method: "extractCheckin", input });
    throwIfAborted(options);
    const result: CheckinExtraction | Error = this.script.extractCheckin
      ? this.script.extractCheckin(input)
      : { answers: [], symptoms: [], memories: [] };
    if (result instanceof Error) throw result;
    return {
      answers: result.answers.map((a) => ({ ...a })),
      symptoms: result.symptoms.map((s) => ({ ...s })),
      memories: [...result.memories],
    };
  }

  /** Inputs of the mapAnswer calls only, in order. */
  get mapAnswerCalls(): MapAnswerInput[] {
    return this.calls.flatMap((c) => (c.method === "mapAnswer" ? [c.input] : []));
  }

  /** Inputs of the smallTalk calls only, in order. */
  get smallTalkCalls(): SmallTalkInput[] {
    return this.calls.flatMap((c) => (c.method === "smallTalk" ? [c.input] : []));
  }

  /** Inputs of the classifyMessage calls only, in order. */
  get classifyCalls(): ClassifyInput[] {
    return this.calls.flatMap((c) => (c.method === "classifyMessage" ? [c.input] : []));
  }

  /** Inputs of the extractCheckin calls only, in order. */
  get extractCalls(): ExtractCheckinInput[] {
    return this.calls.flatMap((c) => (c.method === "extractCheckin" ? [c.input] : []));
  }
}

function throwIfAborted(options: LlmCallOptions | undefined): void {
  if (options?.signal?.aborted) throw new LlmUnavailableError("fake: aborted");
}
