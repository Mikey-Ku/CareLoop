import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FIXTURES_DIR, loadRxNavCache, loadSnapshot } from "../src/finchnode/fixtures.ts";
import {
  LOINC,
  normalizeHealthRecord,
  parseReferenceRange,
  strengthFromName,
  type Dispense,
  type Measurement,
  type Medication,
  type PatientRecord,
} from "../src/finchnode/normalize.ts";
import { DEFAULT_RULES_CONFIG, type RulesConfig } from "../src/rules/config.ts";
import {
  fingerprint,
  ruleApixabanDose,
  ruleBleedingCombination,
  ruleMetforminKidneys,
  rulePotassium,
  ruleRefillTiming,
  runRules,
  type RuleResult,
} from "../src/rules/index.ts";

const config = DEFAULT_RULES_CONFIG;

// ---------- Tiny PatientRecord builder ----------

let seq = 0;
const nextId = () => `rec_${(++seq).toString(16).padStart(24, "0")}`;
const SOURCE = "test-clinic";

function med(name: string, status = "active"): Medication {
  return {
    key: `name|${name.toLowerCase()}`,
    name,
    rxnorm: undefined,
    rxnormFrom: undefined,
    strength: strengthFromName(name),
    sig: undefined,
    status,
    startDate: "2025-01-01",
    provenance: [{ recordId: nextId(), source: SOURCE, sourceRecordId: undefined, date: "2025-01-01" }],
  };
}

function measurement(loinc: string, value: number | undefined, date: string, extra: Partial<Measurement> = {}): Measurement {
  return {
    key: `loinc|${loinc}`,
    loinc,
    name: loinc,
    value,
    text: undefined,
    unit: undefined,
    date,
    referenceRange: undefined,
    usable: value !== undefined,
    unusableReason: value === undefined ? "no value" : undefined,
    provenance: [{ recordId: nextId(), source: SOURCE, sourceRecordId: undefined, date }],
    ...extra,
  };
}

const egfr = (value: number, date: string) => measurement(LOINC.egfr, value, date, { unit: "mL/min/{1.73_m2}" });
const creatinine = (value: number, date = "2026-07-01") => measurement(LOINC.creatinine, value, date, { unit: "mg/dL" });
const weight = (value: number, date = "2026-07-01") => measurement(LOINC.bodyWeight, value, date, { unit: "kg" });
const potassium = (value: number, range = "3.5 - 5.1 mmol/L", date = "2026-07-01") =>
  measurement(LOINC.potassium, value, date, { unit: "mmol/L", referenceRange: parseReferenceRange(range) });

function fill(of: Medication, date: string, daysSupply: number): Dispense {
  return { recordId: nextId(), source: SOURCE, medicationKey: of.key, name: of.name, date, daysSupply };
}

function patient(parts: Partial<PatientRecord> & { birthDate?: string } = {}): PatientRecord {
  const { birthDate, ...rest } = parts;
  return {
    subject: "patient-test",
    demographics: { recordId: nextId(), name: "Test Patient", givenName: "Test", birthDate, gender: "female" },
    medications: [],
    dispenses: [],
    labs: [],
    vitals: [],
    conditions: [],
    sources: [{ system: SOURCE, name: "Test Clinic", lastSyncedAt: "2026-09-01", available: true }],
    syncStatus: "complete",
    dataAsOf: "2026-09-01",
    sharedCategories: [],
    missingCategories: [],
    warnings: [],
    ...rest,
  };
}

function addDays(day: string, days: number): string {
  return new Date(Date.parse(day) + days * 86_400_000).toISOString().slice(0, 10);
}

const CHECKIN = "2026-09-01";

/** Every flag must point back to records: id, source, date and value. */
function expectFullEvidence(r: RuleResult) {
  expect(r.evidence.length).toBeGreaterThan(0);
  for (const e of r.evidence) {
    expect(e.resourceId).toMatch(/^rec_[0-9a-f]{24}$/);
    expect(e.source).toBeTruthy();
    expect(e.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(e.value).toBeTruthy();
  }
}

// ---------- Answer key (Harriet) ----------

type AnswerKey = {
  patient: string;
  checkinDate: string;
  results: { ruleId: string; status: RuleResult["status"]; details: Record<string, unknown>; evidenceDrugs: string[] }[];
};

const answerKey = JSON.parse(readFileSync(join(FIXTURES_DIR, "answer-key.json"), "utf8")) as AnswerKey;
const rxnav = loadRxNavCache();

function recordIds(record: PatientRecord): Set<string> {
  const ids = new Set<string>();
  if (record.demographics.recordId) ids.add(record.demographics.recordId);
  for (const m of [...record.medications, ...record.labs, ...record.vitals, ...record.conditions])
    for (const p of m.provenance) ids.add(p.recordId);
  for (const d of record.dispenses) ids.add(d.recordId);
  return ids;
}

describe("answer key: Harriet", () => {
  const record = normalizeHealthRecord(loadSnapshot(answerKey.patient), { rxnav });
  const results = runRules({ record, checkinDate: answerKey.checkinDate });

  it("covers R1 to R5 in order", () => {
    expect(answerKey.checkinDate).toBe("2026-09-01");
    expect(results.map((r) => r.ruleId)).toEqual(answerKey.results.map((r) => r.ruleId));
  });

  for (const expected of answerKey.results) {
    it(`${expected.ruleId} is ${expected.status}`, () => {
      const actual = results.find((r) => r.ruleId === expected.ruleId)!;
      expect(actual.status).toBe(expected.status);
      expect(actual.details).toMatchObject(expected.details);
      const evidenceText = actual.evidence.map((e) => e.value.toLowerCase()).join(" | ");
      for (const drug of expected.evidenceDrugs) expect(evidenceText).toContain(drug);
      if (actual.status === "flag") expectFullEvidence(actual);
      const ids = recordIds(record);
      for (const e of actual.evidence) expect(ids.has(e.resourceId)).toBe(true);
    });
  }

  it("R1 and R4 cite both of the last two eGFR results", () => {
    const egfrIds = record.labs.filter((m) => m.loinc === LOINC.egfr).slice(-2).map((m) => m.provenance[0]!.recordId);
    for (const ruleId of ["R1", "R4"]) {
      const cited = results.find((r) => r.ruleId === ruleId)!.evidence.map((e) => e.resourceId);
      expect(cited).toEqual(expect.arrayContaining(egfrIds));
    }
  });

  it("is deterministic: the same snapshot gives the same fingerprints", () => {
    const again = runRules({ record: normalizeHealthRecord(loadSnapshot(answerKey.patient), { rxnav }), checkinDate: answerKey.checkinDate });
    expect(again.map(fingerprint)).toEqual(results.map(fingerprint));
  });
});

describe("every other recorded snapshot", () => {
  const subjects = [
    "patient-demo-001",
    "patient-demo-multi-source",
    "patient-demo-messy-coding",
    "patient-demo-sparse",
    "patient-demo-consent-partial",
    "patient-demo-source-unavailable",
    "patient-demo-rate-limited",
    "patient-demo-pediatric-asthma",
  ];
  for (const subject of subjects) {
    it(`${subject}: runs all five rules without throwing`, () => {
      const record = normalizeHealthRecord(loadSnapshot(subject), { rxnav });
      const results = runRules({ record, checkinDate: record.dataAsOf ?? CHECKIN });
      expect(results.map((r) => r.ruleId)).toEqual(["R1", "R2", "R3", "R4", "R5"]);
      for (const r of results) {
        expect(["flag", "checked", "skipped"]).toContain(r.status);
        if (r.status === "flag") expectFullEvidence(r);
      }
    });
  }
});

// ---------- R1 metformin and kidneys ----------

describe("R1 metformin and kidneys", () => {
  const onMetformin = (...labs: Measurement[]) =>
    ruleMetforminKidneys({ record: patient({ medications: [med("metformin hydrochloride 500 MG Oral Tablet")], labs }), checkinDate: CHECKIN });

  it("eGFR 50 is checked", () => {
    expect(onMetformin(egfr(50, "2026-07-01")).status).toBe("checked");
  });

  it("eGFR 40 flags reassess", () => {
    const r = onMetformin(egfr(44, "2026-01-01"), egfr(40, "2026-07-01"));
    expect(r.status).toBe("flag");
    expect(r.details).toMatchObject({ level: "reassess", egfr: 40, previousEgfr: 44, falling: true });
    expectFullEvidence(r);
  });

  it("eGFR 25 flags contraindicated", () => {
    const r = onMetformin(egfr(25, "2026-07-01"));
    expect(r.status).toBe("flag");
    expect(r.details).toMatchObject({ level: "contraindicated", falling: false });
    expect(r.severity).toBe("high");
    expectFullEvidence(r);
  });

  it("uses the latest eGFR, not the lowest", () => {
    const r = onMetformin(egfr(25, "2026-01-01"), egfr(50, "2026-07-01"));
    expect(r.status).toBe("checked");
  });

  it("thresholds are strict 'below' and come from config", () => {
    expect(onMetformin(egfr(config.metforminReassessEgfr, "2026-07-01")).status).toBe("checked");
    expect(onMetformin(egfr(config.metforminContraindicatedEgfr, "2026-07-01")).details).toMatchObject({ level: "reassess" });
    const stricter: RulesConfig = { ...config, metforminReassessEgfr: 55 };
    const r = ruleMetforminKidneys({
      record: patient({ medications: [med("metformin 500 MG Oral Tablet")], labs: [egfr(50, "2026-07-01")] }),
      checkinDate: CHECKIN,
      config: stricter,
    });
    expect(r.status).toBe("flag");
  });

  it("no eGFR is skipped", () => {
    expect(onMetformin().status).toBe("skipped");
    expect(onMetformin(measurement(LOINC.egfr, undefined, "2026-07-01")).status).toBe("skipped");
  });

  it("not on metformin is checked, whatever the eGFR", () => {
    const r = ruleMetforminKidneys({ record: patient({ labs: [egfr(25, "2026-07-01")] }), checkinDate: CHECKIN });
    expect(r.status).toBe("checked");
  });

  it("stopped metformin does not count", () => {
    const r = ruleMetforminKidneys({
      record: patient({ medications: [med("metformin 500 MG Oral Tablet", "stopped")], labs: [egfr(25, "2026-07-01")] }),
      checkinDate: CHECKIN,
    });
    expect(r.status).toBe("checked");
  });
});

// ---------- R2 apixaban dose ----------

describe("R2 apixaban dose", () => {
  const OVER_AGE = "1940-01-01"; // 86 on the check-in date
  const UNDER_AGE = "1950-01-01"; // 76
  const r2 = (dose: string, parts: Partial<PatientRecord> & { birthDate?: string }) =>
    ruleApixabanDose({ record: patient({ medications: [med(`apixaban ${dose} MG Oral Tablet`)], ...parts }), checkinDate: CHECKIN });

  it("two criteria expect 2.5 mg, so 5 mg flags", () => {
    const r = r2("5", { birthDate: OVER_AGE, vitals: [weight(70)], labs: [creatinine(1.6)] });
    expect(r.status).toBe("flag");
    expect(r.details).toMatchObject({ criteriaMet: 2, doseMg: 5, expectedMg: 2.5, criteria: { age: true, weight: false, creatinine: true } });
    expectFullEvidence(r);
  });

  it("two criteria with 2.5 mg is checked", () => {
    const r = r2("2.5", { birthDate: OVER_AGE, vitals: [weight(55)], labs: [creatinine(1.0)] });
    expect(r.status).toBe("checked");
    expect(r.details).toMatchObject({ criteriaMet: 2, expectedMg: 2.5 });
  });

  it("2.5 mg with zero criteria flags (expects 5 mg)", () => {
    const r = r2("2.5", { birthDate: UNDER_AGE, vitals: [weight(70)], labs: [creatinine(1.0)] });
    expect(r.status).toBe("flag");
    expect(r.details).toMatchObject({ criteriaMet: 0, expectedMg: 5, doseMg: 2.5 });
    expectFullEvidence(r);
  });

  it("missing weight that could tip the count is skipped", () => {
    const r = r2("5", { birthDate: OVER_AGE, labs: [creatinine(1.0)] });
    expect(r.status).toBe("skipped");
  });

  it("missing weight that can't change the answer still checks", () => {
    // Two known criteria already met: the dose should be 2.5 whatever the weight.
    expect(r2("5", { birthDate: OVER_AGE, labs: [creatinine(1.6)] }).status).toBe("flag");
    // Zero met and only one unknown: can't reach two, so 5 mg stands.
    expect(r2("5", { birthDate: UNDER_AGE, labs: [creatinine(1.0)] }).status).toBe("checked");
  });

  it("criteria boundaries come from config (>= age, <= weight, >= creatinine)", () => {
    const bornExactly = `${Number(CHECKIN.slice(0, 4)) - config.apixabanAgeYears}${CHECKIN.slice(4)}`;
    const r = r2("5", { birthDate: bornExactly, vitals: [weight(config.apixabanWeightKg)], labs: [creatinine(config.apixabanCreatinineMgDl)] });
    expect(r.details).toMatchObject({ criteriaMet: 3, expectedMg: 2.5 });
  });

  it("age is computed on the check-in date", () => {
    // Turns 80 the day after the check-in date.
    const birthDate = `${Number(CHECKIN.slice(0, 4)) - config.apixabanAgeYears}-09-02`;
    const r = r2("5", { birthDate, vitals: [weight(70)], labs: [creatinine(1.6)] });
    expect(r.details).toMatchObject({ age: config.apixabanAgeYears - 1, criteriaMet: 1 });
    expect(r.status).toBe("checked");
  });

  it("not on apixaban is checked", () => {
    expect(ruleApixabanDose({ record: patient(), checkinDate: CHECKIN }).status).toBe("checked");
  });
});

// ---------- R3 bleeding combination ----------

describe("R3 bleeding combination", () => {
  const r3 = (...names: string[]) => ruleBleedingCombination({ record: patient({ medications: names.map((n) => med(n)) }), checkinDate: CHECKIN });

  it("anticoagulant alone is checked", () => {
    expect(r3("apixaban 5 MG Oral Tablet", "metoprolol 50 MG Oral Tablet").status).toBe("checked");
  });

  it("anticoagulant with an SSRI only flags", () => {
    const r = r3("apixaban 5 MG Oral Tablet", "sertraline 50 MG Oral Tablet");
    expect(r.status).toBe("flag");
    expect(r.details).toEqual({ drugs: ["apixaban", "sertraline"] });
    expectFullEvidence(r);
  });

  it("anticoagulant with aspirin only flags", () => {
    const r = r3("warfarin 5 MG Oral Tablet", "aspirin 81 MG Oral Tablet");
    expect(r.status).toBe("flag");
    expect(r.details).toEqual({ drugs: ["warfarin", "aspirin"] });
  });

  it("aspirin and an SSRI without an anticoagulant is checked", () => {
    expect(r3("aspirin 81 MG Oral Tablet", "sertraline 50 MG Oral Tablet").status).toBe("checked");
  });

  it("a stopped aspirin doesn't count", () => {
    const r = ruleBleedingCombination({
      record: patient({ medications: [med("apixaban 5 MG Oral Tablet"), med("aspirin 81 MG Oral Tablet", "stopped")] }),
      checkinDate: CHECKIN,
    });
    expect(r.status).toBe("checked");
  });
});

// ---------- R4 potassium ----------

describe("R4 potassium", () => {
  const meds = [med("lisinopril 10 MG Oral Tablet"), med("potassium chloride 20 MEQ Extended Release Oral Tablet")];
  const falling = [egfr(40, "2026-01-01"), egfr(35, "2026-07-01")];
  const r4 = (labs: Measurement[], medications = meds) => rulePotassium({ record: patient({ medications, labs }), checkinDate: CHECKIN });
  const topStart = 5.1 - (5.1 - 3.5) * config.potassiumTopFraction;

  it("top-quarter potassium on ACE plus supplement with eGFR falling flags", () => {
    const r = r4([potassium(4.9), ...falling]);
    expect(r.status).toBe("flag");
    expect(r.details).toMatchObject({ inTopQuarter: true, egfrFalling: true, drugs: ["lisinopril", "potassium chloride"] });
    expectFullEvidence(r);
  });

  it("the top quarter starts where config says", () => {
    expect(r4([potassium(topStart), ...falling]).status).toBe("flag");
  });

  it("potassium below the top quarter is checked", () => {
    const r = r4([potassium(Math.round((topStart - 0.2) * 10) / 10), ...falling]);
    expect(r.status).toBe("checked");
    expect(r.details).toMatchObject({ inTopQuarter: false, egfrFalling: true });
  });

  it("eGFR rising is checked", () => {
    const r = r4([potassium(4.9), egfr(35, "2026-01-01"), egfr(40, "2026-07-01")]);
    expect(r.status).toBe("checked");
    expect(r.details).toMatchObject({ inTopQuarter: true, egfrFalling: false });
  });

  it("only one eGFR is skipped", () => {
    expect(r4([potassium(4.9), egfr(35, "2026-07-01")]).status).toBe("skipped");
  });

  it("a range with no low bound is skipped", () => {
    expect(r4([potassium(4.9, "0 - 5.1 mmol/L"), ...falling]).status).toBe("skipped");
    expect(r4([potassium(4.9, "<5.1 mmol/L"), ...falling]).status).toBe("skipped");
  });

  it("no potassium result is skipped", () => {
    expect(r4(falling).status).toBe("skipped");
  });

  it("ACE inhibitor without a potassium supplement is checked", () => {
    expect(r4([potassium(4.9), ...falling], [med("lisinopril 10 MG Oral Tablet")]).status).toBe("checked");
  });

  it("losartan potassium is not a potassium supplement", () => {
    expect(r4([potassium(4.9), ...falling], [med("lisinopril 10 MG Oral Tablet"), med("losartan potassium 50 MG Oral Tablet")]).status).toBe("checked");
  });
});

// ---------- R5 refill timing ----------

describe("R5 refill timing", () => {
  const grace = config.refillGraceDays;
  const r5 = (medications: Medication[], dispenses: Dispense[], checkinDate: string, cfg?: RulesConfig) =>
    ruleRefillTiming({ record: patient({ medications, dispenses }), checkinDate, config: cfg });

  it("two fills on time are checked", () => {
    const m = med("atorvastatin 40 MG Oral Tablet");
    const r = r5([m], [fill(m, "2026-07-01", 30), fill(m, "2026-07-31", 30)], "2026-08-15");
    expect(r.status).toBe("checked");
    expect(r.evidence).toHaveLength(2);
  });

  it("a gap longer than days supply plus grace flags", () => {
    const m = med("atorvastatin 40 MG Oral Tablet");
    const second = addDays("2026-06-01", 30 + grace + 1);
    const r = r5([m], [fill(m, "2026-06-01", 30), fill(m, second, 30)], addDays(second, 10));
    expect(r.status).toBe("flag");
    expect(r.details).toMatchObject({ late: [{ from: "2026-06-01", to: second, gapDays: 30 + grace + 1, allowedDays: 30 + grace }] });
    expectFullEvidence(r);
  });

  it("a gap of exactly days supply plus grace is on time", () => {
    const m = med("atorvastatin 40 MG Oral Tablet");
    const second = addDays("2026-06-01", 30 + grace);
    expect(r5([m], [fill(m, "2026-06-01", 30), fill(m, second, 30)], addDays(second, 10)).status).toBe("checked");
  });

  it("the grace period comes from config", () => {
    const m = med("atorvastatin 40 MG Oral Tablet");
    const second = addDays("2026-06-01", 30 + grace + 1);
    const fills = [fill(m, "2026-06-01", 30), fill(m, second, 30)];
    expect(r5([m], fills, addDays(second, 10), { ...config, refillGraceDays: grace + 1 }).status).toBe("checked");
  });

  it("the last fill running out before the check-in date flags", () => {
    const m = med("atorvastatin 40 MG Oral Tablet");
    const r = r5([m], [fill(m, "2026-06-01", 30), fill(m, "2026-07-01", 30)], addDays("2026-07-01", 30 + grace + 1));
    expect(r.status).toBe("flag");
    expect(r.details).toMatchObject({ late: [{ from: "2026-07-01" }] });
  });

  it("a stopped drug's old fills are ignored", () => {
    const stopped = med("simvastatin 20 MG Oral Tablet", "stopped");
    const r = r5([stopped], [fill(stopped, "2026-01-01", 30), fill(stopped, "2026-02-01", 30)], CHECKIN);
    expect(r.status).toBe("skipped");
  });

  it("single fills are skipped", () => {
    const a = med("atorvastatin 40 MG Oral Tablet");
    const b = med("lisinopril 10 MG Oral Tablet");
    const r = r5([a, b], [fill(a, "2026-05-01", 30), fill(b, "2026-05-01", 30)], CHECKIN);
    expect(r.status).toBe("skipped");
    expect(r.details).toMatchObject({ drugsWithFills: 2, drugsWithRepeatFills: 0 });
  });
});

// ---------- Records after the check-in date ----------

describe("runRules ignores records dated after the check-in date", () => {
  const harriet = normalizeHealthRecord(loadSnapshot(answerKey.patient), { rxnav });
  const keyResults = runRules({ record: harriet, checkinDate: answerKey.checkinDate });
  const later = "2026-09-20";

  it("a rising eGFR and a low potassium after the check-in date change neither R1 nor R4", () => {
    // On the later day these would clear R4 (eGFR rising, potassium low) and move R1 to "checked".
    const record: PatientRecord = { ...harriet, labs: [...harriet.labs, egfr(52, later), potassium(3.8, "3.5 - 5.1 mmol/L", later)] };
    const results = runRules({ record, checkinDate: answerKey.checkinDate });
    expect(results.map(fingerprint)).toEqual(keyResults.map(fingerprint));
    for (const ruleId of ["R1", "R4"]) {
      const r = results.find((x) => x.ruleId === ruleId)!;
      expect(r.status).toBe("flag");
      expect(r.evidence.every((e) => e.date! <= answerKey.checkinDate)).toBe(true);
    }
    // On the later day they count.
    const onLater = runRules({ record, checkinDate: later });
    expect(onLater.find((r) => r.ruleId === "R1")?.status).toBe("checked");
    expect(onLater.find((r) => r.ruleId === "R4")?.status).toBe("checked");
  });

  it("Harriet's answer key is unchanged", () => {
    for (const expected of answerKey.results) {
      const actual = keyResults.find((r) => r.ruleId === expected.ruleId)!;
      expect(actual.status).toBe(expected.status);
      expect(actual.details).toMatchObject(expected.details);
    }
  });

  it("a medication that starts after the check-in date isn't on her list yet (R3)", () => {
    const apixaban = med("apixaban 5 MG Oral Tablet");
    const aspirin = { ...med("aspirin 81 MG Oral Tablet"), startDate: later };
    aspirin.provenance = aspirin.provenance.map((p) => ({ ...p, date: later }));
    expect(runRules({ record: patient({ medications: [apixaban, aspirin] }), checkinDate: CHECKIN }).find((r) => r.ruleId === "R3")?.status).toBe("checked");
    expect(runRules({ record: patient({ medications: [apixaban, aspirin] }), checkinDate: later }).find((r) => r.ruleId === "R3")?.status).toBe("flag");
  });

  it("a fill after the check-in date doesn't count (R5)", () => {
    const m = med("atorvastatin 40 MG Oral Tablet");
    const fills = [fill(m, "2026-08-01", 30), fill(m, later, 30)];
    const r5 = (checkinDate: string) => runRules({ record: patient({ medications: [m], dispenses: fills }), checkinDate }).find((r) => r.ruleId === "R5")!;
    expect(r5(CHECKIN).status).toBe("skipped");
    expect(r5(later).status).toBe("flag");
  });
});

// ---------- fingerprint ----------

describe("fingerprint", () => {
  const meds = [med("metformin 500 MG Oral Tablet")];
  const first = egfr(33, "2026-01-01");
  const record = (latestValue: number) => patient({ medications: meds, labs: [first, { ...egfr(latestValue, "2026-07-01"), provenance: [{ recordId: "rec_aaaaaaaaaaaaaaaaaaaaaaaa", source: SOURCE, sourceRecordId: undefined, date: "2026-07-01" }] }] });

  it("is stable for the same evidence, in any order", () => {
    const a = ruleMetforminKidneys({ record: record(31), checkinDate: CHECKIN });
    const b = ruleMetforminKidneys({ record: record(31), checkinDate: CHECKIN });
    expect(fingerprint(a)).toBe(fingerprint(b));
    expect(fingerprint({ ...a, evidence: [...a.evidence].reverse() })).toBe(fingerprint(a));
  });

  it("changes when an evidence value changes", () => {
    const a = ruleMetforminKidneys({ record: record(31), checkinDate: CHECKIN });
    const b = ruleMetforminKidneys({ record: record(29), checkinDate: CHECKIN });
    expect(fingerprint(a)).not.toBe(fingerprint(b));
  });

  it("differs between rules with the same evidence", () => {
    const a = ruleMetforminKidneys({ record: record(31), checkinDate: CHECKIN });
    expect(fingerprint({ ...a, ruleId: "R4" })).not.toBe(fingerprint(a));
  });
});
