import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PAPER_CONFIRM_BUTTONS, paperReadback } from "../src/checkin/paper-check.ts";
import { FIXTURES_DIR, loadRxNavCache, loadSnapshot } from "../src/finchnode/fixtures.ts";
import { normalizeHealthRecord, strengthFromName, type Medication, type PatientRecord } from "../src/finchnode/normalize.ts";
import { fingerprint } from "../src/rules/index.ts";
import {
  diffPaper,
  ingredientTokens,
  sameIngredient,
  sameStrength,
  type ExtractedPaper,
  type PaperMedication,
} from "../src/rules/paper-diff.ts";

const PAPERS = join(FIXTURES_DIR, "papers");
const BANNER = "SYNTHETIC DEMO DOCUMENT, NOT A REAL MEDICAL RECORD";
const loadPaper = (): ExtractedPaper =>
  JSON.parse(readFileSync(join(PAPERS, "harriet-discharge.extracted.json"), "utf8")) as ExtractedPaper;

// ---------- Tiny record and paper builders ----------

let seq = 0;
function med(name: string, status = "active"): Medication {
  const recordId = `rec_${(++seq).toString(16).padStart(24, "0")}`;
  return {
    key: `name|${name.toLowerCase()}`,
    name,
    rxnorm: undefined,
    rxnormFrom: undefined,
    strength: strengthFromName(name),
    sig: undefined,
    status,
    startDate: "2025-01-01",
    provenance: [{ recordId, source: "test-clinic", sourceRecordId: undefined, date: "2025-01-01" }],
  };
}

function recordWith(...medications: Medication[]): PatientRecord {
  return {
    subject: "test-patient",
    demographics: { recordId: undefined, name: "Test Patient", givenName: "Test", birthDate: "1948-03-02", gender: undefined },
    medications,
    dispenses: [],
    labs: [],
    vitals: [],
    conditions: [],
    sources: [],
    syncStatus: "complete",
    dataAsOf: "2026-09-01",
    sharedCategories: [],
    missingCategories: [],
    warnings: [],
  };
}

function paperWith(...medications: PaperMedication[]): ExtractedPaper {
  return { kind: "discharge", organization: "Test Hospital", date: "2026-08-20", medications, synthetic: true };
}

const line = (name: string, strength: string | undefined, change: PaperMedication["change"]): PaperMedication =>
  strength === undefined ? { name, change } : { name, strength, change };

// ---------- Answer key ----------

describe("R6 answer key for Harriet", () => {
  const key = JSON.parse(readFileSync(join(PAPERS, "answer-key.json"), "utf8")) as {
    patient: string;
    paper: string;
    result: {
      ruleId: string;
      status: string;
      severity: string;
      details: { discrepancies: unknown[] };
      evidenceResourceIds: string[];
    };
  };
  const record = normalizeHealthRecord(loadSnapshot(key.patient), { rxnav: loadRxNavCache() });
  const paper = JSON.parse(readFileSync(join(FIXTURES_DIR, key.paper), "utf8")) as ExtractedPaper;
  const result = diffPaper(record, paper);

  it("matches the written answer key", () => {
    expect(result.ruleId).toBe(key.result.ruleId);
    expect(result.status).toBe(key.result.status);
    expect(result.severity).toBe(key.result.severity);
    expect(result.details.discrepancies).toEqual(key.result.details.discrepancies);
    expect(result.evidence.map((e) => e.resourceId)).toEqual(key.result.evidenceResourceIds);
  });

  it("points the paper evidence at the paper line, its organization and date", () => {
    const paperEvidence = result.evidence.find((e) => e.resourceId.startsWith("paper:"));
    expect(paperEvidence).toEqual({
      resourceId: "paper:0",
      source: "Northstar Health System (Synthetic)",
      date: "2026-08-20",
      value: "Stop: aspirin 81 mg",
    });
    expect(result.evidence[0]).toMatchObject({ source: "northstar-health", value: "aspirin 81 MG Oral Tablet" });
  });

  it("words it as a question for the doctor, never an instruction to stop", () => {
    expect(result.message).toMatch(/ask your doctor or pharmacist/i);
    expect(result.message).toMatch(/aspirin/);
    expect(result.message).not.toMatch(/stop taking/i);
    expect(result.message).not.toMatch(/\u2014/);
  });

  it("the paper fixture is synthetic, a discharge and has exactly one non-continue line", () => {
    expect(paper.synthetic).toBe(true);
    expect(paper.kind).toBe("discharge");
    expect(paper.medications).toHaveLength(14);
    expect(paper.medications.filter((m) => m.change !== "continue")).toEqual([
      expect.objectContaining({ name: "aspirin", strength: "81 mg", change: "stopped" }),
    ]);
  });

  it("gives a stable fingerprint for the flag lifecycle", () => {
    expect(fingerprint(diffPaper(record, paper))).toBe(fingerprint(result));
  });
});

// ---------- Each discrepancy kind ----------

describe("diffPaper", () => {
  it("flags a drug the paper stopped that the record still has active", () => {
    const aspirin = med("aspirin 81 MG Oral Tablet");
    const result = diffPaper(recordWith(aspirin, med("apixaban 5 MG Oral Tablet")), paperWith(line("aspirin", "81 mg", "stopped")));
    expect(result.status).toBe("flag");
    expect(result.severity).toBe("medium");
    expect(result.details.discrepancies).toEqual([
      { kind: "stopped_but_active", paperName: "aspirin", recordName: aspirin.name, paperStrength: "81 mg", recordStrength: "81 MG" },
    ]);
    expect(result.evidence.map((e) => e.resourceId)).toEqual([aspirin.provenance[0]!.recordId, "paper:0"]);
  });

  it("does not flag a stopped drug the record already has stopped or never had", () => {
    const result = diffPaper(
      recordWith(med("aspirin 81 MG Oral Tablet", "stopped"), med("apixaban 5 MG Oral Tablet")),
      paperWith(line("aspirin", "81 mg", "stopped"), line("warfarin", "5 mg", "stopped")),
    );
    expect(result.status).toBe("checked");
    expect(result.details.discrepancies).toEqual([]);
  });

  it("flags a new drug on the paper that is not in the record", () => {
    const result = diffPaper(recordWith(med("apixaban 5 MG Oral Tablet")), paperWith(line("clopidogrel", "75 mg", "new")));
    expect(result.status).toBe("flag");
    expect(result.details.discrepancies).toEqual([{ kind: "new_not_in_record", paperName: "clopidogrel", paperStrength: "75 mg" }]);
    expect(result.evidence).toEqual([{ resourceId: "paper:0", source: "Test Hospital", date: "2026-08-20", value: "New: clopidogrel 75 mg" }]);
    expect(result.message).toMatch(/clopidogrel 75 mg, which isn't on your medication list/);
  });

  it("flags a continued drug that is only in the record as stopped", () => {
    const result = diffPaper(recordWith(med("sertraline 50 MG Oral Tablet", "stopped")), paperWith(line("sertraline", "50 mg", "continue")));
    expect(result.details.discrepancies).toEqual([{ kind: "new_not_in_record", paperName: "sertraline", paperStrength: "50 mg" }]);
  });

  it("flags a dose that differs between paper and record", () => {
    const apixaban = med("apixaban 5 MG Oral Tablet");
    const result = diffPaper(recordWith(apixaban), paperWith(line("apixaban", "2.5 mg", "changed")));
    expect(result.status).toBe("flag");
    expect(result.details.discrepancies).toEqual([
      { kind: "dose_differs", paperName: "apixaban", recordName: apixaban.name, paperStrength: "2.5 mg", recordStrength: "5 MG" },
    ]);
    expect(result.message).toMatch(/apixaban 2\.5 mg, but your medication list shows 5 mg/);
  });

  it("reads a strength printed inside the paper's medication name", () => {
    const result = diffPaper(recordWith(med("lisinopril 10 MG Oral Tablet")), paperWith(line("lisinopril 20 mg", undefined, "continue")));
    expect(result.details.discrepancies).toEqual([
      expect.objectContaining({ kind: "dose_differs", paperStrength: "20 mg", recordStrength: "10 MG" }),
    ]);
  });

  it("flags each discrepancy, with evidence for each, and counts them in the message", () => {
    const result = diffPaper(
      recordWith(med("aspirin 81 MG Oral Tablet"), med("furosemide 40 MG Oral Tablet")),
      paperWith(line("aspirin", "81 mg", "stopped"), line("furosemide", "20 mg", "changed"), line("clopidogrel", "75 mg", "new")),
    );
    expect((result.details.discrepancies as { kind: string }[]).map((d) => d.kind)).toEqual([
      "stopped_but_active",
      "dose_differs",
      "new_not_in_record",
    ]);
    expect(result.evidence.filter((e) => e.resourceId.startsWith("paper:")).map((e) => e.resourceId)).toEqual(["paper:0", "paper:1", "paper:2"]);
    expect(result.message).toMatch(/in 3 places/);
  });

  it("a paper with only matching continue lines is checked", () => {
    const result = diffPaper(
      recordWith(med("apixaban 5 MG Oral Tablet"), med("24 HR metoprolol succinate 50 MG Extended Release Oral Tablet"), med("aspirin 81 MG Oral Tablet")),
      paperWith(line("apixaban", "5 mg", "continue"), line("metoprolol succinate ER", "50 mg", "continue")),
    );
    expect(result.status).toBe("checked");
    expect(result.severity).toBeUndefined();
    expect(result.details.discrepancies).toEqual([]);
  });

  it("a record medication missing from the paper is not a discrepancy", () => {
    const result = diffPaper(recordWith(med("apixaban 5 MG Oral Tablet"), med("aspirin 81 MG Oral Tablet")), paperWith(line("apixaban", "5 mg", "continue")));
    expect(result.status).toBe("checked");
  });

  it("is skipped when no medications were read", () => {
    expect(diffPaper(recordWith(med("apixaban 5 MG Oral Tablet")), paperWith()).status).toBe("skipped");
  });

  it("matches by whole-word ingredient, not substring", () => {
    // "aspirin" must not match a record drug that only contains it inside another word.
    const result = diffPaper(recordWith(med("aspirinate 10 MG Oral Tablet")), paperWith(line("aspirin", "81 mg", "stopped")));
    expect(result.status).toBe("checked");
    expect(sameIngredient("metformin", "metformin hydrochloride 500 MG Oral Tablet")).toBe(true);
    expect(sameIngredient("potassium chloride ER", "potassium chloride 20 MEQ Extended Release Oral Tablet")).toBe(true);
    expect(sameIngredient("potassium citrate", "potassium chloride 20 MEQ Extended Release Oral Tablet")).toBe(false);
    expect(sameIngredient("cholecalciferol (vitamin D3)", "cholecalciferol 0.025 MG Oral Tablet")).toBe(true);
    expect(ingredientTokens("24 HR metoprolol succinate 50 MG Extended Release Oral Tablet")).toEqual(["metoprolol", "succinate"]);
  });
});

// ---------- Dose normalization ----------

describe("sameStrength", () => {
  it("normalizes case and spacing", () => {
    expect(sameStrength("81 MG", "81 mg")).toBe(true);
    expect(sameStrength("81mg", "81 MG")).toBe(true);
  });

  it("sees a different dose", () => {
    expect(sameStrength("5 MG", "2.5 mg")).toBe(false);
  });

  it("converts mcg and g to mg", () => {
    expect(sameStrength("75 mcg", "0.075 MG")).toBe(true);
    expect(sameStrength("25 mcg", "0.025 MG")).toBe(true);
    expect(sameStrength("1 g", "1000 mg")).toBe(true);
  });

  it("can't compare units that don't convert, or a missing strength", () => {
    expect(sameStrength("20 mEq", "20 MEQ")).toBe(true);
    expect(sameStrength("20 mEq", "1500 mg")).toBeUndefined();
    expect(sameStrength(undefined, "5 MG")).toBeUndefined();
  });

  it("with a check-in date, a medication that starts after it isn't on her list yet", () => {
    const later = { ...med("clopidogrel 75 MG Oral Tablet"), startDate: "2026-09-10" };
    later.provenance = later.provenance.map((p) => ({ ...p, date: "2026-09-10" }));
    const record = recordWith(med("apixaban 5 MG Oral Tablet"), later);
    const paper = paperWith(line("clopidogrel", "75 mg", "new"));
    expect(diffPaper(record, paper).status).toBe("checked");
    expect(diffPaper(record, paper, "2026-09-10").status).toBe("checked");
    const before = diffPaper(record, paper, "2026-09-01");
    expect(before.status).toBe("flag");
    expect(before.details.discrepancies).toEqual([{ kind: "new_not_in_record", paperName: "clopidogrel", paperStrength: "75 mg" }]);
  });

  it("a strength the paper leaves out is not a dose discrepancy", () => {
    const result = diffPaper(recordWith(med("apixaban 5 MG Oral Tablet")), paperWith(line("apixaban", undefined, "continue")));
    expect(result.status).toBe("checked");
  });
});

// ---------- Read-back ----------

describe("paperReadback", () => {
  const text = paperReadback(loadPaper());

  it("names the organization and spoken date, grouped by change, stop first", () => {
    expect(text.startsWith("Here's what I read on your discharge papers from Northstar Health System, dated August 20, 2026:")).toBe(true);
    expect(text).toContain("Stop: aspirin 81 mg.");
    expect(text).toContain("Continue: apixaban 5 mg, metoprolol succinate ER 50 mg,");
    expect(text.indexOf("Stop:")).toBeLessThan(text.indexOf("Continue:"));
    expect(text).not.toContain("New:");
    expect(text).not.toContain("Changed:");
  });

  it("ends with a yes/no question and has no em or en dashes", () => {
    expect(text.trim().endsWith("?")).toBe(true);
    expect(text).not.toMatch(/[\u2013\u2014]/);
  });

  it("groups new and changed lines", () => {
    const readback = paperReadback({
      kind: "visit_summary",
      medications: [line("apixaban", "2.5 mg", "changed"), line("clopidogrel", "75 mg", "new"), line("aspirin", "81 mg", "stopped")],
      synthetic: true,
    });
    expect(readback).toBe("Here's what I read on your visit summary: Stop: aspirin 81 mg. New: clopidogrel 75 mg. Changed: apixaban 2.5 mg. Did I read that right?");
  });

  it("offers yes and no buttons", () => {
    expect(PAPER_CONFIRM_BUTTONS).toEqual(["Yes, that's right", "No, something's off"]);
  });
});

// ---------- Printable sheet ----------

describe("harriet-discharge.html", () => {
  const html = readFileSync(join(PAPERS, "harriet-discharge.html"), "utf8");

  it("carries the synthetic banner at the top and the bottom", () => {
    expect(html.split(BANNER).length - 1).toBe(2);
  });

  it("lists every medication, strength and change from the extracted JSON", () => {
    const rows = [...html.matchAll(/<tr[^>]*><td class="med">([^<]+)<\/td><td class="dose">([^<]+)<\/td><td>[^<]*<\/td><td class="change">([^<]+)<\/td><\/tr>/g)].map(
      (m) => ({ name: m[1], strength: m[2], change: m[3] }),
    );
    const changeWord = { stopped: "STOP", continue: "CONTINUE", new: "NEW", changed: "CHANGED" } as const;
    expect(rows).toEqual(loadPaper().medications.map((m) => ({ name: m.name, strength: m.strength, change: changeWord[m.change] })));
  });

  it("shows the synthetic patient and organization, and no em dashes", () => {
    expect(html).toContain("Harriet Lindqvist");
    expect(html).toContain("SYN-20781");
    expect(html).toContain("Northstar Health System (Synthetic)");
    expect(html).toContain("2026-08-20");
    expect(html).not.toMatch(/[\u2014]|&mdash;/);
  });
});
