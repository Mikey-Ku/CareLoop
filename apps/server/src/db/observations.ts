import type { Db } from "./index.ts";

// What the severity ladder saw (symptom_observations, migration 7): one row per thing she told us
// and the level it got (src/checkin/severity.ts). The check-in engine writes them; the repetition
// rule, the family's daily status at "all" and the visit-prep sheet read them. Her words are kept
// only when she typed them, and never logged.

export type ObservationSource = "button" | "typed" | "follow_up" | "safety";

export type SymptomObservation = {
  id: number;
  patientId: string;
  checkinId: number | null;
  /** The check-in date it belongs to (YYYY-MM-DD). */
  day: string;
  /** A question id, her own short topic words, or a safety kind. */
  topic: string;
  questionId: string | null;
  level: number;
  amount: string | null;
  change: string | null;
  source: ObservationSource;
  words: string | null;
  createdAt: string;
};

export type NewObservation = Omit<SymptomObservation, "id" | "checkinId" | "questionId" | "amount" | "change" | "words"> &
  Partial<Pick<SymptomObservation, "checkinId" | "questionId" | "amount" | "change" | "words">>;

/** Longest words kept with an observation. */
export const MAX_OBSERVATION_WORDS = 1000;

const COLUMNS = `id, patient_id AS patientId, checkin_id AS checkinId, day, topic, question_id AS questionId, level, amount,
  change, source, words, created_at AS createdAt`;

export function addObservation(db: Db, o: NewObservation): number {
  const words = o.words?.replace(/\s+/g, " ").trim().slice(0, MAX_OBSERVATION_WORDS) || null;
  const info = db
    .prepare(
      `INSERT INTO symptom_observations (patient_id, checkin_id, day, topic, question_id, level, amount, change, source, words, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(o.patientId, o.checkinId ?? null, o.day, o.topic, o.questionId ?? null, o.level, o.amount ?? null, o.change ?? null, o.source, words, o.createdAt);
  return Number(info.lastInsertRowid);
}

/** Her observations on check-in dates from `fromDay` to `toDay` (both included), oldest first. */
export function observationsBetween(db: Db, patientId: string, fromDay: string, toDay: string): SymptomObservation[] {
  return db
    .prepare(`SELECT ${COLUMNS} FROM symptom_observations WHERE patient_id = ? AND day >= ? AND day <= ? ORDER BY day, id`)
    .all(patientId, fromDay, toDay) as SymptomObservation[];
}

/** The day's highest level, the earliest at that level; undefined when nothing was observed. */
export function highestOfDay(db: Db, patientId: string, day: string): SymptomObservation | undefined {
  return db
    .prepare(`SELECT ${COLUMNS} FROM symptom_observations WHERE patient_id = ? AND day = ? ORDER BY level DESC, id LIMIT 1`)
    .get(patientId, day) as SymptomObservation | undefined;
}

/** Her observations at `minLevel` or above, newest first, at most `n` (the visit-prep sheet). */
export function recentObservations(db: Db, patientId: string, n: number, minLevel = 1): SymptomObservation[] {
  if (n <= 0) return [];
  return db
    .prepare(`SELECT ${COLUMNS} FROM symptom_observations WHERE patient_id = ? AND level >= ? ORDER BY day DESC, id DESC LIMIT ?`)
    .all(patientId, minLevel, Math.floor(n)) as SymptomObservation[];
}
