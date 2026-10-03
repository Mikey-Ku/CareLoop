import { describe, expect, it } from "vitest";
import {
  BUTTON_LEVELS,
  FOLLOW_UP_LEVELS,
  RED_FLAG_TOPICS,
  REPETITION,
  SAFETY_LEVELS,
  TYPED_LEVELS,
  cleanMentions,
  daysSeen,
  highest,
  isRedFlagTopic,
  labelForLevel,
  levelFor,
  needsClarifying,
  topicOf,
  type Level,
  type SeverityHistory,
} from "../src/checkin/severity.ts";
import { QUESTION_BANK } from "../src/context/questions.ts";
import type { Amount, Change, SymptomMention } from "../src/llm/types.ts";

// The severity ladder's fixed tables (src/checkin/severity.ts, docs/DESIGN.md "Severity ladder").
// Pure: no database, no LLM. The engine's reactions to each level are in test/ladder.test.ts.

const BREATHING = "hf-breathing-lying-flat";
const BLEEDING = "anticoagulant-bleeding";
const ANKLES = "hf-ankle-swelling";
const DIZZY = "dizzy-on-standing";
const TODAY = "2026-09-10";

const button = (questionId: string, label: string, history?: SeverityHistory) => levelFor({ source: "button", questionId, label }, history).level;
const typed = (topic: string, amount: Amount, change: Change = "same", questionId?: string, history?: SeverityHistory) =>
  levelFor({ source: "typed", mention: { topic, amount, change, ...(questionId ? { questionId } : {}) } }, history).level;
const daysAgo = (n: number) => new Date(Date.parse(TODAY) - n * 86_400_000).toISOString().slice(0, 10);
const history = (...seen: { ago: number; topic: string; level: number }[]): SeverityHistory => ({
  today: TODAY,
  observations: seen.map(({ ago, topic, level }) => ({ day: daysAgo(ago), topic, level })),
});

describe("button answers: the fixed table, every label", () => {
  it.each([
    [ANKLES, "No", 0],
    [ANKLES, "A little", 1],
    [ANKLES, "More than usual", 2],
    [BREATHING, "Fine", 0],
    [BREATHING, "A little hard", 2],
    [BREATHING, "Yes, it was hard", 3],
    [BLEEDING, "No", 0],
    [BLEEDING, "A little bruising", 2],
    [BLEEDING, "Yes, bleeding", 3],
    [DIZZY, "No", 0],
    [DIZZY, "Sometimes", 1],
    [DIZZY, "Often", 2],
    ["morning-medicines", "Yes", 0],
    ["morning-medicines", "Not yet", 0],
    ["morning-medicines", "Some of them", 1],
    ["mood", "Good", 0],
    ["mood", "Okay", 0],
    ["mood", "Not great", 1],
  ])("%s: %s is level %i", (questionId, label, level) => {
    expect(button(questionId, label)).toBe(level);
    expect(levelFor({ source: "button", questionId, label }).topic).toBe(questionId);
  });

  it("the table and the question bank have exactly the same buttons", () => {
    expect(Object.keys(BUTTON_LEVELS).sort()).toEqual(QUESTION_BANK.map((q) => q.id).sort());
    for (const q of QUESTION_BANK) expect(Object.keys(BUTTON_LEVELS[q.id]!), q.id).toEqual(q.buttons);
  });

  it("red-flag answers are exactly the level-3 labels, and calm answers are level 0", () => {
    for (const q of QUESTION_BANK) {
      const table = BUTTON_LEVELS[q.id]!;
      expect(q.redFlagAnswers, q.id).toEqual(Object.keys(table).filter((l) => table[l] === 3));
      for (const calm of q.calmAnswers) expect(table[calm], `${q.id} ${calm}`).toBe(0);
    }
    expect(RED_FLAG_TOPICS).toEqual(QUESTION_BANK.filter((q) => q.redFlagAnswers.length > 0).map((q) => q.id));
  });

  it("matches labels like a tap (case, spaces); a label the table doesn't know is 0 and says so", () => {
    expect(button(BREATHING, "  yes, IT WAS hard ")).toBe(3);
    expect(levelFor({ source: "button", questionId: BREATHING, label: "Yes" })).toMatchObject({ level: 0, reason: expect.stringMatching(/not in the/) });
    expect(button("no-such-question", "Yes")).toBe(0);
  });

  it("no button answer is ever an emergency: only the safety screen goes above 3", () => {
    for (const table of Object.values(BUTTON_LEVELS)) for (const level of Object.values(table)) expect(level).toBeLessThanOrEqual(3);
  });
});

describe("typed symptoms: how much, new or worse, and red-flag topics", () => {
  it("the table: none 0, a little or unknown 1, a lot 2; on breathing or bleeding a little 2, a lot 3", () => {
    expect(TYPED_LEVELS).toEqual({
      none: { ordinary: 0, redFlag: 0 },
      a_little: { ordinary: 1, redFlag: 2 },
      unknown: { ordinary: 1, redFlag: 2 },
      a_lot: { ordinary: 2, redFlag: 3 },
    });
    expect(typed("knee pain", "none")).toBe(0);
    expect(typed("knee pain", "a_little")).toBe(1);
    expect(typed("knee pain", "unknown")).toBe(1);
    expect(typed("knee pain", "a_lot")).toBe(2);
    expect(typed("breathing", "none")).toBe(0);
    expect(typed("breathing", "a_little")).toBe(2);
    expect(typed("short of breath", "a_lot")).toBe(3);
    expect(typed("bleeding gums", "a_little")).toBe(2);
    expect(typed("nosebleed", "a_lot")).toBe(3);
  });

  it("new or worse than usual is at least 2, never more by itself; with none of it, still 0", () => {
    for (const change of ["new", "worse"] as const) {
      expect(typed("knee pain", "a_little", change)).toBe(2);
      expect(typed("knee pain", "unknown", change)).toBe(2);
      expect(typed("knee pain", "a_lot", change)).toBe(2);
      expect(typed("breathing", "a_lot", change)).toBe(3);
      expect(typed("knee pain", "none", change)).toBe(0);
    }
    for (const change of ["same", "better", "unknown"] as const) expect(typed("knee pain", "a_little", change)).toBe(1);
  });

  it("the live test messages: a little cough and tight breathing is worth watching, a sore knee is small", () => {
    // "breathing a little sparse, tight at points, fine at others, a little cough"
    expect(typed("breathing", "a_little", "unknown")).toBe(2);
    expect(typed("cough", "a_little", "unknown")).toBe(1);
    // "my knee really hurts"
    expect(typed("knee pain", "a_lot", "unknown")).toBe(2);
    expect(typed("knee pain", "a_little", "same")).toBe(1);
  });

  it("topics: the model's question id first, then bank topics in her words, else her words tidied", () => {
    expect(topicOf({ topic: "puffy", questionId: ANKLES })).toBe(ANKLES);
    expect(topicOf({ topic: "anything", questionId: "not-a-question" })).toBe("anything");
    expect(topicOf({ topic: BLEEDING })).toBe(BLEEDING);
    expect(topicOf({ topic: "Short of breath at night" })).toBe(BREATHING);
    expect(topicOf({ topic: "wheezing" })).toBe(BREATHING);
    expect(topicOf({ topic: "nosebleed" })).toBe(BLEEDING);
    expect(topicOf({ topic: "a bruise on my arm" })).toBe(BLEEDING);
    expect(topicOf({ topic: "blood pressure" })).toBe("blood pressure");
    expect(topicOf({ topic: "swollen ankles" })).toBe(ANKLES);
    expect(topicOf({ topic: "lightheaded" })).toBe(DIZZY);
    expect(topicOf({ topic: "  Knee   Pain " })).toBe("knee pain");
    expect(topicOf({ topic: "x".repeat(200) })).toHaveLength(60);
    expect(topicOf({ topic: "   " })).toBe("other");
    expect(isRedFlagTopic(BREATHING) && isRedFlagTopic(BLEEDING) && !isRedFlagTopic(ANKLES)).toBe(true);
  });

  it("an ankle mention typed on the ankle question uses the ordinary table", () => {
    expect(typed("ankles", "a_lot", "same", ANKLES)).toBe(2);
    expect(typed("ankles", "a_little", "worse", ANKLES)).toBe(2);
  });

  it("cleanMentions keeps what the rules can use: a topic, a known amount and change (else unknown)", () => {
    const raw: unknown = [
      { topic: " knee pain ", amount: "a_lot", change: "worse", words: " my knee " },
      { topic: "cough", amount: "tons", change: "sideways" },
      { topic: "", amount: "a_lot" },
      { amount: "a_lot" },
      "knee",
      null,
      { topic: "ankles", questionId: ANKLES, amount: "a_little", change: "same", words: "a bit puffy" },
    ];
    const clean: SymptomMention[] = cleanMentions(raw);
    expect(clean).toEqual([
      { topic: "knee pain", amount: "a_lot", change: "worse", words: "my knee" },
      { topic: "cough", amount: "unknown", change: "unknown", words: "" },
      { topic: "ankles", questionId: ANKLES, amount: "a_little", change: "same", words: "a bit puffy" },
    ]);
    expect(cleanMentions(undefined)).toEqual([]);
    expect(cleanMentions("nope")).toEqual([]);
  });
});

describe("the safety screen and follow-up answers", () => {
  it("urgent symptom is 4, crisis is 5", () => {
    expect(SAFETY_LEVELS).toEqual({ urgent_symptom: 4, crisis: 5 });
    expect(levelFor({ source: "safety", kind: "urgent_symptom" })).toMatchObject({ level: 4, topic: "urgent_symptom" });
    expect(levelFor({ source: "safety", kind: "crisis" })).toMatchObject({ level: 5, topic: "crisis" });
  });

  it("Better is 0; About the same keeps the earlier level, at most 2; Worse is 3, or stays at an emergency or crisis", () => {
    expect(FOLLOW_UP_LEVELS).toEqual({ better: 0, sameAtMost: 2, worseAtLeast: 3 });
    const f = (answer: "better" | "same" | "worse", priorLevel: Level) => levelFor({ source: "follow_up", answer, priorLevel }).level;
    for (const prior of [2, 3, 4, 5] as const) expect(f("better", prior)).toBe(0);
    expect(f("same", 2)).toBe(2);
    expect(f("same", 3)).toBe(2);
    expect(f("same", 5)).toBe(2);
    expect(f("same", 1)).toBe(1);
    expect(f("worse", 2)).toBe(3);
    expect(f("worse", 3)).toBe(3);
    expect(f("worse", 4)).toBe(4);
    expect(f("worse", 5)).toBe(5);
  });
});

describe("the repetition rule: a level-1 topic on 3 of her last 5 days is 2", () => {
  it("is a fixed rule", () => {
    expect(REPETITION).toEqual({ days: 5, timesSeen: 3, from: 1, to: 2 });
  });

  it("today and two of the four days before: 2; today and one: still 1", () => {
    expect(button(DIZZY, "Sometimes", history({ ago: 2, topic: DIZZY, level: 1 }, { ago: 4, topic: DIZZY, level: 1 }))).toBe(2);
    expect(button(DIZZY, "Sometimes", history({ ago: 2, topic: DIZZY, level: 1 }))).toBe(1);
    expect(levelFor({ source: "button", questionId: DIZZY, label: "Sometimes" }, history({ ago: 1, topic: DIZZY, level: 1 }, { ago: 3, topic: DIZZY, level: 2 })).reason).toMatch(
      /seen on 3 of her last 5 days/,
    );
  });

  it("only days in the window count, each day once, only the same topic, only level 1 or more", () => {
    expect(button(DIZZY, "Sometimes", history({ ago: 5, topic: DIZZY, level: 1 }, { ago: 6, topic: DIZZY, level: 1 }))).toBe(1);
    expect(button(DIZZY, "Sometimes", history({ ago: 1, topic: DIZZY, level: 1 }, { ago: 1, topic: DIZZY, level: 1 }))).toBe(1);
    expect(button(DIZZY, "Sometimes", history({ ago: 1, topic: ANKLES, level: 1 }, { ago: 2, topic: ANKLES, level: 1 }))).toBe(1);
    expect(button(DIZZY, "Sometimes", history({ ago: 1, topic: DIZZY, level: 0 }, { ago: 2, topic: DIZZY, level: 0 }))).toBe(1);
    // Earlier today counts as today, not as another day.
    expect(button(DIZZY, "Sometimes", history({ ago: 0, topic: DIZZY, level: 1 }, { ago: 1, topic: DIZZY, level: 1 }))).toBe(1);
    // Days after the check-in date don't count.
    expect(button(DIZZY, "Sometimes", history({ ago: -1, topic: DIZZY, level: 1 }, { ago: -2, topic: DIZZY, level: 1 }))).toBe(1);
    expect(daysSeen(DIZZY, history({ ago: 1, topic: DIZZY, level: 1 }, { ago: 4, topic: DIZZY, level: 3 }, { ago: 5, topic: DIZZY, level: 1 }))).toBe(3);
  });

  it("raises level 1 only: 0 and 2 are left alone; typed topics count by topic", () => {
    const often = history({ ago: 1, topic: DIZZY, level: 1 }, { ago: 2, topic: DIZZY, level: 1 });
    expect(button(DIZZY, "No", often)).toBe(0);
    expect(button(DIZZY, "Often", often)).toBe(2);
    const knee = history({ ago: 1, topic: "knee pain", level: 1 }, { ago: 3, topic: "knee pain", level: 1 });
    expect(typed("knee pain", "a_little", "same", undefined, knee)).toBe(2);
    expect(typed("cough", "a_little", "same", undefined, knee)).toBe(1);
    // "other" (no topic) never adds up.
    expect(typed("   ", "a_little", "same", undefined, history({ ago: 1, topic: "other", level: 1 }, { ago: 2, topic: "other", level: 1 }))).toBe(1);
  });
});

describe("helpers", () => {
  it("one clarifying question only when a little or a lot would change the level", () => {
    expect(needsClarifying({ topic: ANKLES, questionId: ANKLES, amount: "unknown", change: "same" })).toBe(true); // 1 or 2
    expect(needsClarifying({ topic: "breathing", amount: "unknown", change: "unknown" })).toBe(true); // 2 or 3
    expect(needsClarifying({ topic: ANKLES, questionId: ANKLES, amount: "unknown", change: "worse" })).toBe(false); // 2 either way
    expect(needsClarifying({ topic: ANKLES, questionId: ANKLES, amount: "a_little", change: "same" })).toBe(false);
  });

  it("labelForLevel and highest", () => {
    expect(labelForLevel(ANKLES, 1)).toBe("A little");
    expect(labelForLevel(ANKLES, 2)).toBe("More than usual");
    expect(labelForLevel(DIZZY, 2)).toBe("Often");
    expect(labelForLevel("mood", 2)).toBeUndefined();
    expect(highest([{ level: 1, n: "a" }, { level: 2, n: "b" }, { level: 2, n: "c" }])).toEqual({ level: 2, n: "b" });
    expect(highest([])).toBeUndefined();
  });
});
