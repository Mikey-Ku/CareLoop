// SQLite schema, applied as numbered migrations tracked by PRAGMA user_version.
// See docs/DESIGN.md "Database (SQLite)". Append new migrations; never edit a shipped one.

export const MIGRATIONS: readonly string[] = [
  // 1: initial schema. patients.family_chat_id is unused since migration 4 (family_members):
  // Relay chats hold at most one person, so there is no family group chat to store. The
  // column stays because dropping a column in SQLite means rebuilding the table.
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
  // 3: Relay WebSocket inbox. An event is committed here before the SDK ACKs it;
  // a processor works through unprocessed rows in arrival order (src/relay/inbox.ts).
  `
  CREATE TABLE relay_events (
    event_id TEXT PRIMARY KEY,
    sequence TEXT NOT NULL,
    event_type TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    received_at TEXT NOT NULL,
    processed_at TEXT,
    error TEXT
  );
  CREATE INDEX relay_events_unprocessed ON relay_events (processed_at) WHERE processed_at IS NULL;

  -- Each FULL sync Relay asked for: the boundary it superseded events through.
  CREATE TABLE relay_full_syncs (
    id INTEGER PRIMARY KEY,
    through_sequence TEXT NOT NULL,
    reason TEXT NOT NULL,
    chats_seen INTEGER NOT NULL,
    completed_at TEXT NOT NULL
  );
  `,
  // 4: family chats (docs/adr/0001-family-chats-not-a-group.md). One row per family member
  // configured for a senior (FAMILY_RELAY_HANDLES, handles normalized). chat_id is that
  // person's own direct chat with the agent, filled in when they first message the agent
  // (contact.added, or their first direct message). Replaces patients.family_chat_id.
  `
  CREATE TABLE family_members (
    patient_id TEXT NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
    handle TEXT NOT NULL,
    display_name TEXT,
    chat_id TEXT,
    linked_at TEXT,
    PRIMARY KEY (patient_id, handle)
  );
  CREATE INDEX family_members_chat ON family_members (chat_id) WHERE chat_id IS NOT NULL;
  `,
  // 5: the check-in messages that carry its buttons (the greeting, each question, the flag offer
  // and detail, and any re-send of one), with the step each was sent for. A tap names the message
  // it replies to; a tap on one sent for another step or another day is stale and only re-prompts
  // (src/checkin/engine.ts).
  `
  CREATE TABLE checkin_prompts (
    message_id TEXT PRIMARY KEY,
    checkin_id INTEGER NOT NULL REFERENCES checkins(id) ON DELETE CASCADE,
    step TEXT NOT NULL CHECK (step IN ('greeting', 'question', 'flag_offer', 'flag_detail')),
    question_index INTEGER NOT NULL DEFAULT 0,
    sent_at TEXT NOT NULL
  );
  CREATE INDEX checkin_prompts_checkin ON checkin_prompts (checkin_id);
  `,
  // 6: care summaries over Photon (src/care/*). A care summary is the day's facts after a
  // check-in or call, frozen as sent, so follow-up replies answer from exactly what the doctor
  // and the emergency contact were told. care_messages holds every Photon text both ways:
  // outbound rows are written before the send (idempotency_key), inbound rows dedupe by
  // Photon's message id.
  `
  CREATE TABLE care_summaries (
    id INTEGER PRIMARY KEY,
    patient_id TEXT NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
    day TEXT NOT NULL,
    trigger TEXT NOT NULL,
    facts_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (patient_id, day, trigger)
  );

  CREATE TABLE care_messages (
    id INTEGER PRIMARY KEY,
    patient_id TEXT NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
    audience TEXT NOT NULL CHECK (audience IN ('doctor', 'family')),
    phone TEXT NOT NULL,
    direction TEXT NOT NULL CHECK (direction IN ('outbound', 'inbound')),
    kind TEXT NOT NULL CHECK (kind IN ('summary', 'reply', 'inbound')),
    summary_id INTEGER REFERENCES care_summaries(id) ON DELETE SET NULL,
    idempotency_key TEXT UNIQUE,
    photon_message_id TEXT UNIQUE,
    text TEXT NOT NULL,
    created_at TEXT NOT NULL,
    sent_at TEXT,
    error TEXT
  );
  CREATE INDEX care_messages_thread ON care_messages (patient_id, audience, id);
  `,
];

export const SCHEMA_VERSION = MIGRATIONS.length;
