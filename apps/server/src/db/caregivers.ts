import { normalizeHandle } from "../config.ts";
import type { Db } from "./index.ts";

export type CaregiverInviteStatus = "pending" | "claimed" | "approved" | "denied" | "expired" | "revoked";

export type CaregiverInvite = {
  id: number;
  patientId: string;
  requestedHandle: string;
  requestedName: string | null;
  code: string;
  status: CaregiverInviteStatus;
  createdAt: string;
  expiresAt: string;
  claimedChatId: string | null;
  claimedAt: string | null;
  decidedAt: string | null;
};

const COLUMNS = `id, patient_id AS patientId, requested_handle AS requestedHandle, requested_name AS requestedName,
  code, status, created_at AS createdAt, expires_at AS expiresAt, claimed_chat_id AS claimedChatId,
  claimed_at AS claimedAt, decided_at AS decidedAt`;

export const CAREGIVER_INVITE_TTL_MS = 24 * 60 * 60_000;
export const CAREGIVER_HANDLE_PENDING = "__awaiting_handle__";

function row(db: Db, id: number): CaregiverInvite | undefined {
  return db.prepare(`SELECT ${COLUMNS} FROM caregiver_invites WHERE id = ?`).get(id) as CaregiverInvite | undefined;
}

function expire(db: Db, at: string): void {
  db.prepare(`UPDATE caregiver_invites SET status = 'expired', decided_at = ? WHERE status IN ('pending', 'claimed') AND expires_at <= ?`).run(at, at);
}

export function createCaregiverInvite(
  db: Db,
  input: { patientId: string; handle: string; name?: string | null; now: string; code: string },
): CaregiverInvite {
  expire(db, input.now);
  db.prepare(`UPDATE caregiver_invites SET status = 'revoked', decided_at = ? WHERE patient_id = ? AND status IN ('pending', 'claimed')`).run(input.now, input.patientId);
  const expiresAt = new Date(Date.parse(input.now) + CAREGIVER_INVITE_TTL_MS).toISOString();
  const info = db
    .prepare(
      `INSERT INTO caregiver_invites (patient_id, requested_handle, requested_name, code, status, created_at, expires_at)
       VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
    )
    .run(input.patientId, normalizeHandle(input.handle), input.name?.trim() || null, input.code, input.now, expiresAt);
  return row(db, Number(info.lastInsertRowid))!;
}

/** Open the fixed prompt that asks the patient for a handle. */
export function beginCaregiverInvite(db: Db, patientId: string, now: string): void {
  expire(db, now);
  db.prepare(`UPDATE caregiver_invites SET status = 'revoked', decided_at = ? WHERE patient_id = ? AND status IN ('pending', 'claimed')`).run(now, patientId);
  const expiresAt = new Date(Date.parse(now) + CAREGIVER_INVITE_TTL_MS).toISOString();
  db.prepare(`INSERT INTO caregiver_invites (patient_id, requested_handle, code, status, created_at, expires_at) VALUES (?, ?, '', 'pending', ?, ?)`).run(patientId, CAREGIVER_HANDLE_PENDING, now, expiresAt);
}

export function setCaregiverInviteTarget(
  db: Db,
  input: { patientId: string; handle: string; name?: string | null; now: string; code: string },
): CaregiverInvite | undefined {
  const invite = db.prepare(`SELECT ${COLUMNS} FROM caregiver_invites WHERE patient_id = ? AND requested_handle = ? AND status = 'pending' ORDER BY id DESC LIMIT 1`).get(input.patientId, CAREGIVER_HANDLE_PENDING) as CaregiverInvite | undefined;
  if (!invite) return undefined;
  db.prepare(`UPDATE caregiver_invites SET requested_handle = ?, requested_name = ?, code = ? WHERE id = ?`).run(normalizeHandle(input.handle), input.name?.trim() || null, input.code, invite.id);
  return row(db, invite.id);
}

export function pendingInviteForPatient(db: Db, patientId: string, at: string): CaregiverInvite | undefined {
  expire(db, at);
  return db.prepare(`SELECT ${COLUMNS} FROM caregiver_invites WHERE patient_id = ? AND status IN ('pending', 'claimed') ORDER BY id DESC LIMIT 1`).get(patientId) as CaregiverInvite | undefined;
}

export function claimCaregiverInvite(
  db: Db,
  input: { handle: string; chatId: string; code: string; now: string },
): CaregiverInvite | undefined {
  expire(db, input.now);
  const invite = db
    .prepare(`SELECT ${COLUMNS} FROM caregiver_invites WHERE requested_handle = ? AND code = ? AND status = 'pending' AND expires_at > ? ORDER BY id DESC LIMIT 1`)
    .get(normalizeHandle(input.handle), input.code.trim(), input.now) as CaregiverInvite | undefined;
  if (!invite) return undefined;
  db.prepare(`UPDATE caregiver_invites SET status = 'claimed', claimed_chat_id = ?, claimed_at = ? WHERE id = ? AND status = 'pending'`).run(input.chatId, input.now, invite.id);
  return row(db, invite.id);
}

/** Whether this handle has an unexpired invitation waiting for a code. */
export function hasPendingCaregiverInvite(db: Db, handle: string, now: string): boolean {
  expire(db, now);
  return Boolean(
    db
      .prepare(`SELECT 1 FROM caregiver_invites WHERE requested_handle = ? AND status = 'pending' AND expires_at > ? LIMIT 1`)
      .get(normalizeHandle(handle), now),
  );
}

export function decideCaregiverInvite(db: Db, input: { patientId: string; approve: boolean; now: string }): CaregiverInvite | undefined {
  const invite = pendingInviteForPatient(db, input.patientId, input.now);
  if (!invite || invite.status !== "claimed") return undefined;
  const status: CaregiverInviteStatus = input.approve ? "approved" : "denied";
  db.prepare(`UPDATE caregiver_invites SET status = ?, decided_at = ? WHERE id = ? AND status = 'claimed'`).run(status, input.now, invite.id);
  return row(db, invite.id);
}

export function revokeCaregiver(db: Db, input: { patientId: string; handle: string; now: string }): boolean {
  const info = db.prepare(`UPDATE family_members SET chat_id = NULL, linked_at = NULL WHERE patient_id = ? AND handle = ?`).run(input.patientId, normalizeHandle(input.handle));
  db.prepare(`UPDATE caregiver_invites SET status = 'revoked', decided_at = ? WHERE patient_id = ? AND requested_handle = ? AND status IN ('pending', 'claimed', 'approved')`).run(input.now, input.patientId, normalizeHandle(input.handle));
  return info.changes > 0;
}

export function linkApprovedCaregiver(db: Db, invite: CaregiverInvite, now: string): boolean {
  if (invite.status !== "approved" || !invite.claimedChatId) return false;
  const exists = db.prepare(`SELECT 1 FROM family_members WHERE patient_id = ? AND handle = ?`).get(invite.patientId, invite.requestedHandle);
  if (!exists) db.prepare(`INSERT INTO family_members (patient_id, handle, display_name, chat_id, linked_at) VALUES (?, ?, ?, ?, ?)`).run(invite.patientId, invite.requestedHandle, invite.requestedName, invite.claimedChatId, now);
  else db.prepare(`UPDATE family_members SET display_name = COALESCE(?, display_name), chat_id = ?, linked_at = ? WHERE patient_id = ? AND handle = ?`).run(invite.requestedName, invite.claimedChatId, now, invite.patientId, invite.requestedHandle);
  return true;
}
