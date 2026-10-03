import type {
  AnswerMapping,
  LlmCallOptions,
  LlmClient,
  MapAnswerInput,
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
};

export type FakeLlmCall =
  | { method: "mapAnswer"; input: MapAnswerInput }
  | { method: "smallTalk"; input: SmallTalkInput };

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

  /** Inputs of the mapAnswer calls only, in order. */
  get mapAnswerCalls(): MapAnswerInput[] {
    return this.calls.flatMap((c) => (c.method === "mapAnswer" ? [c.input] : []));
  }

  /** Inputs of the smallTalk calls only, in order. */
  get smallTalkCalls(): SmallTalkInput[] {
    return this.calls.flatMap((c) => (c.method === "smallTalk" ? [c.input] : []));
  }
}

function throwIfAborted(options: LlmCallOptions | undefined): void {
  if (options?.signal?.aborted) throw new LlmUnavailableError("fake: aborted");
}
