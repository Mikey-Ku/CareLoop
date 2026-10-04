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

export function addCallTranscript(db: Db, input: { callId: string; speaker: TranscriptSpeaker; text: string; at: string }): void {
  const text = input.text.replace(/\s+/g, " ").trim().slice(0, 2_000);
  if (!text) return;
  const row = db.prepare(`SELECT COALESCE(MAX(sequence), -1) + 1 AS sequence FROM call_transcript_turns WHERE call_id = ?`).get(input.callId) as {
    sequence: number;
  };
  db.prepare(
    `INSERT INTO call_transcript_turns (call_id, sequence, speaker, text, created_at) VALUES (?, ?, ?, ?, ?)`,
  ).run(input.callId, row.sequence, input.speaker, text, input.at);
}

export function callTranscript(db: Db, callId: string): { speaker: TranscriptSpeaker; text: string; createdAt: string }[] {
  return db
    .prepare(`SELECT speaker, text, created_at AS createdAt FROM call_transcript_turns WHERE call_id = ? ORDER BY sequence`)
    .all(callId) as { speaker: TranscriptSpeaker; text: string; createdAt: string }[];
}
