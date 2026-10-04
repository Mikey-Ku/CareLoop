import { screenMessage, type SafetyHit } from "../safety/screen.ts";
import { SAFETY_LEVELS } from "../checkin/severity.ts";
import type { TranscriptTurn } from "./types.ts";

export type EmergencyDecision = { hit: SafetyHit; level: number };

/**
 * The fixed safety screen over every patient turn, fresh each time (no cache). Crisis wins over an urgent
 * symptom, regardless of the order of the turns. The ladder level is 5 for a crisis, 4 for an urgent symptom.
 */
export function emergencyDecision(transcript: readonly TranscriptTurn[]): EmergencyDecision | undefined {
  const hits = transcript
    .filter((turn) => turn.speaker === "patient")
    .map((turn) => screenMessage(turn.text))
    .filter((hit): hit is SafetyHit => Boolean(hit));
  const hit = hits.find((candidate) => candidate.kind === "crisis") ?? hits.find((candidate) => candidate.kind === "urgent_symptom");
  return hit ? { hit, level: SAFETY_LEVELS[hit.kind] } : undefined;
}
