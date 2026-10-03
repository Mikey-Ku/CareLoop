import { beforeEach, describe, expect, it } from "vitest";
import {
  getCheckin,
  getCheckinById,
  getCheckinPatient,
  insertCheckin,
  latestCheckin,
  markInboundHandled,
  patientForChat,
  updateCheckin,
} from "../src/db/checkins.ts";
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
    familyChatId: "chat_family",
  });
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

describe("inbound dedupe", () => {
  it("a message id is handled once", () => {
    expect(markInboundHandled(db, "in_1", "chat_harriet", T1)).toBe(true);
    expect(markInboundHandled(db, "in_1", "chat_harriet", T1)).toBe(false);
    expect(markInboundHandled(db, "in_2", "chat_harriet", T1)).toBe(true);
  });
});

describe("patients for the engine", () => {
  it("finds the senior by her own chat, not by the family group", () => {
    expect(patientForChat(db, "chat_harriet")).toMatchObject({ id: P, preferredName: "Harriet", familyChatId: "chat_family", sharing: "status" });
    expect(patientForChat(db, "chat_family")).toBeUndefined();
    expect(patientForChat(db, "chat_nobody")).toBeUndefined();
    expect(getCheckinPatient(db, P)?.finchnodePatientId).toBe("patient-demo-polypharmacy");
  });
});
