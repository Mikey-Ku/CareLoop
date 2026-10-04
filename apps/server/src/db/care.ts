import type { CareAudience } from "../care/contacts.ts";
import type { CareFacts } from "../care/facts.ts";
import type { Db } from "./index.ts";

// Care summaries and the Photon threads with her doctor and emergency contact (migration 11).

export type CareSummaryRow = { id: number; patientId: string; day: string; trigger: string; facts: CareFacts; createdAt: string };

type RawSummary = Omit<CareSummaryRow, "facts"> & { factsJson: string };

const SUMMARY_COLUMNS = `id, patient_id AS patientId, day, trigger, facts_json AS factsJson, created_at AS createdAt`;

function summaryFromRaw(raw: RawSummary | undefined): CareSummaryRow | undefined {
  if (!raw) return undefined;
  const { factsJson, ...rest } = raw;
  return { ...rest, facts: JSON.parse(factsJson) as CareFacts };
}

/** Store the facts a summary is built from. The same (patient, day, trigger) keeps its first facts. */
export function insertCareSummary(db: Db, input: { patientId: string; day: string; trigger: string; facts: CareFacts; createdAt: string }): CareSummaryRow {
  db.prepare(
    `INSERT INTO care_summaries (patient_id, day, trigger, facts_json, created_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (patient_id, day, trigger) DO NOTHING`,
  ).run(input.patientId, input.day, input.trigger, JSON.stringify(input.facts), input.createdAt);
  return getCareSummary(db, input.patientId, input.day, input.trigger)!;
}

export function getCareSummary(db: Db, patientId: string, day: string, trigger: string): CareSummaryRow | undefined {
  return summaryFromRaw(
    db.prepare(`SELECT ${SUMMARY_COLUMNS} FROM care_summaries WHERE patient_id = ? AND day = ? AND trigger = ?`).get(patientId, day, trigger) as
      | RawSummary
      | undefined,
  );
}

/** The newest summary that went out to `audience`: what a follow-up question is answered from. */
export function latestSentSummary(db: Db, patientId: string, audience: CareAudience): CareSummaryRow | undefined {
  return summaryFromRaw(
    db
      .prepare(
        `SELECT s.id, s.patient_id AS patientId, s.day, s.trigger, s.facts_json AS factsJson, s.created_at AS createdAt
         FROM care_summaries s JOIN care_messages m ON m.summary_id = s.id
         WHERE s.patient_id = ? AND m.audience = ? AND m.kind = 'summary' AND m.sent_at IS NOT NULL
         ORDER BY m.id DESC LIMIT 1`,
      )
      .get(patientId, audience) as RawSummary | undefined,
  );
}

export type CareMessageRow = {
  id: number;
  patientId: string;
  audience: CareAudience;
  phone: string;
  direction: "outbound" | "inbound";
  kind: "summary" | "reply" | "inbound";
  summaryId: number | null;
  idempotencyKey: string | null;
  photonMessageId: string | null;
  text: string;
  createdAt: string;
  sentAt: string | null;
  error: string | null;
};

const MESSAGE_COLUMNS = `id, patient_id AS patientId, audience, phone, direction, kind, summary_id AS summaryId,
  idempotency_key AS idempotencyKey, photon_message_id AS photonMessageId, text, created_at AS createdAt,
  sent_at AS sentAt, error`;

/**
 * Plan one outbound text before sending it. Returns the row; when the key already exists the
 * stored row comes back unchanged, so a retry sees whether the first attempt went out (sentAt).
 */
export function planOutbound(
  db: Db,
  input: { patientId: string; audience: CareAudience; phone: string; kind: "summary" | "reply"; summaryId: number | null; key: string; text: string; createdAt: string },
): CareMessageRow {
  db.prepare(
    `INSERT INTO care_messages (patient_id, audience, phone, direction, kind, summary_id, idempotency_key, text, created_at)
     VALUES (?, ?, ?, 'outbound', ?, ?, ?, ?, ?) ON CONFLICT (idempotency_key) DO NOTHING`,
  ).run(input.patientId, input.audience, input.phone, input.kind, input.summaryId, input.key, input.text, input.createdAt);
  return db.prepare(`SELECT ${MESSAGE_COLUMNS} FROM care_messages WHERE idempotency_key = ?`).get(input.key) as CareMessageRow;
}

export function markOutboundSent(db: Db, id: number, sentAt: string, photonMessageId: string | null): void {
  db.prepare(`UPDATE care_messages SET sent_at = ?, photon_message_id = COALESCE(?, photon_message_id), error = NULL WHERE id = ?`).run(
    sentAt,
    photonMessageId,
    id,
  );
}

export function markOutboundFailed(db: Db, id: number, error: string): void {
  db.prepare(`UPDATE care_messages SET error = ? WHERE id = ?`).run(error, id);
}

/** Record an inbound text. Returns false when Photon delivered this message id before. */
export function recordInbound(
  db: Db,
  input: { patientId: string; audience: CareAudience; phone: string; photonMessageId: string; text: string; createdAt: string; summaryId: number | null },
): boolean {
  return (
    db
      .prepare(
        `INSERT INTO care_messages (patient_id, audience, phone, direction, kind, summary_id, photon_message_id, text, created_at, sent_at)
         VALUES (?, ?, ?, 'inbound', 'inbound', ?, ?, ?, ?, ?) ON CONFLICT (photon_message_id) DO NOTHING`,
      )
      .run(input.patientId, input.audience, input.phone, input.summaryId, input.photonMessageId, input.text, input.createdAt, input.createdAt).changes === 1
  );
}

/** The last `limit` messages with one contact that actually went through, oldest first. */
export function careThread(db: Db, patientId: string, audience: CareAudience, limit = 12): CareMessageRow[] {
  const rows = db
    .prepare(
      `SELECT ${MESSAGE_COLUMNS} FROM care_messages
       WHERE patient_id = ? AND audience = ? AND sent_at IS NOT NULL ORDER BY id DESC LIMIT ?`,
    )
    .all(patientId, audience, limit) as CareMessageRow[];
  return rows.reverse();
}

export function careMessages(db: Db, patientId: string): CareMessageRow[] {
  return db.prepare(`SELECT ${MESSAGE_COLUMNS} FROM care_messages WHERE patient_id = ? ORDER BY id`).all(patientId) as CareMessageRow[];
}

/** The outbound text planned under this key, if any (sent or not). */
export function outboundForKey(db: Db, key: string): CareMessageRow | undefined {
  return db.prepare(`SELECT ${MESSAGE_COLUMNS} FROM care_messages WHERE idempotency_key = ?`).get(key) as CareMessageRow | undefined;
}

/** The summary text as it went to `audience` (written or template), if it went out. */
export function sentSummaryText(db: Db, summaryId: number, audience: CareAudience): string | undefined {
  const row = db
    .prepare(`SELECT text FROM care_messages WHERE summary_id = ? AND audience = ? AND kind = 'summary' AND sent_at IS NOT NULL ORDER BY id DESC LIMIT 1`)
    .get(summaryId, audience) as { text: string } | undefined;
  return row?.text;
}
