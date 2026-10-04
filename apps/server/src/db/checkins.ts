import type { Db, SharingLevel } from "./index.ts";

// One row per patient and check-in date. Besides the outcome (status, mood,
// answers) a row keeps what the conversation is waiting for: the step, which
// question, and the flag on offer. See src/checkin/engine.ts.

export type CheckinStatus = "sent" | "answered" | "skipped" | "missed";
/** greeting: waiting for her open reply, "Quick questions" or "Not today"; question: waiting for an answer to question_index; flag_offer / flag_detail: a flag is on offer; done: nothing pending. */
export type CheckinStep = "greeting" | "question" | "flag_offer" | "flag_detail" | "done";

/**
 * One answer in checkins.answers_json. `level`: its severity level (src/checkin/severity.ts); answers stored
 * before the ladder have none. `via` and `freeText` when it came from her typed words (FreeTextAnswer in
 * src/checkin/engine-types.ts); a tap stores neither.
 */
export type StoredAnswer = {
  questionId: string;
  questionText: string;
  answer: string;
  at: string;
  level?: number;
  via?: "free_text" | "confirmed" | "voice";
  freeText?: string;
};

/**
 * An answer her words suggested on a red-flag question, waiting for her tap (migration 9): "It sounds
 * like ... Is that right?". `answer` is one of the question's labels; `words` is what she typed.
 */
export type Suggestion = { answer: string; words: string };

export type CheckinRow = {
  id: number;
  patientId: string;
  date: string;
  status: CheckinStatus;
  mood: string | null;
  answers: StoredAnswer[];
  questionIds: string[];
  step: CheckinStep;
  questionIndex: number;
  pendingFlagId: number | null;
  sentAt: string | null;
  finishedAt: string | null;
  /**
   * When a red flag or a safety hit (crisis, urgent symptom) first came up in this check-in (migration 6).
   * Set: no flag offer that day, and the closing says she'll hear from us again later.
   */
  concernAt: string | null;
  /** When she tapped "Let me explain" on the pending question (migration 8); her next typed message is about it. */
  explainAt: string | null;
  /** Suggested answers on red-flag questions waiting for her tap, by question id (migration 9). */
  suggestions: Record<string, Suggestion>;
};

type RawRow = Omit<CheckinRow, "answers" | "questionIds" | "suggestions"> & {
  answersJson: string | null;
  questionIdsJson: string;
  suggestionsJson: string | null;
};

const COLUMNS = `id, patient_id AS patientId, date, status, mood, answers_json AS answersJson,
  question_ids_json AS questionIdsJson, step, question_index AS questionIndex, pending_flag_id AS pendingFlagId,
  sent_at AS sentAt, finished_at AS finishedAt, concern_at AS concernAt, explain_at AS explainAt, suggestions_json AS suggestionsJson`;

function fromRaw(raw: RawRow | undefined): CheckinRow | undefined {
  if (!raw) return undefined;
  const { answersJson, questionIdsJson, suggestionsJson, ...rest } = raw;
  return {
    ...rest,
    answers: answersJson ? (JSON.parse(answersJson) as StoredAnswer[]) : [],
    questionIds: JSON.parse(questionIdsJson) as string[],
    suggestions: suggestionsJson ? (JSON.parse(suggestionsJson) as Record<string, Suggestion>) : {},
  };
}

export function insertCheckin(db: Db, input: { patientId: string; date: string; questionIds: string[]; sentAt: string }): number {
  const info = db
    .prepare(
      `INSERT INTO checkins (patient_id, date, status, answers_json, question_ids_json, step, question_index, sent_at)
       VALUES (?, ?, 'sent', '[]', ?, 'greeting', 0, ?)`,
    )
    .run(input.patientId, input.date, JSON.stringify(input.questionIds), input.sentAt);
  return Number(info.lastInsertRowid);
}

export function getCheckin(db: Db, patientId: string, date: string): CheckinRow | undefined {
  return fromRaw(db.prepare(`SELECT ${COLUMNS} FROM checkins WHERE patient_id = ? AND date = ?`).get(patientId, date) as RawRow | undefined);
}

export function getCheckinById(db: Db, id: number): CheckinRow | undefined {
  return fromRaw(db.prepare(`SELECT ${COLUMNS} FROM checkins WHERE id = ?`).get(id) as RawRow | undefined);
}

/** The most recent check-in (latest date) for a patient, finished or not. */
export function latestCheckin(db: Db, patientId: string): CheckinRow | undefined {
  return fromRaw(
    db.prepare(`SELECT ${COLUMNS} FROM checkins WHERE patient_id = ? ORDER BY date DESC, id DESC LIMIT 1`).get(patientId) as
      | RawRow
      | undefined,
  );
}

/** Her check-ins before `date` that she finished: answered, or said "not today" to. Missed ones don't count. */
export function finishedCheckinsBefore(db: Db, patientId: string, date: string): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM checkins WHERE patient_id = ? AND date < ? AND status IN ('answered', 'skipped')`)
    .get(patientId, date) as { n: number };
  return row.n;
}

export type CheckinPatch = Partial<{
  status: CheckinStatus;
  mood: string | null;
  answers: StoredAnswer[];
  step: CheckinStep;
  questionIndex: number;
  pendingFlagId: number | null;
  finishedAt: string | null;
  concernAt: string | null;
  explainAt: string | null;
  suggestions: Record<string, Suggestion>;
}>;

const PATCH_COLUMNS: Record<keyof CheckinPatch, string> = {
  status: "status",
  mood: "mood",
  answers: "answers_json",
  step: "step",
  questionIndex: "question_index",
  pendingFlagId: "pending_flag_id",
  finishedAt: "finished_at",
  concernAt: "concern_at",
  explainAt: "explain_at",
  suggestions: "suggestions_json",
};

export function updateCheckin(db: Db, id: number, patch: CheckinPatch): void {
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const [key, value] of Object.entries(patch) as [keyof CheckinPatch, unknown][]) {
    if (value === undefined) continue;
    sets.push(`${PATCH_COLUMNS[key]} = ?`);
    values.push(key === "answers" || key === "suggestions" ? JSON.stringify(value) : value);
  }
  if (sets.length === 0) return;
  db.prepare(`UPDATE checkins SET ${sets.join(", ")} WHERE id = ?`).run(...values, id);
}

/** A check-in step that sends buttons and waits for a tap. */
export type PromptStep = Exclude<CheckinStep, "done">;

/** One sent message carrying a check-in step's buttons (checkin_prompts, migration 5). */
export type CheckinPrompt = { messageId: string; checkinId: number; step: PromptStep; questionIndex: number; sentAt: string };

/** Remember a sent message as carrying `step`'s buttons. Recording the same message again changes nothing. */
export function recordCheckinPrompt(db: Db, prompt: CheckinPrompt): void {
  db.prepare(
    `INSERT INTO checkin_prompts (message_id, checkin_id, step, question_index, sent_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (message_id) DO NOTHING`,
  ).run(prompt.messageId, prompt.checkinId, prompt.step, prompt.questionIndex, prompt.sentAt);
}

/** The check-in step a sent message was for, or undefined if it carried no check-in buttons. */
export function getCheckinPrompt(db: Db, messageId: string): CheckinPrompt | undefined {
  return db
    .prepare(
      `SELECT message_id AS messageId, checkin_id AS checkinId, step, question_index AS questionIndex, sent_at AS sentAt
       FROM checkin_prompts WHERE message_id = ?`,
    )
    .get(messageId) as CheckinPrompt | undefined;
}

/** Record an inbound Relay message id. Returns false if it was already handled (a webhook retry). */
export function markInboundHandled(db: Db, messageId: string, chatId: string, receivedAt: string): boolean {
  return (
    db
      .prepare(`INSERT INTO inbound_messages (message_id, chat_id, received_at) VALUES (?, ?, ?) ON CONFLICT (message_id) DO NOTHING`)
      .run(messageId, chatId, receivedAt).changes === 1
  );
}

export type CheckinPatient = {
  id: string;
  finchnodePatientId: string;
  preferredName: string;
  relayChatId: string | null;
  sharing: SharingLevel;
};

const PATIENT_COLUMNS = `id, finchnode_patient_id AS finchnodePatientId, preferred_name AS preferredName,
  relay_chat_id AS relayChatId, sharing`;

export function getCheckinPatient(db: Db, patientId: string): CheckinPatient | undefined {
  return db.prepare(`SELECT ${PATIENT_COLUMNS} FROM patients WHERE id = ?`).get(patientId) as CheckinPatient | undefined;
}

/**
 * The senior whose own chat this is. Only her chat matches: a family chat (family_members.chat_id)
 * matches no one, so family members can never answer a check-in or change her sharing level.
 */
export function patientForChat(db: Db, chatId: string): CheckinPatient | undefined {
  return db.prepare(`SELECT ${PATIENT_COLUMNS} FROM patients WHERE relay_chat_id = ?`).get(chatId) as CheckinPatient | undefined;
}
