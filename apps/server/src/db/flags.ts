import { fingerprint, type RuleResult, type Severity } from "../rules/index.ts";
import type { Db } from "./index.ts";

// Flag lifecycle: new -> told -> noted -> cleared. See docs/DESIGN.md "Flag lifecycle".

export type FlagStatus = "new" | "told" | "noted" | "cleared";
export type OpenFlagStatus = Exclude<FlagStatus, "cleared">;

/** Shaped for the context packet's `openFlags`. */
export type FlagSummary = {
  flagId: string;
  ruleId: string;
  status: FlagStatus;
  message: string;
  severity: Severity | null;
};

export type SyncResult = { inserted: FlagSummary[]; cleared: FlagSummary[]; unchanged: number };

const SUMMARY_COLUMNS = "CAST(id AS TEXT) AS flagId, rule_id AS ruleId, status, message, severity";
const SEVERITY_ORDER = "CASE severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 WHEN 'low' THEN 2 ELSE 3 END";

/**
 * Reconcile stored flags with a fresh set of rule results for one snapshot.
 *
 * - A `flag` result whose fingerprint has no open flag inserts a `new` flag.
 * - A `flag` result matching an open flag (new, told, noted) changes nothing.
 * - An open flag whose rule now returns `checked`, or whose fingerprint is no longer
 *   among that rule's `flag` results, becomes `cleared`. Changed evidence therefore
 *   clears the old row and inserts a new one.
 * - Rules that are absent from `results`, or that returned `skipped` (not enough data
 *   to decide), leave their open flags alone. This lets R6 (paper diff) sync separately
 *   from the record rules, and keeps a flaky sync from clearing and re-raising flags.
 *
 * A fingerprint that matches only a cleared flag is treated as a new occurrence.
 */
export function syncFlags(db: Db, patientId: string, results: readonly RuleResult[], now: string): SyncResult {
  const byRule = new Map<string, { decided: boolean; flags: Map<string, RuleResult> }>();
  for (const r of results) {
    const entry = byRule.get(r.ruleId) ?? { decided: false, flags: new Map<string, RuleResult>() };
    if (r.status === "flag") {
      entry.decided = true;
      entry.flags.set(fingerprint(r), r);
    } else if (r.status === "checked") {
      entry.decided = true;
    }
    byRule.set(r.ruleId, entry);
  }

  const openForRule = db.prepare(
    `SELECT id, fingerprint FROM flags WHERE patient_id = ? AND rule_id = ? AND status != 'cleared'`,
  );
  const clear = db.prepare(
    `UPDATE flags SET status = 'cleared', cleared_at = ? WHERE id = ? RETURNING ${SUMMARY_COLUMNS}`,
  );
  const insert = db.prepare(
    `INSERT INTO flags (patient_id, rule_id, fingerprint, status, severity, message, evidence_json, created_at)
     VALUES (?, ?, ?, 'new', ?, ?, ?, ?) RETURNING ${SUMMARY_COLUMNS}`,
  );

  return db.transaction((): SyncResult => {
    const out: SyncResult = { inserted: [], cleared: [], unchanged: 0 };
    for (const [ruleId, { decided, flags }] of byRule) {
      if (!decided) continue;
      const open = openForRule.all(patientId, ruleId) as { id: number; fingerprint: string }[];
      const openPrints = new Set(open.map((f) => f.fingerprint));
      for (const f of open) {
        if (flags.has(f.fingerprint)) out.unchanged++;
        else out.cleared.push(clear.get(now, f.id) as FlagSummary);
      }
      for (const [print, r] of flags) {
        if (openPrints.has(print)) continue;
        out.inserted.push(
          insert.get(patientId, ruleId, print, r.severity ?? null, r.message, JSON.stringify(r.evidence), now) as FlagSummary,
        );
      }
    }
    return out;
  })();
}

/** Open flags (new, told, noted) for the context packet, most severe first, then oldest. */
export function openFlags(db: Db, patientId: string): FlagSummary[] {
  return db
    .prepare(
      `SELECT ${SUMMARY_COLUMNS} FROM flags WHERE patient_id = ? AND status != 'cleared'
       ORDER BY ${SEVERITY_ORDER}, created_at, id`,
    )
    .all(patientId) as FlagSummary[];
}

/** Flags she said she will raise: the visit-prep list. */
export function notedFlags(db: Db, patientId: string): FlagSummary[] {
  return db
    .prepare(`SELECT ${SUMMARY_COLUMNS} FROM flags WHERE patient_id = ? AND status = 'noted' ORDER BY ${SEVERITY_ORDER}, noted_at, id`)
    .all(patientId) as FlagSummary[];
}

export function getFlag(db: Db, flagId: string | number): FlagSummary | undefined {
  return db.prepare(`SELECT ${SUMMARY_COLUMNS} FROM flags WHERE id = ?`).get(Number(flagId)) as FlagSummary | undefined;
}

/**
 * The one `new` flag to offer on check-in date `day`, or undefined.
 * Nothing is offered if a flag was already offered or told that day.
 * Order: high, medium, low severity, then oldest.
 */
export function nextFlagToOffer(db: Db, patientId: string, day: string): FlagSummary | undefined {
  const busy = db
    .prepare(`SELECT 1 FROM flags WHERE patient_id = ? AND (offered_on = ? OR told_on = ?) LIMIT 1`)
    .get(patientId, day, day);
  if (busy) return undefined;
  return db
    .prepare(
      `SELECT ${SUMMARY_COLUMNS} FROM flags WHERE patient_id = ? AND status = 'new'
       ORDER BY ${SEVERITY_ORDER}, created_at, id LIMIT 1`,
    )
    .get(patientId) as FlagSummary | undefined;
}

/**
 * Record that a flag was offered on check-in date `day` (buttons "Tell me more" / "Later").
 * "Later" leaves it `new`; this stops it being offered again the same day.
 */
export function markOffered(db: Db, flagId: string | number, day: string): boolean {
  return db.prepare(`UPDATE flags SET offered_on = ? WHERE id = ? AND status = 'new'`).run(day, Number(flagId)).changes === 1;
}

/** new -> told. `day` is the check-in date (defaults to the date part of `now`). Returns false if not `new`. */
export function markTold(db: Db, flagId: string | number, now: string, day: string = now.slice(0, 10)): boolean {
  return (
    db
      .prepare(`UPDATE flags SET status = 'told', told_at = ?, told_on = ? WHERE id = ? AND status = 'new'`)
      .run(now, day, Number(flagId)).changes === 1
  );
}

/** told (or new) -> noted, when she taps "I'll ask my doctor". Returns false otherwise. */
export function markNoted(db: Db, flagId: string | number, now: string): boolean {
  return (
    db
      .prepare(`UPDATE flags SET status = 'noted', noted_at = ? WHERE id = ? AND status IN ('new', 'told')`)
      .run(now, Number(flagId)).changes === 1
  );
}

/**
 * Record consent ended (FinchNode 410): delete her stored flags along with the record copy they came
 * from. A check-in's pending_flag_id becomes null (ON DELETE SET NULL). Check-ins, chats and memories
 * stay. Returns the number of flags deleted.
 */
export function deletePatientFlags(db: Db, patientId: string): number {
  return db.prepare("DELETE FROM flags WHERE patient_id = ?").run(patientId).changes;
}
