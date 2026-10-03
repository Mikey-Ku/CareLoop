import type { Db } from "./index.ts";

export type SnapshotInput = {
  patientId: string;
  fetchedAt: string;
  scenario?: string | null;
  syncStatus?: string | null;
  /** The FinchNode response as received; objects are JSON-encoded. */
  raw: unknown;
};

export type SnapshotRow = {
  id: number;
  patientId: string;
  fetchedAt: string;
  scenario: string | null;
  syncStatus: string | null;
  rawJson: string;
};

export function saveSnapshot(db: Db, s: SnapshotInput): number {
  const rawJson = typeof s.raw === "string" ? s.raw : JSON.stringify(s.raw);
  const info = db
    .prepare("INSERT INTO record_snapshots (patient_id, fetched_at, scenario, sync_status, raw_json) VALUES (?, ?, ?, ?, ?)")
    .run(s.patientId, s.fetchedAt, s.scenario ?? null, s.syncStatus ?? null, rawJson);
  return Number(info.lastInsertRowid);
}

export function latestSnapshot(db: Db, patientId: string): SnapshotRow | undefined {
  return db
    .prepare(
      `SELECT id, patient_id AS patientId, fetched_at AS fetchedAt, scenario, sync_status AS syncStatus, raw_json AS rawJson
       FROM record_snapshots WHERE patient_id = ? ORDER BY fetched_at DESC, id DESC LIMIT 1`,
    )
    .get(patientId) as SnapshotRow | undefined;
}

/**
 * Record consent ended (FinchNode 410): delete our copy of her health record.
 * Memories, check-ins and chat history stay unless she asks to delete them.
 * Returns the number of snapshots deleted.
 */
export function deletePatientSnapshots(db: Db, patientId: string): number {
  return db.prepare("DELETE FROM record_snapshots WHERE patient_id = ?").run(patientId).changes;
}
