import type { Db } from "./index.ts";

// What she typed that is worth keeping for her doctor (migrations 6 and 9). The check-in
// engine writes these; the visit-prep sheet (lane C) reads them.
//
// checkin_notes: her own words about one thing, in one check-in, such as "Yes but it was
// weirder, I don't know how to explain it" on the breathing question, or "a little bit of
// pain in the back" while she answered about her ankles. `topic` is what it is about: a
// question id, or her own topic words ("back pain"); `questionId` is set only when the topic
// is one of that check-in's questions. Family sees notes only at sharing "all", in the
// daily status.
//
// visit_questions: questions about her medicines she typed ("can I stop the water pill?").
// Never answered by the app; kept for her next visit.

/** Longest note or visit question kept; anything longer is cut. */
export const MAX_NOTE_LENGTH = 1000;

/** Trimmed, whitespace collapsed, capped. Empty when nothing is left. */
function clean(text: string): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > MAX_NOTE_LENGTH ? one.slice(0, MAX_NOTE_LENGTH).trimEnd() : one;
}

export type CheckinNote = {
  id: number;
  patientId: string;
  checkinId: number;
  /** The check-in question it is about, or null when it is about something else. */
  questionId: string | null;
  /** What it is about: the question id, or her own topic words. */
  topic: string;
  text: string;
  createdAt: string;
};

const NOTE_COLUMNS = `id, patient_id AS patientId, checkin_id AS checkinId, question_id AS questionId, topic, text, created_at AS createdAt`;

/**
 * Save her words as a note in a check-in: on one of its questions (`questionId`, the topic too), or on
 * another topic (`topic`, `questionId` null). A blank note is not saved (returns undefined).
 */
export function addCheckinNote(
  db: Db,
  note: { patientId: string; checkinId: number; questionId?: string | null; topic?: string; text: string; createdAt: string },
): number | undefined {
  const text = clean(note.text);
  if (!text) return undefined;
  const questionId = note.questionId ?? null;
  const topic = (note.topic ?? questionId ?? "").trim() || "other";
  const info = db
    .prepare(`INSERT INTO checkin_notes (patient_id, checkin_id, question_id, topic, text, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(note.patientId, note.checkinId, questionId, topic, text, note.createdAt);
  return Number(info.lastInsertRowid);
}

/** Notes on one check-in, oldest first. */
export function checkinNotes(db: Db, checkinId: number): CheckinNote[] {
  return db.prepare(`SELECT ${NOTE_COLUMNS} FROM checkin_notes WHERE checkin_id = ? ORDER BY id`).all(checkinId) as CheckinNote[];
}

/** Her notes across check-ins, newest first, at most `n` (the visit-prep sheet). */
export function recentCheckinNotes(db: Db, patientId: string, n: number): CheckinNote[] {
  if (n <= 0) return [];
  return db
    .prepare(`SELECT ${NOTE_COLUMNS} FROM checkin_notes WHERE patient_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`)
    .all(patientId, Math.floor(n)) as CheckinNote[];
}

export type VisitQuestion = { id: number; patientId: string; text: string; createdAt: string };

/** Save a question she has for her doctor or pharmacist. A blank one is not saved (returns undefined). */
export function addVisitQuestion(db: Db, input: { patientId: string; text: string; createdAt: string }): number | undefined {
  const text = clean(input.text);
  if (!text) return undefined;
  const info = db.prepare(`INSERT INTO visit_questions (patient_id, text, created_at) VALUES (?, ?, ?)`).run(input.patientId, text, input.createdAt);
  return Number(info.lastInsertRowid);
}

/** Her questions for the next visit, oldest first. */
export function visitQuestions(db: Db, patientId: string): VisitQuestion[] {
  return db
    .prepare(`SELECT id, patient_id AS patientId, text, created_at AS createdAt FROM visit_questions WHERE patient_id = ? ORDER BY created_at, id`)
    .all(patientId) as VisitQuestion[];
}
