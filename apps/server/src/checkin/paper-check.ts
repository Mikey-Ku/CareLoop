import { paperLineText, type ExtractedPaper, type PaperChange } from "../rules/paper-diff.ts";

// Hospital paper check, after the photo is read: what we read back to her to
// confirm before comparing anything with her medication list (R6).

export const PAPER_CONFIRM_BUTTONS: string[] = ["Yes, that's right", "No, something's off"];

const GROUPS: { change: PaperChange; label: string }[] = [
  { change: "stopped", label: "Stop" },
  { change: "new", label: "New" },
  { change: "changed", label: "Changed" },
  { change: "continue", label: "Continue" },
];

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** "2026-08-20" -> "August 20, 2026"; anything else is said as printed. */
function spokenDate(date: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const month = match ? MONTHS[Number(match[2]) - 1] : undefined;
  return match && month ? `${month} ${Number(match[3])}, ${match[1]}` : date;
}

/** Drop a trailing "(Synthetic)" style label so the organization reads naturally aloud. */
function spokenOrganization(organization: string): string {
  return organization.replace(/\s*\([^)]*\)\s*$/, "").trim() || organization;
}

/** "Here's what I read on your discharge papers from Northstar Health System, dated August 20, 2026: Stop: aspirin 81 mg. ..." */
export function paperReadback(paper: ExtractedPaper): string {
  const what = paper.kind === "discharge" ? "your discharge papers" : "your visit summary";
  const from = paper.organization ? ` from ${spokenOrganization(paper.organization)}` : "";
  const dated = paper.date ? `, dated ${spokenDate(paper.date)}` : "";
  const intro = `Here's what I read on ${what}${from}${dated}:`;

  if (paper.medications.length === 0) return `${intro} I couldn't find any medicines on them. Is that right?`;

  const groups = GROUPS.flatMap(({ change, label }) => {
    const lines = paper.medications.filter((m) => m.change === change).map(paperLineText);
    return lines.length > 0 ? [`${label}: ${lines.join(", ")}.`] : [];
  });
  return `${intro} ${groups.join(" ")} Did I read that right?`;
}
