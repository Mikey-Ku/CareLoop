import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.ts";
import type { AttemptLogEntry } from "../src/llm/fallback.ts";
import {
  GeminiLlmClient,
  MAP_ANSWER_SYSTEM_PROMPT,
  candidateText,
  cleanList,
  parseMapping,
  parseSmallTalk,
  type FetchLike,
  type GeminiDeps,
} from "../src/llm/gemini.ts";
import { createLlmClient, describeLlm, FakeLlmClient, LlmUnavailableError } from "../src/llm/index.ts";

const KEY = "AIza_test_SECRET_key_123";
const ANKLE = {
  question: "Have your ankles or feet been more swollen than usual?",
  options: ["No", "A little", "Yes, more than usual"],
  reply: "my ankles are a bit puffy today and I slept badly",
};

type Call = { url: string; init: RequestInit; body: any };
type Step = Response | Error | ((init: RequestInit) => Promise<Response>);

/** A fetch that plays `steps` in order and records every call. */
function scriptedFetch(steps: Step[]): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(String(init.body)) });
    const step = steps.shift();
    if (!step) throw new Error("scriptedFetch: no more steps");
    if (step instanceof Error) throw step;
    if (typeof step === "function") return step(init);
    return step;
  };
  return { fetch, calls };
}

/** A 200 whose model text is `payload` as JSON (or a raw string). */
function ok(payload: unknown): Response {
  const text = typeof payload === "string" ? payload : JSON.stringify(payload);
  return new Response(JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text }] } }] }), { status: 200 });
}

function status(code: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ error: { code, message: "nope" } }), { status: code, headers });
}

/** A fetch step that never answers but rejects when its signal aborts, like real fetch. */
function hang(init: RequestInit): Promise<Response> {
  return new Promise((_, reject) => {
    const signal = init.signal as AbortSignal;
    signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
  });
}

function client(steps: Step[], extra: Partial<GeminiDeps> & { models?: string[]; timeoutMs?: number; attemptTimeoutMs?: number } = {}) {
  const { fetch, calls } = scriptedFetch(steps);
  const log: AttemptLogEntry[] = [];
  const pauses: number[] = [];
  const { models, timeoutMs, attemptTimeoutMs, ...deps } = extra;
  const llm = new GeminiLlmClient(
    { apiKey: KEY, models: models ?? ["model-a", "model-b"], timeoutMs: timeoutMs ?? 5000, attemptTimeoutMs },
    {
      fetch,
      logger: (e) => log.push(e),
      sleep: async (ms) => {
        pauses.push(ms);
      },
      random: () => 0.5,
      ...deps,
    },
  );
  return { llm, calls, log, pauses };
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected a rejection");
}

describe("Gemini request shape", () => {
  it("posts the mapping prompt with a schema enum of the options plus unclear, key only in the header", async () => {
    const { llm, calls } = client([ok({ answer: "A little", confidence: "high", otherComplaints: ["slept badly"] })]);
    const result = await llm.mapAnswer(ANKLE);
    expect(result).toEqual({ answer: "A little", confidence: "high", otherComplaints: ["slept badly"] });

    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call!.url).toBe("https://generativelanguage.googleapis.com/v1beta/models/model-a:generateContent");
    expect(call!.url).not.toContain(KEY);
    expect(call!.init.method).toBe("POST");
    const headers = call!.init.headers as Record<string, string>;
    expect(headers["x-goog-api-key"]).toBe(KEY);
    expect(headers["content-type"]).toBe("application/json");
    expect(String(call!.init.body)).not.toContain(KEY);
    expect(call!.init.signal).toBeInstanceOf(AbortSignal);

    const body = call!.body;
    expect(body.systemInstruction.parts[0].text).toBe(MAP_ANSWER_SYSTEM_PROMPT);
    expect(MAP_ANSWER_SYSTEM_PROMPT).toContain("never choose the calmest option");
    expect(body.contents).toHaveLength(1);
    expect(body.contents[0].role).toBe("user");
    expect(JSON.parse(body.contents[0].parts[0].text)).toEqual(ANKLE);
    expect(body.generationConfig).toMatchObject({ temperature: 0, responseMimeType: "application/json" });
    // Cost: capped output and no reasoning tokens.
    expect(body.generationConfig).toMatchObject({ maxOutputTokens: 200, thinkingConfig: { thinkingLevel: "minimal" } });
    const schema = body.generationConfig.responseSchema;
    expect(schema.type).toBe("OBJECT");
    expect(schema.required).toEqual(["answer", "confidence", "otherComplaints"]);
    expect(schema.properties.answer).toEqual({ type: "STRING", enum: ["No", "A little", "Yes, more than usual", "unclear"] });
    expect(schema.properties.confidence.enum).toEqual(["high", "medium", "low"]);
    expect(schema.properties.otherComplaints).toEqual({ type: "ARRAY", items: { type: "STRING" } });
  });

  it("posts small talk with name, message and memories, and a text/memories/complaints schema", async () => {
    const { llm, calls } = client([ok({ text: "That sounds lovely, Harriet. Enjoy the baking!", memories: ["granddaughter visiting Sunday"], complaints: [] })]);
    const reply = await llm.smallTalk({ seniorName: "Harriet", message: "my granddaughter is visiting on Sunday, I'm baking", memories: ["likes roses"] });
    expect(reply).toEqual({ text: "That sounds lovely, Harriet. Enjoy the baking!", memories: ["granddaughter visiting Sunday"], complaints: [] });
    const body = calls[0]!.body;
    expect(body.systemInstruction.parts[0].text).toContain("Never say or suggest you are a person, a friend or family");
    expect(JSON.parse(body.contents[0].parts[0].text)).toEqual({
      herName: "Harriet",
      message: "my granddaughter is visiting on Sunday, I'm baking",
      thingsSheToldUsBefore: ["likes roses"],
    });
    expect(body.generationConfig.responseSchema.required).toEqual(["text", "memories", "complaints"]);
  });

  it("drops duplicate options and a literal 'unclear' from the enum", async () => {
    const { llm, calls } = client([ok({ answer: "no", confidence: "high", otherComplaints: [] })]);
    await llm.mapAnswer({ question: "q", options: ["No", "no ", "Unclear", "Yes"], reply: "nope" });
    expect(calls[0]!.body.generationConfig.responseSchema.properties.answer.enum).toEqual(["No", "Yes", "unclear"]);
  });

  it("answers unclear without a request when there are no options or no reply", async () => {
    const { llm, calls } = client([]);
    expect(await llm.mapAnswer({ question: "q", options: [], reply: "yes" })).toEqual({ answer: "unclear", confidence: "low", otherComplaints: [] });
    expect(await llm.mapAnswer({ ...ANKLE, reply: "   " })).toEqual({ answer: "unclear", confidence: "low", otherComplaints: [] });
    expect(calls).toHaveLength(0);
  });
});

describe("mapping validation", () => {
  it("normalizes case and spacing to the option's own spelling", async () => {
    const { llm } = client([
      ok({ answer: "a little", confidence: "medium", otherComplaints: [] }),
      ok({ answer: "  YES,  MORE THAN USUAL ", confidence: "high", otherComplaints: [] }),
    ]);
    expect((await llm.mapAnswer(ANKLE)).answer).toBe("A little");
    expect((await llm.mapAnswer(ANKLE)).answer).toBe("Yes, more than usual");
  });

  it("turns invalid JSON into unclear with low confidence", () => {
    expect(parseMapping("not json {", ANKLE.options)).toEqual({ answer: "unclear", confidence: "low", otherComplaints: [] });
    expect(parseMapping(JSON.stringify({ confidence: "high" }), ANKLE.options)).toEqual({ answer: "unclear", confidence: "low", otherComplaints: [] });
  });

  it("turns an answer outside the options into unclear but keeps her other complaints", () => {
    const text = JSON.stringify({ answer: "Maybe", confidence: "high", otherComplaints: ["headache"] });
    expect(parseMapping(text, ANKLE.options)).toEqual({ answer: "unclear", confidence: "low", otherComplaints: ["headache"] });
    const unclear = JSON.stringify({ answer: "Unclear", confidence: "high", otherComplaints: [] });
    expect(parseMapping(unclear, ANKLE.options)).toEqual({ answer: "unclear", confidence: "low", otherComplaints: [] });
  });

  it("treats an unknown confidence as low and bad complaint lists as empty", () => {
    const text = JSON.stringify({ answer: "No", confidence: "very", otherComplaints: "tired" });
    expect(parseMapping(text, ANKLE.options)).toEqual({ answer: "No", confidence: "low", otherComplaints: [] });
  });

  it("an invalid model reply over the wire is unclear, not an error", async () => {
    const { llm } = client([ok("{ broken"), ok({ answer: "Sideways", confidence: "high", otherComplaints: [] })]);
    expect(await llm.mapAnswer(ANKLE)).toEqual({ answer: "unclear", confidence: "low", otherComplaints: [] });
    expect(await llm.mapAnswer(ANKLE)).toEqual({ answer: "unclear", confidence: "low", otherComplaints: [] });
  });
});

describe("lists", () => {
  it("trims, drops blanks, repeats and non-strings, caps at 5 items of 200 characters, softens long dashes", () => {
    const long = "x".repeat(250);
    expect(cleanList(["  slept   badly ", "", "Slept badly", 7, "knee \u2014 sore", long, "a", "b", "c", "d"])).toEqual([
      "slept badly",
      "knee, sore",
      "x".repeat(200),
      "a",
      "b",
    ]);
  });
});

describe("small talk validation", () => {
  const good = { text: "That sounds lovely.", memories: [], complaints: [] };

  it("accepts a short reply and cleans its lists", () => {
    const reply = parseSmallTalk(JSON.stringify({ ...good, memories: [" baking  on Sunday ", "baking on sunday"], complaints: ["sore hip"] }));
    expect(reply).toEqual({ text: "That sounds lovely.", memories: ["baking on Sunday"], complaints: ["sore hip"] });
  });

  it.each([
    ["an em dash", { ...good, text: "Lovely \u2014 enjoy it." }],
    ["an en dash", { ...good, text: "Lovely \u2013 enjoy it." }],
    ["too long", { ...good, text: "a".repeat(401) }],
    ["empty", { ...good, text: "   " }],
    ["missing text", { memories: [], complaints: [] }],
  ])("rejects %s with LlmUnavailableError", (_label, payload) => {
    expect(() => parseSmallTalk(JSON.stringify(payload))).toThrow(LlmUnavailableError);
  });

  it("rejects JSON that doesn't parse", () => {
    expect(() => parseSmallTalk("{ nope")).toThrow(LlmUnavailableError);
  });

  it("a rejected reply over the wire throws LlmUnavailableError", async () => {
    const { llm } = client([ok({ ...good, text: "Lovely \u2014 enjoy it." })]);
    await expect(llm.smallTalk({ seniorName: "Harriet", message: "hi" })).rejects.toBeInstanceOf(LlmUnavailableError);
  });
});

describe("response envelope", () => {
  it("joins the answer parts and skips thought parts", () => {
    const raw = JSON.stringify({ candidates: [{ content: { parts: [{ text: "thinking", thought: true }, { text: '{"a":' }, { text: "1}" }] } }] });
    expect(candidateText(raw)).toBe('{"a":1}');
  });

  it("is undefined for no candidates, no text or a non-JSON body", () => {
    expect(candidateText(JSON.stringify({ promptFeedback: { blockReason: "SAFETY" } }))).toBeUndefined();
    expect(candidateText(JSON.stringify({ candidates: [{ content: { parts: [{ text: "  " }] } }] }))).toBeUndefined();
    expect(candidateText("<html>")).toBeUndefined();
  });

  it("a 200 with no candidates moves to the next model without a retry", async () => {
    const empty = new Response(JSON.stringify({ promptFeedback: { blockReason: "OTHER" } }), { status: 200 });
    const { llm, calls, log } = client([empty, ok({ answer: "No", confidence: "high", otherComplaints: [] })]);
    expect((await llm.mapAnswer(ANKLE)).answer).toBe("No");
    expect(calls.map((c) => c.url.includes("model-b"))).toEqual([false, true]);
    expect(log.map((e) => e.status)).toEqual(["empty", 200]);
  });
});

describe("retries and fallbacks", () => {
  // A fresh Response each time: a body can only be read once.
  const answer = () => Promise.resolve(ok({ answer: "No", confidence: "high", otherComplaints: [] }));
  const modelOf = (c: Call) => c.url.split("/models/")[1]!.split(":")[0];

  it("retries the same model once after a 500, with a jittered pause", async () => {
    const { llm, calls, log, pauses } = client([status(500), answer]);
    expect((await llm.mapAnswer(ANKLE)).answer).toBe("No");
    expect(calls.map(modelOf)).toEqual(["model-a", "model-a"]);
    expect(log.map((e) => [e.operation, e.model, e.attempt, e.status])).toEqual([
      ["mapAnswer", "model-a", 1, 500],
      ["mapAnswer", "model-a", 2, 200],
    ]);
    expect(pauses).toEqual([500]); // 250 base + 0.5 * 500 jitter
    expect(log.every((e) => typeof e.ms === "number" && e.ms >= 0)).toBe(true);
  });

  it.each([503, 429])("a busy model (%i) is skipped at once: next model, no pause", async (code) => {
    const { llm, calls, log, pauses } = client([status(code), answer]);
    expect((await llm.mapAnswer(ANKLE)).answer).toBe("No");
    expect(calls.map(modelOf)).toEqual(["model-a", "model-b"]);
    expect(log.map((e) => e.status)).toEqual([code, 200]);
    expect(pauses).toEqual([]);
  });

  it("retries 500 and network errors on the same model, then moves on", async () => {
    const { llm, calls } = client([status(500), new TypeError("fetch failed"), answer]);
    expect((await llm.mapAnswer(ANKLE)).answer).toBe("No");
    expect(calls.map(modelOf)).toEqual(["model-a", "model-a", "model-b"]);
  });

  it.each([400, 401, 403, 404])("skips to the next model at once on %i", async (code) => {
    const { llm, calls, pauses } = client([status(code), answer]);
    expect((await llm.mapAnswer(ANKLE)).answer).toBe("No");
    expect(calls.map(modelOf)).toEqual(["model-a", "model-b"]);
    expect(pauses).toEqual([]);
  });

  it("honours Retry-After, capped at 2 seconds", async () => {
    const first = client([status(500, { "retry-after": "1" }), answer]);
    await first.llm.mapAnswer(ANKLE);
    expect(first.pauses).toEqual([1000]);
    const second = client([status(502, { "retry-after": "30" }), answer]);
    await second.llm.mapAnswer(ANKLE);
    expect(second.pauses).toEqual([2000]);
  });

  it("throws LlmUnavailableError naming every status, never the key", async () => {
    const { llm } = client([status(500), status(503), status(404)]);
    const err = await rejection(llm.mapAnswer(ANKLE));
    expect(err).toBeInstanceOf(LlmUnavailableError);
    expect(err.message).toContain("model-a 500, model-a 503, model-b 404");
    expect(err.message).not.toContain(KEY);
    expect(String(err.stack)).not.toContain(KEY);
  });

  it("gives up with LlmUnavailableError when the time budget runs out", async () => {
    const { llm, log } = client([hang, hang, hang, hang], { timeoutMs: 60, sleep: undefined });
    const started = Date.now();
    const err = await rejection(llm.mapAnswer(ANKLE));
    expect(err).toBeInstanceOf(LlmUnavailableError);
    expect(err.message).toContain("60 ms budget ran out");
    expect(err.message).toContain("model-a timeout");
    expect(Date.now() - started).toBeLessThan(1000);
    expect(log).toHaveLength(1); // the budget was gone, so no retry and no second model
  });

  it("enforces the budget even when fetch ignores the abort signal", async () => {
    const deaf = () => new Promise<Response>(() => {});
    const { llm } = client([deaf], { timeoutMs: 40 });
    await expect(llm.mapAnswer(ANKLE)).rejects.toBeInstanceOf(LlmUnavailableError);
  });

  it("does not retry when the pause would overrun the budget", async () => {
    const { llm, calls } = client([status(500, { "retry-after": "2" }), answer], { timeoutMs: 1000 });
    expect((await llm.mapAnswer(ANKLE)).answer).toBe("No");
    expect(calls.map(modelOf)).toEqual(["model-a", "model-b"]);
  });

  it("a model whose single attempt timed out is skipped for the next one", async () => {
    const { llm, calls, log } = client([hang, answer], { attemptTimeoutMs: 30, timeoutMs: 2000 });
    expect((await llm.mapAnswer(ANKLE)).answer).toBe("No");
    expect(calls.map(modelOf)).toEqual(["model-a", "model-b"]);
    expect(log.map((e) => e.status)).toEqual(["timeout", 200]);
  });

  it("stops at once when the caller's signal aborts, and aborts the request", async () => {
    const { llm, calls } = client([hang, hang]);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    const err = await rejection(llm.mapAnswer(ANKLE, { signal: controller.signal }));
    expect(err).toBeInstanceOf(LlmUnavailableError);
    expect(err.message).toContain("aborted");
    expect(calls).toHaveLength(1);
    expect((calls[0]!.init.signal as AbortSignal).aborted).toBe(true);
  });

  it("never calls fetch when the signal is already aborted", async () => {
    const { llm, calls } = client([answer]);
    await expect(llm.smallTalk({ seniorName: "Harriet", message: "hi" }, { signal: AbortSignal.abort() })).rejects.toBeInstanceOf(LlmUnavailableError);
    expect(calls).toHaveLength(0);
  });

  it("aborting during the retry pause ends the call", async () => {
    const controller = new AbortController();
    const { llm, calls } = client([status(500), answer], { sleep: undefined, random: () => 1 });
    setTimeout(() => controller.abort(), 20);
    const err = await rejection(llm.mapAnswer(ANKLE, { signal: controller.signal }));
    expect(err.message).toContain("aborted");
    expect(calls).toHaveLength(1);
  });
});

describe("the key never leaks from the client", () => {
  it("is not in JSON, inspect output or String()", () => {
    const { llm } = client([]);
    expect(JSON.stringify(llm)).not.toContain(KEY);
    expect(inspect(llm, { depth: 10, showHidden: true })).not.toContain(KEY);
    expect(String(llm)).not.toContain(KEY);
  });
});

describe("createLlmClient", () => {
  it("is undefined without a key, so the app stays on buttons", () => {
    const config = loadConfig({});
    expect(createLlmClient(config)).toBeUndefined();
    expect(describeLlm(config)).toContain("GEMINI_API_KEY is not set");
  });

  it("is undefined for anthropic, which has no adapter yet", () => {
    const config = loadConfig({ LLM_PROVIDER: "anthropic", GEMINI_API_KEY: KEY });
    expect(createLlmClient(config)).toBeUndefined();
    expect(describeLlm(config)).toContain("anthropic");
  });

  it("builds a Gemini client from the config or its llm section, using the configured models", async () => {
    const config = loadConfig({ GEMINI_API_KEY: KEY, GEMINI_MODELS: "m1, m2" });
    expect(createLlmClient(config.llm)?.provider).toBe("gemini");
    const { fetch, calls } = scriptedFetch([status(404), ok({ answer: "No", confidence: "high", otherComplaints: [] })]);
    const log: AttemptLogEntry[] = [];
    const llm = createLlmClient(config, { fetch, logger: (e) => log.push(e) });
    expect(llm).toBeInstanceOf(GeminiLlmClient);
    expect((await llm!.mapAnswer(ANKLE)).answer).toBe("No");
    expect(calls.map((c) => c.url.split("/models/")[1])).toEqual(["m1:generateContent", "m2:generateContent"]);
    expect((calls[0]!.init.headers as Record<string, string>)["x-goog-api-key"]).toBe(KEY);
    expect(log.map((e) => e.model)).toEqual(["m1", "m2"]);
    expect(describeLlm(config)).toBe("free text on: gemini m1, m2 (12000 ms budget per call, 4000 ms per try)");
    expect(describeLlm(config)).not.toContain(KEY);
  });
});

describe("FakeLlmClient", () => {
  it("answers from its script and records each call", async () => {
    const fake = new FakeLlmClient({
      mapAnswer: (input) => ({ answer: input.options[1]!, confidence: "high", otherComplaints: ["slept badly"] }),
      smallTalk: (input) => ({ text: `Hello ${input.seniorName}.`, memories: [], complaints: [] }),
    });
    expect(fake.provider).toBe("fake");
    expect(await fake.mapAnswer(ANKLE)).toEqual({ answer: "A little", confidence: "high", otherComplaints: ["slept badly"] });
    expect(await fake.smallTalk({ seniorName: "Harriet", message: "hi" })).toEqual({ text: "Hello Harriet.", memories: [], complaints: [] });
    expect(fake.calls).toEqual([
      { method: "mapAnswer", input: ANKLE },
      { method: "smallTalk", input: { seniorName: "Harriet", message: "hi" } },
    ]);
    expect(fake.mapAnswerCalls).toEqual([ANKLE]);
    expect(fake.smallTalkCalls).toHaveLength(1);
  });

  it("throws a returned Error, and still records the call", async () => {
    const fake = new FakeLlmClient({ mapAnswer: () => new LlmUnavailableError("gemini down") });
    await expect(fake.mapAnswer(ANKLE)).rejects.toThrow("gemini down");
    expect(fake.calls).toHaveLength(1);
  });

  it("defaults: mapAnswer is unclear, smallTalk is unavailable, an aborted signal throws", async () => {
    const fake = new FakeLlmClient();
    expect(await fake.mapAnswer(ANKLE)).toEqual({ answer: "unclear", confidence: "low", otherComplaints: [] });
    await expect(fake.smallTalk({ seniorName: "Harriet", message: "hi" })).rejects.toBeInstanceOf(LlmUnavailableError);
    await expect(fake.mapAnswer(ANKLE, { signal: AbortSignal.abort() })).rejects.toBeInstanceOf(LlmUnavailableError);
  });
});
