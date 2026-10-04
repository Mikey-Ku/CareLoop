import type { Medication } from "../finchnode/normalize.ts";
import { ingredientTokens } from "../rules/paper-diff.ts";

// When she takes each medicine, from her prescription's instructions (the sig, such as
// "Take 1 tablet by mouth twice daily"), by fixed rules (SIG_RULES). No LLM, no dosing
// advice: the reminders only read the instructions back word for word.
//
//   "as needed" anywhere           -> not scheduled (listed separately as "as needed")
//   "three times daily", "every 8 hours" -> morning, midday and evening
//   "twice daily", "every 12 hours"      -> morning and evening
//   "at bedtime"                   -> bedtime
//   "with the evening meal", "in the evening" -> evening
//   "every morning", "before breakfast", "in the morning" -> morning
//   "once daily" with no time      -> morning
// Anything else is unscheduled (no reminder), never guessed.

export type Slot = "morning" | "midday" | "evening" | "bedtime";

/** Slots in the order of her day. */
export const SLOTS: readonly Slot[] = ["morning", "midday", "evening", "bedtime"];

export type SigRuleKind = "as_needed" | "frequency" | "time_of_day" | "default";

export type SigRule = {
  id: string;
  kind: SigRuleKind;
  pattern: RegExp;
  slots: readonly Slot[];
};

/**
 * The rule table, applied in this order: "as needed" wins over everything; a frequency (twice,
 * three times) sets the slots on its own; otherwise every time of day that matches; "once daily"
 * with no time of day is the morning.
 */
export const SIG_RULES: readonly SigRule[] = [
  { id: "as_needed", kind: "as_needed", pattern: /\b(?:as needed|if needed|when needed|prn)\b/i, slots: [] },
  {
    id: "three_times_daily",
    kind: "frequency",
    pattern: /\b(?:three times (?:a |per )?day|three times daily|every 8 hours|tid)\b/i,
    slots: ["morning", "midday", "evening"],
  },
  {
    id: "twice_daily",
    kind: "frequency",
    pattern: /\b(?:twice (?:a |per )?day|twice daily|two times (?:a |per )?day|two times daily|every 12 hours|bid)\b/i,
    slots: ["morning", "evening"],
  },
  { id: "bedtime", kind: "time_of_day", pattern: /\b(?:at bedtime|before bed(?:time)?|at night|every night|nightly)\b/i, slots: ["bedtime"] },
  {
    id: "evening",
    kind: "time_of_day",
    pattern: /\b(?:with (?:the |your )?evening meal|in the evening|every evening|with (?:dinner|supper))\b/i,
    slots: ["evening"],
  },
  {
    id: "morning",
    kind: "time_of_day",
    pattern: /\b(?:every morning|in the morning|before breakfast|with breakfast)\b/i,
    slots: ["morning"],
  },
  { id: "once_daily", kind: "default", pattern: /\b(?:once (?:a |per )?day|once daily|daily|every day)\b/i, slots: ["morning"] },
];

export type DoseCount = { n: number; unit: "tablet" | "capsule" };

export type SigReading = {
  /** When it is taken, in the order of her day. Empty when as needed or unscheduled. */
  slots: Slot[];
  asNeeded: boolean;
  /** "Take 1 tablet", "Take two capsules": how many each time, when the sig says so. */
  count: DoseCount | undefined;
  /** The rules that decided it (ids from SIG_RULES). */
  rules: string[];
};

const NUMBER_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4 };
const COUNT = /\btake\s+(\d+|one|two|three|four)\s+(tablets?|capsules?)\b/i;

/** How many tablets or capsules each time, when the sig says "Take N tablet(s)/capsule(s)" (N a digit or a word). */
export function doseCount(sig: string): DoseCount | undefined {
  const match = COUNT.exec(sig);
  if (!match) return undefined;
  const raw = match[1]!.toLowerCase();
  const n = /^\d+$/.test(raw) ? Number(raw) : NUMBER_WORDS[raw];
  if (n === undefined || !Number.isInteger(n) || n < 1) return undefined;
  return { n, unit: match[2]!.toLowerCase().startsWith("capsule") ? "capsule" : "tablet" };
}

/** The slots a sig's instructions put a medicine in, by SIG_RULES. */
export function readSig(sig: string | undefined): SigReading {
  const text = (sig ?? "").replace(/\s+/g, " ").trim();
  const count = text ? doseCount(text) : undefined;
  const hits = SIG_RULES.filter((r) => r.pattern.test(text));
  const ids = (rules: SigRule[]) => rules.map((r) => r.id);
  const asNeeded = hits.find((r) => r.kind === "as_needed");
  if (asNeeded) return { slots: [], asNeeded: true, count, rules: [asNeeded.id] };
  const frequency = hits.find((r) => r.kind === "frequency");
  if (frequency) return { slots: [...frequency.slots], asNeeded: false, count, rules: [frequency.id] };
  const times = hits.filter((r) => r.kind === "time_of_day");
  if (times.length > 0) {
    const slots = SLOTS.filter((s) => times.some((r) => r.slots.includes(s)));
    return { slots, asNeeded: false, count, rules: ids(times) };
  }
  const daily = hits.find((r) => r.kind === "default");
  if (daily) return { slots: [...daily.slots], asNeeded: false, count, rules: [daily.id] };
  return { slots: [], asNeeded: false, count, rules: [] };
}

// ---------- How a medicine is named to her ----------

const UNIT_WORDS: Record<string, string> = { mg: "mg", mcg: "mcg", ug: "mcg", "µg": "mcg", meq: "mEq", g: "g", ml: "mL", unt: "units", unit: "units", units: "units" };

/** "5 MG" -> "5 mg", "20 MEQ" -> "20 mEq". Undefined when there is none. */
export function strengthWords(strength: string | undefined): string | undefined {
  const match = /(\d+(?:\.\d+)?)\s*(mg|mcg|ug|µg|meq|g|ml|unt|units?)\b/i.exec(strength ?? "");
  if (!match) return undefined;
  return `${match[1]} ${UNIT_WORDS[match[2]!.toLowerCase()] ?? match[2]!.toLowerCase()}`;
}

/** "24 HR metoprolol succinate 50 MG Extended Release Oral Tablet" -> "metoprolol succinate". */
export function medicineWords(name: string): string {
  const tokens = ingredientTokens(name);
  return tokens.length > 0 ? tokens.join(" ") : name.replace(/\s+/g, " ").trim().toLowerCase();
}

/** "apixaban 5 mg", as said in a sentence. */
export function plainName(med: Pick<Medication, "name" | "strength">): string {
  const strength = strengthWords(med.strength);
  const words = medicineWords(med.name);
  return strength ? `${words} ${strength}` : words;
}

/** "Apixaban 5 mg", at the start of a reminder line. */
export function displayName(med: Pick<Medication, "name" | "strength">): string {
  const plain = plainName(med);
  return plain.charAt(0).toUpperCase() + plain.slice(1);
}

/**
 * Her prescription's instructions as read back: exactly as written, only the first letter lowered so
 * they read on after "Your label says:", and a trailing period dropped. Never reworded.
 */
export function labelInstructions(sig: string | undefined): string | undefined {
  const one = (sig ?? "").replace(/\s+/g, " ").trim().replace(/[.\s]+$/, "");
  if (!one) return undefined;
  return one.charAt(0).toLowerCase() + one.slice(1);
}

/** "tablet" or "capsule" from the drug name ("Oral Capsule"), for the refill request. */
export function doseForm(med: Pick<Medication, "name" | "sig">): "tablet" | "capsule" | undefined {
  const count = doseCount(med.sig ?? "");
  if (count) return count.unit;
  if (/\bcapsules?\b/i.test(med.name)) return "capsule";
  if (/\btablets?\b/i.test(med.name)) return "tablet";
  return undefined;
}

// ---------- Her schedule ----------

export type ScheduledMedication = {
  key: string;
  /** "Apixaban 5 mg". */
  name: string;
  /** "apixaban 5 mg". */
  plain: string;
  /** "apixaban". */
  ingredient: string;
  /** Her prescription's words as read back (labelInstructions), if the record has them. */
  instructions: string | undefined;
  slots: Slot[];
  asNeeded: boolean;
  count: DoseCount | undefined;
  med: Medication;
};

/** Each active medication with its slots, in record order. */
export function medicationSchedule(meds: readonly Medication[]): ScheduledMedication[] {
  return meds
    .filter((m) => m.status === "active")
    .map((med) => {
      const read = readSig(med.sig);
      return {
        key: med.key,
        name: displayName(med),
        plain: plainName(med),
        ingredient: medicineWords(med.name),
        instructions: labelInstructions(med.sig),
        slots: read.slots,
        asNeeded: read.asNeeded,
        count: read.count,
        med,
      };
    });
}

/** The medicines taken in one slot, in record order. */
export function medsForSlot(schedule: readonly ScheduledMedication[], slot: Slot): ScheduledMedication[] {
  return schedule.filter((s) => s.slots.includes(slot));
}

/** The "as needed" medicines: never in a reminder. */
export function asNeededMeds(schedule: readonly ScheduledMedication[]): ScheduledMedication[] {
  return schedule.filter((s) => s.asNeeded);
}

/** One memory-check candidate: a scheduled medicine with a known count, asked about its first slot. */
export type MemoryCandidate = { med: ScheduledMedication; slot: Slot; count: DoseCount; instructions: string };

/** Scheduled medicines with a known count and instructions to read back, in record order. */
export function memoryCandidates(schedule: readonly ScheduledMedication[]): MemoryCandidate[] {
  return schedule.flatMap((s) => (s.count && s.instructions && s.slots[0] ? [{ med: s, slot: s.slots[0], count: s.count, instructions: s.instructions }] : []));
}
