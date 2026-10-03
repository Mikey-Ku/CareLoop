// Every number a rule uses lives here, with where it came from.
// Don't add a threshold that isn't in docs/DESIGN.md; add a config value and ask the team.

export type RulesConfig = {
  /** R1: FDA metformin safety communication. Below this eGFR, reassess. */
  metforminReassessEgfr: number;
  /** R1: below this eGFR, metformin is contraindicated. */
  metforminContraindicatedEgfr: number;
  /** R2: Eliquis label dose-reduction criteria (two or more means 2.5 mg twice daily). */
  apixabanAgeYears: number;
  apixabanWeightKg: number;
  apixabanCreatinineMgDl: number;
  apixabanCriteriaForReduction: number;
  /** R4: "top quarter of its reference range" (DESIGN.md, demo heuristic the team confirms). */
  potassiumTopFraction: number;
  /**
   * R5: days allowed past a fill's days supply before a refill counts as late.
   * 7 days, confirmed by the team 2026-10-03.
   */
  refillGraceDays: number;
};

export const DEFAULT_RULES_CONFIG: RulesConfig = {
  metforminReassessEgfr: 45,
  metforminContraindicatedEgfr: 30,
  apixabanAgeYears: 80,
  apixabanWeightKg: 60,
  apixabanCreatinineMgDl: 1.5,
  apixabanCriteriaForReduction: 2,
  potassiumTopFraction: 0.25,
  refillGraceDays: 7,
};
