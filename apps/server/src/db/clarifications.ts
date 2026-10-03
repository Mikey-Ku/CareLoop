import type { Db } from "./index.ts";

// The one clarifying question (clarifications, migration 7). When she types about today's question
// and how much is unclear in a way that changes the level, the engine asks once "A little, or a
// lot?" (src/checkin/engine.ts). One row per check-in question, so it is never asked twice; her
// tap, or any other answer to the question, closes it.

export type Clarification = {
  id: number;
  patientId: string;
  checkinId: number;
  questionId: string;
  /** New or worse than usual, as the model read it: it still raises the level after her tap. */
  change: string | null;
  /** What she typed, kept with the answer her tap gives. */
  words: string | null;
  askedAt: string;
  answeredAt: string | null;
  answer: string | null;
};

const COLUMNS = `id, patient_id AS patientId, checkin_id AS checkinId, question_id AS questionId, change, words,
  asked_at AS askedAt, answered_at AS answeredAt, answer`;

/** Record that it was asked. Returns undefined if it was already asked about this question (never twice). */
export function addClarification(
  db: Db,
  input: { patientId: string; checkinId: number; questionId: string; change: string | null; words: string | null; askedAt: string },
): number | undefined {
  const info = db
    .prepare(
      `INSERT INTO clarifications (patient_id, checkin_id, question_id, change, words, asked_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (checkin_id, question_id) DO NOTHING`,
    )
    .run(input.patientId, input.checkinId, input.questionId, input.change, input.words, input.askedAt);
  return info.changes === 1 ? Number(info.lastInsertRowid) : undefined;
}

/** Whether it was already asked about this question of this check-in. */
export function clarificationAsked(db: Db, checkinId: number, questionId: string): boolean {
  return db.prepare(`SELECT 1 FROM clarifications WHERE checkin_id = ? AND question_id = ?`).get(checkinId, questionId) !== undefined;
}

/** The clarification waiting for her tap on this question, if any. */
export function openClarification(db: Db, checkinId: number, questionId: string): Clarification | undefined {
  return db
    .prepare(`SELECT ${COLUMNS} FROM clarifications WHERE checkin_id = ? AND question_id = ? AND answered_at IS NULL`)
    .get(checkinId, questionId) as Clarification | undefined;
}

/** Close it with the answer the question got. Returns false if it was already closed. */
export function closeClarification(db: Db, id: number, answer: string, answeredAt: string): boolean {
  return db.prepare(`UPDATE clarifications SET answer = ?, answered_at = ? WHERE id = ? AND answered_at IS NULL`).run(answer, answeredAt, id).changes === 1;
}
