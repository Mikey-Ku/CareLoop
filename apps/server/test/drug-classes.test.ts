import { describe, expect, it } from "vitest";
import type { Medication } from "../src/finchnode/normalize.ts";
import { DRUG_CLASSES, inClass, ingredientOf, medsInClass, type DrugClass } from "../src/rules/drug-classes.ts";

const med = (name: string): Medication => ({
  key: `name|${name.toLowerCase()}`,
  name,
  rxnorm: undefined,
  rxnormFrom: undefined,
  strength: undefined,
  sig: undefined,
  status: "active",
  startDate: undefined,
  provenance: [],
});

// Harriet's medication names as FinchNode sends them, with the class each should land in.
const HARRIET: [string, DrugClass | undefined][] = [
  ["apixaban 5 MG Oral Tablet", "anticoagulant"],
  ["24 HR metoprolol succinate 50 MG Extended Release Oral Tablet", "betaBlocker"],
  ["furosemide 40 MG Oral Tablet", "loopDiuretic"],
  ["lisinopril 10 MG Oral Tablet", "aceInhibitor"],
  ["atorvastatin 40 MG Oral Tablet", undefined],
  ["metformin hydrochloride 500 MG Oral Tablet", "metformin"],
  ["levothyroxine sodium 0.075 MG Oral Tablet", undefined],
  ["omeprazole 20 MG Delayed Release Oral Capsule", undefined],
  ["acetaminophen 500 MG Oral Tablet", undefined],
  ["sertraline 50 MG Oral Tablet", "ssri"],
  ["trazodone hydrochloride 50 MG Oral Tablet", undefined],
  ["potassium chloride 20 MEQ Extended Release Oral Tablet", "potassiumSupplement"],
  ["cholecalciferol 0.025 MG Oral Tablet", undefined],
  ["aspirin 81 MG Oral Tablet", "aspirin"],
];
const CLASSES = Object.keys(DRUG_CLASSES) as DrugClass[];

describe("drug classes", () => {
  for (const [name, expected] of HARRIET) {
    it(`${name} -> ${expected ?? "no class"}`, () => {
      expect(CLASSES.filter((c) => inClass(med(name), c))).toEqual(expected ? [expected] : []);
    });
  }

  it("matches regardless of case", () => {
    expect(inClass(med("APIXABAN 5 MG"), "anticoagulant")).toBe(true);
    expect(inClass(med("Eliquis (Apixaban) 2.5 mg"), "anticoagulant")).toBe(true);
  });

  it("matches whole words only", () => {
    expect(inClass(med("losartan potassium 50 MG Oral Tablet"), "potassiumSupplement")).toBe(false);
    expect(inClass(med("escitalopram 10 MG Oral Tablet"), "ssri")).toBe(true);
    expect(ingredientOf(med("escitalopram 10 MG Oral Tablet"), "ssri")).toBe("escitalopram");
  });

  it("medsInClass keeps only members, in order", () => {
    const meds = HARRIET.map(([n]) => med(n));
    expect(medsInClass(meds, "anticoagulant").map((m) => m.name)).toEqual(["apixaban 5 MG Oral Tablet"]);
    expect(medsInClass(meds, "ssri").map((m) => ingredientOf(m, "ssri"))).toEqual(["sertraline"]);
    expect(medsInClass([], "aspirin")).toEqual([]);
  });

  it("ingredientOf names the ingredient, or falls back to the full name", () => {
    expect(ingredientOf(med("potassium chloride 20 MEQ Extended Release Oral Tablet"), "potassiumSupplement")).toBe("potassium chloride");
    expect(ingredientOf(med("metformin hydrochloride 500 MG Oral Tablet"), "metformin")).toBe("metformin");
    expect(ingredientOf(med("atorvastatin 40 MG Oral Tablet"), "aspirin")).toBe("atorvastatin 40 MG Oral Tablet");
  });

  it("free-text names from messy records still classify", () => {
    expect(inClass(med("lisinopril 10 mg, 1 daily"), "aceInhibitor")).toBe(true);
    expect(inClass(med("Metformin ER 500mg"), "metformin")).toBe(true);
  });
});
