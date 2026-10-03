import { describe, expect, it } from "vitest";
import { evaluateRedFlag } from "../src/checkin/red-flags.ts";
import { QUESTION_BANK, type Question } from "../src/context/questions.ts";

const q = (id: string): Question => {
  const entry = QUESTION_BANK.find((e) => e.id === id);
  if (!entry) throw new Error(`no question ${id}`);
  return entry;
};

describe("evaluateRedFlag", () => {
  it("hf-breathing-lying-flat: only \"Yes, it was hard\" (level 3) is a red flag; Fine and A little hard are not", () => {
    const question = q("hf-breathing-lying-flat");
    expect(evaluateRedFlag(question, "Yes, it was hard")).toEqual({
      questionId: "hf-breathing-lying-flat",
      questionText: question.text,
      answer: "Yes, it was hard",
    });
    expect(evaluateRedFlag(question, "Fine")).toBeUndefined();
    expect(evaluateRedFlag(question, "A little hard")).toBeUndefined();
  });

  it("anticoagulant-bleeding: only \"Yes, bleeding\" is a red flag; A little bruising is worth watching, not a red flag", () => {
    const question = q("anticoagulant-bleeding");
    expect(evaluateRedFlag(question, "Yes, bleeding")).toMatchObject({ questionId: "anticoagulant-bleeding", answer: "Yes, bleeding" });
    expect(evaluateRedFlag(question, "No")).toBeUndefined();
    expect(evaluateRedFlag(question, "A little bruising")).toBeUndefined();
  });

  it.each(["hf-ankle-swelling", "dizzy-on-standing", "morning-medicines", "mood"])("%s: no answer is a red flag", (id) => {
    const question = q(id);
    for (const answer of question.buttons) expect(evaluateRedFlag(question, answer)).toBeUndefined();
  });

  it("matches case-insensitively and ignores surrounding spaces, returning the canonical label", () => {
    expect(evaluateRedFlag(q("hf-breathing-lying-flat"), "  yes, IT WAS hard ")).toMatchObject({ answer: "Yes, it was hard" });
    expect(evaluateRedFlag(q("anticoagulant-bleeding"), "YES, BLEEDING")).toMatchObject({ answer: "Yes, bleeding" });
  });

  it("free text that only contains a red-flag word is not a red flag", () => {
    expect(evaluateRedFlag(q("hf-breathing-lying-flat"), "yes a little")).toBeUndefined();
    expect(evaluateRedFlag(q("hf-breathing-lying-flat"), "Yes")).toBeUndefined();
  });

  it("every red-flag answer in the bank is one of that question's buttons", () => {
    for (const entry of QUESTION_BANK) for (const a of entry.redFlagAnswers) expect(entry.buttons).toContain(a);
  });
});
