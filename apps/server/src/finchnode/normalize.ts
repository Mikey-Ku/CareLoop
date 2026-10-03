import { cleanDrugTerm, type RxNavCache } from "./rxnav.ts";
import {
  CATEGORIES,
  type Category,
  type Code,
  type HealthRecord,
  type Warning,
  type WireCondition,
  type WireDispense,
  type WireMedication,
  type WireObservation,
} from "./types.ts";

// Our model of one patient's health record: FinchNode's snapshot with values
// parsed, units converted, unusable records marked and sources merged.

export const RXNORM_SYSTEM = "http://www.nlm.nih.gov/research/umls/rxnorm";
export const LOINC_SYSTEM = "http://loinc.org";

export const LOINC = {
  heartRate: "8867-4",
  bodyWeight: "29463-7",
  bloodPressurePanel: "85354-9",
  creatinine: "2160-0",
  egfr: "98979-8",
  potassium: "2823-3",
  glucoseMolar: "14749-6",
  glucoseMass: "2345-7",
} as const;

/** Where one fact came from. Every rule result's evidence points back to these. */
export type Provenance = {
  recordId: string;
  source: string;
  sourceRecordId: string | undefined;
  date: string | undefined;
};

export type Medication = {
  key: string;
  name: string;
  rxnorm: string | undefined;
  rxnormFrom: "source" | "rxnav" | undefined;
  /** Strength from the drug name, such as "5 MG". */
  strength: string | undefined;
  sig: string | undefined;
  status: string;
  startDate: string | undefined;
  provenance: Provenance[];
};

export type Dispense = {
  recordId: string;
  source: string;
  medicationKey: string;
  name: string;
  date: string | undefined;
  daysSupply: number | undefined;
};

export type ReferenceRange = { low: number | undefined; high: number | undefined; text: string };

export type Measurement = {
  key: string;
  loinc: string | undefined;
  name: string;
  value: number | undefined;
  /** Non-numeric results such as "Negative". */
  text: string | undefined;
  unit: string | undefined;
  date: string | undefined;
  referenceRange: ReferenceRange | undefined;
  usable: boolean;
  unusableReason: string | undefined;
  provenance: Provenance[];
};

export type Condition = {
  key: string;
  name: string;
  status: string | undefined;
  onsetDate: string | undefined;
  provenance: Provenance[];
};

export type SourceState = {
  system: string;
  name: string | undefined;
  lastSyncedAt: string | undefined;
  available: boolean;
};

export type PatientRecord = {
  subject: string;
  demographics: {
    recordId: string | undefined;
    name: string | undefined;
    givenName: string | undefined;
    birthDate: string | undefined;
    gender: string | undefined;
  };
  medications: Medication[];
  dispenses: Dispense[];
  labs: Measurement[];
  vitals: Measurement[];
  conditions: Condition[];
  sources: SourceState[];
  syncStatus: string;
  dataAsOf: string | undefined;
  /** Categories this patient shared with us (consent receipts), or every category when receipts aren't listed. */
  sharedCategories: Category[];
  missingCategories: string[];
  warnings: Warning[];
};

/** YYYY-MM-DD, or undefined when the source date can't be read (for example "fall 2024"). */
export function toDay(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(value.trim());
  if (!match) return undefined;
  // Date.parse rolls "2026-02-30" over to March 2, so check the day survives a round trip.
  const parsed = new Date(`${match[1]}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(match[1]!) ? match[1] : undefined;
}

function codeIn(codes: Code[], system: string): string | undefined {
  return codes.find((c) => c.system === system)?.code;
}

function primaryCode(codes: Code[]): string | undefined {
  const clinical = codes.find((c) => !c.system.includes("observation-category") && !c.system.includes("v2-0074"));
  return clinical ? `${clinical.system}|${clinical.code}` : undefined;
}

function provenance(r: { id: string; source: string; sourceRecordId?: string | null | undefined }, date?: string): Provenance {
  return { recordId: r.id, source: r.source, sourceRecordId: r.sourceRecordId ?? undefined, date };
}

function normalizeName(name: string): string {
  return name.replace(/\s+/g, " ").trim().toLowerCase();
}

/** "apixaban 5 MG Oral Tablet" -> "5 MG"; "potassium chloride 20 MEQ ..." -> "20 MEQ". */
export function strengthFromName(name: string): string | undefined {
  const match = /(\d+(?:\.\d+)?)\s*(MG|MCG|MEQ|UNT|ML|G)\b/i.exec(name);
  return match ? `${match[1]} ${match[2]!.toUpperCase()}` : undefined;
}

/** "3.5 - 5.1 mmol/L" -> { low: 3.5, high: 5.1 }. A low bound of 0 means "no lower bound" in source data. */
export function parseReferenceRange(text: string | null | undefined): ReferenceRange | undefined {
  if (!text) return undefined;
  const between = /(-?\d+(?:\.\d+)?)\s*(?:-|–|to)\s*(\d+(?:\.\d+)?)/.exec(text);
  if (between) {
    const low = Number(between[1]);
    return { low: low === 0 ? undefined : low, high: Number(between[2]), text };
  }
  const upper = /^\s*(?:<|<=|≤)\s*(\d+(?:\.\d+)?)/.exec(text);
  if (upper) return { low: undefined, high: Number(upper[1]), text };
  const lower = /^\s*(?:>|>=|≥)\s*(\d+(?:\.\d+)?)/.exec(text);
  if (lower) return { low: Number(lower[1]), high: undefined, text };
  return { low: undefined, high: undefined, text };
}

// Unit conversion. Keys are UCUM codes as FinchNode sends them.
type Conversion = { to: string; factor: number; digits: number };
const GLUCOSE_MMOL_TO_MG = 18.016;
const UNIT_ALIASES: Record<string, string> = {
  "u[IU]/mL": "m[IU]/L",
  "uIU/mL": "m[IU]/L",
  "mIU/L": "m[IU]/L",
  lb: "[lb_av]",
  lbs: "[lb_av]",
};
function conversionFor(loinc: string | undefined, unit: string): Conversion | undefined {
  if (unit === "[lb_av]") return { to: "kg", factor: 0.45359237, digits: 1 };
  if (loinc === LOINC.glucoseMolar && unit === "mmol/L") return { to: "mg/dL", factor: GLUCOSE_MMOL_TO_MG, digits: 0 };
  return undefined;
}
const round = (n: number, digits: number) => Math.round(n * 10 ** digits) / 10 ** digits;

const UNUSABLE_STATUSES = new Set(["cancelled", "entered-in-error", "preliminary"]);

export function normalizeObservation(o: WireObservation): Measurement {
  const loinc = codeIn(o.codes, LOINC_SYSTEM);
  const name = o.name ?? loinc ?? "Unnamed result";
  const date = toDay(o.date);
  const raw = o.value === null || o.value === undefined ? undefined : String(o.value).trim();
  const numeric = raw !== undefined && /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : undefined;
  let unit = o.unit ? (UNIT_ALIASES[o.unit] ?? o.unit) : undefined;
  let value = numeric;
  let referenceRange = parseReferenceRange(o.referenceRange);
  let finalLoinc = loinc;

  const conversion = unit ? conversionFor(loinc, unit) : undefined;
  if (conversion) {
    if (value !== undefined) value = round(value * conversion.factor, conversion.digits);
    if (referenceRange) {
      const scale = (n: number | undefined) => (n === undefined ? undefined : round(n * conversion.factor, conversion.digits));
      referenceRange = { low: scale(referenceRange.low), high: scale(referenceRange.high), text: referenceRange.text };
    }
    unit = conversion.to;
    if (loinc === LOINC.glucoseMolar) finalLoinc = LOINC.glucoseMass;
  }

  let unusableReason: string | undefined;
  if (o.status && UNUSABLE_STATUSES.has(o.status)) unusableReason = `status ${o.status}`;
  else if (raw === undefined || raw === "") unusableReason = "no value";
  else if (!date) unusableReason = "no date";

  return {
    key: finalLoinc ? `loinc|${finalLoinc}` : `name|${normalizeName(name)}`,
    loinc: finalLoinc,
    name,
    value,
    text: numeric === undefined ? raw : undefined,
    unit,
    date,
    referenceRange,
    usable: unusableReason === undefined,
    unusableReason,
    provenance: [provenance(o, date)],
  };
}

export function normalizeMedication(m: WireMedication, rxnav?: RxNavCache): Medication {
  const name = m.name ?? "Unnamed medication";
  const sourceCode = codeIn(m.codes, RXNORM_SYSTEM);
  const looked = sourceCode ? undefined : rxnav?.get(name);
  const rxnorm = sourceCode ?? looked?.rxcui;
  return {
    key: rxnorm ? `rxnorm|${rxnorm}` : `name|${cleanDrugTerm(name)}`,
    name,
    rxnorm,
    rxnormFrom: sourceCode ? "source" : looked ? "rxnav" : undefined,
    strength: strengthFromName(name),
    sig: m.dosage ?? undefined,
    status: m.status ?? "unknown",
    startDate: toDay(m.startDate),
    provenance: [provenance(m, toDay(m.startDate))],
  };
}

function normalizeDispense(d: WireDispense, rxnav?: RxNavCache): Dispense {
  const name = d.name ?? "Unnamed medication";
  const rxnorm = codeIn(d.codes, RXNORM_SYSTEM) ?? rxnav?.get(name)?.rxcui;
  return {
    recordId: d.id,
    source: d.source,
    medicationKey: rxnorm ? `rxnorm|${rxnorm}` : `name|${cleanDrugTerm(name)}`,
    name,
    date: toDay(d.handedOverDate),
    daysSupply: d.daysSupply ?? undefined,
  };
}

function normalizeCondition(c: WireCondition): Condition {
  const name = c.name ?? "Unnamed condition";
  const code = primaryCode(c.codes);
  return {
    key: code ?? `name|${normalizeName(name)}`,
    name,
    status: c.status ?? undefined,
    onsetDate: toDay(c.onsetDate),
    provenance: [provenance(c, toDay(c.onsetDate ?? c.recordedDate))],
  };
}

// Merge: the same code from two sources becomes one item with both sources in its provenance.

function mergeMedications(meds: Medication[]): Medication[] {
  const byKey = new Map<string, Medication>();
  for (const med of meds) {
    const existing = byKey.get(med.key);
    if (!existing) {
      byKey.set(med.key, { ...med, provenance: [...med.provenance] });
      continue;
    }
    const newer = (med.startDate ?? "") > (existing.startDate ?? "");
    const merged: Medication = newer ? { ...med, provenance: existing.provenance } : existing;
    merged.provenance = [...existing.provenance, ...med.provenance];
    if (existing.status === "active" || med.status === "active") merged.status = "active";
    byKey.set(med.key, merged);
  }
  return [...byKey.values()];
}

function mergeConditions(conditions: Condition[]): Condition[] {
  const byKey = new Map<string, Condition>();
  for (const c of conditions) {
    const existing = byKey.get(c.key);
    if (!existing) byKey.set(c.key, { ...c, provenance: [...c.provenance] });
    else existing.provenance.push(...c.provenance);
  }
  return [...byKey.values()];
}

/** Observations are a time series, so only the same test on the same day with the same value is a duplicate. */
function mergeMeasurements(items: Measurement[]): Measurement[] {
  const byKey = new Map<string, Measurement>();
  const out: Measurement[] = [];
  for (const m of items) {
    if (!m.usable) {
      out.push(m);
      continue;
    }
    const k = `${m.key}|${m.date}|${m.value ?? m.text}|${m.unit}`;
    const existing = byKey.get(k);
    if (existing) existing.provenance.push(...m.provenance);
    else {
      const copy = { ...m, provenance: [...m.provenance] };
      byKey.set(k, copy);
      out.push(copy);
    }
  }
  return out.sort((a, b) => (a.date ?? "").localeCompare(b.date ?? ""));
}

function sharedCategories(record: HealthRecord): Category[] {
  const receipts = record.consent?.receipts ?? [];
  const known = new Set<string>(CATEGORIES);
  if (receipts.length === 0) return [...CATEGORIES];
  const shared = new Set(receipts.flatMap((r) => r.categories).filter((c) => known.has(c)));
  return CATEGORIES.filter((c) => shared.has(c));
}

export function normalizeHealthRecord(record: HealthRecord, options: { rxnav?: RxNavCache } = {}): PatientRecord {
  const { data, meta } = record;
  const unavailable = new Set(meta.warnings.filter((w) => w.code === "source_unavailable").map((w) => w.source));
  const demo = data.demographics;
  const fullName = demo?.name ?? undefined;

  return {
    subject: record.id,
    demographics: {
      recordId: demo?.id,
      name: fullName,
      givenName: fullName?.split(/\s+/)[0],
      birthDate: toDay(demo?.birthDate),
      gender: demo?.gender ?? undefined,
    },
    medications: mergeMedications(data.medications.map((m) => normalizeMedication(m, options.rxnav))),
    dispenses: data.medicationDispenses
      .map((d) => normalizeDispense(d, options.rxnav))
      .sort((a, b) => (a.date ?? "").localeCompare(b.date ?? "")),
    labs: mergeMeasurements(data.labs.map(normalizeObservation)),
    vitals: mergeMeasurements(data.vitals.map(normalizeObservation)),
    conditions: mergeConditions(data.conditions.map(normalizeCondition)),
    sources: record.sources.map((s) => ({
      system: s.system,
      name: s.organization ?? undefined,
      lastSyncedAt: s.lastSyncedAt ?? undefined,
      available: !unavailable.has(s.system),
    })),
    syncStatus: meta.syncStatus,
    dataAsOf: toDay(meta.dataAsOf),
    sharedCategories: sharedCategories(record),
    missingCategories: meta.missingCategories,
    warnings: meta.warnings,
  };
}

// Queries used by rules and the packet builder.

export function activeMedications(record: PatientRecord): Medication[] {
  return record.medications.filter((m) => m.status === "active");
}

/** Usable readings of one test, oldest first. */
export function series(items: Measurement[], loinc: string): Measurement[] {
  return items.filter((m) => m.usable && m.loinc === loinc && m.value !== undefined);
}

export function latest(items: Measurement[], loinc: string): Measurement | undefined {
  return series(items, loinc).at(-1);
}

/** Age in whole years on a YYYY-MM-DD date. */
export function ageOn(birthDate: string, day: string): number {
  const [by, bm, bd] = birthDate.split("-").map(Number) as [number, number, number];
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return y - by - (m < bm || (m === bm && d < bd) ? 1 : 0);
}

