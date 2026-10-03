import { describe, expect, it } from "vitest";
import { evaluateRedFlag } from "../src/checkin/red-flags.ts";
import { QUESTION_BANK, type Question } from "../src/context/questions.ts";

const q = (id: string): Question => {
  const entry = QUESTION_BANK.find((e) => e.id === id);
  if (!entry) throw new Error(`no question ${id}`);
  return entry;
};

describe("evaluateRedFlag", () => {
  it("hf-breathing-lying-flat: Yes is a red flag, No is not", () => {
    const question = q("hf-breathing-lying-flat");
    expect(evaluateRedFlag(question, "Yes")).toEqual({
      questionId: "hf-breathing-lying-flat",
      questionText: question.text,
      answer: "Yes",
    });
    expect(evaluateRedFlag(question, "No")).toBeUndefined();
  });

  it("anticoagulant-bleeding: Yes is a red flag, No is not", () => {
    const question = q("anticoagulant-bleeding");
    expect(evaluateRedFlag(question, "Yes")).toMatchObject({ questionId: "anticoagulant-bleeding", answer: "Yes" });
    expect(evaluateRedFlag(question, "No")).toBeUndefined();
  });

  it.each(["hf-ankle-swelling", "dizzy-on-standing", "morning-medicines", "mood"])("%s: no answer is a red flag", (id) => {
    const question = q(id);
    for (const answer of question.buttons) expect(evaluateRedFlag(question, answer)).toBeUndefined();
  });

  it("matches case-insensitively and ignores surrounding spaces, returning the canonical label", () => {
    expect(evaluateRedFlag(q("hf-breathing-lying-flat"), "  yes ")).toMatchObject({ answer: "Yes" });
    expect(evaluateRedFlag(q("anticoagulant-bleeding"), "YES")).toMatchObject({ answer: "Yes" });
  });

  it("free text that only contains a red-flag word is not a red flag", () => {
    expect(evaluateRedFlag(q("hf-breathing-lying-flat"), "yes a little")).toBeUndefined();
  });

  it("every red-flag answer in the bank is one of that question's buttons", () => {
    for (const entry of QUESTION_BANK) for (const a of entry.redFlagAnswers) expect(entry.buttons).toContain(a);
  });
});
