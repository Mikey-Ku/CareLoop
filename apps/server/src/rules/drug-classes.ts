import type { Medication } from "../finchnode/normalize.ts";

// Drug classes by ingredient name. Matching on the ingredient (not the RxNorm
// product code) means any strength or brand of the same drug is caught.

export const DRUG_CLASSES = {
  anticoagulant: ["apixaban", "rivaroxaban", "dabigatran", "edoxaban", "warfarin"],
  aspirin: ["aspirin"],
  ssri: ["sertraline", "fluoxetine", "citalopram", "escitalopram", "paroxetine", "fluvoxamine"],
  aceInhibitor: [
    "lisinopril",
    "enalapril",
    "ramipril",
    "benazepril",
    "captopril",
    "quinapril",
    "fosinopril",
    "perindopril",
    "trandolapril",
    "moexipril",
  ],
  potassiumSupplement: ["potassium chloride", "potassium citrate", "potassium bicarbonate"],
  metformin: ["metformin"],
  betaBlocker: ["metoprolol", "atenolol", "carvedilol", "bisoprolol", "propranolol", "nebivolol", "labetalol"],
  loopDiuretic: ["furosemide", "bumetanide", "torsemide"],
} as const;

export type DrugClass = keyof typeof DRUG_CLASSES;

export function inClass(med: Medication, drugClass: DrugClass): boolean {
  const name = med.name.toLowerCase();
  return DRUG_CLASSES[drugClass].some((ingredient) => new RegExp(`\\b${ingredient}\\b`).test(name));
}

export function medsInClass(meds: Medication[], drugClass: DrugClass): Medication[] {
  return meds.filter((m) => inClass(m, drugClass));
}

/** The ingredient that put a medication in a class, for plain-language messages. */
export function ingredientOf(med: Medication, drugClass: DrugClass): string {
  const name = med.name.toLowerCase();
  return DRUG_CLASSES[drugClass].find((i) => new RegExp(`\\b${i}\\b`).test(name)) ?? med.name;
}
