import { describe, expect, it } from "vitest";
import { CLASSIFY_SAMPLES, describeClassification, main, SAMPLES } from "../src/cli/llm-check.ts";
import type { FetchLike } from "../src/llm/gemini.ts";

const KEY = "AIza_check_SECRET_789";

function run(env: Record<string, string>, fetch?: FetchLike) {
  const lines: string[] = [];
  const code = main(env, (l) => lines.push(l), { fetch, sleep: async () => {} });
  return code.then((c) => ({ code: c, output: lines.join("\n") }));
}

function reply(payload: unknown): Response {
  return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(payload) }] } }] }), { status: 200 });
}

describe("npm run llm:check", () => {
  it("names what .env is missing and exits 1 without a key", async () => {
    const { code, output } = await run({});
    expect(code).toBe(1);
    expect(output).toContain("GEMINI_API_KEY");
  });

  it("asks for gemini when another provider is set", async () => {
    const { code, output } = await run({ LLM_PROVIDER: "anthropic", GEMINI_API_KEY: KEY });
    expect(code).toBe(1);
    expect(output).toContain("LLM_PROVIDER=gemini");
    expect(output).not.toContain(KEY);
  });

  it("runs the samples, small talk and classification, printing results, models and timings, never the key", async () => {
    const fetch: FetchLike = async (url, init) => {
      const body = JSON.parse(String(init.body));
      if (url.includes("model-a")) return new Response("{}", { status: 503 });
      const properties = body.generationConfig.responseSchema.properties;
      if ("kind" in properties) {
        const pending = "answer" in properties;
        return reply({ kind: pending ? "answer" : "medicine_question", answer: pending ? "Yes" : "unclear", confidence: "high", complaints: [], memories: [], forFamily: "" });
      }
      return "answer" in properties
        ? reply({ answer: "unclear", confidence: "low", otherComplaints: [] })
        : reply({ text: "How lovely, enjoy the baking.", memories: ["granddaughter visiting Sunday"], complaints: [] });
    };
    const { code, output } = await run({ GEMINI_API_KEY: KEY, GEMINI_MODELS: "model-a,model-b" }, fetch);
    expect(code).toBe(0);
    for (const sample of SAMPLES) expect(output).toContain(sample.reply);
    expect(output).toContain("model model-b");
    expect(output).toContain("mapAnswer model-a #1 503");
    expect(output).toContain("How lovely, enjoy the baking.");
    for (const sample of CLASSIFY_SAMPLES) expect(output).toContain(`classifyMessage: "${sample.message}"`);
    expect(output).toContain("kind=medicine_question confidence=high");
    expect(output).toContain("kind=answer answer=Yes confidence=high");
    expect(output).toContain("pending: Did you have trouble breathing when lying flat last night? [No | Yes]");
    expect(output).toContain("classifyMessage model-a #1 503");
    expect(output).toContain("every call answered");
    expect(output).not.toContain(KEY);
  });

  it("has one classify sample per main kind, the last with a pending question", () => {
    expect(CLASSIFY_SAMPLES).toHaveLength(6);
    expect(CLASSIFY_SAMPLES.filter((s) => s.pending)).toHaveLength(1);
    expect(CLASSIFY_SAMPLES.at(-1)!.pending?.options).toEqual(["No", "Yes"]);
  });

  it("describes a classification on one line", () => {
    expect(
      describeClassification({ kind: "family_message", confidence: "high", complaints: ["tired"], memories: [], forFamily: "I love her" }),
    ).toBe('kind=family_message confidence=high forFamily="I love her" complaints=["tired"]');
  });

  it("exits 1 when calls get no answer", async () => {
    const fetch: FetchLike = async () => new Response("{}", { status: 404 });
    const { code, output } = await run({ GEMINI_API_KEY: KEY, GEMINI_MODELS: "gone" }, fetch);
    expect(code).toBe(1);
    expect(output).toContain("[FAIL]");
    expect(output).toContain("gone 404");
    expect(output).not.toContain(KEY);
  });
});
