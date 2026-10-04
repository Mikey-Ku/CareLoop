import type { AnswerHistoryEntry } from "../context/questions.ts";
import { addDays } from "../days.ts";
import type { StoredAnswer } from "./checkins.ts";
import type { Db } from "./index.ts";

// What the question picker (src/context/questions.ts pickQuestions) needs from earlier
// check-ins: which questions she answered, when, and what she said.

/**
 * Her answers on the `days` check-in dates before `beforeDay` (YYYY-MM-DD, not included),
 * oldest first, in the order she gave them. A question counts as asked only if she answered
 * it: a "not today" or missed day leaves nothing here, so its questions stay due.
 */
export function answerHistory(db: Db, patientId: string, beforeDay: string, days = 14): AnswerHistoryEntry[] {
  if (Number.isNaN(Date.parse(beforeDay))) throw new Error(`answerHistory: beforeDay must be YYYY-MM-DD, got "${beforeDay}"`);
  const from = addDays(beforeDay, -days);
  const rows = db
    .prepare(
      `SELECT date, answers_json AS answersJson FROM checkins
       WHERE patient_id = ? AND date >= ? AND date < ? ORDER BY date, id`,
    )
    .all(patientId, from, beforeDay) as { date: string; answersJson: string | null }[];
  return rows.flatMap((row) => {
    const answers = row.answersJson ? (JSON.parse(row.answersJson) as StoredAnswer[]) : [];
    return answers.map((a) => ({ day: row.date, questionId: a.questionId, answer: a.answer }));
  });
}
