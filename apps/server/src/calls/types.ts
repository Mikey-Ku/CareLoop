import type { ContextPacket } from "../context/packet.ts";
import type { SymptomMention } from "../llm/types.ts";
import type { VitalsResult } from "../vitals/types.ts";

export type ConcernLevel = "low" | "moderate" | "high" | "emergency" | "crisis";
export type RecommendedHumanAction =
  | "none"
  | "monitor_and_document"
  | "contact_clinician_today"
  | "emergency_services_now"
  | "crisis_support_now";

export type TranscriptTurn = { speaker: "patient" | "agent"; text: string; at?: string };

export type FinchEvidence = { source: string; detail: string };

export type ScreeningResult = {
  callId: string;
  patientId: string;
  symptoms: SymptomMention[];
  vitals: VitalsResult;
  finchEvidence: FinchEvidence[];
  concernLevel: ConcernLevel;
  recommendedHumanAction: RecommendedHumanAction;
  uncertainty: string[];
  patientResponseText: string;
  caregiverSummary: string;
};

export type ScreeningInput = {
  callId: string;
  patientId: string;
  transcript: TranscriptTurn[];
  currentVitals: VitalsResult;
  contextPacket: ContextPacket;
  recentMemories: string[];
  symptomObservations: FinchEvidence[];
};

export type ScreeningModelOutput = Omit<ScreeningResult, "callId" | "patientId" | "vitals"> & {
  symptoms: SymptomMention[];
};
