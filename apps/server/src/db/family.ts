import { normalizeHandle } from "../config.ts";
import type { Db } from "./index.ts";

// Family members and their family chats (migration 4, docs/adr/0001-family-chats-not-a-group.md).
// A Relay chat holds at most one person, so each family member has their own direct
// chat with the agent. The agent can't open that chat: the member messages the agent
// first, and the chat is linked from contact.added or their first direct message
// (src/relay/inbox.ts). Every family message goes to each linked family chat.
// Handles are stored normalized (normalizeHandle in src/config.ts).

export type FamilyMember = {
  patientId: string;
  handle: string;
  displayName: string | null;
  /** Their direct chat with the agent; null until they message it. */
  chatId: string | null;
  linkedAt: string | null;
};

/** A linked family member: where family messages for them go. */
export type FamilyChat = { handle: string; displayName: string | null; chatId: string };

export type FamilySync = {
  /** Handles that got a new row. */
  added: string[];
  /** Rows whose handle is no longer configured. They are left in place, links and all. */
  notConfigured: string[];
};

const COLUMNS = `patient_id AS patientId, handle, display_name AS displayName, chat_id AS chatId, linked_at AS linkedAt`;

/**
 * Make sure every configured handle has a row for this patient. Existing rows (and
 * their chat links) are kept. A handle that was removed from the configuration is
 * NOT deleted: its row stays, and while it is linked that person still gets family
 * messages. It is reported in `notConfigured` so the caller can say so; delete the
 * row by hand to stop it.
 */
export function syncFamilyMembers(db: Db, patientId: string, handles: readonly string[]): FamilySync {
  const wanted = [...new Set(handles.map(normalizeHandle).filter((h) => h.length > 0))];
  const insert = db.prepare(`INSERT INTO family_members (patient_id, handle) VALUES (?, ?) ON CONFLICT (patient_id, handle) DO NOTHING`);
  return db.transaction((): FamilySync => {
    const added = wanted.filter((handle) => insert.run(patientId, handle).changes === 1);
    const notConfigured = familyMembers(db, patientId)
      .map((m) => m.handle)
      .filter((handle) => !wanted.includes(handle));
    return { added, notConfigured };
  })();
}

/**
 * Store a family member's direct chat with the agent, for every senior they are
 * configured for. Returns the patients they were linked for (and whether anything
 * changed), or undefined when the handle belongs to no configured family member.
 * A display name, when given, replaces the stored one; otherwise it is kept.
 */
export function linkFamilyMember(
  db: Db,
  handle: string,
  chatId: string,
  displayName?: string | null,
  now: string = new Date().toISOString(),
): { patientIds: string[]; changed: boolean } | undefined {
  const normalized = normalizeHandle(handle);
  return db.transaction(() => {
    const rows = db.prepare(`SELECT ${COLUMNS} FROM family_members WHERE handle = ? ORDER BY rowid`).all(normalized) as FamilyMember[];
    if (rows.length === 0) return undefined;
    let changed = false;
    const update = db.prepare(
      `UPDATE family_members SET chat_id = ?, linked_at = ?, display_name = COALESCE(?, display_name) WHERE patient_id = ? AND handle = ?`,
    );
    for (const row of rows) {
      const relinked = row.chatId !== chatId;
      const renamed = Boolean(displayName) && displayName !== row.displayName;
      if (!relinked && !renamed) continue;
      update.run(chatId, relinked ? now : row.linkedAt, displayName || null, row.patientId, normalized);
      changed = true;
    }
    return { patientIds: rows.map((r) => r.patientId), changed };
  })();
}

/** Linked family chats for a patient, in the order the members were configured. */
export function familyChats(db: Db, patientId: string): FamilyChat[] {
  return db
    .prepare(
      `SELECT handle, display_name AS displayName, chat_id AS chatId FROM family_members
       WHERE patient_id = ? AND chat_id IS NOT NULL ORDER BY rowid`,
    )
    .all(patientId) as FamilyChat[];
}

/** Every family member configured for a patient, linked or not, in configured order. */
export function familyMembers(db: Db, patientId: string): FamilyMember[] {
  return db.prepare(`SELECT ${COLUMNS} FROM family_members WHERE patient_id = ? ORDER BY rowid`).all(patientId) as FamilyMember[];
}

// Family relays (family_relays, migration 6): things she asked the assistant to pass on to
// her family ("tell Sarah I love her"). Passed on at once to every linked family chat; with
// none linked yet, kept until one is (CheckinEngine.passOnFamilyMessages).

export type FamilyRelay = { id: number; patientId: string; text: string; createdAt: string; passedOnAt: string | null };

/** Store something to pass on. `passedOnAt` is set when it goes out right away. */
export function addFamilyRelay(db: Db, input: { patientId: string; text: string; createdAt: string; passedOnAt: string | null }): number {
  const info = db
    .prepare(`INSERT INTO family_relays (patient_id, text, created_at, passed_on_at) VALUES (?, ?, ?, ?)`)
    .run(input.patientId, input.text, input.createdAt, input.passedOnAt);
  return Number(info.lastInsertRowid);
}

/** What she asked to pass on that no family chat has had yet, oldest first. */
export function waitingFamilyRelays(db: Db, patientId: string): FamilyRelay[] {
  return db
    .prepare(
      `SELECT id, patient_id AS patientId, text, created_at AS createdAt, passed_on_at AS passedOnAt FROM family_relays
       WHERE patient_id = ? AND passed_on_at IS NULL ORDER BY id`,
    )
    .all(patientId) as FamilyRelay[];
}

export function markFamilyRelayPassedOn(db: Db, id: number, at: string): void {
  db.prepare(`UPDATE family_relays SET passed_on_at = ? WHERE id = ? AND passed_on_at IS NULL`).run(at, id);
}

/** The family member(s) whose direct chat this is. Never the senior: her chat is patients.relay_chat_id. */
export function familyMembersForChat(db: Db, chatId: string): FamilyMember[] {
  return db.prepare(`SELECT ${COLUMNS} FROM family_members WHERE chat_id = ? ORDER BY rowid`).all(chatId) as FamilyMember[];
}
