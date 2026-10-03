import type { ExtractedPaper } from "../rules/paper-diff.ts";
import type { Db } from "./index.ts";

// Hospital paper checks (paper_scans), one row per read of her papers.
// Queries only: the table comes from migration 1. Without a status column the
// row's phase is derived from its two nullable columns:
//
//   confirmed_at  discrepancies_json        phase
//   null          null                      awaiting her "Yes" / "No" on the read-back
//   null          {"outcome":"rejected"}    she said the read-back was wrong; nothing compared
//   set           {"outcome":"flag", ...}   compared (R6), see PaperOutcome
//
// Only the latest row for a patient can be pending; an older unanswered read-back
// is superseded by a newer one.

/** What R6 found, plus where the conversation about it stands. Stored as discrepancies_json. */
export type PaperOutcome =
  | { outcome: "rejected"; at: string }
  | {
      outcome: "flag" | "checked" | "skipped";
      /** R6 `details.discrepancies`: empty unless the outcome is flag. */
      discrepancies: unknown[];
      /** The R6 row in `flags` when the outcome is flag. */
      flagId: number | null;
      /** Her answer to the R6 message: pending until she taps "I'll ask my doctor" or "Later". */
      followUp: "pending" | "noted" | "later" | null;
      /** Why nothing was compared, when the outcome is skipped. */
      reason?: string;
    };

export type PaperScanPhase = "awaiting_confirm" | "rejected" | "confirmed";

export type PaperScanRow = {
  id: number;
  patientId: string;
  relayAttachmentId: string | null;
  paper: ExtractedPaper;
  createdAt: string;
  confirmedAt: string | null;
  outcome: PaperOutcome | null;
  phase: PaperScanPhase;
};

type RawRow = {
  id: number;
  patientId: string;
  relayAttachmentId: string | null;
  extractedJson: string | null;
  createdAt: string;
  confirmedAt: string | null;
  discrepanciesJson: string | null;
};

const COLUMNS = `id, patient_id AS patientId, relay_attachment_id AS relayAttachmentId, extracted_json AS extractedJson,
  created_at AS createdAt, confirmed_at AS confirmedAt, discrepancies_json AS discrepanciesJson`;

function fromRaw(raw: RawRow | undefined): PaperScanRow | undefined {
  if (!raw) return undefined;
  const outcome = raw.discrepanciesJson ? (JSON.parse(raw.discrepanciesJson) as PaperOutcome) : null;
  const phase: PaperScanPhase = raw.confirmedAt !== null ? "confirmed" : outcome ? "rejected" : "awaiting_confirm";
  return {
    id: raw.id,
    patientId: raw.patientId,
    relayAttachmentId: raw.relayAttachmentId,
    paper: JSON.parse(raw.extractedJson ?? "null") as ExtractedPaper,
    createdAt: raw.createdAt,
    confirmedAt: raw.confirmedAt,
    outcome,
    phase,
  };
}

export function insertPaperScan(
  db: Db,
  input: { patientId: string; paper: ExtractedPaper; attachmentId?: string | null; createdAt: string },
): number {
  const info = db
    .prepare(`INSERT INTO paper_scans (patient_id, relay_attachment_id, extracted_json, created_at) VALUES (?, ?, ?, ?)`)
    .run(input.patientId, input.attachmentId ?? null, JSON.stringify(input.paper), input.createdAt);
  return Number(info.lastInsertRowid);
}

export function getPaperScan(db: Db, id: number): PaperScanRow | undefined {
  return fromRaw(db.prepare(`SELECT ${COLUMNS} FROM paper_scans WHERE id = ?`).get(id) as RawRow | undefined);
}

/** The scan already made from this Relay attachment, if any (a replayed photo). */
export function paperScanForAttachment(db: Db, patientId: string, attachmentId: string): PaperScanRow | undefined {
  return fromRaw(
    db
      .prepare(`SELECT ${COLUMNS} FROM paper_scans WHERE patient_id = ? AND relay_attachment_id = ? ORDER BY id DESC LIMIT 1`)
      .get(patientId, attachmentId) as RawRow | undefined,
  );
}

export function latestPaperScan(db: Db, patientId: string): PaperScanRow | undefined {
  return fromRaw(
    db.prepare(`SELECT ${COLUMNS} FROM paper_scans WHERE patient_id = ? ORDER BY id DESC LIMIT 1`).get(patientId) as
      | RawRow
      | undefined,
  );
}

/** She confirmed the read-back and R6 ran. */
export function confirmPaperScan(db: Db, id: number, confirmedAt: string, outcome: PaperOutcome): void {
  db.prepare(`UPDATE paper_scans SET confirmed_at = ?, discrepancies_json = ? WHERE id = ?`).run(
    confirmedAt,
    JSON.stringify(outcome),
    id,
  );
}

/** She said the read-back was wrong: nothing confirmed, nothing compared. */
export function rejectPaperScan(db: Db, id: number, at: string): void {
  const outcome: PaperOutcome = { outcome: "rejected", at };
  db.prepare(`UPDATE paper_scans SET discrepancies_json = ? WHERE id = ? AND confirmed_at IS NULL`).run(JSON.stringify(outcome), id);
}

/** Replace the stored outcome (her follow-up answer to the R6 message). */
export function updatePaperOutcome(db: Db, id: number, outcome: PaperOutcome): void {
  db.prepare(`UPDATE paper_scans SET discrepancies_json = ? WHERE id = ?`).run(JSON.stringify(outcome), id);
}

/** The open (not cleared) flag for a rule and fingerprint. */
export function openFlagIdByFingerprint(db: Db, patientId: string, ruleId: string, print: string): number | undefined {
  const row = db
    .prepare(`SELECT id FROM flags WHERE patient_id = ? AND rule_id = ? AND fingerprint = ? AND status != 'cleared'`)
    .get(patientId, ruleId, print) as { id: number } | undefined;
  return row?.id;
}

/** Has this inbound message id been handled already? Read-only; the engine records it inside its transaction. */
export function inboundSeen(db: Db, messageId: string): boolean {
  return db.prepare(`SELECT 1 FROM inbound_messages WHERE message_id = ?`).get(messageId) !== undefined;
}
