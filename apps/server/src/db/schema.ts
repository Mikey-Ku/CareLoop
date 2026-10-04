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
  // 6: what she types, beyond answers (src/checkin/engine.ts "Typed messages").
  // checkins.concern_at: when a red flag or a safety hit (crisis, urgent symptom) first came up in
  // this check-in. Set, it means no flag offer that day and a closing that says she'll hear from us
  // again. checkin_notes: her own words about a question ("it was weirder than that"), kept for her
  // doctor's visit-prep sheet and shown to family only at sharing "all". visit_questions: medicine
  // questions she asked, for her next visit. follow_ups: one later check-in after a red flag or a
  // safety hit ("How is your breathing now?"). family_relays: things she asked us to pass on to her
  // family; passed_on_at stays empty until a family chat is linked to take it.
  `
  ALTER TABLE checkins ADD COLUMN concern_at TEXT;

  CREATE TABLE checkin_notes (
    id INTEGER PRIMARY KEY,
    patient_id TEXT NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
    checkin_id INTEGER NOT NULL REFERENCES checkins(id) ON DELETE CASCADE,
    question_id TEXT NOT NULL,
    text TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX checkin_notes_checkin ON checkin_notes (checkin_id);
  CREATE INDEX checkin_notes_patient ON checkin_notes (patient_id, created_at);

  CREATE TABLE visit_questions (
    id INTEGER PRIMARY KEY,
    patient_id TEXT NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
    text TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX visit_questions_patient ON visit_questions (patient_id, created_at);

  CREATE TABLE follow_ups (
    id INTEGER PRIMARY KEY,
    patient_id TEXT NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
    checkin_id INTEGER REFERENCES checkins(id) ON DELETE SET NULL,
    -- the red-flag question id, "crisis", "urgent_symptom", or "general" when several came up
    reason TEXT NOT NULL,
    created_at TEXT NOT NULL,
    due_at TEXT NOT NULL,
    sent_at TEXT,
    -- the sent follow-up message, so a tap on its buttons finds it
    message_id TEXT,
    answered_at TEXT,
    answer TEXT
  );
  CREATE INDEX follow_ups_due ON follow_ups (due_at) WHERE sent_at IS NULL;
  CREATE INDEX follow_ups_patient ON follow_ups (patient_id, sent_at);
  CREATE UNIQUE INDEX follow_ups_message ON follow_ups (message_id) WHERE message_id IS NOT NULL;

  CREATE TABLE family_relays (
    id INTEGER PRIMARY KEY,
    patient_id TEXT NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
    text TEXT NOT NULL,
    created_at TEXT NOT NULL,
    passed_on_at TEXT
  );
  CREATE INDEX family_relays_waiting ON family_relays (patient_id) WHERE passed_on_at IS NULL;
  `,
  // 7: the severity ladder (docs/DESIGN.md "Severity ladder", src/checkin/severity.ts).
  // symptom_observations: every level the ladder gave something she told us (a button answer,
  // a typed symptom, a follow-up answer, a safety hit), by check-in date and topic (a question id,
  // her own short topic words, or a safety kind). Read by the repetition rule (a level-1 topic on
  // 3 of her last 5 days is level 2), the family's daily status at "all" and the visit-prep
  // sheet. words: her words for it, when typed. follow_ups.level: the level that asked for the
  // follow-up (the highest when several joined); "About the same" keeps it, at most 2. Older rows
  // have none and count as 3 (they were all red flags or safety hits). clarifications: the one
  // "A little, or a lot?" asked about a typed symptom on a check-in question, never twice.
  `
  CREATE TABLE symptom_observations (
    id INTEGER PRIMARY KEY,
    patient_id TEXT NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
    checkin_id INTEGER REFERENCES checkins(id) ON DELETE SET NULL,
    day TEXT NOT NULL,
    topic TEXT NOT NULL,
    question_id TEXT,
    level INTEGER NOT NULL CHECK (level BETWEEN 0 AND 5),
    amount TEXT CHECK (amount IS NULL OR amount IN ('none', 'a_little', 'a_lot', 'unknown')),
    change TEXT CHECK (change IS NULL OR change IN ('new', 'worse', 'same', 'better', 'unknown')),
    source TEXT NOT NULL CHECK (source IN ('button', 'typed', 'follow_up', 'safety')),
    words TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX symptom_observations_patient_day ON symptom_observations (patient_id, day);

  ALTER TABLE follow_ups ADD COLUMN level INTEGER CHECK (level IS NULL OR level BETWEEN 0 AND 5);

  CREATE TABLE clarifications (
    id INTEGER PRIMARY KEY,
    patient_id TEXT NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
    checkin_id INTEGER NOT NULL REFERENCES checkins(id) ON DELETE CASCADE,
    question_id TEXT NOT NULL,
    change TEXT CHECK (change IS NULL OR change IN ('new', 'worse', 'same', 'better', 'unknown')),
    words TEXT,
    asked_at TEXT NOT NULL,
    answered_at TEXT,
    answer TEXT,
    UNIQUE (checkin_id, question_id)
  );
  `,
  // 8: "Let me explain" (src/checkin/engine.ts). checkins.explain_at: when she tapped it on the
  // pending question; her next typed message is her own words about that question, and is kept
  // for her doctor even when it can't be matched to an answer. Cleared once that message is
  // handled or the check-in moves to another question.
  `
  ALTER TABLE checkins ADD COLUMN explain_at TEXT;
  `,
  // 9: one understanding pass for everything she types during a check-in (src/checkin/engine.ts).
  // checkin_notes.topic: what a note is about, a question id or her own topic words ("back pain");
  // question_id is null when that isn't one of the check-in's questions. SQLite can't drop NOT NULL
  // in place, so the table is rebuilt, with topic filled from question_id for older notes.
  // checkins.suggestions_json: the answer her words suggested on a red-flag question, waiting for
  // her tap ("It sounds like ... Is that right?"), keyed by question id with her words.
  `
  CREATE TABLE checkin_notes_v9 (
    id INTEGER PRIMARY KEY,
    patient_id TEXT NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
    checkin_id INTEGER NOT NULL REFERENCES checkins(id) ON DELETE CASCADE,
    question_id TEXT,
    topic TEXT NOT NULL,
    text TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  INSERT INTO checkin_notes_v9 (id, patient_id, checkin_id, question_id, topic, text, created_at)
    SELECT id, patient_id, checkin_id, question_id, question_id, text, created_at FROM checkin_notes;
  DROP TABLE checkin_notes;
  ALTER TABLE checkin_notes_v9 RENAME TO checkin_notes;
  CREATE INDEX checkin_notes_checkin ON checkin_notes (checkin_id);
  CREATE INDEX checkin_notes_patient ON checkin_notes (patient_id, created_at);

  ALTER TABLE checkins ADD COLUMN suggestions_json TEXT;
  `,
  // 10: the medication helper (src/meds, src/db/meds.ts).
  // med_doses: one row per morning or evening reminder sent (patient, check-in date, slot) and what
  // she said: sent, taken, not_yet (one gentle re-reminder at nudge_due_at, never more), missed (no
  // answer by MISSED_CHECKIN_TIME, morning only). med_memory_checks: the day's "how many do you take?"
  // (one medicine a day, planned with the morning reminder, asked after "Taken"). med_refills: one row
  // per fill reminded about (patient, medication, fill date); "I've asked for it" stops that fill.
  // med_prompts: which sent message carries which buttons, so a tap finds its dose, check or refill.
  // med_label_checks: a photographed label compared with her list, once per Relay attachment.
  // symptom_observations.source gains 'photo' (a label that doesn't match her list is a level-2
  // "medicine check" for her doctor); SQLite can't change a CHECK in place, so the table is rebuilt.
  `
  CREATE TABLE med_doses (
    id INTEGER PRIMARY KEY,
    patient_id TEXT NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
    day TEXT NOT NULL,
    slot TEXT NOT NULL CHECK (slot IN ('morning', 'evening')),
    status TEXT NOT NULL CHECK (status IN ('sent', 'taken', 'not_yet', 'missed')),
    at TEXT NOT NULL,
    sent_at TEXT NOT NULL,
    nudge_due_at TEXT,
    nudged_at TEXT,
    UNIQUE (patient_id, day, slot)
  );
  CREATE INDEX med_doses_nudge ON med_doses (nudge_due_at) WHERE nudge_due_at IS NOT NULL AND nudged_at IS NULL;

  CREATE TABLE med_memory_checks (
    id INTEGER PRIMARY KEY,
    patient_id TEXT NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
    day TEXT NOT NULL,
    medication_key TEXT NOT NULL,
    ingredient TEXT NOT NULL,
    unit TEXT NOT NULL CHECK (unit IN ('tablet', 'capsule')),
    slot TEXT NOT NULL CHECK (slot IN ('morning', 'midday', 'evening', 'bedtime')),
    count INTEGER NOT NULL CHECK (count > 0),
    instructions TEXT NOT NULL,
    planned_at TEXT NOT NULL,
    asked_at TEXT,
    answered_at TEXT,
    answer TEXT,
    correct INTEGER,
    UNIQUE (patient_id, day)
  );

  CREATE TABLE med_refills (
    id INTEGER PRIMARY KEY,
    patient_id TEXT NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
    medication_key TEXT NOT NULL,
    fill_date TEXT NOT NULL,
    name TEXT NOT NULL,
    run_out TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('reminded', 'snoozed', 'asked')),
    last_reminded_day TEXT,
    snoozed_until TEXT,
    family_told_at TEXT,
    updated_at TEXT NOT NULL,
    UNIQUE (patient_id, medication_key, fill_date)
  );

  CREATE TABLE med_prompts (
    message_id TEXT PRIMARY KEY,
    patient_id TEXT NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('dose', 'memory', 'refill')),
    ref_id INTEGER NOT NULL,
    sent_at TEXT NOT NULL
  );

  CREATE TABLE med_label_checks (
    id INTEGER PRIMARY KEY,
    patient_id TEXT NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
    attachment_id TEXT NOT NULL,
    outcome TEXT NOT NULL CHECK (outcome IN ('match', 'strength_differs', 'not_on_list', 'unreadable')),
    medication_key TEXT,
    label_medicine TEXT,
    label_strength TEXT,
    created_at TEXT NOT NULL,
    UNIQUE (patient_id, attachment_id)
  );

  CREATE TABLE symptom_observations_v10 (
    id INTEGER PRIMARY KEY,
    patient_id TEXT NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
    checkin_id INTEGER REFERENCES checkins(id) ON DELETE SET NULL,
    day TEXT NOT NULL,
    topic TEXT NOT NULL,
    question_id TEXT,
    level INTEGER NOT NULL CHECK (level BETWEEN 0 AND 5),
    amount TEXT CHECK (amount IS NULL OR amount IN ('none', 'a_little', 'a_lot', 'unknown')),
    change TEXT CHECK (change IS NULL OR change IN ('new', 'worse', 'same', 'better', 'unknown')),
    source TEXT NOT NULL CHECK (source IN ('button', 'typed', 'follow_up', 'safety', 'photo')),
    words TEXT,
    created_at TEXT NOT NULL
  );
  INSERT INTO symptom_observations_v10 (id, patient_id, checkin_id, day, topic, question_id, level, amount, change, source, words, created_at)
    SELECT id, patient_id, checkin_id, day, topic, question_id, level, amount, change, source, words, created_at FROM symptom_observations;
  DROP TABLE symptom_observations;
  ALTER TABLE symptom_observations_v10 RENAME TO symptom_observations;
  CREATE INDEX symptom_observations_patient_day ON symptom_observations (patient_id, day);
  `,
];

export const SCHEMA_VERSION = MIGRATIONS.length;
