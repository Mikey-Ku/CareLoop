import type { VitalsResult } from "../vitals/types.ts";

export type ConcernLevel = "low" | "moderate" | "high" | "emergency" | "crisis";
export type RecommendedHumanAction =
  | "none"
  | "monitor_and_document"
  | "contact_clinician_today"
  | "emergency_services_now"
  | "crisis_support_now";

export type TranscriptTurn = { speaker: "patient" | "agent"; text: string; at?: string };

/**
 * A call's result, kept in call_sessions.screening_json. Fixed rules set every field: `level` is the
 * highest severity-ladder level of what she said (src/checkin/severity.ts, safety included), and
 * concernLevel and recommendedHumanAction follow from it. No model decides or words any of it.
 */
export type ScreeningResult = {
  callId: string;
  patientId: string;
  /** The check-in date the call belongs to (YYYY-MM-DD). */
  day: string;
  level: number;
  concernLevel: ConcernLevel;
  recommendedHumanAction: RecommendedHumanAction;
  /** What it was about, as ladder topics (question ids, her topic words, or a safety kind). */
  topics: string[];
  vitals: VitalsResult;
  uncertainty: string[];
  /** What the voice reads back (fixed copy by level, src/calls/copy.ts). */
  patientResponseText: string;
  caregiverSummary: string;
  /** The post-call message in her chat, once sent: its taps find this call. */
  summaryMessageId?: string;
};
