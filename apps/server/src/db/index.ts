import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { MIGRATIONS, SCHEMA_VERSION } from "./schema.ts";

export type Db = Database.Database;
export type SharingLevel = "status" | "status_vitals" | "all";

const isMemory = (path: string) => path === ":memory:" || path === "";

/**
 * Open (or create) the app database and bring it up to the latest schema.
 * Safe to call repeatedly on the same file: migrations run only once each.
 */
export function openDatabase(path: string): Db {
  if (!isMemory(path)) mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("foreign_keys = ON");
  if (!isMemory(path)) db.pragma("journal_mode = WAL");
  migrate(db);
  return db;
}

export function schemaVersion(db: Db): number {
  return db.pragma("user_version", { simple: true }) as number;
}

function migrate(db: Db): void {
  const current = schemaVersion(db);
  if (current > SCHEMA_VERSION)
    throw new Error(`Database schema version ${current} is newer than this code (${SCHEMA_VERSION}).`);
  for (let version = current; version < SCHEMA_VERSION; version++) {
    const sql = MIGRATIONS[version]!;
    db.transaction(() => {
      db.exec(sql);
      db.pragma(`user_version = ${version + 1}`);
    })();
  }
}

export type PatientRow = {
  id: string;
  finchnodePatientId: string;
  /** The FinchNode subject to read. For legacy rows this equals finchnodePatientId. */
  finchnodeSubject?: string | null;
  preferredName: string;
  relayHandle?: string | null;
  relayChatId?: string | null;
  checkinTime?: string | null;
  timezone?: string | null;
  sharing?: SharingLevel;
  onboardingStatus?: "pending" | "active" | "revoked";
};

/**
 * Insert a patient, or update the given fields if the id exists. Sharing is only changed when passed.
 * Family chats live in family_members (src/db/family.ts); patients.family_chat_id is unused.
 */
export function upsertPatient(db: Db, p: PatientRow): void {
  db.prepare(
    `INSERT INTO patients (id, finchnode_patient_id, finchnode_subject, preferred_name, relay_handle, relay_chat_id, checkin_time, timezone, sharing, onboarding_status)
     VALUES (@id, @finchnodePatientId, COALESCE(@finchnodeSubject, @finchnodePatientId), @preferredName, @relayHandle, @relayChatId, @checkinTime, @timezone, COALESCE(@sharing, 'status'), COALESCE(@onboardingStatus, 'active'))
     ON CONFLICT (id) DO UPDATE SET
       finchnode_patient_id = excluded.finchnode_patient_id,
       finchnode_subject = COALESCE(@finchnodeSubject, patients.finchnode_subject, excluded.finchnode_patient_id),
       preferred_name = excluded.preferred_name,
       relay_handle = excluded.relay_handle,
       relay_chat_id = excluded.relay_chat_id,
       checkin_time = excluded.checkin_time,
       timezone = excluded.timezone,
       sharing = COALESCE(@sharing, patients.sharing),
       onboarding_status = COALESCE(@onboardingStatus, patients.onboarding_status)`,
  ).run({
    id: p.id,
    finchnodePatientId: p.finchnodePatientId,
    finchnodeSubject: p.finchnodeSubject ?? null,
    preferredName: p.preferredName,
    relayHandle: p.relayHandle ?? null,
    relayChatId: p.relayChatId ?? null,
    checkinTime: p.checkinTime ?? null,
    timezone: p.timezone ?? null,
    sharing: p.sharing ?? null,
    onboardingStatus: p.onboardingStatus ?? null,
  });
}

export type ActivePatient = {
  id: string;
  finchnodePatientId: string;
  preferredName: string;
  relayHandle: string | null;
  relayChatId: string | null;
  timezone: string | null;
  onboardingStatus: "pending" | "active" | "revoked";
};

/** All local patient accounts that can receive a check-in. */
export function activePatients(db: Db): ActivePatient[] {
  return db
    .prepare(
      `SELECT id, COALESCE(finchnode_subject, finchnode_patient_id) AS finchnodePatientId,
              preferred_name AS preferredName, relay_handle AS relayHandle, relay_chat_id AS relayChatId,
              timezone, onboarding_status AS onboardingStatus
       FROM patients WHERE onboarding_status = 'active' ORDER BY id`,
    )
    .all() as ActivePatient[];
}

export function getSharing(db: Db, patientId: string): SharingLevel | undefined {
  const row = db.prepare("SELECT sharing FROM patients WHERE id = ?").get(patientId) as { sharing: SharingLevel } | undefined;
  return row?.sharing;
}

/** Only the senior changes this, from her own chat. */
export function setSharing(db: Db, patientId: string, sharing: SharingLevel): void {
  db.prepare("UPDATE patients SET sharing = ? WHERE id = ?").run(sharing, patientId);
}

export * from "./flags.ts";
export * from "./snapshots.ts";
export * from "./calls.ts";
