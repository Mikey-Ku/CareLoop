import type { Db } from "./index.ts";

// The medication helper's state (migration 10). Written by src/meds/flow.ts inside the
// engine's transactions. Nothing here holds her words or a photo.

export type ReminderSlot = "morning" | "evening";
export type DoseStatus = "sent" | "taken" | "not_yet" | "missed";

export type DoseRow = {
  id: number;
  patientId: string;
  day: string;
  slot: ReminderSlot;
  status: DoseStatus;
  /** When the status last changed. */
  at: string;
  sentAt: string;
  /** "Not yet": when the one gentle re-reminder is due. Set once, never moved. */
  nudgeDueAt: string | null;
  nudgedAt: string | null;
};

const DOSE_COLUMNS = `id, patient_id AS patientId, day, slot, status, at, sent_at AS sentAt, nudge_due_at AS nudgeDueAt, nudged_at AS nudgedAt`;

/** A reminder for this day and slot, or undefined when one was already sent. */
export function insertDose(db: Db, d: { patientId: string; day: string; slot: ReminderSlot; sentAt: string }): number | undefined {
  const info = db
    .prepare(`INSERT INTO med_doses (patient_id, day, slot, status, at, sent_at) VALUES (?, ?, ?, 'sent', ?, ?) ON CONFLICT DO NOTHING`)
    .run(d.patientId, d.day, d.slot, d.sentAt, d.sentAt);
  return info.changes === 1 ? Number(info.lastInsertRowid) : undefined;
}

export function getDose(db: Db, patientId: string, day: string, slot: ReminderSlot): DoseRow | undefined {
  return db.prepare(`SELECT ${DOSE_COLUMNS} FROM med_doses WHERE patient_id = ? AND day = ? AND slot = ?`).get(patientId, day, slot) as DoseRow | undefined;
}

export function getDoseById(db: Db, id: number): DoseRow | undefined {
  return db.prepare(`SELECT ${DOSE_COLUMNS} FROM med_doses WHERE id = ?`).get(id) as DoseRow | undefined;
}

/** Her latest reminder still waiting for "Taken" (sent or not yet), if any. */
export function openDose(db: Db, patientId: string): DoseRow | undefined {
  return db
    .prepare(`SELECT ${DOSE_COLUMNS} FROM med_doses WHERE patient_id = ? AND status IN ('sent', 'not_yet') ORDER BY sent_at DESC, id DESC LIMIT 1`)
    .get(patientId) as DoseRow | undefined;
}

export function setDoseStatus(db: Db, id: number, status: DoseStatus, at: string): void {
  db.prepare(`UPDATE med_doses SET status = ?, at = ? WHERE id = ?`).run(status, at, id);
}

/** "Not yet": the one re-reminder. Returns false when one was already planned (never more than one). */
export function planNudge(db: Db, id: number, dueAt: string): boolean {
  return db.prepare(`UPDATE med_doses SET nudge_due_at = ? WHERE id = ? AND nudge_due_at IS NULL`).run(dueAt, id).changes === 1;
}

/** Re-reminders due by `now` whose dose is still "not yet". */
export function dueNudges(db: Db, now: string): DoseRow[] {
  return db
    .prepare(`SELECT ${DOSE_COLUMNS} FROM med_doses WHERE nudge_due_at IS NOT NULL AND nudged_at IS NULL AND nudge_due_at <= ? AND status = 'not_yet' ORDER BY nudge_due_at, id`)
    .all(now) as DoseRow[];
}

/** The next re-reminder still to come (the simulator's /later). */
export function nextNudge(db: Db, patientId: string): DoseRow | undefined {
  return db
    .prepare(`SELECT ${DOSE_COLUMNS} FROM med_doses WHERE patient_id = ? AND nudge_due_at IS NOT NULL AND nudged_at IS NULL AND status = 'not_yet' ORDER BY nudge_due_at, id LIMIT 1`)
    .get(patientId) as DoseRow | undefined;
}

export function markNudged(db: Db, id: number, at: string): void {
  db.prepare(`UPDATE med_doses SET nudged_at = ? WHERE id = ?`).run(at, id);
}

// ---------- "How many do you take?" ----------

export type MemoryCheckRow = {
  id: number;
  patientId: string;
  day: string;
  medicationKey: string;
  ingredient: string;
  unit: "tablet" | "capsule";
  slot: "morning" | "midday" | "evening" | "bedtime";
  count: number;
  instructions: string;
  plannedAt: string;
  askedAt: string | null;
  answeredAt: string | null;
  answer: string | null;
  correct: number | null;
};

const MEMORY_COLUMNS = `id, patient_id AS patientId, day, medication_key AS medicationKey, ingredient, unit, slot, count, instructions,
  planned_at AS plannedAt, asked_at AS askedAt, answered_at AS answeredAt, answer, correct`;

/** Plan the day's check (once a day; a second plan for the same day changes nothing). */
export function planMemoryCheck(
  db: Db,
  m: Pick<MemoryCheckRow, "patientId" | "day" | "medicationKey" | "ingredient" | "unit" | "slot" | "count" | "instructions" | "plannedAt">,
): void {
  db.prepare(
    `INSERT INTO med_memory_checks (patient_id, day, medication_key, ingredient, unit, slot, count, instructions, planned_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
  ).run(m.patientId, m.day, m.medicationKey, m.ingredient, m.unit, m.slot, m.count, m.instructions, m.plannedAt);
}

export function memoryCheckFor(db: Db, patientId: string, day: string): MemoryCheckRow | undefined {
  return db.prepare(`SELECT ${MEMORY_COLUMNS} FROM med_memory_checks WHERE patient_id = ? AND day = ?`).get(patientId, day) as MemoryCheckRow | undefined;
}

export function memoryCheckById(db: Db, id: number): MemoryCheckRow | undefined {
  return db.prepare(`SELECT ${MEMORY_COLUMNS} FROM med_memory_checks WHERE id = ?`).get(id) as MemoryCheckRow | undefined;
}

/** The check asked and not answered yet, if any (her latest). */
export function pendingMemoryCheck(db: Db, patientId: string): MemoryCheckRow | undefined {
  return db
    .prepare(`SELECT ${MEMORY_COLUMNS} FROM med_memory_checks WHERE patient_id = ? AND asked_at IS NOT NULL AND answered_at IS NULL ORDER BY day DESC, id DESC LIMIT 1`)
    .get(patientId) as MemoryCheckRow | undefined;
}

/** How many checks she was asked before `day`: where the rotation through her medicines stands. */
export function memoryChecksAskedBefore(db: Db, patientId: string, day: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM med_memory_checks WHERE patient_id = ? AND day < ? AND asked_at IS NOT NULL`).get(patientId, day) as { n: number }).n;
}

export function markMemoryAsked(db: Db, id: number, at: string): void {
  db.prepare(`UPDATE med_memory_checks SET asked_at = ? WHERE id = ? AND asked_at IS NULL`).run(at, id);
}

/** Her answer ("1", "2", "Not sure"). Returns false when it was already answered. */
export function answerMemoryCheck(db: Db, id: number, answer: string, correct: boolean, at: string): boolean {
  return (
    db.prepare(`UPDATE med_memory_checks SET answer = ?, correct = ?, answered_at = ? WHERE id = ? AND answered_at IS NULL`).run(answer, correct ? 1 : 0, at, id)
      .changes === 1
  );
}

// ---------- Refills ----------

export type RefillStatus = "reminded" | "snoozed" | "asked";

export type RefillRow = {
  id: number;
  patientId: string;
  medicationKey: string;
  fillDate: string;
  /** "apixaban 5 mg". */
  name: string;
  runOut: string;
  status: RefillStatus;
  lastRemindedDay: string | null;
  /** "Remind me tomorrow": not reminded again before this day. */
  snoozedUntil: string | null;
  familyToldAt: string | null;
  updatedAt: string;
};

const REFILL_COLUMNS = `id, patient_id AS patientId, medication_key AS medicationKey, fill_date AS fillDate, name, run_out AS runOut, status,
  last_reminded_day AS lastRemindedDay, snoozed_until AS snoozedUntil, family_told_at AS familyToldAt, updated_at AS updatedAt`;

export function getRefill(db: Db, patientId: string, medicationKey: string, fillDate: string): RefillRow | undefined {
  return db
    .prepare(`SELECT ${REFILL_COLUMNS} FROM med_refills WHERE patient_id = ? AND medication_key = ? AND fill_date = ?`)
    .get(patientId, medicationKey, fillDate) as RefillRow | undefined;
}

export function getRefillById(db: Db, id: number): RefillRow | undefined {
  return db.prepare(`SELECT ${REFILL_COLUMNS} FROM med_refills WHERE id = ?`).get(id) as RefillRow | undefined;
}

/** Record a reminder sent on `day` for this fill (a new row, or the existing one reminded again). Returns its id. */
export function markRefillReminded(
  db: Db,
  r: { patientId: string; medicationKey: string; fillDate: string; name: string; runOut: string; day: string; at: string },
): number {
  db.prepare(
    `INSERT INTO med_refills (patient_id, medication_key, fill_date, name, run_out, status, last_reminded_day, updated_at)
     VALUES (?, ?, ?, ?, ?, 'reminded', ?, ?)
     ON CONFLICT (patient_id, medication_key, fill_date) DO UPDATE SET
       status = 'reminded', last_reminded_day = excluded.last_reminded_day, updated_at = excluded.updated_at`,
  ).run(r.patientId, r.medicationKey, r.fillDate, r.name, r.runOut, r.day, r.at);
  return getRefill(db, r.patientId, r.medicationKey, r.fillDate)!.id;
}

/** How many refill reminders went out on `day`. */
export function refillsRemindedOn(db: Db, patientId: string, day: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM med_refills WHERE patient_id = ? AND last_reminded_day = ?`).get(patientId, day) as { n: number }).n;
}

/** Her latest refill reminder still open (not "asked"), for a typed button label. */
export function openRefill(db: Db, patientId: string): RefillRow | undefined {
  return db
    .prepare(`SELECT ${REFILL_COLUMNS} FROM med_refills WHERE patient_id = ? AND status != 'asked' ORDER BY last_reminded_day DESC, updated_at DESC, id DESC LIMIT 1`)
    .get(patientId) as RefillRow | undefined;
}

export function setRefillStatus(db: Db, id: number, status: RefillStatus, at: string, snoozedUntil: string | null = null): void {
  db.prepare(`UPDATE med_refills SET status = ?, snoozed_until = ?, updated_at = ? WHERE id = ?`).run(status, snoozedUntil, at, id);
}

export function markRefillFamilyTold(db: Db, id: number, at: string): void {
  db.prepare(`UPDATE med_refills SET family_told_at = ?, updated_at = ? WHERE id = ?`).run(at, at, id);
}

// ---------- Which message carries which buttons ----------

export type MedPromptKind = "dose" | "memory" | "refill";
export type MedPrompt = { messageId: string; patientId: string; kind: MedPromptKind; refId: number; sentAt: string };

export function recordMedPrompt(db: Db, p: MedPrompt): void {
  db.prepare(`INSERT INTO med_prompts (message_id, patient_id, kind, ref_id, sent_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (message_id) DO NOTHING`).run(
    p.messageId,
    p.patientId,
    p.kind,
    p.refId,
    p.sentAt,
  );
}

/** When the latest message carrying this helper prompt (a reminder and its re-reminder, a memory check, a refill) went out. */
export function latestMedPromptAt(db: Db, kind: MedPromptKind, refId: number): string | undefined {
  const row = db.prepare(`SELECT MAX(sent_at) AS at FROM med_prompts WHERE kind = ? AND ref_id = ?`).get(kind, refId) as { at: string | null };
  return row.at ?? undefined;
}

export function getMedPrompt(db: Db, messageId: string): MedPrompt | undefined {
  return db
    .prepare(`SELECT message_id AS messageId, patient_id AS patientId, kind, ref_id AS refId, sent_at AS sentAt FROM med_prompts WHERE message_id = ?`)
    .get(messageId) as MedPrompt | undefined;
}

// ---------- Label photos ----------

export type LabelOutcome = "match" | "strength_differs" | "not_on_list" | "unreadable";

export type LabelCheckRow = {
  id: number;
  patientId: string;
  attachmentId: string;
  outcome: LabelOutcome;
  medicationKey: string | null;
  labelMedicine: string | null;
  labelStrength: string | null;
  createdAt: string;
};

const LABEL_COLUMNS = `id, patient_id AS patientId, attachment_id AS attachmentId, outcome, medication_key AS medicationKey,
  label_medicine AS labelMedicine, label_strength AS labelStrength, created_at AS createdAt`;

export function labelCheckFor(db: Db, patientId: string, attachmentId: string): LabelCheckRow | undefined {
  return db.prepare(`SELECT ${LABEL_COLUMNS} FROM med_label_checks WHERE patient_id = ? AND attachment_id = ?`).get(patientId, attachmentId) as
    | LabelCheckRow
    | undefined;
}

export function insertLabelCheck(db: Db, c: Omit<LabelCheckRow, "id">): number {
  const info = db
    .prepare(
      `INSERT INTO med_label_checks (patient_id, attachment_id, outcome, medication_key, label_medicine, label_strength, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(c.patientId, c.attachmentId, c.outcome, c.medicationKey, c.labelMedicine, c.labelStrength, c.createdAt);
  return Number(info.lastInsertRowid);
}
