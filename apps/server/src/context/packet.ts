import {
  LOINC,
  activeMedications,
  ageOn,
  asOf,
  series,
  type Measurement,
  type PatientRecord,
} from "../finchnode/normalize.ts";
import { fingerprint, type RuleResult } from "../rules/index.ts";
import { isActiveCondition, pickQuestions, type AnswerHistoryEntry } from "./questions.ts";

// The context packet: everything the chat and voice companion may know about
// her today, built from one snapshot as it stood on the check-in date (records
// dated after it are ignored, see `asOf`). Pure: no clock, no I/O. See
// docs/DESIGN.md "Context packet".

export type Sharing = "status" | "status_vitals" | "all";
export type FlagStatus = "new" | "told" | "noted" | "cleared";

export type ContextPacket = {
  /** age is null only when the record has no usable birth date (for example consent covers medications only). */
  patient: { preferredName: string; age: number | null };
  conditions: string[];
  medications: { name: string; rxnorm?: string; dose?: string; lastFill?: string; source: string }[];
  usualRange: {
    /** Lowest to highest clinic heart rate. Kept as data even when readings aren't compared with it. */
    heartRate?: { low: number; high: number; readings: number };
    /**
     * Whether a camera heart-rate reading may be compared with `heartRate`. False with no
     * usual range, and false with active atrial fibrillation: the irregular rhythm makes
     * camera readings least reliable, so a reading is only reported as an estimate.
     */
    compareHeartRate: boolean;
    /** Why readings aren't compared, in plain words. Absent when they are. */
    note?: string;
  };
  recentLabs: { name: string; value: number; unit: string; date: string; refRange?: string }[];
  todaysQuestions: { id: string; text: string; buttons: string[] }[];
  openFlags: { flagId: string; ruleId: string; status: "new" | "told" | "noted"; message: string }[];
  /** Things she told us, newest first, capped at MAX_MEMORIES. */
  memories: string[];
  pendingFamilyMessages: { id: string; from: string; kind: "voice" | "text" }[];
  sharing: Sharing;
  /** YYYY-MM-DD, see docs/DESIGN.md "Dates". */
  checkinDate: string;
  /** Snapshot meta.dataAsOf, or null when FinchNode did not report one. */
  dataAsOf: string | null;
};

/** A stored flag row as the packet needs it. Cleared flags are dropped. */
export type StoredFlag = { flagId: string; ruleId: string; status: FlagStatus; message: string };

export type BuildContextPacketInput = {
  record: PatientRecord;
  ruleResults: RuleResult[];
  checkinDate: string;
  /** Stored flags (from the flags table). When given, used instead of deriving flags from rule results. */
  flags?: StoredFlag[];
  /** Newest first. */
  memories?: string[];
  pendingFamilyMessages?: ContextPacket["pendingFamilyMessages"];
  sharing?: Sharing;
  /** Name she asked to be called (patients.preferred_name); defaults to her given name from the record. */
  preferredName?: string;
  /** USUAL_RANGE_MIN_READINGS. */
  minUsualRangeReadings?: number;
  /** Her answers before the check-in date (db `answerHistory`), so todaysQuestions matches the engine's red-flag cadence. */
  history?: AnswerHistoryEntry[];
};

export const MAX_MEMORIES = 10;
export const DEFAULT_MIN_USUAL_RANGE_READINGS = 3;

export function buildContextPacket(input: BuildContextPacketInput): ContextPacket {
  const { checkinDate } = input;
  const record = asOf(input.record, checkinDate);
  const birthDate = record.demographics.birthDate;

  return {
    patient: {
      preferredName: input.preferredName ?? record.demographics.givenName ?? "",
      age: birthDate ? ageOn(birthDate, checkinDate) : null,
    },
    conditions: record.conditions.filter(isActiveCondition).map((c) => c.name),
    medications: medications(record),
    usualRange: usualRange(record, input.minUsualRangeReadings ?? DEFAULT_MIN_USUAL_RANGE_READINGS),
    recentLabs: recentLabs(record),
    todaysQuestions: pickQuestions(record, checkinDate, { history: input.history ?? [] }).map(({ id, text, buttons }) => ({ id, text, buttons })),
    openFlags: openFlags(input),
    memories: (input.memories ?? []).slice(0, MAX_MEMORIES),
    pendingFamilyMessages: input.pendingFamilyMessages ?? [],
    sharing: input.sharing ?? "status",
    checkinDate,
    dataAsOf: record.dataAsOf ?? null,
  };
}

function medications(record: PatientRecord): ContextPacket["medications"] {
  const sourceNames = new Map(record.sources.map((s) => [s.system, s.name ?? s.system]));
  return activeMedications(record).map((med) => {
    const fills = record.dispenses
      .filter((d) => d.medicationKey === med.key && d.date !== undefined)
      .map((d) => d.date!)
      .sort();
    const sources = [...new Set(med.provenance.map((p) => sourceNames.get(p.source) ?? p.source))];
    const lastFill = fills.at(-1);
    return {
      name: med.name,
      ...(med.rxnorm ? { rxnorm: med.rxnorm } : {}),
      ...(med.strength ? { dose: med.strength } : {}),
      ...(lastFill ? { lastFill } : {}),
      source: sources.join(", "),
    };
  });
}

const AFIB = /atrial fibrillation/i;

export const AFIB_NOTE =
  "Atrial fibrillation (an irregular heartbeat) is on her record. Camera heart-rate readings are least reliable with an irregular rhythm, so a reading is given as an estimate and never compared with her usual range.";

function tooFewReadingsNote(readings: number, minReadings: number): string {
  if (readings === 0) return "Her record has no clinic heart-rate readings, so there is no usual range to compare a reading with.";
  const count = readings === 1 ? "1 clinic heart-rate reading" : `${readings} clinic heart-rate readings`;
  return `Her record has only ${count} and a usual range needs ${minReadings}, so a reading is not compared.`;
}

/**
 * Lowest to highest clinic heart rate, only with enough readings, and whether a camera
 * reading may be compared with it. Breathing rate is never compared.
 */
function usualRange(record: PatientRecord, minReadings: number): ContextPacket["usualRange"] {
  const values = series(record.vitals, LOINC.heartRate).map((m) => m.value!);
  const enough = values.length > 0 && values.length >= minReadings;
  const heartRate = enough ? { heartRate: { low: Math.min(...values), high: Math.max(...values), readings: values.length } } : {};
  if (record.conditions.some((c) => isActiveCondition(c) && AFIB.test(c.name)))
    return { ...heartRate, compareHeartRate: false, note: AFIB_NOTE };
  if (!enough) return { compareHeartRate: false, note: tooFewReadingsNote(values.length, minReadings) };
  return { ...heartRate, compareHeartRate: true };
}

/** "Creatinine [Mass/volume] in Serum or Plasma" -> "Creatinine". */
function shortLabName(name: string): string {
  const cut = name.split(" [")[0]!.trim();
  return cut || name;
}

/**
 * The reference range in the value's unit. When normalize converted the unit
 * (glucose mmol/L to mg/dL), the source text is in the old unit, so rebuild it
 * from the converted bounds.
 */
function refRangeText(m: Measurement): string | undefined {
  const range = m.referenceRange;
  if (!range) return undefined;
  if (!m.unit || range.text.includes(m.unit)) return range.text;
  const { low, high } = range;
  if (low !== undefined && high !== undefined) return `${low} - ${high} ${m.unit}`;
  if (high !== undefined) return `<= ${high} ${m.unit}`;
  if (low !== undefined) return `>= ${low} ${m.unit}`;
  return range.text;
}

/** Latest usable numeric value per lab test, newest first. */
function recentLabs(record: PatientRecord): ContextPacket["recentLabs"] {
  const latestByKey = new Map<string, Measurement>();
  for (const m of record.labs) {
    if (!m.usable || m.value === undefined || m.date === undefined) continue;
    const existing = latestByKey.get(m.key);
    if (!existing || m.date >= existing.date!) latestByKey.set(m.key, m);
  }
  return [...latestByKey.values()]
    .sort((a, b) => b.date!.localeCompare(a.date!) || a.name.localeCompare(b.name))
    .map((m) => {
      const refRange = refRangeText(m);
      return {
        name: shortLabName(m.name),
        value: m.value!,
        unit: m.unit ?? "",
        date: m.date!,
        ...(refRange ? { refRange } : {}),
      };
    });
}

function openFlags(input: BuildContextPacketInput): ContextPacket["openFlags"] {
  if (input.flags) {
    return input.flags.flatMap((f) =>
      f.status === "cleared" ? [] : [{ flagId: f.flagId, ruleId: f.ruleId, status: f.status, message: f.message }],
    );
  }
  return input.ruleResults
    .filter((r) => r.status === "flag")
    .map((r) => ({ flagId: fingerprint(r), ruleId: r.ruleId, status: "new" as const, message: r.message }));
}
