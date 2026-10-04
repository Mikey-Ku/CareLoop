import type { Db } from "./index.ts";

// Prompts that wait for her next typed message and have no state of their own elsewhere (migration 13):
// "I have a question" on a medicines reminder (the "Go ahead, ..." message) and the sharing menu.
// Together with the check-in's prompts (checkin_prompts), follow-ups, the medication helper's prompts
// and the paper check, they decide where typed text goes: the most recently sent prompt still waiting
// (src/checkin/engine.ts "Latest prompt wins"). Each waits for one typed message: it closes once her
// next typed message is planned, whatever took it. Nothing here holds her words.

export type WaitingKind = "meds_question" | "sharing_menu";

export type WaitingPrompt = { id: number; patientId: string; kind: WaitingKind; refId: number | null; openedAt: string; closedAt: string | null };

const COLUMNS = `id, patient_id AS patientId, kind, ref_id AS refId, opened_at AS openedAt, closed_at AS closedAt`;

/** Open a prompt of this kind, closing any older one of the same kind. Returns its id. */
export function openWaitingPrompt(db: Db, p: { patientId: string; kind: WaitingKind; refId?: number | null; at: string }): number {
  db.prepare(`UPDATE waiting_prompts SET closed_at = ? WHERE patient_id = ? AND kind = ? AND closed_at IS NULL`).run(p.at, p.patientId, p.kind);
  const info = db
    .prepare(`INSERT INTO waiting_prompts (patient_id, kind, ref_id, opened_at) VALUES (?, ?, ?, ?)`)
    .run(p.patientId, p.kind, p.refId ?? null, p.at);
  return Number(info.lastInsertRowid);
}

/** Her open prompts, newest first. */
export function openWaitingPrompts(db: Db, patientId: string): WaitingPrompt[] {
  return db
    .prepare(`SELECT ${COLUMNS} FROM waiting_prompts WHERE patient_id = ? AND closed_at IS NULL ORDER BY opened_at DESC, id DESC`)
    .all(patientId) as WaitingPrompt[];
}

/** Close her open prompts (of one kind, or all). */
export function closeWaitingPrompts(db: Db, patientId: string, at: string, kind?: WaitingKind): void {
  if (kind) db.prepare(`UPDATE waiting_prompts SET closed_at = ? WHERE patient_id = ? AND kind = ? AND closed_at IS NULL`).run(at, patientId, kind);
  else db.prepare(`UPDATE waiting_prompts SET closed_at = ? WHERE patient_id = ? AND closed_at IS NULL`).run(at, patientId);
}
