import type { Db } from "./index.ts";

// Things the senior told us, in her own words (the memories table, migration 1):
// facts about her life and complaints she mentioned in passing, picked out of
// free text by the LLM. Saved to give later chats and calls some context (the
// context packet reads them). Never acted on: nothing here raises a flag or an alert.

/** Longest memory kept; anything longer is cut. */
export const MAX_MEMORY_LENGTH = 300;

/** Trimmed, whitespace collapsed, capped. Empty when nothing is left. */
function clean(text: string): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > MAX_MEMORY_LENGTH ? one.slice(0, MAX_MEMORY_LENGTH).trimEnd() : one;
}

/**
 * Save memories for a patient. Blank ones are dropped, and one she already has (same words,
 * ignoring case and spacing, not deleted) is not saved again. Returns how many were added.
 */
export function addMemories(db: Db, patientId: string, texts: readonly string[], now: string): number {
  const exists = db.prepare(`SELECT 1 FROM memories WHERE patient_id = ? AND deleted_at IS NULL AND lower(text) = lower(?)`);
  const insert = db.prepare(`INSERT INTO memories (patient_id, text, created_at) VALUES (?, ?, ?)`);
  let added = 0;
  db.transaction(() => {
    for (const raw of texts) {
      const text = clean(raw);
      if (!text || exists.get(patientId, text)) continue;
      insert.run(patientId, text, now);
      added += 1;
    }
  })();
  return added;
}

/** Her `n` most recent memories (not deleted), newest first. */
export function recentMemories(db: Db, patientId: string, n: number): string[] {
  if (n <= 0) return [];
  const rows = db
    .prepare(`SELECT text FROM memories WHERE patient_id = ? AND deleted_at IS NULL ORDER BY created_at DESC, id DESC LIMIT ?`)
    .all(patientId, Math.floor(n)) as { text: string }[];
  return rows.map((r) => r.text);
}
