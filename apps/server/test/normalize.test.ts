import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FIXTURES_DIR, loadRecorded, loadRxNavCache, loadSnapshot } from "../src/finchnode/fixtures.ts";
import {
  LOINC,
  activeMedications,
  ageOn,
  asOf,
  latest,
  normalizeHealthRecord,
  normalizeObservation,
  parseReferenceRange,
  series,
  strengthFromName,
  toDay,
  type PatientRecord,
} from "../src/finchnode/normalize.ts";
import { RxNavCache, cleanDrugTerm } from "../src/finchnode/rxnav.ts";
import { HealthRecordSchema, ObservationSchema } from "../src/finchnode/types.ts";

const rxnav = loadRxNavCache();
const normalized = (subject: string): PatientRecord => normalizeHealthRecord(loadSnapshot(subject), { rxnav });

describe("toDay", () => {
  it("keeps the day of an ISO date or timestamp", () => {
    expect(toDay("2026-07-14")).toBe("2026-07-14");
    expect(toDay("2026-07-14T16:20:00Z")).toBe("2026-07-14");
    expect(toDay("  2026-07-14T16:20:00Z ")).toBe("2026-07-14");
    expect(toDay("2024-02-29")).toBe("2024-02-29");
  });

  it("returns undefined for dates it can't read", () => {
    expect(toDay("fall 2024")).toBeUndefined();
    expect(toDay("2024")).toBeUndefined();
    expect(toDay("07/14/2026")).toBeUndefined();
    expect(toDay("")).toBeUndefined();
    expect(toDay(null)).toBeUndefined();
    expect(toDay(undefined)).toBeUndefined();
  });

  it("rejects impossible calendar days instead of rolling them over", () => {
    expect(toDay("2026-02-30")).toBeUndefined();
    expect(toDay("2026-02-29")).toBeUndefined();
    expect(toDay("2026-13-01")).toBeUndefined();
  });
});

describe("parseReferenceRange", () => {
  it("parses low - high with units", () => {
    expect(parseReferenceRange("3.5 - 5.1 mmol/L")).toEqual({ low: 3.5, high: 5.1, text: "3.5 - 5.1 mmol/L" });
    expect(parseReferenceRange("12-15.5")).toEqual({ low: 12, high: 15.5, text: "12-15.5" });
    expect(parseReferenceRange("4 to 10")).toMatchObject({ low: 4, high: 10 });
    expect(parseReferenceRange("4 – 10")).toMatchObject({ low: 4, high: 10 });
  });

  it("treats a low bound of 0 as no lower bound", () => {
    expect(parseReferenceRange("0 - 17.5 g/dL")).toEqual({ low: undefined, high: 17.5, text: "0 - 17.5 g/dL" });
  });

  it("parses one-sided ranges", () => {
    expect(parseReferenceRange(">= 60 mL/min/{1.73_m2}")).toMatchObject({ low: 60, high: undefined });
    expect(parseReferenceRange("> 60")).toMatchObject({ low: 60, high: undefined });
    expect(parseReferenceRange("< 5.7 %")).toMatchObject({ low: undefined, high: 5.7 });
    expect(parseReferenceRange("<= 200")).toMatchObject({ low: undefined, high: 200 });
  });

  it("keeps unparseable text with no bounds", () => {
    expect(parseReferenceRange("Negative")).toEqual({ low: undefined, high: undefined, text: "Negative" });
  });

  it("returns undefined when there is no range", () => {
    expect(parseReferenceRange(null)).toBeUndefined();
    expect(parseReferenceRange(undefined)).toBeUndefined();
    expect(parseReferenceRange("")).toBeUndefined();
  });
});

describe("strengthFromName", () => {
  it("pulls the strength out of an RxNorm-style name", () => {
    expect(strengthFromName("apixaban 5 MG Oral Tablet")).toBe("5 MG");
    expect(strengthFromName("levothyroxine sodium 0.075 MG Oral Tablet")).toBe("0.075 MG");
    expect(strengthFromName("potassium chloride 20 MEQ Extended Release Oral Tablet")).toBe("20 MEQ");
    expect(strengthFromName("vitamin B12 1000 MCG Oral Tablet")).toBe("1000 MCG");
    expect(strengthFromName("insulin glargine 100 UNT/ML Injectable Solution")).toBe("100 UNT");
  });

  it("uppercases the unit", () => {
    expect(strengthFromName("lisinopril 10 mg tablet")).toBe("10 MG");
  });

  it("returns undefined when there is no strength", () => {
    expect(strengthFromName("blood pressure pill, 1 daily")).toBeUndefined();
    expect(strengthFromName("Tylenol")).toBeUndefined();
  });
});

describe("ageOn", () => {
  it("counts whole years and turns over on the birthday", () => {
    expect(ageOn("1948-03-02", "2026-09-01")).toBe(78);
    expect(ageOn("1948-03-02", "2026-03-01")).toBe(77);
    expect(ageOn("1948-03-02", "2026-03-02")).toBe(78);
    expect(ageOn("1948-03-02", "2026-02-28")).toBe(77);
  });
});

describe("cleanDrugTerm", () => {
  it("drops schedule text and lowercases", () => {
    expect(cleanDrugTerm("blood pressure pill, 1 daily")).toBe("blood pressure pill");
    expect(cleanDrugTerm("Lisinopril 10 mg, 1 daily")).toBe("lisinopril 10 mg");
    expect(cleanDrugTerm("aspirin 81 mg 1 daily")).toBe("aspirin 81 mg");
    expect(cleanDrugTerm("metformin 500 mg 2x daily")).toBe("metformin 500 mg");
    expect(cleanDrugTerm("metoprolol 25 mg 2 times a day")).toBe("metoprolol 25 mg");
    expect(cleanDrugTerm("Tylenol (acetaminophen)")).toBe("tylenol");
    expect(cleanDrugTerm("  Sertraline   50 MG ; at night")).toBe("sertraline 50 mg");
  });
});

describe("RxNavCache", () => {
  it("the recorded cache says the free-text blood pressure pill has no RxNorm code", () => {
    expect(rxnav.get("blood pressure pill, 1 daily")).toBeNull();
    expect(rxnav.get("never looked up")).toBeUndefined();
  });

  it("lookup serves cached terms without fetching", async () => {
    const fetchImpl = (async () => {
      throw new Error("should not fetch");
    }) as unknown as typeof fetch;
    await expect(rxnav.lookup("Blood pressure pill, 1 daily", fetchImpl)).resolves.toBeNull();
  });

  it("lookup asks RxNav for a normalized match only and caches the answer", async () => {
    const urls: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      urls.push(String(input));
      return new Response(JSON.stringify({ idGroup: { rxnormId: ["314076"] } }), { status: 200 });
    }) as typeof fetch;
    const cache = new RxNavCache();

    expect(await cache.lookup("Lisinopril 10 MG Oral Tablet, 1 daily", fetchImpl)).toEqual({
      rxcui: "314076",
      term: "lisinopril 10 mg oral tablet",
    });
    expect(await cache.lookup("lisinopril 10 mg oral tablet", fetchImpl)).toEqual({
      rxcui: "314076",
      term: "lisinopril 10 mg oral tablet",
    });
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain("search=2");
    expect(urls[0]).toContain("name=lisinopril%2010%20mg%20oral%20tablet");
  });

  it("caches a miss as null", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ idGroup: {} }), { status: 200 })) as unknown as typeof fetch;
    const cache = new RxNavCache();
    expect(await cache.lookup("water pill", fetchImpl)).toBeNull();
    expect(cache.get("water pill")).toBeNull();
  });
});

describe("every recorded 200 snapshot", () => {
  const files = readdirSync(join(FIXTURES_DIR, "finchnode", "records")).filter((f) => f.endsWith(".json"));
  const snapshots = files
    .map((f) => ({ name: f.replace(/\.json$/, ""), recorded: loadRecorded(`records/${f.replace(/\.json$/, "")}`) }))
    .filter((s) => s.recorded.status === 200);

  it("found the record and behavior snapshots", () => {
    expect(snapshots.map((s) => s.name).sort()).toEqual([
      "patient-demo-001",
      "patient-demo-consent-partial",
      "patient-demo-messy-coding",
      "patient-demo-multi-source",
      "patient-demo-pediatric-asthma",
      "patient-demo-polypharmacy",
      "patient-demo-rate-limited",
      "patient-demo-source-unavailable",
      "patient-demo-sparse",
    ]);
  });

  it.each(snapshots.map((s) => [s.name, s.recorded.body] as const))("%s parses and normalizes", (name, body) => {
    const parsed = HealthRecordSchema.parse(body);
    const record = normalizeHealthRecord(parsed, { rxnav });
    expect(record.subject).toBe(name);
    // Also fine without an RxNav cache.
    expect(() => normalizeHealthRecord(parsed)).not.toThrow();
  });
});

describe("scenario: consent-partial", () => {
  it("sharedCategories is exactly medications and allergies", () => {
    const record = normalized("patient-demo-consent-partial");
    expect(record.sharedCategories).toEqual(["medications", "allergies"]);
    expect(record.labs).toEqual([]);
    expect(record.medications).toHaveLength(2);
  });

  it("a snapshot without receipts shares every category", () => {
    expect(normalized("patient-demo-polypharmacy").sharedCategories).toContain("labs");
  });
});

describe("scenario: source-unavailable", () => {
  const record = normalized("patient-demo-source-unavailable");

  it("is a partial sync", () => {
    expect(record.syncStatus).toBe("partial");
    expect(record.warnings.some((w) => w.code === "source_unavailable" && w.source === "quillhaven-medical")).toBe(true);
  });

  it("marks quillhaven-medical unavailable with its last sync, and keeps the other source", () => {
    const quill = record.sources.find((s) => s.system === "quillhaven-medical");
    expect(quill).toEqual({
      system: "quillhaven-medical",
      name: "Quillhaven Medical Group (Synthetic)",
      lastSyncedAt: "2026-08-15T09:00:00Z",
      available: false,
    });
    expect(toDay(quill?.lastSyncedAt)).toBe("2026-08-15");
    expect(record.sources.find((s) => s.system === "northstar-health")?.available).toBe(true);
  });

  it("still uses the data", () => {
    expect(record.medications.length).toBeGreaterThan(0);
    expect(record.labs.length).toBeGreaterThan(0);
  });
});

describe("scenario: multi-source-overlap", () => {
  const record = normalized("patient-demo-multi-source");

  it("merges levothyroxine (RxNorm 966221) from both sources into one medication", () => {
    const levo = record.medications.filter((m) => m.rxnorm === "966221");
    expect(levo).toHaveLength(1);
    expect(levo[0]?.provenance.map((p) => p.source).sort()).toEqual(["northstar-health", "quillhaven-medical"]);
    expect(levo[0]?.provenance.map((p) => p.recordId).sort()).toEqual([
      "rec_4dd7c60c03e996017c3ba18f",
      "rec_52a93a5ccc12e075b00f679f",
    ]);
    expect(levo[0]?.status).toBe("active");
    // The newer prescription wins for the displayed fields.
    expect(levo[0]?.startDate).toBe("2026-03-05");
    expect(record.medications).toHaveLength(3);
  });

  it("normalizes TSH m[IU]/L and u[IU]/mL to the same unit", () => {
    const tsh = record.labs.filter((m) => m.loinc === "3016-3");
    expect(tsh).toHaveLength(2);
    expect(new Set(tsh.map((m) => m.unit))).toEqual(new Set(["m[IU]/L"]));
    expect(tsh.map((m) => m.value)).toEqual([3.1, 3.4]);
    expect(tsh.map((m) => m.provenance[0]?.source)).toEqual(["northstar-health", "quillhaven-medical"]);
  });

  it("merges the shared condition and ignores the duplicate flu shot (immunizations aren't modeled)", () => {
    const hypo = record.conditions.filter((c) => c.name === "Hypothyroidism");
    expect(hypo).toHaveLength(1);
    expect(hypo[0]?.provenance.map((p) => p.source)).toEqual(["northstar-health", "quillhaven-medical"]);
    expect(record).not.toHaveProperty("immunizations");
  });

  it("lists both sources as available", () => {
    expect(record.sources.map((s) => [s.system, s.available])).toEqual([
      ["northstar-health", true],
      ["quillhaven-medical", true],
    ]);
  });
});

describe("scenario: messy-coding", () => {
  const record = normalized("patient-demo-messy-coding");
  const lab = (loinc: string) => record.labs.find((m) => m.loinc === loinc);

  it("keeps the free-text blood pressure pill with no RxNorm code", () => {
    const pill = record.medications.find((m) => m.name === "blood pressure pill, 1 daily");
    expect(pill).toBeDefined();
    expect(pill?.rxnorm).toBeUndefined();
    expect(pill?.rxnormFrom).toBeUndefined();
    expect(pill?.strength).toBeUndefined();
    expect(pill?.key.startsWith("name|")).toBe(true);
    expect(pill?.status).toBe("active");
  });

  it("keys free-text meds by the cleaned drug term, so schedule text doesn't split them", () => {
    const snapshot = loadSnapshot("patient-demo-messy-coding");
    const pill = snapshot.data.medications.find((m) => m.name === "blood pressure pill, 1 daily")!;
    const twoSources = {
      ...snapshot,
      data: {
        ...snapshot.data,
        medications: [pill, { ...pill, id: "rec_other", source: "quillhaven-medical", name: "Blood pressure pill" }],
      },
    };
    const merged = normalizeHealthRecord(twoSources, { rxnav }).medications;
    expect(merged).toHaveLength(1);
    expect(merged[0]!.key).toBe("name|blood pressure pill");
    expect(merged[0]!.provenance.map((p) => p.source).sort()).toEqual(["northstar-health", "quillhaven-medical"]);
  });

  it("keeps the coded meds and their source codes", () => {
    expect(record.medications.find((m) => m.rxnorm === "197361")).toMatchObject({ strength: "5 MG", rxnormFrom: "source" });
    // Undated, status unknown: still listed, not active.
    const simva = record.medications.find((m) => m.rxnorm === "312961");
    expect(simva).toMatchObject({ status: "unknown", startDate: undefined });
    expect(activeMedications(record).map((m) => m.rxnorm)).not.toContain("312961");
  });

  it("converts weight 168 [lb_av] to 76.2 kg", () => {
    const weight = latest(record.vitals, LOINC.bodyWeight);
    expect(weight).toMatchObject({ value: 76.2, unit: "kg", usable: true, date: "2026-05-12" });
  });

  it("converts glucose 6.1 mmol/L to 110 mg/dL under LOINC 2345-7, range included", () => {
    expect(lab(LOINC.glucoseMolar)).toBeUndefined();
    const glucose = lab(LOINC.glucoseMass);
    expect(glucose).toMatchObject({ value: 110, unit: "mg/dL", key: "loinc|2345-7", usable: true });
    expect(glucose?.referenceRange).toMatchObject({ low: 70, high: 101 });
  });

  it("marks the cancelled creatinine unusable with a reason", () => {
    const creatinine = lab(LOINC.creatinine);
    expect(creatinine).toMatchObject({ usable: false, value: undefined });
    expect(creatinine?.unusableReason).toBe("status cancelled");
    expect(series(record.labs, LOINC.creatinine)).toEqual([]);
  });

  it("keeps 'Negative' as text", () => {
    expect(lab("2887-8")).toMatchObject({ value: undefined, text: "Negative", usable: true });
  });

  it("treats hemoglobin range '0 - 17.5' as no low bound, high 17.5", () => {
    expect(lab("718-7")?.referenceRange).toMatchObject({ low: undefined, high: 17.5 });
  });

  it("does not crash on the 'fall 2024' flu shot or undated condition", () => {
    const cholesterol = record.conditions.find((c) => c.name === "high cholesterol");
    expect(cholesterol).toMatchObject({ onsetDate: undefined, key: "name|high cholesterol" });
    expect(cholesterol?.provenance[0]?.date).toBe("2026-05-12");
  });
});

describe("normalizeObservation edge cases", () => {
  const base = {
    id: "rec_000000000000000000000001",
    resourceType: "Observation",
    source: "northstar-health",
    codes: [{ system: "http://loinc.org", code: LOINC.potassium }],
    name: "Potassium",
    status: "final",
  };

  it("marks a reading with no date unusable", () => {
    const m = normalizeObservation(ObservationSchema.parse({ ...base, value: "4.1", unit: "mmol/L", date: "fall 2024" }));
    expect(m).toMatchObject({ usable: false, unusableReason: "no date", value: 4.1 });
  });

  it("marks a reading with no value unusable", () => {
    const m = normalizeObservation(ObservationSchema.parse({ ...base, value: null, date: "2026-07-14" }));
    expect(m).toMatchObject({ usable: false, unusableReason: "no value" });
  });

  it("accepts numeric values sent as numbers", () => {
    const m = normalizeObservation(ObservationSchema.parse({ ...base, value: 4.9, unit: "mmol/L", date: "2026-07-14" }));
    expect(m).toMatchObject({ usable: true, value: 4.9, text: undefined });
  });

  it("falls back to a name key when there is no LOINC code", () => {
    const m = normalizeObservation(ObservationSchema.parse({ ...base, codes: [], name: "  Home  BP ", value: "120", date: "2026-07-14" }));
    expect(m.key).toBe("name|home bp");
    expect(m.loinc).toBeUndefined();
  });
});

describe("scenario: sparse-record", () => {
  it("normalizes with empty lists", () => {
    const record = normalized("patient-demo-sparse");
    expect(record.medications).toEqual([]);
    expect(record.dispenses).toEqual([]);
    expect(record.labs).toEqual([]);
    expect(record.vitals).toEqual([]);
    expect(record.conditions).toEqual([]);
    expect(record.demographics.givenName).toBe("Jonah");
    expect(record.missingCategories).toContain("medications");
  });
});

describe("Harriet (patient-demo-polypharmacy)", () => {
  const record = normalized("patient-demo-polypharmacy");

  it("demographics and data as-of", () => {
    expect(record.demographics).toMatchObject({ givenName: "Harriet", birthDate: "1948-03-02" });
    expect(record.dataAsOf).toBe("2026-09-01");
    expect(ageOn(record.demographics.birthDate!, record.dataAsOf!)).toBe(78);
  });

  it("has 14 active medications, all coded by the source", () => {
    const active = activeMedications(record);
    expect(active).toHaveLength(14);
    expect(active.every((m) => m.rxnormFrom === "source")).toBe(true);
    expect(active.map((m) => m.rxnorm).sort()).toEqual(
      [
        "1364445", "866436", "313988", "314076", "617311", "861007", "966222",
        "198051", "198440", "312941", "856377", "198116", "199362", "243670",
      ].sort(),
    );
    expect(active.find((m) => m.rxnorm === "1364445")?.strength).toBe("5 MG");
  });

  it("has one dispense per drug, levothyroxine for 90 days", () => {
    expect(record.dispenses).toHaveLength(14);
    expect(record.dispenses.find((d) => d.medicationKey === "rxnorm|966222")?.daysSupply).toBe(90);
  });

  it("has 10 heart-rate readings between 65 and 91", () => {
    const hr = series(record.vitals, LOINC.heartRate);
    expect(hr).toHaveLength(10);
    const values = hr.map((m) => m.value!);
    expect(Math.min(...values)).toBe(65);
    expect(Math.max(...values)).toBe(91);
  });

  it("latest eGFR is 31 on 2026-07-14, falling", () => {
    expect(latest(record.labs, LOINC.egfr)).toMatchObject({ value: 31, date: "2026-07-14" });
    expect(series(record.labs, LOINC.egfr).map((m) => m.value)).toEqual([39, 36, 33, 31]);
  });

  it("latest potassium is 4.9 with range 3.5 to 5.1", () => {
    const k = latest(record.labs, LOINC.potassium);
    expect(k).toMatchObject({ value: 4.9, date: "2026-07-14" });
    expect(k?.referenceRange).toMatchObject({ low: 3.5, high: 5.1 });
  });

  it("latest weight is 70.5 kg on 2026-01-20", () => {
    expect(latest(record.vitals, LOINC.bodyWeight)).toMatchObject({ value: 70.5, unit: "kg", date: "2026-01-20" });
  });

  it("has 10 conditions", () => {
    expect(record.conditions).toHaveLength(10);
  });
});

describe("asOf: the record as it stood on the check-in date", () => {
  const multi = normalized("patient-demo-multi-source");
  const harriet = normalized("patient-demo-polypharmacy");

  it("drops labs, vitals, dispenses, medications and conditions dated after the check-in date", () => {
    const record = asOf(multi, "2025-12-31");
    expect(record.labs.map((m) => m.date)).toEqual(["2025-09-16", "2025-11-20", "2025-11-20"]);
    expect(record.labs.every((m) => m.date! <= "2025-12-31")).toBe(true);
    // Levothyroxine started in March 2026 at both sources, so it isn't on her list yet.
    expect(record.medications.map((m) => m.name)).toEqual(["sumatriptan 50 MG Oral Tablet", "ferrous sulfate 325 MG Oral Tablet"]);
    expect(asOf(multi, "2025-11-19").conditions.map((c) => c.name)).toEqual(["Hypothyroidism", "Migraine"]);
    expect(asOf(multi, "2025-11-20").conditions).toHaveLength(3);
  });

  it("on or after the last date nothing changes, and the input is never modified", () => {
    const before = structuredClone(harriet);
    expect(asOf(harriet, harriet.dataAsOf!)).toEqual(harriet);
    expect(asOf(multi, "2026-09-01")).toEqual(multi);
    asOf(harriet, "2020-01-01");
    expect(harriet).toEqual(before);
  });

  it("a medication merged from two sources keeps only the source records from before the check-in date", () => {
    const levo = asOf(multi, "2026-03-03").medications.find((m) => m.rxnorm === "966221")!;
    expect(levo.provenance.map((p) => p.recordId)).toEqual(["rec_52a93a5ccc12e075b00f679f"]);
    expect(levo.startDate).toBe("2026-03-02");
    expect(asOf(multi, "2026-03-01").medications.some((m) => m.rxnorm === "966221")).toBe(false);
  });

  it("keeps undated items: a missing date says nothing about when the record was made", () => {
    const [first] = harriet.medications;
    const undatedMed = { ...first!, startDate: undefined, provenance: first!.provenance.map((p) => ({ ...p, date: undefined })) };
    const undatedCondition = { ...harriet.conditions[0]!, onsetDate: undefined };
    const undatedDispense = { ...harriet.dispenses[0]!, date: undefined };
    const undatedLab = { ...harriet.labs[0]!, date: undefined, usable: false, unusableReason: "no date" };
    const record = asOf(
      { ...harriet, medications: [undatedMed], conditions: [undatedCondition], dispenses: [undatedDispense], labs: [undatedLab], vitals: [] },
      "2000-01-01",
    );
    expect(record.medications).toEqual([undatedMed]);
    expect(record.conditions).toEqual([undatedCondition]);
    expect(record.dispenses).toEqual([undatedDispense]);
    expect(record.labs).toEqual([undatedLab]);
  });

  it("keeps everything that isn't a dated record: demographics, sources, data as-of, shared categories", () => {
    const record = asOf(harriet, "2000-01-01");
    expect(record.medications).toEqual([]);
    expect(record.labs).toEqual([]);
    expect(record.vitals).toEqual([]);
    expect(record.dispenses).toEqual([]);
    expect(record.demographics).toEqual(harriet.demographics);
    expect(record.dataAsOf).toBe(harriet.dataAsOf);
    expect(record.sources).toEqual(harriet.sources);
    expect(record.sharedCategories).toEqual(harriet.sharedCategories);
  });
});
