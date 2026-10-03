import { beforeEach, describe, expect, it } from "vitest";
import { answerHistory } from "../src/db/answer-history.ts";
import {
  getCheckin,
  getCheckinById,
  getCheckinPatient,
  getCheckinPrompt,
  insertCheckin,
  latestCheckin,
  markInboundHandled,
  patientForChat,
  recordCheckinPrompt,
  updateCheckin,
} from "../src/db/checkins.ts";
import { linkFamilyMember, syncFamilyMembers } from "../src/db/family.ts";
import { openDatabase, upsertPatient, type Db } from "../src/db/index.ts";

const P = "harriet";
const T1 = "2026-09-01T09:00:00Z";

let db: Db;
beforeEach(() => {
  db = openDatabase(":memory:");
  upsertPatient(db, {
    id: P,
    finchnodePatientId: "patient-demo-polypharmacy",
    preferredName: "Harriet",
    relayChatId: "chat_harriet",
  });
  syncFamilyMembers(db, P, ["sarah"]);
  linkFamilyMember(db, "sarah", "chat_family", null, T1);
});

describe("checkins rows", () => {
  it("insert starts at the greeting with status sent and no answers", () => {
    const id = insertCheckin(db, { patientId: P, date: "2026-09-01", questionIds: ["a", "b"], sentAt: T1 });
    expect(getCheckin(db, P, "2026-09-01")).toEqual({
      id,
      patientId: P,
      date: "2026-09-01",
      status: "sent",
      mood: null,
      answers: [],
      questionIds: ["a", "b"],
      step: "greeting",
      questionIndex: 0,
      pendingFlagId: null,
      sentAt: T1,
      finishedAt: null,
    });
  });

  it("one row per patient and date", () => {
    insertCheckin(db, { patientId: P, date: "2026-09-01", questionIds: [], sentAt: T1 });
    expect(() => insertCheckin(db, { patientId: P, date: "2026-09-01", questionIds: [], sentAt: T1 })).toThrow(/UNIQUE/);
  });

  it("update patches only the given fields and round-trips answers", () => {
    const id = insertCheckin(db, { patientId: P, date: "2026-09-01", questionIds: ["mood"], sentAt: T1 });
    const answers = [{ questionId: "mood", questionText: "How are you?", answer: "Good", at: T1 }];
    updateCheckin(db, id, { answers, mood: "Good", step: "question", questionIndex: 0 });
    updateCheckin(db, id, { status: "answered", finishedAt: T1, step: "done" });
    expect(getCheckinById(db, id)).toMatchObject({ status: "answered", mood: "Good", answers, step: "done", finishedAt: T1 });
  });

  it("keeps the status and step checks", () => {
    const id = insertCheckin(db, { patientId: P, date: "2026-09-01", questionIds: [], sentAt: T1 });
    expect(() => db.prepare("UPDATE checkins SET status = 'bogus' WHERE id = ?").run(id)).toThrow(/CHECK/);
    expect(() => db.prepare("UPDATE checkins SET step = 'bogus' WHERE id = ?").run(id)).toThrow(/CHECK/);
  });

  it("latestCheckin is the latest date, finished or not", () => {
    expect(latestCheckin(db, P)).toBeUndefined();
    insertCheckin(db, { patientId: P, date: "2026-09-02", questionIds: [], sentAt: T1 });
    const first = insertCheckin(db, { patientId: P, date: "2026-09-01", questionIds: [], sentAt: T1 });
    updateCheckin(db, first, { step: "question" });
    expect(latestCheckin(db, P)?.date).toBe("2026-09-02");
  });
});

describe("check-in prompts (the messages carrying a step's buttons)", () => {
  it("records the step a sent message was for, once", () => {
    const id = insertCheckin(db, { patientId: P, date: "2026-09-01", questionIds: ["a", "b"], sentAt: T1 });
    expect(getCheckinPrompt(db, "msg_1")).toBeUndefined();
    recordCheckinPrompt(db, { messageId: "msg_1", checkinId: id, step: "question", questionIndex: 1, sentAt: T1 });
    recordCheckinPrompt(db, { messageId: "msg_1", checkinId: id, step: "greeting", questionIndex: 0, sentAt: T1 }); // replayed send
    expect(getCheckinPrompt(db, "msg_1")).toEqual({ messageId: "msg_1", checkinId: id, step: "question", questionIndex: 1, sentAt: T1 });
  });

  it("rejects an unknown step or check-in", () => {
    const id = insertCheckin(db, { patientId: P, date: "2026-09-01", questionIds: [], sentAt: T1 });
    expect(() => recordCheckinPrompt(db, { messageId: "m", checkinId: id, step: "done" as never, questionIndex: 0, sentAt: T1 })).toThrow(/CHECK/);
    expect(() => recordCheckinPrompt(db, { messageId: "m", checkinId: 999, step: "greeting", questionIndex: 0, sentAt: T1 })).toThrow(/FOREIGN KEY/);
  });
});

describe("answerHistory", () => {
  const answer = (questionId: string, value: string) => ({ questionId, questionText: `${questionId}?`, answer: value, at: T1 });
  function day(date: string, answers: ReturnType<typeof answer>[], status: "answered" | "skipped" | "missed" | "sent" = "answered") {
    const id = insertCheckin(db, { patientId: P, date, questionIds: answers.map((a) => a.questionId), sentAt: T1 });
    updateCheckin(db, id, { answers, status });
  }

  it("her answers before the day, oldest first, as the picker wants them", () => {
    day("2026-09-01", [answer("hf-breathing-lying-flat", "No"), answer("mood", "Good")]);
    day("2026-09-02", [answer("hf-ankle-swelling", "A little")]);
    day("2026-09-03", [answer("mood", "Okay")]); // the day itself: not included
    expect(answerHistory(db, P, "2026-09-03")).toEqual([
      { day: "2026-09-01", questionId: "hf-breathing-lying-flat", answer: "No" },
      { day: "2026-09-01", questionId: "mood", answer: "Good" },
      { day: "2026-09-02", questionId: "hf-ankle-swelling", answer: "A little" },
    ]);
  });

  it("only answered questions count: not today, missed and unanswered days add nothing", () => {
    day("2026-09-01", [], "skipped");
    day("2026-09-02", [], "missed");
    day("2026-09-03", [answer("hf-breathing-lying-flat", "No")], "skipped"); // one answer, then "not today"
    expect(answerHistory(db, P, "2026-09-04")).toEqual([{ day: "2026-09-03", questionId: "hf-breathing-lying-flat", answer: "No" }]);
  });

  it("looks back `days` check-in dates (14 by default), and only at this patient", () => {
    upsertPatient(db, { id: "other", finchnodePatientId: "fn-other", preferredName: "Other" });
    day("2026-08-17", [answer("mood", "Good")]);
    day("2026-08-18", [answer("mood", "Okay")]);
    const otherId = insertCheckin(db, { patientId: "other", date: "2026-08-30", questionIds: ["mood"], sentAt: T1 });
    updateCheckin(db, otherId, { answers: [answer("mood", "Not great")] });
    expect(answerHistory(db, P, "2026-09-01").map((h) => h.day)).toEqual(["2026-08-18"]);
    expect(answerHistory(db, P, "2026-09-01", 15).map((h) => h.day)).toEqual(["2026-08-17", "2026-08-18"]);
    expect(answerHistory(db, P, "2026-08-18")).toEqual([{ day: "2026-08-17", questionId: "mood", answer: "Good" }]);
  });

  it("rejects a day it can't read", () => {
    expect(() => answerHistory(db, P, "soon")).toThrow(/YYYY-MM-DD/);
  });
});

describe("inbound dedupe", () => {
  it("a message id is handled once", () => {
    expect(markInboundHandled(db, "in_1", "chat_harriet", T1)).toBe(true);
    expect(markInboundHandled(db, "in_1", "chat_harriet", T1)).toBe(false);
    expect(markInboundHandled(db, "in_2", "chat_harriet", T1)).toBe(true);
  });
});

describe("patients for the engine", () => {
  it("finds the senior by her own chat, never by a family chat", () => {
    expect(patientForChat(db, "chat_harriet")).toMatchObject({ id: P, preferredName: "Harriet", relayChatId: "chat_harriet", sharing: "status" });
    expect(patientForChat(db, "chat_family")).toBeUndefined();
    expect(patientForChat(db, "chat_nobody")).toBeUndefined();
    expect(getCheckinPatient(db, P)?.finchnodePatientId).toBe("patient-demo-polypharmacy");
  });
});
