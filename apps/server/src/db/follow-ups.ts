import type { Db } from "./index.ts";

// Follow-up check-ins (follow_ups, migration 6; level, migration 7). After a level-2 answer
// (worth watching), a red flag (level 3) or a safety hit the engine schedules one later message ("Checking in again, Harriet. How is your breathing
// now?") with "Better", "About the same" and "Worse". A job sends it once it is due
// (src/checkin/engine.ts runDueFollowUps); her tap is matched by the sent message id.
//
// At most one follow-up waits to be sent per patient: a second concern before it goes
// out joins it, keeping the earlier due time and the higher level. When the two are about different things it
// becomes a general one ("How are you feeling now?"), except that a crisis outranks
// everything (its follow-up points to 988).

/** A follow-up about several things at once. */
export const GENERAL_REASON = "general";
/** The safety kind whose follow-up wins over any other reason. */
const CRISIS_REASON = "crisis";

/** The reason when a second concern joins a waiting follow-up. */
export function mergedReason(waiting: string, added: string): string {
  if (waiting === added || waiting === CRISIS_REASON) return waiting;
  if (added === CRISIS_REASON) return CRISIS_REASON;
  return GENERAL_REASON;
}

export type FollowUpRow = {
  id: number;
  patientId: string;
  checkinId: number | null;
  /** The question id or topic, "crisis", "urgent_symptom", or "general". */
  reason: string;
  /** The severity level that asked for it (the highest when several joined); null on rows from before migration 7. */
  level: number | null;
  createdAt: string;
  dueAt: string;
  sentAt: string | null;
  messageId: string | null;
  answeredAt: string | null;
  answer: string | null;
};

const COLUMNS = `id, patient_id AS patientId, checkin_id AS checkinId, reason, level, created_at AS createdAt, due_at AS dueAt,
  sent_at AS sentAt, message_id AS messageId, answered_at AS answeredAt, answer`;

/** The follow-up waiting to be sent for a patient, if any (the earliest due). */
export function nextFollowUp(db: Db, patientId: string): FollowUpRow | undefined {
  return db
    .prepare(`SELECT ${COLUMNS} FROM follow_ups WHERE patient_id = ? AND sent_at IS NULL ORDER BY due_at, id LIMIT 1`)
    .get(patientId) as FollowUpRow | undefined;
}

/** A follow-up row with no level (from before migration 7) was a red flag or a safety hit: level 3. */
export const LEGACY_FOLLOW_UP_LEVEL = 3;

/**
 * Schedule a follow-up, or join the one already waiting to be sent: same reason, nothing changes;
 * another reason, it becomes general (or crisis, see mergedReason). The level becomes the higher
 * of the two. Returns the follow-up's id.
 */
export function scheduleFollowUp(
  db: Db,
  input: { patientId: string; checkinId: number | null; reason: string; createdAt: string; dueAt: string; level?: number },
): number {
  const level = input.level ?? LEGACY_FOLLOW_UP_LEVEL;
  return db.transaction((): number => {
    const waiting = nextFollowUp(db, input.patientId);
    if (waiting) {
      const reason = mergedReason(waiting.reason, input.reason);
      const higher = Math.max(waiting.level ?? LEGACY_FOLLOW_UP_LEVEL, level);
      if (reason !== waiting.reason || higher !== waiting.level)
        db.prepare(`UPDATE follow_ups SET reason = ?, level = ? WHERE id = ?`).run(reason, higher, waiting.id);
      return waiting.id;
    }
    const info = db
      .prepare(`INSERT INTO follow_ups (patient_id, checkin_id, reason, level, created_at, due_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(input.patientId, input.checkinId, input.reason, level, input.createdAt, input.dueAt);
    return Number(info.lastInsertRowid);
  })();
}

/** Follow-ups due by `now` (ISO) and not sent yet, every patient, earliest first. */
export function dueFollowUps(db: Db, now: string): FollowUpRow[] {
  // ISO timestamps from toISOString() compare as text; julianday copes with other offsets.
  return db
    .prepare(`SELECT ${COLUMNS} FROM follow_ups WHERE sent_at IS NULL AND julianday(due_at) <= julianday(?) ORDER BY due_at, id`)
    .all(now) as FollowUpRow[];
}

/** Record that the follow-up went out as `messageId`. */
export function markFollowUpSent(db: Db, id: number, messageId: string, sentAt: string): void {
  db.prepare(`UPDATE follow_ups SET sent_at = ?, message_id = ? WHERE id = ? AND sent_at IS NULL`).run(sentAt, messageId, id);
}

/** The follow-up a sent message carried, if any. */
export function followUpForMessage(db: Db, messageId: string): FollowUpRow | undefined {
  return db.prepare(`SELECT ${COLUMNS} FROM follow_ups WHERE message_id = ?`).get(messageId) as FollowUpRow | undefined;
}

/** The latest follow-up sent to her and not answered yet: what a typed "Better" answers. */
export function openFollowUp(db: Db, patientId: string): FollowUpRow | undefined {
  return db
    .prepare(
      `SELECT ${COLUMNS} FROM follow_ups WHERE patient_id = ? AND sent_at IS NOT NULL AND answered_at IS NULL
       ORDER BY sent_at DESC, id DESC LIMIT 1`,
    )
    .get(patientId) as FollowUpRow | undefined;
}

/** Store her answer. Returns false if it was already answered (a second tap). */
export function answerFollowUp(db: Db, id: number, answer: string, answeredAt: string): boolean {
  return db.prepare(`UPDATE follow_ups SET answer = ?, answered_at = ? WHERE id = ? AND answered_at IS NULL`).run(answer, answeredAt, id).changes === 1;
}
