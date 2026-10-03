import { describe, expect, it } from "vitest";
import { MAX_QUESTIONS_PER_DAY, QUESTION_BANK, eligibleQuestions, pickQuestions } from "../src/context/questions.ts";
import { loadRxNavCache, loadSnapshot } from "../src/finchnode/fixtures.ts";
import { normalizeHealthRecord } from "../src/finchnode/normalize.ts";

const rxnav = loadRxNavCache();
const harriet = normalizeHealthRecord(loadSnapshot("patient-demo-polypharmacy"), { rxnav });

function addDays(day: string, n: number): string {
  return new Date(Date.parse(day) + n * 86_400_000).toISOString().slice(0, 10);
}

describe("question bank", () => {
  it("has Relay-safe buttons and no em dashes", () => {
    for (const q of QUESTION_BANK) {
      expect(q.buttons.length).toBeGreaterThanOrEqual(1);
      expect(q.buttons.length).toBeLessThanOrEqual(5);
      for (const b of q.buttons) expect(b.length).toBeLessThanOrEqual(80);
      for (const answer of q.redFlagAnswers) expect(q.buttons).toContain(answer);
      expect(`${q.text} ${q.buttons.join(" ")}`).not.toMatch(/\u2014/);
    }
    expect(new Set(QUESTION_BANK.map((q) => q.id)).size).toBe(QUESTION_BANK.length);
  });

  it("every question in the bank applies to Harriet", () => {
    expect(eligibleQuestions(harriet).map((q) => q.id)).toEqual(QUESTION_BANK.map((q) => q.id));
  });
});

describe("pickQuestions", () => {
  it("is deterministic for a date", () => {
    expect(pickQuestions(harriet, "2026-09-01")).toEqual(pickQuestions(harriet, "2026-09-01"));
  });

  it("never asks more than 3", () => {
    for (let i = 0; i < 30; i++) {
      const picked = pickQuestions(harriet, addDays("2026-09-01", i));
      expect(picked.length).toBeLessThanOrEqual(MAX_QUESTIONS_PER_DAY);
      expect(new Set(picked.map((q) => q.id)).size).toBe(picked.length);
    }
  });

  it("rotates so every eligible question comes up within a few days", () => {
    const eligible = eligibleQuestions(harriet).map((q) => q.id);
    const days = Math.ceil(eligible.length / MAX_QUESTIONS_PER_DAY);
    for (const start of ["2026-09-01", "2026-09-02", "2026-12-31"]) {
      const seen = new Set<string>();
      for (let i = 0; i < days; i++) for (const q of pickQuestions(harriet, addDays(start, i))) seen.add(q.id);
      expect([...seen].sort()).toEqual([...eligible].sort());
    }
    expect(pickQuestions(harriet, "2026-09-01")).not.toEqual(pickQuestions(harriet, "2026-09-02"));
  });

  it("rotates fully for eligible counts that don't divide evenly", () => {
    for (const max of [2, 4, 5]) {
      const eligible = eligibleQuestions(harriet).map((q) => q.id);
      const seen = new Set<string>();
      for (let i = 0; i < eligible.length; i++) for (const q of pickQuestions(harriet, addDays("2026-09-01", i), max)) seen.add(q.id);
      expect(seen.size).toBe(eligible.length);
    }
  });

  it("returns every eligible question when there are 3 or fewer", () => {
    const sparse = normalizeHealthRecord(loadSnapshot("patient-demo-sparse"), { rxnav });
    expect(pickQuestions(sparse, "2026-09-01").map((q) => q.id)).toEqual(["mood"]);
  });

  it("rejects a check-in date it can't read", () => {
    expect(() => pickQuestions(harriet, "not a date")).toThrow(/YYYY-MM-DD/);
  });
});
