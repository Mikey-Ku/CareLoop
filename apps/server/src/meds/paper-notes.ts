import type { Db } from "../db/index.ts";
import type { PaperOutcome } from "../db/paper-scans.ts";
import { sameIngredient, sameStrength, type DiscrepancyKind } from "../rules/paper-diff.ts";

// Her hospital papers against her medication list (R6, src/checkin/paper-flow.ts). While a paper check's
// R6 flag is unresolved (not cleared), a medicine her papers say was stopped, or changed to another dose,
// that her record still lists gets one fixed note wherever the medication helper names it: its line in the
// medicines reminder (after her prescription's words), the memory check, and a matching label photo.
// The medicine is never taken off her list and she is never told to stop it: her pharmacist decides.

export type PaperChangeKind = "stopped" | "changed";

/** One unresolved R6 discrepancy about a medicine on her list. */
export type PaperChange = { kind: PaperChangeKind; recordName: string; paperStrength: string | undefined };

const KINDS: Partial<Record<DiscrepancyKind, PaperChangeKind>> = { stopped_but_active: "stopped", dose_differs: "changed" };

/** The unresolved R6 discrepancies from her confirmed paper checks (their R6 flag not cleared), newest check first. */
export function unresolvedPaperChanges(db: Db, patientId: string): PaperChange[] {
  const rows = db
    .prepare(
      `SELECT s.discrepancies_json AS json, f.status AS flagStatus FROM paper_scans s LEFT JOIN flags f ON f.id = json_extract(s.discrepancies_json, '$.flagId')
       WHERE s.patient_id = ? AND s.confirmed_at IS NOT NULL ORDER BY s.id DESC`,
    )
    .all(patientId) as { json: string | null; flagStatus: string | null }[];
  const changes: PaperChange[] = [];
  for (const row of rows) {
    if (!row.json || row.flagStatus === "cleared") continue;
    let outcome: PaperOutcome;
    try {
      outcome = JSON.parse(row.json) as PaperOutcome;
    } catch {
      continue;
    }
    if (outcome.outcome !== "flag" || !Array.isArray(outcome.discrepancies)) continue;
    for (const d of outcome.discrepancies as { kind?: string; recordName?: unknown; paperStrength?: unknown }[]) {
      const kind = KINDS[d?.kind as DiscrepancyKind];
      if (!kind || typeof d.recordName !== "string" || !d.recordName) continue;
      changes.push({ kind, recordName: d.recordName, paperStrength: typeof d.paperStrength === "string" ? d.paperStrength : undefined });
    }
  }
  return changes;
}

/**
 * What her papers say about this medicine on her list, if anything unresolved: "stopped" wins over
 * "changed"; a change is moot once her list shows the papers' strength. `strength` undefined: not compared.
 */
export function paperChangeFor(changes: readonly PaperChange[], med: { name: string; strength?: string | undefined }): PaperChangeKind | undefined {
  const mine = changes.filter((c) => sameIngredient(c.recordName, med.name));
  if (mine.some((c) => c.kind === "stopped")) return "stopped";
  if (mine.some((c) => c.kind === "changed" && sameStrength(c.paperStrength, med.strength) !== true)) return "changed";
  return undefined;
}
