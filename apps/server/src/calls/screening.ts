import { addMemories } from "../db/memories.ts";
import { recentObservations } from "../db/observations.ts";
import { buildContextPacket, type ContextPacket } from "../context/packet.ts";
import { loadRxNavCache } from "../finchnode/fixtures.ts";
import { normalizeHealthRecord } from "../finchnode/normalize.ts";
import type { HealthRecord } from "../finchnode/types.ts";
import type { LlmClient } from "../llm/types.ts";
import { runRules } from "../rules/index.ts";
import type { Db } from "../db/index.ts";
import { emergencyDecision, emergencyResult } from "./emergency.ts";
import type { ScreeningInput, ScreeningResult } from "./types.ts";
import { emptyVitalsResult } from "../vitals/types.ts";

export type ScreeningDeps = {
  db: Db;
  loadSnapshot: (subject: string) => Promise<HealthRecord>;
  llm?: LlmClient;
  now?: () => string;
};

export async function loadScreeningContext(deps: ScreeningDeps, input: { patientId: string; subject: string; checkinDate: string }): Promise<{
  packet: ContextPacket;
  recentMemories: string[];
  symptomObservations: { source: string; detail: string }[];
}> {
  const record = normalizeHealthRecord(await deps.loadSnapshot(input.subject), { rxnav: loadRxNavCache() });
  const ruleResults = runRules({ record, checkinDate: input.checkinDate });
  const packet = buildContextPacket({ record, ruleResults, checkinDate: input.checkinDate });
  const observations = recentObservations(deps.db, input.patientId, 10).map((observation) => ({
    source: "stored_observation",
    detail: `${observation.topic}: level ${observation.level}${observation.words ? `, patient words: ${observation.words}` : ""}`,
  }));
  return { packet, recentMemories: packet.memories, symptomObservations: observations };
}

export async function runScreening(deps: ScreeningDeps, input: ScreeningInput): Promise<ScreeningResult> {
  const emergency = emergencyDecision(input.transcript);
  if (emergency) return emergencyResult({ callId: input.callId, patientId: input.patientId, decision: emergency, vitals: input.currentVitals });

  const model = deps.llm?.screenCall;
  if (model) {
    const output = await model({
      patientId: input.patientId,
      transcript: input.transcript.map(({ speaker, text }) => ({ speaker, text })),
      vitals: input.currentVitals,
      finchContext: input.contextPacket,
      recentMemories: input.recentMemories,
      symptomObservations: input.symptomObservations,
    });
    return { callId: input.callId, patientId: input.patientId, vitals: input.currentVitals, ...output };
  }

  return {
    callId: input.callId,
    patientId: input.patientId,
    symptoms: [],
    vitals: input.currentVitals,
    finchEvidence: input.symptomObservations,
    concernLevel: "moderate",
    recommendedHumanAction: "monitor_and_document",
    uncertainty: ["Gemini was unavailable, so no model interpretation was made.", "A human caregiver or clinician must review the transcript and vitals."],
    patientResponseText: "Thank you for telling me what is going on. I have recorded your information, but I could not complete the evidence review. A human member of your care team should review it.",
    caregiverSummary: "Gemini was unavailable. Review the patient transcript and any usable vitals manually.",
  };
}

/** Save only approved, bounded memories after a successful call. */
export function persistApprovedCallMemories(db: Db, patientId: string, memories: readonly string[], now: string): number {
  return addMemories(db, patientId, memories.slice(0, 5), now);
}

export function emptyCallVitals() {
  return emptyVitalsResult("relay_video", [{ code: "not_started", message: "No usable Presage reading was obtained" }]);
}
