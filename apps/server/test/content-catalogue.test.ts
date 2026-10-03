import { describe, expect, it } from "vitest";
import {
  evaluate,
  HARD_TAGS,
  isSafetyKind,
  loadCatalogue,
  main,
  renderReport,
  summarize,
  type Catalogue,
} from "../src/cli/content-eval.ts";
import { QUESTION_BANK } from "../src/context/questions.ts";
import { FakeLlmClient, MESSAGE_KINDS, type MessageClassification } from "../src/llm/index.ts";
import { screenMessage, type SafetyHit } from "../src/safety/screen.ts";

// The content catalogue (fixtures/content/messages.json) is the measuring stick
// for the safety screen and classifyMessage. Offline only: the live model runs
// in `npm run content:eval`, never here.

const catalogue = loadCatalogue();
const cases = catalogue.cases;
const BANK = new Map(QUESTION_BANK.map((q) => [q.id, q]));
const LONG_DASH = /[\u2013\u2014]/;

describe("content catalogue", () => {
  it("has 100 to 120 cases with unique ids", () => {
    expect(cases.length).toBeGreaterThanOrEqual(100);
    expect(cases.length).toBeLessThanOrEqual(120);
    const ids = cases.map((c) => c.id);
    expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([]);
  });

  it("uses only message kinds the app knows, at least 5 cases of each", () => {
    for (const c of cases) expect(MESSAGE_KINDS).toContain(c.expectKind);
    for (const kind of MESSAGE_KINDS) {
      expect(cases.filter((c) => c.expectKind === kind).length, kind).toBeGreaterThanOrEqual(5);
    }
  });

  it("points pending at real questions and expectAnswer at one of that question's buttons (or unclear)", () => {
    for (const c of cases) {
      if (c.pending !== undefined) expect(BANK.has(c.pending), `${c.id}: pending ${c.pending}`).toBe(true);
      if (c.expectAnswer === undefined) continue;
      expect(c.expectKind, c.id).toBe("answer");
      const q = BANK.get(c.pending ?? "");
      expect(q, `${c.id}: expectAnswer needs a pending question`).toBeDefined();
      expect([...(q?.buttons ?? []), "unclear"], c.id).toContain(c.expectAnswer);
    }
  });

  it("only expects kind answer when a question is pending", () => {
    for (const c of cases.filter((x) => x.expectKind === "answer")) expect(c.pending, c.id).toBeDefined();
  });

  it("marks mustScreen only on safety cases of that kind, and mustNotScreen only on ordinary ones", () => {
    for (const c of cases) {
      if (c.mustScreen !== undefined) expect(c.expectKind, c.id).toBe(c.mustScreen);
      if (c.mustNotScreen) expect(isSafetyKind(c.expectKind), c.id).toBe(false);
    }
    expect(cases.filter((c) => c.mustScreen === "crisis").length).toBeGreaterThanOrEqual(5);
    expect(cases.filter((c) => c.mustScreen === "urgent_symptom").length).toBeGreaterThanOrEqual(5);
  });

  it("leaves some safety cases to the model alone (Spanish, unusual phrasing)", () => {
    const modelOnly = cases.filter((c) => isSafetyKind(c.expectKind) && c.mustScreen === undefined);
    expect(modelOnly.length).toBeGreaterThanOrEqual(5);
    expect(modelOnly.some((c) => c.hard === "spanish")).toBe(true);
  });

  it("has at least 10 hard cases, covering every kind of hard the brief asks for", () => {
    const hard = cases.filter((c) => c.hard !== undefined);
    expect(hard.length).toBeGreaterThanOrEqual(10);
    for (const tag of ["typo", "caps", "emoji", "spanish", "long", "idiom", "negation", "manipulation"] as const) {
      expect(hard.some((c) => c.hard === tag), tag).toBe(true);
    }
    for (const c of hard) expect(HARD_TAGS).toContain(c.hard);
  });

  it("marks every idiom and negation case mustNotScreen", () => {
    for (const c of cases.filter((x) => x.hard === "idiom" || x.hard === "negation")) expect(c.mustNotScreen, c.id).toBe(true);
  });

  it("has no long dashes", () => {
    for (const c of cases) {
      expect(LONG_DASH.test(c.text), c.id).toBe(false);
      expect(LONG_DASH.test(c.note ?? ""), c.id).toBe(false);
    }
    expect(LONG_DASH.test(catalogue.description)).toBe(false);
  });
});

describe("safety screen against the catalogue", () => {
  const must = cases.filter((c) => c.mustScreen !== undefined).map((c) => [c.id, c.mustScreen, c.text] as const);
  it.each(must)("%s is caught as %s", (_id, kind, text) => {
    expect(screenMessage(text)?.kind).toBe(kind);
  });

  const mustNot = cases.filter((c) => c.mustNotScreen).map((c) => [c.id, c.text] as const);
  it.each(mustNot)("%s is left alone", (_id, text) => {
    expect(screenMessage(text)).toBeUndefined();
  });
});

describe("content eval with a fake model", () => {
  const mini: Catalogue = {
    description: "test",
    seniorName: "Harriet",
    cases: [
      { id: "s-screened", text: "screened crisis", expectKind: "crisis", mustScreen: "crisis" },
      { id: "s-hidden", text: "hidden crisis", expectKind: "crisis" },
      { id: "s-model", text: "model urgent", expectKind: "urgent_symptom" },
      { id: "a-puffy", text: "a bit puffy", pending: "hf-ankle-swelling", expectKind: "answer", expectAnswer: "A little" },
      { id: "a-wrong", text: "every time", pending: "dizzy-on-standing", expectKind: "answer", expectAnswer: "Yes, often" },
      { id: "i-idiom", text: "idiom hit", expectKind: "chat", mustNotScreen: true },
      { id: "c-down", text: "model down", expectKind: "chat" },
    ],
  };
  const screen = (text: string): SafetyHit | undefined =>
    text === "screened crisis" ? { kind: "crisis", matched: "screened" } : text === "idiom hit" ? { kind: "urgent_symptom", matched: "hit" } : undefined;
  const reply = (kind: MessageClassification["kind"], answer?: string): MessageClassification => ({ kind, answer, confidence: "high", complaints: [], memories: [] });
  const fake = () =>
    new FakeLlmClient({
      classifyMessage: (input) => {
        if (input.message === "model down") return new Error("all models busy");
        if (input.message === "model urgent") return reply("urgent_symptom");
        if (input.message === "screened crisis") return reply("crisis");
        if (input.message === "a bit puffy") return reply("answer", "A little");
        if (input.message === "every time") return reply("answer", "Sometimes");
        return reply("chat");
      },
    });

  async function run(llm: FakeLlmClient) {
    return evaluate(mini, {
      screen,
      classify: async (input) => ({ value: await llm.classifyMessage(input), model: "fake-lite" }),
      sleep: async () => {},
      retryDelaysMs: [0],
    });
  }

  it("asks the model about unscreened messages and every safety case, with the pending question's buttons", async () => {
    const llm = fake();
    const results = await run(llm);
    const asked = llm.classifyCalls.map((c) => c.message);
    expect(asked).toContain("screened crisis"); // a safety case: the model is measured as the backup
    expect(asked).not.toContain("idiom hit"); // screened and not a safety case: the engine never asks
    expect(asked.filter((m) => m === "model down")).toHaveLength(2); // one retry
    expect(llm.classifyCalls.find((c) => c.message === "a bit puffy")?.pending).toEqual({
      question: BANK.get("hf-ankle-swelling")?.text,
      options: BANK.get("hf-ankle-swelling")?.buttons,
    });
    expect(results.map((r) => r.final)).toEqual(["crisis", "chat", "urgent_symptom", "answer", "answer", "urgent_symptom", "error"]);
  });

  it("scores safety, answers and mismatches, and lists a case nobody caught as critical", async () => {
    const s = summarize(await run(fake()));
    expect(s.safety.screenCaught).toBe(1);
    expect(s.safety.modelCaught).toBe(2);
    expect(s.safety.neither.map((r) => r.c.id)).toEqual(["s-hidden"]);
    expect(s.screenFalseHits.map((r) => r.c.id)).toEqual(["i-idiom"]);
    expect(s.falseAlarms.map((r) => r.c.id)).toEqual(["i-idiom"]);
    expect(s.answers).toMatchObject({ cases: 2, right: 1 });
    expect(s.mismatches.map((r) => r.c.id)).toEqual(["s-hidden", "a-wrong", "i-idiom", "c-down"]);
    expect(s.modelErrors.map((r) => r.c.id)).toEqual(["c-down"]);
  });

  it("writes the safety section first, with the critical list, and no long dashes", async () => {
    const report = renderReport(await run(fake()), { generatedAt: "2026-10-03T12:00:00.000Z", chain: ["fake-lite"] });
    const safety = report.indexOf("## Safety");
    const critical = report.indexOf("### Critical: caught by neither");
    expect(safety).toBeGreaterThan(0);
    expect(safety).toBeLessThan(report.indexOf("## Accuracy by kind"));
    expect(safety).toBeLessThan(report.indexOf("## Mismatches"));
    expect(report.slice(critical, report.indexOf("### Every safety case"))).toContain("hidden crisis");
    expect(report).toContain("| a-wrong | every time | dizzy-on-standing | answer: Yes, often | answer: Sometimes (high) |");
    expect(LONG_DASH.test(report)).toBe(false);
  });

  it("names what .env is missing and exits 1 without a key, calling nothing", async () => {
    const lines: string[] = [];
    const code = await main({}, (l) => lines.push(l), { reportPath: "/nonexistent/should-not-be-written.md" });
    expect(code).toBe(1);
    expect(lines.join("\n")).toContain("GEMINI_API_KEY");
  });
});
