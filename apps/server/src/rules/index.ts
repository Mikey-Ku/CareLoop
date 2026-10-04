import { createHash } from "node:crypto";
import {
  LOINC,
  activeMedications,
  ageOn,
  asOf,
  latest,
  series,
  type Measurement,
  type Medication,
  type PatientRecord,
  type Provenance,
} from "../finchnode/normalize.ts";
import { DEFAULT_RULES_CONFIG, type RulesConfig } from "./config.ts";
import { ingredientOf, medsInClass } from "./drug-classes.ts";
import { andList } from "../text.ts";

// Deterministic medication rules. The LLM never decides what is risky; it only
// rewords `message`. See docs/DESIGN.md "Rules engine".

export type RuleId = "R1" | "R2" | "R3" | "R4" | "R5" | "R6";
export type Severity = "high" | "medium" | "low";

export type Evidence = {
  resourceId: string;
  source: string;
  date: string | undefined;
  value: string;
};

export type RuleResult = {
  ruleId: RuleId;
  status: "flag" | "checked" | "skipped";
  severity: Severity | undefined;
  message: string;
  evidence: Evidence[];
  /** Rule-specific facts the answer key and the LLM wording can use. */
  details: Record<string, unknown>;
};

export type RuleContext = {
  record: PatientRecord;
  /** The check-in date (YYYY-MM-DD) rules reason about. See docs/DESIGN.md "Dates". */
  checkinDate: string;
  config?: RulesConfig;
};

function medEvidence(med: Medication): Evidence[] {
  return med.provenance.map((p) => ({ resourceId: p.recordId, source: p.source, date: p.date, value: med.name }));
}

function measurementEvidence(m: Measurement): Evidence[] {
  const value = `${m.name}: ${m.value ?? m.text}${m.unit ? ` ${m.unit}` : ""}`;
  return m.provenance.map((p: Provenance) => ({ resourceId: p.recordId, source: p.source, date: m.date, value }));
}

const result = (
  ruleId: RuleId,
  status: RuleResult["status"],
  message: string,
  extra: Partial<Pick<RuleResult, "severity" | "evidence" | "details">> = {},
): RuleResult => ({
  ruleId,
  status,
  message,
  severity: extra.severity,
  evidence: extra.evidence ?? [],
  details: extra.details ?? {},
});

/** R1: metformin and kidney function (FDA safety communication). */
export function ruleMetforminKidneys({ record, config = DEFAULT_RULES_CONFIG }: RuleContext): RuleResult {
  const metformin = medsInClass(activeMedications(record), "metformin");
  if (metformin.length === 0) return result("R1", "checked", "Not on metformin.");
  const egfrs = series(record.labs, LOINC.egfr);
  const egfr = egfrs.at(-1);
  if (!egfr || egfr.value === undefined) return result("R1", "skipped", "On metformin but no usable eGFR result.");

  const previous = egfrs.at(-2);
  const falling = previous?.value !== undefined && egfr.value < previous.value;
  const evidence = [...metformin.flatMap(medEvidence), ...(previous ? measurementEvidence(previous) : []), ...measurementEvidence(egfr)];
  const trend = falling ? `, down from ${previous!.value}` : "";
  const details = { egfr: egfr.value, previousEgfr: previous?.value, falling };

  if (egfr.value < config.metforminContraindicatedEgfr)
    return result("R1", "flag", `Your latest kidney test (eGFR) is ${egfr.value}${trend}, and you take metformin. Below ${config.metforminContraindicatedEgfr}, metformin is usually not recommended.`, {
      severity: "high",
      evidence,
      details: { ...details, level: "contraindicated" },
    });
  if (egfr.value < config.metforminReassessEgfr)
    return result("R1", "flag", `Your latest kidney test (eGFR) is ${egfr.value}${trend}, and you take metformin. Below ${config.metforminReassessEgfr}, doctors usually review metformin.`, {
      severity: "medium",
      evidence,
      details: { ...details, level: "reassess" },
    });
  return result("R1", "checked", `Metformin with eGFR ${egfr.value}: kidney function is above ${config.metforminReassessEgfr}.`, {
    evidence,
    details,
  });
}

/** R2: apixaban dose against the Eliquis label's dose-reduction criteria. */
export function ruleApixabanDose({ record, checkinDate, config = DEFAULT_RULES_CONFIG }: RuleContext): RuleResult {
  const apixaban = activeMedications(record).filter((m) => /\bapixaban\b/i.test(m.name));
  const med = apixaban[0];
  if (!med) return result("R2", "checked", "Not on apixaban.");
  const doseMg = med.strength ? Number(med.strength.split(" ")[0]) : undefined;

  const birthDate = record.demographics.birthDate;
  const age = birthDate ? ageOn(birthDate, checkinDate) : undefined;
  const weight = latest(record.vitals, LOINC.bodyWeight);
  const creatinine = latest(record.labs, LOINC.creatinine);

  const criteria = {
    age: age === undefined ? undefined : age >= config.apixabanAgeYears,
    weight: weight?.value === undefined ? undefined : weight.value <= config.apixabanWeightKg,
    creatinine: creatinine?.value === undefined ? undefined : creatinine.value >= config.apixabanCreatinineMgDl,
  };
  const met = Object.values(criteria).filter((v) => v === true).length;
  const unknown = Object.values(criteria).filter((v) => v === undefined).length;
  const evidence = [
    ...medEvidence(med),
    ...(record.demographics.recordId && birthDate
      ? [{ resourceId: record.demographics.recordId, source: med.provenance[0]!.source, date: birthDate, value: `age ${age}` }]
      : []),
    ...(weight ? measurementEvidence(weight) : []),
    ...(creatinine ? measurementEvidence(creatinine) : []),
  ];
  const details = { criteriaMet: met, criteria, age, weightKg: weight?.value, creatinine: creatinine?.value, doseMg };

  // Unknown criteria could change the answer only if they could reach the reduction count.
  if (met < config.apixabanCriteriaForReduction && met + unknown >= config.apixabanCriteriaForReduction)
    return result("R2", "skipped", "Not enough age, weight or creatinine data to check the apixaban dose.", { evidence, details });
  if (doseMg === undefined) return result("R2", "skipped", "Couldn't read the apixaban strength.", { evidence, details });

  const expectedMg = met >= config.apixabanCriteriaForReduction ? 2.5 : 5;
  const summary = `${met} of 3 dose-reduction criteria met (age ${age}, weight ${weight?.value ?? "?"} kg, creatinine ${creatinine?.value ?? "?"} mg/dL)`;
  if (doseMg !== expectedMg)
    return result(
      "R2",
      "flag",
      `You take apixaban (a blood thinner) ${doseMg} mg. Your age (${age ?? "?"}), weight (${weight?.value ?? "?"} kg) and kidney test (creatinine ${creatinine?.value ?? "?"} mg/dL) meet ${met} of the 3 dose checks on its label, which suggests a different dose. Your doctor can check whether your dose is right for you.`,
      { severity: "medium", evidence, details: { ...details, expectedMg } },
    );
  return result("R2", "checked", `Apixaban ${doseMg} mg matches the label: ${summary}.`, { evidence, details: { ...details, expectedMg } });
}

/** R3: anticoagulant combined with aspirin and/or an SSRI raises bleeding risk. */
export function ruleBleedingCombination({ record }: RuleContext): RuleResult {
  const meds = activeMedications(record);
  const anticoagulants = medsInClass(meds, "anticoagulant");
  if (anticoagulants.length === 0) return result("R3", "checked", "Not on an anticoagulant.");
  const partners = [...medsInClass(meds, "aspirin"), ...medsInClass(meds, "ssri")];
  if (partners.length === 0) return result("R3", "checked", "Anticoagulant without aspirin or an SSRI.");

  const drugs = [
    ...anticoagulants.map((m) => ingredientOf(m, "anticoagulant")),
    ...medsInClass(meds, "aspirin").map((m) => ingredientOf(m, "aspirin")),
    ...medsInClass(meds, "ssri").map((m) => ingredientOf(m, "ssri")),
  ];
  return result("R3", "flag", `You take ${andList(drugs)}. Taken together, they can raise the chance of bleeding.`, {
    severity: "medium",
    evidence: [...anticoagulants, ...partners].flatMap(medEvidence),
    details: { drugs },
  });
}

/** R4: high-normal potassium on an ACE inhibitor plus a potassium supplement, with eGFR falling. */
export function rulePotassium({ record, config = DEFAULT_RULES_CONFIG }: RuleContext): RuleResult {
  const meds = activeMedications(record);
  const ace = medsInClass(meds, "aceInhibitor");
  const supplement = medsInClass(meds, "potassiumSupplement");
  if (ace.length === 0 || supplement.length === 0)
    return result("R4", "checked", "Not on both an ACE inhibitor and a potassium supplement.");

  const potassium = latest(record.labs, LOINC.potassium);
  const range = potassium?.referenceRange;
  if (!potassium || potassium.value === undefined || range?.low === undefined || range.high === undefined)
    return result("R4", "skipped", "No usable potassium result with a reference range.");
  const egfrs = series(record.labs, LOINC.egfr);
  const [previous, current] = [egfrs.at(-2), egfrs.at(-1)];
  if (previous?.value === undefined || current?.value === undefined)
    return result("R4", "skipped", "Fewer than two eGFR results, so the kidney trend is unknown.");

  const topStart = range.high - (range.high - range.low) * config.potassiumTopFraction;
  const inTopQuarter = potassium.value >= topStart;
  const egfrFalling = current.value < previous.value;
  const evidence = [
    ...ace.flatMap(medEvidence),
    ...supplement.flatMap(medEvidence),
    ...measurementEvidence(potassium),
    ...measurementEvidence(previous),
    ...measurementEvidence(current),
  ];
  const drugs = [
    ...ace.map((m) => ingredientOf(m, "aceInhibitor")),
    ...supplement.map((m) => ingredientOf(m, "potassiumSupplement")),
  ];
  const details = { potassium: potassium.value, topStart: Math.round(topStart * 100) / 100, inTopQuarter, egfrFalling, drugs };

  if (inTopQuarter && egfrFalling)
    return result(
      "R4",
      "flag",
      `Your latest potassium test is ${potassium.value} ${potassium.unit ?? ""}, near the top of its range (${range.text}). You take ${ingredientOf(ace[0]!, "aceInhibitor")} and ${ingredientOf(supplement[0]!, "potassiumSupplement")}, and your kidney test (eGFR) has gone down, from ${previous.value} to ${current.value}.`.replace(/\s+/g, " "),
      { severity: "medium", evidence, details },
    );
  return result("R4", "checked", `Potassium ${potassium.value} with eGFR ${current.value}: no flag.`, { evidence, details });
}

const DAY_MS = 86_400_000;
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / DAY_MS);

/** R5: refill timing. Needs two or more fills of the same drug. */
export function ruleRefillTiming({ record, checkinDate, config = DEFAULT_RULES_CONFIG }: RuleContext): RuleResult {
  // Only drugs she is still on: a stopped drug's last fill is not a late refill.
  const active = new Set(activeMedications(record).map((m) => m.key));
  const byMed = new Map<string, typeof record.dispenses>();
  for (const d of record.dispenses) {
    if (!d.date || d.daysSupply === undefined || !active.has(d.medicationKey)) continue;
    byMed.set(d.medicationKey, [...(byMed.get(d.medicationKey) ?? []), d]);
  }
  const repeated = [...byMed.values()].filter((fills) => fills.length >= 2);
  if (repeated.length === 0)
    return result("R5", "skipped", "No drug has two or more fills, so refill timing can't be checked.", {
      details: { drugsWithFills: byMed.size, drugsWithRepeatFills: 0 },
    });

  const late: { name: string; from: string; to: string; gapDays: number; allowedDays: number; recordId: string; source: string }[] = [];
  for (const fills of repeated) {
    const sorted = [...fills].sort((a, b) => a.date!.localeCompare(b.date!));
    sorted.forEach((fill, i) => {
      const next = sorted[i + 1]?.date ?? checkinDate;
      const gapDays = daysBetween(fill.date!, next);
      const allowedDays = fill.daysSupply! + config.refillGraceDays;
      if (gapDays > allowedDays)
        late.push({ name: fill.name, from: fill.date!, to: next, gapDays, allowedDays, recordId: fill.recordId, source: fill.source });
    });
  }
  const evidence = repeated.flat().map((d) => ({ resourceId: d.recordId, source: d.source, date: d.date, value: `${d.name}, ${d.daysSupply} days` }));
  if (late.length === 0) return result("R5", "checked", "Refills are on time.", { evidence });
  const lateText = late.map((l) => {
    const supply = `a ${l.allowedDays - config.refillGraceDays}-day supply`;
    return l.to === checkinDate && !record.dispenses.some((d) => d.date === l.to && d.name === l.name)
      ? `${l.name}, not refilled yet, ${l.gapDays} days after ${supply}`
      : `${l.name}, refilled ${l.gapDays} days after ${supply}`;
  });
  return result("R5", "flag", `Your pharmacy record shows a gap between refills: ${lateText.join("; ")}.`, {
    severity: "low",
    evidence,
    details: { late },
  });
}

export const RULES = [ruleMetforminKidneys, ruleApixabanDose, ruleBleedingCombination, rulePotassium, ruleRefillTiming];

/** Runs R1 to R5 on the record as it stood on the check-in date (see `asOf`). */
export function runRules(context: RuleContext): RuleResult[] {
  const scoped: RuleContext = { ...context, record: asOf(context.record, context.checkinDate) };
  return RULES.map((rule) => rule(scoped));
}

/** Same rule, same evidence records and values -> same fingerprint. New evidence reopens a flag. */
export function fingerprint(result: RuleResult): string {
  const parts = result.evidence.map((e) => `${e.resourceId}=${e.value}`).sort();
  return createHash("sha256").update(`${result.ruleId}|${parts.join("|")}`).digest("hex").slice(0, 16);
}
