import { screenMessage, type SafetyHit } from "../safety/screen.ts";
import type { ConcernLevel, RecommendedHumanAction, ScreeningResult, TranscriptTurn } from "./types.ts";
import { emptyVitalsResult, type VitalsResult } from "../vitals/types.ts";

export type EmergencyDecision = {
  hit: SafetyHit;
  concernLevel: ConcernLevel;
  recommendedHumanAction: RecommendedHumanAction;
  patientResponseText: string;
};

/** Crisis wins over urgent symptom, regardless of the order of transcript turns. */
export function emergencyDecision(transcript: readonly TranscriptTurn[]): EmergencyDecision | undefined {
  const hits = transcript
    .filter((turn) => turn.speaker === "patient")
    .map((turn) => screenMessage(turn.text))
    .filter((hit): hit is SafetyHit => Boolean(hit));
  const hit = hits.find((candidate) => candidate.kind === "crisis") ?? hits.find((candidate) => candidate.kind === "urgent_symptom");
  if (!hit) return undefined;
  if (hit.kind === "crisis") {
    return {
      hit,
      concernLevel: "crisis",
      recommendedHumanAction: "crisis_support_now",
      patientResponseText:
        "I’m really glad you told me. Your safety matters. Please call or text 988 now, or call 911 if you may act on these thoughts. If you can, stay with someone you trust while help is coming.",
    };
  }
  return {
    hit,
    concernLevel: "emergency",
    recommendedHumanAction: "emergency_services_now",
    patientResponseText:
      "This could be an emergency. Please call 911 now, or ask someone nearby to call for you. I’m going to make sure this is shared with the care team.",
  };
}

export function emergencyResult(input: { callId: string; patientId: string; decision: EmergencyDecision; vitals?: VitalsResult }): ScreeningResult {
  return {
    callId: input.callId,
    patientId: input.patientId,
    symptoms: [],
    vitals: input.vitals ?? emptyVitalsResult("relay_video", [{ code: "emergency_precedence", message: "Safety phrase took precedence before model interpretation" }]),
    finchEvidence: [{ source: "patient_transcript", detail: `Fixed safety phrase matched: ${input.decision.hit.matched}` }],
    concernLevel: input.decision.concernLevel,
    recommendedHumanAction: input.decision.recommendedHumanAction,
    uncertainty: ["A fixed safety rule fired; clinical diagnosis is not made by this system."],
    patientResponseText: input.decision.patientResponseText,
    caregiverSummary: `Safety screening detected ${input.decision.hit.kind}. Immediate human follow-up is required.`,
  };
}
