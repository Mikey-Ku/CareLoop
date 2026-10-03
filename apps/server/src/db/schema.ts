// SQLite schema, applied as numbered migrations tracked by PRAGMA user_version.
// See docs/DESIGN.md "Database (SQLite)". Append new migrations; never edit a shipped one.

export const MIGRATIONS: readonly string[] = [
  // 1: initial schema
  `
  CREATE TABLE patients (
    id TEXT PRIMARY KEY,
    finchnode_patient_id TEXT NOT NULL UNIQUE,
    preferred_name TEXT NOT NULL,
    relay_handle TEXT,
    relay_chat_id TEXT,
    family_chat_id TEXT,
    checkin_time TEXT,
    timezone TEXT,
    sharing TEXT NOT NULL DEFAULT 'status' CHECK (sharing IN ('status', 'status_vitals', 'all'))
  );

  CREATE TABLE record_snapshots (
    id INTEGER PRIMARY KEY,
    patient_id TEXT NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
    fetched_at TEXT NOT NULL,
    scenario TEXT,
    sync_status TEXT,
    raw_json TEXT NOT NULL
  );
  CREATE INDEX record_snapshots_patient ON record_snapshots (patient_id, fetched_at);

  CREATE TABLE checkins (
    id INTEGER PRIMARY KEY,
    patient_id TEXT NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
    date TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('sent', 'answered', 'skipped', 'missed')),
    mood TEXT,
    answers_json TEXT,
    UNIQUE (patient_id, date)
  );

  CREATE TABLE vitals_readings (
    id INTEGER PRIMARY KEY,
    patient_id TEXT NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
    taken_at TEXT NOT NULL,
    heart_rate REAL,
    breathing_rate REAL,
    method TEXT NOT NULL CHECK (method IN ('relay_call', 'scan_screen')),
    confidence REAL
  );
  CREATE INDEX vitals_readings_patient ON vitals_readings (patient_id, taken_at);

  CREATE TABLE memories (
    id INTEGER PRIMARY KEY,
    patient_id TEXT NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
    text TEXT NOT NULL,
    created_at TEXT NOT NULL,
    deleted_at TEXT
  );
  CREATE INDEX memories_patient ON memories (patient_id, created_at);

  CREATE TABLE flags (
    id INTEGER PRIMARY KEY,
    patient_id TEXT NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
    rule_id TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'told', 'noted', 'cleared')),
    severity TEXT CHECK (severity IS NULL OR severity IN ('high', 'medium', 'low')),
    message TEXT NOT NULL,
    evidence_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    offered_on TEXT,
    told_at TEXT,
    told_on TEXT,
    noted_at TEXT,
    cleared_at TEXT,
    CHECK ((status = 'cleared') = (cleared_at IS NOT NULL))
  );
  -- One open row per (patient, rule, fingerprint); cleared rows are history.
  CREATE UNIQUE INDEX flags_open_fingerprint ON flags (patient_id, rule_id, fingerprint) WHERE status != 'cleared';
  CREATE INDEX flags_patient_status ON flags (patient_id, status);

  CREATE TABLE paper_scans (
    id INTEGER PRIMARY KEY,
    patient_id TEXT NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
    relay_attachment_id TEXT,
    extracted_json TEXT,
    created_at TEXT NOT NULL,
    confirmed_at TEXT,
    discrepancies_json TEXT
  );

  CREATE TABLE family_messages (
    id INTEGER PRIMARY KEY,
    patient_id TEXT NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
    direction TEXT NOT NULL CHECK (direction IN ('to_senior', 'to_family')),
    kind TEXT NOT NULL CHECK (kind IN ('voice', 'text', 'photo')),
    from_name TEXT,
    relay_message_id TEXT UNIQUE,
    created_at TEXT NOT NULL,
    played_at TEXT
  );
  CREATE INDEX family_messages_patient ON family_messages (patient_id, played_at);
  `,
  // 2: check-in conversation state (what is pending) and inbound message dedupe
  `
  ALTER TABLE checkins ADD COLUMN question_ids_json TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE checkins ADD COLUMN step TEXT NOT NULL DEFAULT 'greeting'
    CHECK (step IN ('greeting', 'question', 'flag_offer', 'flag_detail', 'done'));
  ALTER TABLE checkins ADD COLUMN question_index INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE checkins ADD COLUMN pending_flag_id INTEGER REFERENCES flags(id) ON DELETE SET NULL;
  ALTER TABLE checkins ADD COLUMN sent_at TEXT;
  ALTER TABLE checkins ADD COLUMN finished_at TEXT;
  CREATE INDEX checkins_patient_date ON checkins (patient_id, date);

  -- Relay retries webhooks; a message id is handled once.
  CREATE TABLE inbound_messages (
    message_id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL,
    received_at TEXT NOT NULL
  );
  `,
];

export const SCHEMA_VERSION = MIGRATIONS.length;
