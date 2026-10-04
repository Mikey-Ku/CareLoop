import { buildContextPacket, type ContextPacket } from "../context/packet.ts";
import { LEVEL_NAMES, type Level } from "../checkin/severity.ts";
import type { UnderstoodItem } from "../checkin/copy.ts";
import { loadRxNavCache } from "../finchnode/fixtures.ts";
import { normalizeHealthRecord } from "../finchnode/normalize.ts";
import type { HealthRecord } from "../finchnode/types.ts";
import { runRules } from "../rules/index.ts";
import { emptyVitalsResult, type VitalsResult } from "../vitals/types.ts";
import { spokenReaction } from "./copy.ts";
import type { ConcernLevel, RecommendedHumanAction, ScreeningResult } from "./types.ts";

// A call's result from the severity ladder. Gemini has no say over the level or the action: the
// engine's fixed rules level what she said (src/checkin/engine.ts "Video check-in calls"), and the
// words she hears come from fixed copy (src/calls/copy.ts).

const CONCERN: Readonly<Record<Level, ConcernLevel>> = { 0: "low", 1: "low", 2: "moderate", 3: "high", 4: "emergency", 5: "crisis" };
const ACTION: Readonly<Record<Level, RecommendedHumanAction>> = {
  0: "none",
  1: "monitor_and_document",
  2: "monitor_and_document",
  3: "contact_clinician_today",
  4: "emergency_services_now",
  5: "crisis_support_now",
};

const asLevel = (n: number): Level => Math.max(0, Math.min(5, Math.round(n))) as Level;

export function callResult(input: {
  callId: string;
  patientId: string;
  day: string;
  level: number;
  items: readonly UnderstoodItem[];
  safety?: string | undefined;
  vitals: VitalsResult;
  firstName: string;
  /** Family told by the safety path (named in the 4 and 5 replies). */
  familyNames: readonly string[];
  uncertainty?: string[];
  summaryMessageId?: string | undefined;
}): ScreeningResult {
  const level = asLevel(input.level);
  const topics = [...new Set([...(input.safety ? [input.safety] : []), ...input.items.filter((i) => i.level > 0).map((i) => i.topic)])];
  return {
    callId: input.callId,
    patientId: input.patientId,
    day: input.day,
    level,
    concernLevel: CONCERN[level],
    recommendedHumanAction: ACTION[level],
    topics,
    vitals: input.vitals,
    uncertainty: input.uncertainty ?? [],
    patientResponseText: spokenReaction(level, input.firstName, input.items, input.familyNames) || `Thank you, ${input.firstName}.`,
    caregiverSummary: `Highest level on this call: ${level} (${LEVEL_NAMES[level]})${topics.length > 0 ? `, about ${topics.join(", ")}` : ""}.`,
    ...(input.summaryMessageId ? { summaryMessageId: input.summaryMessageId } : {}),
  };
}

/** Her usual heart-rate range from the record, for the read-back (compareHeartRate is false with AFib). */
export async function loadUsualRange(loadSnapshot: (subject: string) => Promise<HealthRecord>, subject: string, day: string): Promise<ContextPacket["usualRange"]> {
  const record = normalizeHealthRecord(await loadSnapshot(subject), { rxnav: loadRxNavCache() });
  return buildContextPacket({ record, ruleResults: runRules({ record, checkinDate: day }), checkinDate: day }).usualRange;
}

export function emptyCallVitals(): VitalsResult {
  return emptyVitalsResult("relay_video", [{ code: "not_started", message: "No usable Presage reading was obtained" }]);
}
