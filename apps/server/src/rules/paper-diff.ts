import { activeMedications, asOf, type Medication, type PatientRecord } from "../finchnode/normalize.ts";
import { cleanDrugTerm } from "../finchnode/rxnav.ts";
import type { Evidence, RuleResult } from "./index.ts";

// R6: hospital paper check. Compares the medication list read off her
// discharge or visit papers (after she confirmed the read-back) with her
// FinchNode medication list. See docs/DESIGN.md "Rules engine".

export type PaperChange = "continue" | "new" | "stopped" | "changed";

export type PaperMedication = {
  name: string;
  /** As printed, such as "81 mg" or "20 mEq". Falls back to a strength inside `name`. */
  strength?: string;
  instructions?: string;
  change: PaperChange;
};

/** What Claude vision reads off a photo of her papers, confirmed by her before any comparison. */
export type ExtractedPaper = {
  kind: "discharge" | "visit_summary";
  organization?: string;
  /** YYYY-MM-DD as printed on the papers. */
  date?: string;
  medications: PaperMedication[];
  synthetic: boolean;
};

export type DiscrepancyKind = "stopped_but_active" | "new_not_in_record" | "dose_differs";

export type Discrepancy = {
  kind: DiscrepancyKind;
  paperName: string;
  recordName?: string;
  paperStrength?: string;
  recordStrength?: string;
};

// ---------- Matching by ingredient ----------

const STRENGTH = /(\d+(?:\.\d+)?)\s*(mg|mcg|µg|ug|meq|g|units?|unt|iu|ml)\b/i;

/** Dose-form words that are not part of the ingredient name. */
const FORM_WORDS = new Set([
  "er", "xr", "xl", "sr", "dr", "ec", "cr", "hr", "extended", "delayed", "release", "oral", "tablet", "tablets",
  "tab", "capsule", "capsules", "cap", "solution", "suspension", "chewable", "by", "mouth",
]);

/** "24 HR metoprolol succinate 50 MG Extended Release Oral Tablet" -> ["metoprolol", "succinate"]. */
export function ingredientTokens(name: string): string[] {
  const cleaned = cleanDrugTerm(name).replace(new RegExp(STRENGTH.source, "gi"), " ");
  return cleaned
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0 && !/^\d+$/.test(t) && !FORM_WORDS.has(t));
}

/** Same ingredient when every word of one name's ingredient appears as a whole word in the other's. */
export function sameIngredient(a: string, b: string): boolean {
  const ta = ingredientTokens(a);
  const tb = ingredientTokens(b);
  if (ta.length === 0 || tb.length === 0) return false;
  const [shorter, longer] = ta.length <= tb.length ? [ta, new Set(tb)] : [tb, new Set(ta)];
  return shorter.every((t) => longer.has(t));
}

// ---------- Strength ----------

export type ParsedStrength = { value: number; unit: "mg" | "meq" | "unit" | "ml" };

/** "5 MG" -> 5 mg; "75 mcg" -> 0.075 mg; "1 g" -> 1000 mg; "20 mEq" -> 20 meq. */
export function parseStrength(text: string | undefined): ParsedStrength | undefined {
  if (!text) return undefined;
  const match = STRENGTH.exec(text);
  if (!match) return undefined;
  const value = Number(match[1]);
  const unit = match[2]!.toLowerCase();
  if (unit === "mg") return { value, unit: "mg" };
  if (unit === "g") return { value: value * 1000, unit: "mg" };
  if (unit === "mcg" || unit === "ug" || unit === "µg") return { value: value / 1000, unit: "mg" };
  if (unit === "meq") return { value, unit: "meq" };
  if (unit === "ml") return { value, unit: "ml" };
  return { value, unit: "unit" };
}

/**
 * true: same strength, false: different, undefined: can't compare
 * (a strength missing, or units that don't convert, like mEq against mg).
 */
export function sameStrength(a: string | undefined, b: string | undefined): boolean | undefined {
  const pa = parseStrength(a);
  const pb = parseStrength(b);
  if (!pa || !pb || pa.unit !== pb.unit) return undefined;
  return Math.abs(pa.value - pb.value) <= 1e-9 * Math.max(1, Math.abs(pa.value), Math.abs(pb.value));
}

// ---------- The rule ----------

const CHANGE_LABEL: Record<PaperChange, string> = { stopped: "Stop", new: "New", changed: "Changed", continue: "Continue" };

export function paperStrength(line: PaperMedication): string | undefined {
  if (line.strength?.trim()) return line.strength.trim();
  const match = STRENGTH.exec(line.name);
  return match ? match[0] : undefined;
}

/** "aspirin" + "81 mg" -> "aspirin 81 mg"; doesn't repeat a strength already in the name. */
export function paperLineText(line: PaperMedication): string {
  const strength = line.strength?.trim();
  return strength && !line.name.toLowerCase().includes(strength.toLowerCase()) ? `${line.name} ${strength}` : line.name;
}

function medEvidence(med: Medication): Evidence[] {
  return med.provenance.map((p) => ({ resourceId: p.recordId, source: p.source, date: p.date, value: med.name }));
}

function paperEvidence(paper: ExtractedPaper, line: PaperMedication, index: number): Evidence {
  return {
    resourceId: `paper:${index}`,
    source: paper.organization ?? "paper",
    date: paper.date,
    value: `${CHANGE_LABEL[line.change]}: ${paperLineText(line)}`,
  };
}

function describeDiscrepancy(d: Discrepancy, plural: boolean): string {
  switch (d.kind) {
    case "stopped_but_active":
      return `${plural ? "they say" : "it says"} to stop ${d.paperName}${d.paperStrength ? ` ${d.paperStrength}` : ""}, but your medication list still shows it as active`;
    case "new_not_in_record":
      return `${plural ? "they list" : "it lists"} ${d.paperName}${d.paperStrength ? ` ${d.paperStrength}` : ""}, which isn't on your medication list`;
    case "dose_differs":
      return `${plural ? "they list" : "it lists"} ${d.paperName} ${d.paperStrength}, but your medication list shows ${d.recordStrength ? strengthWords(d.recordStrength) : "a different strength"}`;
  }
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** "2026-08-20" -> "August 20, 2026"; anything else is said as printed. */
export function spokenDate(date: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const month = match ? MONTHS[Number(match[2]) - 1] : undefined;
  return match && month ? `${month} ${Number(match[3])}, ${match[1]}` : date;
}

/** Drop a trailing "(Synthetic)" style label so the organization reads naturally aloud. */
export function spokenOrganization(organization: string): string {
  return organization.replace(/\s*\([^)]*\)\s*$/, "").trim() || organization;
}

/** "81 MG" -> "81 mg", as her reminders write it. */
function strengthWords(strength: string): string {
  return strength.replace(/\b(MG|MCG|ML|G)\b/g, (u) => u.toLowerCase()).replace(/\bMEQ\b/gi, "mEq");
}

/** "Your discharge papers from Northstar Health System dated August 20, 2026" and the verb that agrees with it. */
function papersPhrase(paper: ExtractedPaper): { subject: string; plural: boolean } {
  const what = paper.kind === "discharge" ? "discharge papers" : "visit summary";
  const from = paper.organization ? ` from ${spokenOrganization(paper.organization)}` : "";
  const dated = paper.date ? ` dated ${spokenDate(paper.date)}` : "";
  return { subject: `Your ${what}${from}${dated}`, plural: paper.kind === "discharge" };
}

/**
 * R6: flag each of (a) paper says stopped but the record has it active, (b) a drug on
 * the paper (new, continued or changed) with no active match in the record, (c) a dose
 * that differs between paper and record. A record medication missing from the paper is
 * not a discrepancy: discharge papers often list only what changed.
 *
 * With `checkinDate`, the record is compared as it stood on that day (see `asOf`):
 * a medication that starts after the check-in date isn't on her list yet.
 */
export function diffPaper(record: PatientRecord, paper: ExtractedPaper, checkinDate?: string): RuleResult {
  const base = { ruleId: "R6" as const, severity: undefined };
  if (paper.medications.length === 0)
    return { ...base, status: "skipped", message: "No medications were read from the papers.", evidence: [], details: { discrepancies: [] } };

  const active = activeMedications(checkinDate ? asOf(record, checkinDate) : record);
  const discrepancies: Discrepancy[] = [];
  const evidence: Evidence[] = [];

  paper.medications.forEach((line, index) => {
    const matches = active.filter((m) => sameIngredient(line.name, m.name));
    const strength = paperStrength(line);
    const found = (d: Discrepancy, meds: Medication[]) => {
      discrepancies.push(d);
      evidence.push(...meds.flatMap(medEvidence), paperEvidence(paper, line, index));
    };

    if (line.change === "stopped") {
      const med = matches[0];
      if (med)
        found(
          { kind: "stopped_but_active", paperName: line.name, recordName: med.name, paperStrength: strength, recordStrength: med.strength },
          matches,
        );
      return;
    }
    if (matches.length === 0) {
      found({ kind: "new_not_in_record", paperName: line.name, paperStrength: strength }, []);
      return;
    }
    const comparisons = matches.map((m) => sameStrength(strength, m.strength));
    // Any matching record medication with the same strength settles it; so does a strength we can't compare.
    if (comparisons.some((c) => c !== false)) return;
    const med = matches[0]!;
    found(
      { kind: "dose_differs", paperName: line.name, recordName: med.name, paperStrength: strength, recordStrength: med.strength },
      matches,
    );
  });

  const details = {
    discrepancies: discrepancies.map((d) => Object.fromEntries(Object.entries(d).filter(([, v]) => v !== undefined))),
    paper: { kind: paper.kind, organization: paper.organization, date: paper.date, lines: paper.medications.length },
  };
  const { subject, plural } = papersPhrase(paper);
  if (discrepancies.length === 0)
    return {
      ...base,
      status: "checked",
      message: `${subject} ${plural ? "match" : "matches"} your medication list.`,
      evidence: [],
      details,
    };

  const sentences = discrepancies.map((d) => `${describeDiscrepancy(d, plural)}.`);
  const message = `${subject} ${plural ? "don't" : "doesn't"} match your medication list in ${discrepancies.length === 1 ? "one place" : `${discrepancies.length} places`}: ${sentences.join(" Also, ")} Please ask your doctor or pharmacist which is right.`;
  return { ...base, status: "flag", severity: "medium", message, evidence, details };
}
