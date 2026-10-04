import type { Db } from "./index.ts";

export type CallStatus = "ringing" | "in_progress" | "ended" | "failed";
export type CallPhase = "interview" | "quiet_measurement" | "screening" | "complete" | "emergency" | "failed";
export type TranscriptSpeaker = "patient" | "agent";

export type CallSessionRow = {
  callId: string;
  patientId: string;
  relayChatId: string;
  status: CallStatus;
  phase: CallPhase;
  conversationId: string | null;
  startedAt: string;
  answeredAt: string | null;
  endedAt: string | null;
  measurementStartedAt: string | null;
  measurementEndedAt: string | null;
  screeningJson: string | null;
  error: string | null;
};

const SESSION_COLUMNS = `call_id AS callId, patient_id AS patientId, relay_chat_id AS relayChatId,
  status, phase, conversation_id AS conversationId, started_at AS startedAt, answered_at AS answeredAt,
  ended_at AS endedAt, measurement_started_at AS measurementStartedAt, measurement_ended_at AS measurementEndedAt,
  screening_json AS screeningJson, error`;

export function createCallSession(db: Db, input: { callId: string; patientId: string; relayChatId: string; at: string }): void {
  db.prepare(
    `INSERT INTO call_sessions (call_id, patient_id, relay_chat_id, status, phase, started_at)
     VALUES (?, ?, ?, 'ringing', 'interview', ?)
     ON CONFLICT (call_id) DO NOTHING`,
  ).run(input.callId, input.patientId, input.relayChatId, input.at);
}

export function getCallSession(db: Db, callId: string): CallSessionRow | undefined {
  return db.prepare(`SELECT ${SESSION_COLUMNS} FROM call_sessions WHERE call_id = ?`).get(callId) as CallSessionRow | undefined;
}

export function patchCallSession(db: Db, callId: string, patch: Partial<{
  status: CallStatus;
  phase: CallPhase;
  conversationId: string | null;
  answeredAt: string;
  endedAt: string;
  measurementStartedAt: string;
  measurementEndedAt: string;
  screeningJson: string;
  error: string;
}>): void {
  const columns: Record<string, string> = {
    status: "status",
    phase: "phase",
    conversationId: "conversation_id",
    answeredAt: "answered_at",
    endedAt: "ended_at",
    measurementStartedAt: "measurement_started_at",
    measurementEndedAt: "measurement_ended_at",
    screeningJson: "screening_json",
    error: "error",
  };
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    sets.push(`${columns[key]} = ?`);
    values.push(value);
  }
  if (sets.length === 0) return;
  values.push(callId);
  db.prepare(`UPDATE call_sessions SET ${sets.join(", ")} WHERE call_id = ?`).run(...values);
}

const turnText = (text: string) => text.replace(/\s+/g, " ").trim().slice(0, 2_000);

export function addCallTranscript(db: Db, input: { callId: string; speaker: TranscriptSpeaker; text: string; at: string }): void {
  const text = turnText(input.text);
  if (!text) return;
  const row = db.prepare(`SELECT COALESCE(MAX(sequence), -1) + 1 AS sequence FROM call_transcript_turns WHERE call_id = ?`).get(input.callId) as {
    sequence: number;
  };
  db.prepare(
    `INSERT INTO call_transcript_turns (call_id, sequence, speaker, text, created_at) VALUES (?, ?, ?, ?, ?)`,
  ).run(input.callId, row.sequence, input.speaker, text, input.at);
}

/** The call's latest agent turn takes new text (ElevenLabs corrects what the voice said when she talks over it). */
export function correctLastAgentTurn(db: Db, input: { callId: string; text: string }): void {
  const text = turnText(input.text);
  if (!text) return;
  db.prepare(
    `UPDATE call_transcript_turns SET text = ?
     WHERE call_id = ? AND sequence = (SELECT MAX(sequence) FROM call_transcript_turns WHERE call_id = ? AND speaker = 'agent')`,
  ).run(text, input.callId, input.callId);
}

export function callTranscript(db: Db, callId: string): { speaker: TranscriptSpeaker; text: string; createdAt: string }[] {
  return db
    .prepare(`SELECT speaker, text, created_at AS createdAt FROM call_transcript_turns WHERE call_id = ? ORDER BY sequence`)
    .all(callId) as { speaker: TranscriptSpeaker; text: string; createdAt: string }[];
}

/**
 * The call whose post-call message ("Here's what I noted from our call") is `messageId`: the call's
 * result (screening_json) keeps the message id and the check-in date, so her tap finds them.
 */
export function callForSummaryMessage(db: Db, messageId: string): { callId: string; patientId: string; day: string; startedAt: string } | undefined {
  return db
    .prepare(
      `SELECT call_id AS callId, patient_id AS patientId, json_extract(screening_json, '$.day') AS day, started_at AS startedAt
       FROM call_sessions WHERE screening_json IS NOT NULL AND json_valid(screening_json)
         AND json_extract(screening_json, '$.summaryMessageId') = ?`,
    )
    .get(messageId) as { callId: string; patientId: string; day: string; startedAt: string } | undefined;
}

/**
 * Whether she was on a call (answered, and still going or ended) at or after `sinceIso`. Her day's
 * check-in counts as touched then, even if the call recorded no answers: she talked to us, so the
 * family must not get "hasn't checked in". A 10-minute margin covers a call that opened the check-in
 * itself (answered a moment before the check-in's sent time).
 */
export function wasOnCallSince(db: Db, patientId: string, sinceIso: string): boolean {
  const since = Date.parse(sinceIso) - 10 * 60_000;
  const rows = db
    .prepare(`SELECT answered_at AS answeredAt, ended_at AS endedAt FROM call_sessions WHERE patient_id = ? AND answered_at IS NOT NULL AND status != 'failed' ORDER BY started_at DESC LIMIT 10`)
    .all(patientId) as { answeredAt: string; endedAt: string | null }[];
  return rows.some((r) => Date.parse(r.endedAt ?? r.answeredAt) >= since);
}
