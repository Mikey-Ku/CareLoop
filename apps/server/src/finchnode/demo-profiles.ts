import type { Db } from "../db/index.ts";

/** The record-bearing synthetic FinchNode profiles safe for ordinary demos. */
export const SYNTHETIC_PROFILES = [
  { scenario: "baseline-adult", subject: "patient-demo-001", displayName: "Morgan" },
  { scenario: "polypharmacy-senior", subject: "patient-demo-polypharmacy", displayName: "Harriet" },
  { scenario: "multi-source-overlap", subject: "patient-demo-multi-source", displayName: "Priya" },
  { scenario: "sparse-record", subject: "patient-demo-sparse", displayName: "Jonah" },
  { scenario: "messy-coding", subject: "patient-demo-messy-coding", displayName: "Dolores" },
  { scenario: "pediatric-asthma", subject: "patient-demo-pediatric-asthma", displayName: "Theo" },
] as const;

export type SyntheticProfile = (typeof SYNTHETIC_PROFILES)[number];

/**
 * Pick the least-used synthetic subject. Local patient rows are deliberately counted rather than
 * treating a FinchNode subject as an account identity: several Relay users may safely rehearse the
 * same synthetic record while keeping all local state separate.
 */
export function nextSyntheticProfile(db: Db): SyntheticProfile {
  let best: SyntheticProfile = SYNTHETIC_PROFILES[0]!;
  let bestCount = Number.POSITIVE_INFINITY;
  for (const profile of SYNTHETIC_PROFILES) {
    const row = db.prepare(`SELECT COUNT(*) AS count FROM patients WHERE finchnode_subject = ? OR (finchnode_subject IS NULL AND finchnode_patient_id = ?)`).get(profile.subject, profile.subject) as { count: number };
    if (row.count < bestCount) {
      best = profile;
      bestCount = row.count;
    }
  }
  return best;
}
