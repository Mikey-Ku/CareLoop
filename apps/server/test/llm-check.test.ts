import { describe, expect, it } from "vitest";
import {
  CLASSIFY_SAMPLES,
  CLASSIFY_SYMPTOM_SAMPLES,
  describeClassification,
  describeExtraction,
  EXTRACT_SAMPLES,
  main,
  SAMPLES,
  TODAY_QUESTIONS,
} from "../src/cli/llm-check.ts";
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

  it("runs the samples, small talk, classification and extraction, printing results, models and timings, never the key", async () => {
    const fetch: FetchLike = async (url, init) => {
      const body = JSON.parse(String(init.body));
      if (url.includes("model-a")) return new Response("{}", { status: 503 });
      const properties = body.generationConfig.responseSchema.properties;
      const user = JSON.parse(body.contents[0].parts[0].text);
      if ("kind" in properties) {
        const pending = "answer" in properties;
        const symptoms = String(user.message).includes("knee")
          ? [{ words: "my knee really hurts", topic: "knee pain", amount: "a_lot", change: "unknown" }]
          : [];
        return reply({
          kind: pending ? "answer" : "medicine_question",
          answer: pending ? "Yes, it was hard" : "unclear",
          confidence: "high",
          complaints: [],
          symptoms,
          memories: [],
          forFamily: "",
        });
      }
      if ("symptoms" in properties) {
        return reply({
          symptoms: [{ words: "ankles a bit puffy", topic: "ankles", questionId: "hf-ankle-swelling", amount: "a_little", change: "unknown" }],
          answers: {
            "hf-ankle-swelling": { answer: "a little", confidence: "high" },
            "hf-breathing-lying-flat": { answer: "not_answered", confidence: "low" },
          },
          memories: [],
        });
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
    expect(output).toContain("kind=answer answer=Yes, it was hard confidence=high");
    expect(output).toContain("pending: How was your breathing last night when you lay down? [Fine | A little hard | Yes, it was hard]");
    expect(output).toContain("classifyMessage model-a #1 503");
    for (const sample of CLASSIFY_SYMPTOM_SAMPLES) expect(output).toContain(`classifyMessage: "${sample.message}"`);
    expect(output).toContain('symptoms=[knee pain a_lot/unknown "my knee really hurts"]');
    expect(output).toContain("hf-ankle-swelling: Have your ankles or feet been more swollen than usual? [No | A little | More than usual]");
    for (const sample of EXTRACT_SAMPLES) expect(output).toContain(`extractCheckin: "${sample.message}"`);
    expect(output).toContain('answers={hf-ankle-swelling="A little" (high)} symptoms=[hf-ankle-swelling a_little/unknown "ankles a bit puffy"]');
    expect(output).toContain("extractCheckin model-a #1 503");
    expect(output).toContain("every call answered");
    expect(output).not.toContain(KEY);
  });

  it("has one classify sample per main kind, the last with a pending question", () => {
    expect(CLASSIFY_SAMPLES).toHaveLength(6);
    expect(CLASSIFY_SAMPLES.filter((s) => s.pending)).toHaveLength(1);
    expect(CLASSIFY_SAMPLES.at(-1)!.pending?.options).toEqual(["Fine", "A little hard", "Yes, it was hard"]);
  });

  it("extracts four replies against today's three questions, with graded labels, and classifies two symptom messages", () => {
    expect(EXTRACT_SAMPLES).toHaveLength(4);
    expect(CLASSIFY_SYMPTOM_SAMPLES).toHaveLength(2);
    expect(TODAY_QUESTIONS.map((q) => [q.id, q.options])).toEqual([
      ["hf-ankle-swelling", ["No", "A little", "More than usual"]],
      ["hf-breathing-lying-flat", ["Fine", "A little hard", "Yes, it was hard"]],
      ["dizzy-on-standing", ["No", "Sometimes", "Often"]],
    ]);
  });

  it("describes an extraction on one line", () => {
    expect(
      describeExtraction({
        answers: [{ questionId: "dizzy-on-standing", answer: "Sometimes", confidence: "medium" }],
        symptoms: [{ topic: "knee pain", amount: "a_little", change: "same", words: "knee aches" }],
        memories: ["baking Sunday"],
      }),
    ).toBe('answers={dizzy-on-standing="Sometimes" (medium)} symptoms=[knee pain a_little/same "knee aches"] memories=["baking Sunday"]');
    expect(describeExtraction({ answers: [], symptoms: [], memories: [] })).toBe("answers={} symptoms=[]");
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
