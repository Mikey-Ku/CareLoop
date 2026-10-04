import type { Db } from "./index.ts";

// vitals_readings (migration 1): camera readings, kept for trends. They never change her usual range
// (docs/DESIGN.md "Daily questions and red flags"). Breathing rate is saved, never compared.

export type VitalsMethod = "relay_call" | "scan_screen";

export type NewVitalsReading = {
  patientId: string;
  takenAt: string;
  heartRate: number | null;
  breathingRate: number | null;
  method: VitalsMethod;
  /** SmartSpectra's confidence (0 to 100) for the heart rate, else for the breathing rate. */
  confidence: number | null;
};

export function addVitalsReading(db: Db, r: NewVitalsReading): number {
  const info = db
    .prepare(`INSERT INTO vitals_readings (patient_id, taken_at, heart_rate, breathing_rate, method, confidence) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(r.patientId, r.takenAt, r.heartRate, r.breathingRate, r.method, r.confidence);
  return Number(info.lastInsertRowid);
}

/**
 * Her latest camera heart rate taken at or after `sinceIso` (the day's check-in sent time), if any.
 * A 10-minute margin covers a call that opened the check-in itself, as in wasOnCallSince.
 */
export function latestHeartRateSince(db: Db, patientId: string, sinceIso: string): number | undefined {
  const since = Date.parse(sinceIso) - 10 * 60_000;
  const rows = db
    .prepare(`SELECT taken_at AS takenAt, heart_rate AS heartRate FROM vitals_readings WHERE patient_id = ? AND heart_rate IS NOT NULL ORDER BY taken_at DESC LIMIT 5`)
    .all(patientId) as { takenAt: string; heartRate: number }[];
  return rows.find((r) => Date.parse(r.takenAt) >= since)?.heartRate;
}
