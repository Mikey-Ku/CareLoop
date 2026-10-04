import { describe, expect, it } from "vitest";
import {
  MAX_QUESTION_BUTTONS,
  MAX_QUESTIONS_PER_DAY,
  QUESTION_BANK,
  QUESTION_CADENCE,
  eligibleQuestions,
  isWorryingAnswer,
  pickQuestions,
  type AnswerHistoryEntry,
} from "../src/context/questions.ts";
import { loadRxNavCache, loadSnapshot } from "../src/finchnode/fixtures.ts";
import { normalizeHealthRecord, type PatientRecord } from "../src/finchnode/normalize.ts";

const rxnav = loadRxNavCache();
const harriet = normalizeHealthRecord(loadSnapshot("patient-demo-polypharmacy"), { rxnav });

const BREATHING = "hf-breathing-lying-flat";
const BLEEDING = "anticoagulant-bleeding";
const RED_FLAG = new Set([BREATHING, BLEEDING]);

function addDays(day: string, n: number): string {
  return new Date(Date.parse(day) + n * 86_400_000).toISOString().slice(0, 10);
}

const entry = (id: string) => QUESTION_BANK.find((q) => q.id === id)!;
const calm = (id: string) => entry(id).calmAnswers[0]!;
const ids = (record: PatientRecord, day: string, history: AnswerHistoryEntry[] = []) => pickQuestions(record, day, { history }).map((q) => q.id);
const redFlagIds = (record: PatientRecord, day: string, history: AnswerHistoryEntry[] = []) => ids(record, day, history).filter((id) => RED_FLAG.has(id));

/**
 * Runs `days` check-ins from `start`, answering every picked question with `answer` (calm by default),
 * and returns each day's picks with the history built along the way.
 */
function run(
  record: PatientRecord,
  start: string,
  days: number,
  answer: (day: string, id: string) => string = (_, id) => calm(id),
): { picks: string[][]; history: AnswerHistoryEntry[] } {
  const history: AnswerHistoryEntry[] = [];
  const picks: string[][] = [];
  for (let i = 0; i < days; i++) {
    const day = addDays(start, i);
    const today = ids(record, day, history);
    picks.push(today);
    for (const questionId of today) history.push({ day, questionId, answer: answer(day, questionId) });
  }
  return { picks, history };
}

describe("question bank", () => {
  it("has Relay-safe buttons and no em dashes, at most MAX_QUESTION_BUTTONS (4) so one more fits", () => {
    expect(MAX_QUESTION_BUTTONS).toBe(4);
    for (const q of QUESTION_BANK) {
      expect(q.buttons.length).toBeGreaterThanOrEqual(1);
      expect(q.buttons.length).toBeLessThanOrEqual(MAX_QUESTION_BUTTONS);
      for (const b of q.buttons) expect(b.length).toBeLessThanOrEqual(80);
      for (const answer of q.redFlagAnswers) expect(q.buttons).toContain(answer);
      expect(`${q.text} ${q.buttons.join(" ")}`).not.toMatch(/\u2014/);
    }
    expect(new Set(QUESTION_BANK.map((q) => q.id)).size).toBe(QUESTION_BANK.length);
  });

  it("every question has calm answers among its buttons, and a red-flag answer is never calm", () => {
    for (const q of QUESTION_BANK) {
      expect(q.calmAnswers.length).toBeGreaterThan(0);
      for (const a of q.calmAnswers) expect(q.buttons).toContain(a);
      for (const a of q.redFlagAnswers) expect(q.calmAnswers).not.toContain(a);
      // At least one button is worrying, or a follow-up could never start.
      expect(q.buttons.some((b) => !q.calmAnswers.includes(b))).toBe(true);
    }
  });

  it("groups: both heart failure questions together, bleeding on its own, the rest by id", () => {
    expect(Object.fromEntries(QUESTION_BANK.map((q) => [q.id, q.group]))).toEqual({
      "hf-ankle-swelling": "heart_failure",
      [BREATHING]: "heart_failure",
      [BLEEDING]: "bleeding",
      "dizzy-on-standing": "dizzy-on-standing",
      "morning-medicines": "morning-medicines",
      mood: "mood",
    });
  });

  it("worrying answers: anything but a calm one, matched like a button", () => {
    expect(isWorryingAnswer("hf-ankle-swelling", "A little")).toBe(true);
    expect(isWorryingAnswer("hf-ankle-swelling", " no ")).toBe(false);
    expect(isWorryingAnswer(BREATHING, "Yes, it was hard")).toBe(true);
    expect(isWorryingAnswer(BREATHING, "A little hard")).toBe(true);
    expect(isWorryingAnswer(BREATHING, "Fine")).toBe(false);
    expect(isWorryingAnswer("mood", "Okay")).toBe(false);
    expect(isWorryingAnswer("mood", "Not great")).toBe(true);
    expect(isWorryingAnswer("morning-medicines", "Not yet")).toBe(true);
    expect(isWorryingAnswer("no-such-question", "Yes")).toBe(false);
  });

  it("symptom questions have graded answers, warm wording, and only the level-3 answer is a red flag", () => {
    expect(QUESTION_BANK.map((q) => [q.id, q.text, q.buttons, q.redFlagAnswers])).toEqual([
      ["hf-ankle-swelling", "Have your ankles or feet been more swollen than usual?", ["No", "A little", "More than usual"], []],
      ["hf-breathing-lying-flat", "How was your breathing last night when you lay down?", ["Fine", "A little hard", "Yes, it was hard"], ["Yes, it was hard"]],
      ["anticoagulant-bleeding", "Any unusual bruising or bleeding?", ["No", "A little bruising", "Yes, bleeding"], ["Yes, bleeding"]],
      ["dizzy-on-standing", "Have you felt dizzy when standing up?", ["No", "Sometimes", "Often"], []],
      ["morning-medicines", "Did you take your morning medicines?", ["Yes", "Not yet", "Some of them"], []],
      ["mood", "How are you feeling today?", ["Good", "Okay", "Not great"], []],
    ]);
  });

  it("every question in the bank applies to Harriet", () => {
    expect(eligibleQuestions(harriet).map((q) => q.id)).toEqual(QUESTION_BANK.map((q) => q.id));
  });

  it("cadence defaults: every other day, 3 follow-up days, at most 2 red-flag questions", () => {
    expect(QUESTION_CADENCE).toEqual({ redFlagEveryDays: 2, followUpDays: 3, maxRedFlagQuestions: 2 });
  });
});

describe("pickQuestions: red-flag cadence", () => {
  const D = "2026-09-10";

  it("never asked: both red-flag questions are due, plus one more", () => {
    const picked = ids(harriet, D);
    expect(picked).toHaveLength(MAX_QUESTIONS_PER_DAY);
    expect(picked.filter((id) => RED_FLAG.has(id))).toEqual([BREATHING, BLEEDING]);
  });

  it("answered yesterday: not due", () => {
    const history = [BREATHING, BLEEDING].map((questionId) => ({ day: addDays(D, -1), questionId, answer: calm(questionId) }));
    expect(redFlagIds(harriet, D, history)).toEqual([]);
    expect(ids(harriet, D, history)).toHaveLength(3);
  });

  it("answered 2 days ago: due again (every other day)", () => {
    const history = [BREATHING, BLEEDING].map((questionId) => ({ day: addDays(D, -2), questionId, answer: calm(questionId) }));
    expect(redFlagIds(harriet, D, history)).toEqual([BREATHING, BLEEDING]);
  });

  it("each red-flag question keeps its own cadence", () => {
    const history = [
      { day: addDays(D, -1), questionId: BREATHING, answer: "Fine" },
      { day: addDays(D, -2), questionId: BLEEDING, answer: "No" },
    ];
    expect(redFlagIds(harriet, D, history)).toEqual([BLEEDING]);
  });

  it("a worrying answer 2 days ago in the group makes it due every day, even if answered yesterday", () => {
    const history = [
      { day: addDays(D, -2), questionId: "hf-ankle-swelling", answer: "A little" },
      { day: addDays(D, -1), questionId: BREATHING, answer: "Fine" },
      { day: addDays(D, -1), questionId: BLEEDING, answer: "No" },
    ];
    expect(redFlagIds(harriet, D, history)).toEqual([BREATHING]);
    // A red-flag answer is worrying too.
    expect(redFlagIds(harriet, D, [{ day: addDays(D, -1), questionId: BLEEDING, answer: "Yes, bleeding" }]).includes(BLEEDING)).toBe(true);
  });

  it("the follow-up window expires after followUpDays", () => {
    const history = (worryDaysAgo: number) => [
      { day: addDays(D, -worryDaysAgo), questionId: "hf-ankle-swelling", answer: "More than usual" },
      { day: addDays(D, -1), questionId: BREATHING, answer: "Fine" },
      { day: addDays(D, -1), questionId: BLEEDING, answer: "No" },
    ];
    expect(redFlagIds(harriet, D, history(3))).toEqual([BREATHING]);
    expect(redFlagIds(harriet, D, history(4))).toEqual([]);
    // The window is a cadence value.
    expect(pickQuestions(harriet, D, { history: history(4), cadence: { followUpDays: 4 } }).map((q) => q.id)).toContain(BREATHING);
  });

  it("a worrying answer only reaches its own group", () => {
    const history = [
      { day: addDays(D, -1), questionId: "mood", answer: "Not great" },
      { day: addDays(D, -1), questionId: BREATHING, answer: "Fine" },
      { day: addDays(D, -1), questionId: BLEEDING, answer: "No" },
    ];
    expect(redFlagIds(harriet, D, history)).toEqual([]);
  });

  it("a day with no answers (not today, missed) doesn't count as asked", () => {
    // She answered both 3 days ago, then said "not today" twice: no answers, so they are due.
    const history = [BREATHING, BLEEDING].map((questionId) => ({ day: addDays(D, -3), questionId, answer: calm(questionId) }));
    expect(redFlagIds(harriet, addDays(D, -2), history)).toEqual([]);
    expect(redFlagIds(harriet, D, history)).toEqual([BREATHING, BLEEDING]);
  });

  it("at most maxRedFlagQuestions; when more are due, never asked or asked longest ago wins", () => {
    const history = [
      { day: addDays(D, -2), questionId: BREATHING, answer: "Fine" },
      { day: addDays(D, -5), questionId: BLEEDING, answer: "No" },
    ];
    expect(pickQuestions(harriet, D, { history, cadence: { maxRedFlagQuestions: 1 } }).filter((q) => RED_FLAG.has(q.id)).map((q) => q.id)).toEqual([BLEEDING]);
    const neverBleeding = history.slice(0, 1);
    expect(pickQuestions(harriet, D, { history: neverBleeding, cadence: { maxRedFlagQuestions: 1 } }).filter((q) => RED_FLAG.has(q.id)).map((q) => q.id)).toEqual([BLEEDING]);
    // Never more than 2 a day by default, whatever the history, and never more than max.
    for (let i = 0; i < 20; i++) expect(redFlagIds(harriet, addDays(D, i)).length).toBeLessThanOrEqual(2);
    expect(pickQuestions(harriet, D, { max: 1 }).map((q) => q.id)).toEqual([BREATHING]);
    expect(pickQuestions(harriet, D, { max: 0 })).toEqual([]);
  });

  it("no heart failure or anticoagulant: no red-flag questions, ever", () => {
    for (const subject of ["patient-demo-001", "patient-demo-consent-partial", "patient-demo-messy-coding", "patient-demo-sparse"]) {
      const record = normalizeHealthRecord(loadSnapshot(subject), { rxnav });
      const { picks } = run(record, D, 6);
      expect(picks.flat().filter((id) => RED_FLAG.has(id))).toEqual([]);
    }
    // Harriet without her heart failure: only the bleeding question can come up.
    const noHf = { ...harriet, conditions: [] };
    expect(run(noHf, D, 4).picks.flat().filter((id) => RED_FLAG.has(id))).toEqual([BLEEDING, BLEEDING]);
  });

  it("ignores history on or after the check-in date", () => {
    const history = [BREATHING, BLEEDING].map((questionId) => ({ day: D, questionId, answer: calm(questionId) }));
    expect(redFlagIds(harriet, D, history)).toEqual([BREATHING, BLEEDING]);
    expect(redFlagIds(harriet, D, [{ day: addDays(D, 1), questionId: BREATHING, answer: "Fine" }])).toEqual([BREATHING, BLEEDING]);
  });
});

describe("pickQuestions: the other questions", () => {
  it("with a calm history: red-flag questions every other day, every question at least every other day", () => {
    const { picks } = run(harriet, "2026-09-01", 14);
    for (const [i, day] of picks.entries()) {
      expect(day.length).toBe(MAX_QUESTIONS_PER_DAY);
      expect(new Set(day).size).toBe(day.length);
      expect(day.filter((id) => RED_FLAG.has(id))).toEqual(i % 2 === 0 ? [BREATHING, BLEEDING] : []);
    }
    for (let i = 1; i < picks.length; i++) {
      const twoDays = new Set([...picks[i - 1]!, ...picks[i]!]);
      expect([...twoDays].sort()).toEqual(QUESTION_BANK.map((q) => q.id).sort());
    }
  });

  it("Harriet 2026-09-01 to 09-05 with a calm history", () => {
    expect(run(harriet, "2026-09-01", 5).picks).toEqual([
      [BREATHING, BLEEDING, "dizzy-on-standing"],
      ["hf-ankle-swelling", "morning-medicines", "mood"],
      [BREATHING, BLEEDING, "dizzy-on-standing"],
      ["hf-ankle-swelling", "morning-medicines", "mood"],
      [BREATHING, BLEEDING, "dizzy-on-standing"],
    ]);
  });

  it('Harriet with "A little" ankle swelling on 09-02: breathing and ankles daily for 3 days, then back to normal', () => {
    const worry = (day: string, id: string) => (day === "2026-09-02" && id === "hf-ankle-swelling" ? "A little" : calm(id));
    expect(run(harriet, "2026-09-01", 6, worry).picks).toEqual([
      [BREATHING, BLEEDING, "dizzy-on-standing"],
      ["hf-ankle-swelling", "morning-medicines", "mood"],
      ["hf-ankle-swelling", BREATHING, BLEEDING],
      ["hf-ankle-swelling", BREATHING, "dizzy-on-standing"],
      ["hf-ankle-swelling", BREATHING, BLEEDING],
      ["dizzy-on-standing", "morning-medicines", "mood"],
    ]);
  });

  it("a worrying answer to a non-red-flag question puts it first among the others", () => {
    const D = "2026-09-10";
    const history = [
      { day: addDays(D, -1), questionId: "mood", answer: "Not great" },
      { day: addDays(D, -1), questionId: "dizzy-on-standing", answer: "No" },
      { day: addDays(D, -1), questionId: "morning-medicines", answer: "Yes" },
    ];
    expect(ids(harriet, D, history)).toContain("mood");
    expect(ids(harriet, D, history.slice(1).concat({ day: addDays(D, -1), questionId: "mood", answer: "Good" }))).not.toContain("mood");
  });

  it("asks in bank order", () => {
    for (let i = 0; i < 10; i++) {
      const picked = ids(harriet, addDays("2026-09-01", i));
      const order = picked.map((id) => QUESTION_BANK.findIndex((q) => q.id === id));
      expect(order).toEqual([...order].sort((a, b) => a - b));
    }
  });

  it("with no history the other slot rotates by date", () => {
    const others = new Set(Array.from({ length: 4 }, (_, i) => ids(harriet, addDays("2026-09-01", i)).find((id) => !RED_FLAG.has(id))));
    expect(others.size).toBe(4);
  });

  it("is deterministic for the same inputs", () => {
    const { history } = run(harriet, "2026-09-01", 5, (day, id) => (day === "2026-09-03" ? entry(id).buttons.at(-1)! : calm(id)));
    expect(pickQuestions(harriet, "2026-09-06", { history })).toEqual(pickQuestions(harriet, "2026-09-06", { history: [...history] }));
    expect(pickQuestions(harriet, "2026-09-01")).toEqual(pickQuestions(harriet, "2026-09-01"));
  });

  it("returns every eligible question when there are 3 or fewer", () => {
    const sparse = normalizeHealthRecord(loadSnapshot("patient-demo-sparse"), { rxnav });
    expect(pickQuestions(sparse, "2026-09-01").map((q) => q.id)).toEqual(["mood"]);
    const messy = normalizeHealthRecord(loadSnapshot("patient-demo-messy-coding"), { rxnav });
    expect(pickQuestions(messy, "2026-09-01").map((q) => q.id)).toEqual(["dizzy-on-standing", "morning-medicines", "mood"]);
  });

  it("returns questions without the bank's internals", () => {
    for (const q of pickQuestions(harriet, "2026-09-01")) expect(Object.keys(q).sort()).toEqual(["buttons", "id", "redFlagAnswers", "text"]);
  });

  it("rejects a check-in date it can't read", () => {
    expect(() => pickQuestions(harriet, "not a date")).toThrow(/YYYY-MM-DD/);
  });
});
