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
