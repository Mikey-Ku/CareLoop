import { DOCTOR_RULE_LABELS } from "../care/copy.ts";
import { LEVEL_WORDS, type CheckinOutcome } from "../care/facts.ts";
import type { Evidence } from "../rules/index.ts";
import type { Discrepancy } from "../rules/paper-diff.ts";
import type { DoctorReport, ReportDose, ReportSymptom } from "./build.ts";
import { andList } from "../text.ts";

// Two printable pages (US letter) for her doctor, from a DoctorReport. Page 1 stands alone: what was
// collected this week (counts and where each came from), a plain "in brief", the day-by-day table, the
// rule flags for review (never an assessment: we make none), what she reported and her questions.
// Page 2 is the reference detail: camera vitals, labs from her record, a reconciliation-style medication
// table, the problem list with codes, the evidence behind each flag and where the data comes from.
//
// Documentation conventions: two patient identifiers (name, date of birth) plus the record id;
// dates as "Oct 3, 2026"; 24-hour times with her time zone; medications as generic name,
// strength and dose form with the sig as in the record and the RxNorm code; no "Do Not Use"
// abbreviations (QD, QOD, U, IU, MS, MSO4, MgSO4), no trailing zeros, always a leading zero;
// SNOMED CT codes on conditions and LOINC codes on labs; UCUM units. Severity is said as
// "Level 3 (call the doctor today)", never "critical" or "abnormal"; a lab outside its range
// is "above reference range". Fixed wording only: every number and date comes from the data.
// House style as everywhere else: no long dashes, no diagnosis, no dosing advice.

export const REPORT_FOOTER = "Prepared by an AI check-in assistant from what she reported and her health record. Not a diagnosis.";
export const SYNTHETIC_BANNER = "SYNTHETIC DEMO DATA, NOT A REAL PATIENT";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-10-03" -> "Oct 3, 2026". Anything else is returned as it is. */
export function reportDate(day: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(day);
  if (!m) return day;
  return `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}`;
}

/** "2026-08-28" -> "Fri". */
function weekday(day: string): string {
  const [y, mo, d] = day.split("-").map(Number) as [number, number, number];
  return WEEKDAYS[new Date(Date.UTC(y, mo - 1, d)).getUTCDay()] ?? "";
}

/** "EDT" for an instant in a time zone. */
function zoneName(iso: string, timezone: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: timezone, timeZoneName: "short" }).formatToParts(new Date(iso)).find((p) => p.type === "timeZoneName")?.value ?? timezone;
}

function esc(text: string | number | null | undefined): string {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Her words in quotes, with any long dash in them shown as a comma (house style). */
function quoted(text: string): string {
  return `&ldquo;${esc(text.replace(/\s*[‒-―]\s*/g, ", "))}&rdquo;`;
}

/** A number without trailing zeros and with a leading zero ("5", "0.075", never "5.0" or ".5"). */
export function num(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  const s = String(Number(value.toFixed(6)));
  return s.startsWith(".") ? `0${s}` : s.startsWith("-.") ? `-0${s.slice(1)}` : s;
}

/** "5 MG" style strengths in a text: trailing zeros dropped, leading zero added, units in safe lower case. */
const UNIT_WORDS: Record<string, string> = { MG: "mg", MCG: "mcg", MEQ: "mEq", ML: "mL", G: "g", UNT: "units", "%": "%" };
function strengthText(text: string): string {
  return text.replace(/(\d*\.?\d+)\s*(MG|MCG|MEQ|ML|UNT|G|%)(?=\b|\s|$|\/)/g, (_m, n: string, unit: string) => `${num(Number(n))} ${UNIT_WORDS[unit] ?? unit.toLowerCase()}`);
}

/**
 * A record drug name as generic name, strength and dose form: "24 HR metoprolol succinate 50 MG Extended Release Oral Tablet"
 * -> "metoprolol succinate 50 mg extended-release oral tablet (24 hour)".
 */
export function medicationName(recordName: string): string {
  let name = recordName.trim();
  let suffix = "";
  const hours = /^(\d+) HR\s+/i.exec(name);
  if (hours) {
    name = name.slice(hours[0].length);
    suffix = ` (${hours[1]} hour)`;
  }
  name = strengthText(name)
    .replace(/\bExtended Release\b/gi, "extended-release")
    .replace(/\bDelayed Release\b/gi, "delayed-release")
    .replace(/\b(Oral|Tablet|Capsule|Solution|Suspension|Injection|Topical|Inhaler|Patch|Chewable|Disintegrating)\b/g, (w) => w.toLowerCase());
  return `${name}${suffix}`;
}

/** UCUM units as a clinician reads them: "mL/min/{1.73_m2}" -> "mL/min/1.73m2", "10*3/uL" -> "10^3/uL", "m[IU]/L" -> "mIU/L". */
export function unitText(unit: string): string {
  return unit.replace(/\{1\.73_m2\}/g, "1.73m2").replace(/10\*(\d+)/g, "10^$1").replace(/\[([^\]]*)\]/g, "$1").replace(/[{}]/g, "");
}

/** "Creatinine [Mass/volume] in Serum or Plasma" -> "Creatinine"; "Hemoglobin A1c/Hemoglobin.total in Blood" -> "Hemoglobin A1c". */
const LAB_NAMES: Record<string, string> = {
  "Glomerular filtration rate": "eGFR (CKD-EPI 2021)",
  "Cholesterol in LDL": "LDL cholesterol",
  "Cholesterol in HDL": "HDL cholesterol",
  Cholesterol: "Total cholesterol",
  Thyrotropin: "TSH",
  Leukocytes: "White blood cells",
};
function labName(name: string): string {
  const short =
    name
      .split(" [")[0]!
      .replace(/\/Hemoglobin\.total/, "")
      .replace(/ in (Serum|Blood|Plasma).*$/, "")
      .trim() || name;
  return LAB_NAMES[short] ?? short;
}

const SOURCE_WORDS: Record<string, string> = {
  button: "tapped an answer",
  typed: "typed",
  follow_up: "follow-up answer",
  safety: "safety screen",
  photo: "label photo",
  voice: "voice call",
};

const OUTCOME_WORDS: Record<CheckinOutcome, string> = {
  checked_in: "Answered",
  not_today: "Not today",
  missed: "Missed",
  in_progress: "Started",
  none: "None sent",
};

const DOSE_WORDS: Record<ReportDose, string> = { taken: "Taken", "not confirmed": "Not confirmed", "no reminder": "No reminder" };

const FLAG_STATUS: Record<"new" | "told" | "noted", string> = {
  new: "New, not yet discussed with her",
  told: "Told, she has heard it",
  noted: "Noted, she plans to raise it with you",
};

const SYSTEM_NAMES: Record<string, string> = {
  "http://snomed.info/sct": "SNOMED CT",
  "http://hl7.org/fhir/sid/icd-10-cm": "ICD-10-CM",
  "http://hl7.org/fhir/sid/icd-10": "ICD-10",
};

/** "Level 3 (call the doctor today)". */
export function levelText(level: number): string {
  return `Level ${level} (${LEVEL_WORDS[level] ?? (level === 0 ? "fine" : "unrated")})`;
}

function levelShort(level: number): string {
  return `<span class="lv lv${Math.min(Math.max(level, 0), 5)}">Level ${level}</span>`;
}

function levelBadge(level: number): string {
  return `<span class="lv lv${Math.min(Math.max(level, 0), 5)}">${esc(levelText(level))}</span>`;
}

/** "Glomerular filtration rate [...]: 31 mL/min/{1.73_m2}" -> "Glomerular filtration rate: 31 mL/min/1.73m2"; drug names in the safe form. */
function evidenceValue(value: string): string {
  const colon = value.indexOf(": ");
  if (colon < 0) return medicationName(value);
  return `${labName(value.slice(0, colon))}: ${unitText(value.slice(colon + 2))}`;
}

const PAPER_CHANGE: Record<string, string> = { Stop: "marked stopped", New: "listed as new", Changed: "listed as changed", Continue: "listed to continue" };

/** One evidence item: the value, its date and its record source and id. Hospital paper lines are said as what the papers show. */
function evidenceLine(e: Evidence): string {
  if (e.resourceId.startsWith("paper:")) {
    const m = /^(\w+): (.+)$/.exec(e.value);
    const what = m ? `${m[2]} ${PAPER_CHANGE[m[1]!] ?? `(${m[1]!.toLowerCase()})`}` : e.value;
    return `Hospital papers (${esc(e.source)}${e.date ? `, ${esc(reportDate(e.date))}` : ""}): ${esc(strengthText(what))}`;
  }
  return `${esc(evidenceValue(e.value))}, ${esc(e.date ? reportDate(e.date) : "undated")} <span class="id">${esc(e.source)} ${esc(e.resourceId)}</span>`;
}

function discrepancyLine(d: Discrepancy): string {
  const paper = strengthText(`${d.paperName}${d.paperStrength ? ` ${d.paperStrength}` : ""}`);
  switch (d.kind) {
    case "stopped_but_active":
      return `${esc(paper)} marked stopped on the papers; her medication list still shows ${esc(medicationName(d.recordName ?? d.paperName))} as active`;
    case "new_not_in_record":
      return `${esc(paper)} on the papers, not on her medication list`;
    case "dose_differs":
      return `${esc(paper)} on the papers; her medication list shows ${esc(strengthText(d.recordStrength ?? "another strength"))}`;
  }
}

/** "2026-08-30" -> "Aug 30" for the short lists on page 1 (the year is in the header). */
function shortDate(day: string): string {
  return reportDate(day).replace(/, \d{4}$/, "");
}

/** One row per topic: its highest level, when each level was reported, and her answers and words with their dates. */
function symptomTable(symptoms: ReportSymptom[]): string {
  const groups = new Map<string, ReportSymptom[]>();
  for (const s of symptoms) {
    const key = s.source === "photo" ? "photo" : s.about;
    groups.set(key, [...(groups.get(key) ?? []), s]);
  }
  const rows = [...groups.values()]
    .map((entries) => [...entries].sort((a, b) => b.level - a.level || (a.day < b.day ? -1 : a.day > b.day ? 1 : 0)))
    .sort((a, b) => b[0]!.level - a[0]!.level || (a[0]!.day < b[0]!.day ? -1 : 1))
    .map((entries) => {
      const top = entries[0]!;
      const photo = top.source === "photo";
      const levels = [...new Set(entries.map((e) => e.level))];
      const when =
        entries.length === 1
          ? esc(reportDate(top.day))
          : levels.map((lv) => `Level ${lv}: ${esc(andList(entries.filter((e) => e.level === lv).map((e) => shortDate(e.day))))}`).join("; ");
      const said = photo
        ? "didn't match her list (see Medications)"
        : entries
            .map((e) => {
              const bits = [e.answer ? `Answer ${quoted(e.answer)}` : "", e.words ? `her words ${quoted(e.words)}` : ""].filter(Boolean).join("; ");
              return bits && entries.length > 1 ? `${esc(shortDate(e.day))}: ${bits}` : bits;
            })
            .filter(Boolean)
            .join(" | ");
      const via = [...new Set(entries.map((e) => SOURCE_WORDS[e.source] ?? e.source))].join(", ");
      return `<tr><td class="nw">${levelShort(top.level)}</td><td>${esc(photo ? "label photo" : top.about)}</td><td>${when}</td><td>${said || '<span class="muted">no words kept</span>'}</td><td>${esc(via)}</td></tr>`;
    });
  return `<div class="wrap"><table class="said"><tr><th>Level</th><th>About</th><th>When</th><th>Her answer or her own words</th><th>How reported</th></tr>${rows.join("")}</table></div>`;
}

const CSS = `
  @page { size: letter portrait; margin: 0.36in 0.45in 0.46in 0.45in; }
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: #ffffff; color: #14181d; }
  body { font-family: "Helvetica Neue", Helvetica, Arial, sans-serif; font-size: 8.6pt; line-height: 1.28; }
  .page { max-width: 7.6in; margin: 0 auto; }
  @media screen { html, body { background: #eef0f2; } .page { background: #ffffff; padding: 0.35in 0.4in; margin: 16px auto; box-shadow: 0 1px 4px rgba(0,0,0,0.15); } }
  @media screen and (max-width: 640px) { body { font-size: 10pt; } .page { padding: 16px; margin: 0; } .tiles { grid-template-columns: 1fr 1fr !important; } .flag { grid-template-columns: 1fr !important; } .cols { grid-template-columns: 1fr !important; } .wrap { overflow-x: auto; } }
  .banner { border: 2px solid #14181d; background: #ffe600; text-align: center; font-weight: 700; font-size: 8pt; letter-spacing: 0.04em; padding: 0 6px; margin-bottom: 5px; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  header { display: flex; justify-content: space-between; align-items: flex-end; gap: 12px; border-bottom: 2px solid #14181d; padding-bottom: 4px; }
  h1 { font-size: 16pt; margin: 0; letter-spacing: -0.01em; line-height: 1.1; }
  .who { font-size: 9.6pt; margin-top: 2px; }
  .meta { text-align: right; font-size: 7.8pt; color: #2a3038; }
  h2 { break-after: avoid; font-size: 8.8pt; margin: 6px 0 3px 0; text-transform: uppercase; letter-spacing: 0.06em; color: #2a3038; border-bottom: 1px solid #b9c0c8; padding-bottom: 1px; }
  h2 small { text-transform: none; font-weight: 400; letter-spacing: 0; color: #4a5560; font-size: 7.8pt; }
  h3 { font-size: 8.6pt; margin: 6px 0 2px 0; }
  .tiles { display: grid; grid-template-columns: repeat(3, 1fr); gap: 5px; }
  .tile { border: 1px solid #c3cbd3; border-radius: 4px; padding: 4px 7px 4px 7px; background: #f6f8fa; break-inside: avoid; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .tile.watch { border-color: #b08900; background: #fff7dc; }
  .tile .label { font-size: 6.8pt; font-weight: 700; letter-spacing: 0.07em; text-transform: uppercase; color: #46515e; }
  .tile .big { font-size: 17pt; font-weight: 700; line-height: 1.08; }
  .tile .big small { font-size: 8.8pt; font-weight: 600; color: #46515e; }
  .tile .line { font-size: 7.9pt; }
  .tile .src { font-size: 6.6pt; color: #5b6672; margin-top: 1px; }
  ul { margin: 0; padding-left: 13px; }
  li { margin: 0 0 1.5px 0; }
  p { margin: 0 0 3px 0; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; vertical-align: top; padding: 1.5px 4px; border-bottom: 1px solid #e0e4e8; }
  th { font-size: 7pt; color: #46515e; font-weight: 600; border-bottom: 1px solid #98a2ad; }
  tr { break-inside: avoid; }
  table.one td { white-space: nowrap; }
  table.one td:first-child, table.one td:nth-child(2) { white-space: normal; }
  tr.has-note td { border-bottom: none; }
  tr.note td { white-space: normal; font-size: 7.4pt; color: #333a42; padding-left: 14px; }
  .week th, .week td { text-align: center; font-size: 8pt; }
  .week th:first-child, .week td:first-child { text-align: left; white-space: nowrap; font-weight: 600; }
  table.said { table-layout: fixed; }
  table.said th:nth-child(1) { width: 0.62in; } table.said th:nth-child(2) { width: 1.15in; } table.said th:nth-child(3) { width: 1.2in; } table.said th:nth-child(5) { width: 0.8in; }
  .legend { font-size: 7pt; color: #4a5560; margin-top: 2px; }
  .nw { white-space: nowrap; }
  .muted { color: #5b6672; }
  .id { font-family: Menlo, Consolas, monospace; font-size: 6.4pt; color: #555555; }
  .code { font-family: Menlo, Consolas, monospace; font-size: 6.6pt; color: #444444; white-space: nowrap; }
  .lv { display: inline-block; font-weight: 700; font-size: 7.4pt; border-radius: 2px; padding: 0 3px; border: 1px solid #888888; white-space: nowrap; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .lv0 { background: #ffffff; color: #444444; }
  .lv1 { background: #eef1f4; }
  .lv2 { background: #ffe8a3; border-color: #b08900; }
  .lv3, .lv4, .lv5 { background: #c62828; color: #ffffff; border-color: #8e0000; }
  .bad { font-weight: 700; }
  .flag { display: grid; grid-template-columns: 2.1em 1fr 1.55in; gap: 6px; align-items: start; border-left: 3px solid #b08900; background: #fffbea; padding: 3px 6px; margin-bottom: 3px; break-inside: avoid; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .flag .rule { font-weight: 700; }
  .flag .what { font-size: 8pt; color: #2a3038; }
  .flag .chip { font-size: 7.4pt; text-align: right; color: #2a3038; }
  .reference { break-before: page; }
  .reference ~ section, .reference { font-size: 7.5pt; }
  .reference ~ section th, .reference th { font-size: 6.8pt; }
  .reference ~ section td, .reference td, .reference ~ section th, .reference th { padding-top: 0.5px; padding-bottom: 0.5px; }
  .reference ~ section h2, .reference h2 { margin-top: 4px; }
  .reference ~ section li { margin-bottom: 0.5px; }
  .reference ~ section td, .reference td { padding-top: 0.2px; padding-bottom: 0.2px; }
  ul.two { columns: 2; column-gap: 14px; }
  ul.two li { break-inside: avoid; }
  .about { border: 1px solid #c3cbd3; border-radius: 4px; padding: 3px 7px; background: #f6f8fa; font-size: 7.4pt; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .cols { display: grid; grid-template-columns: 1fr 1fr; gap: 0 14px; }
  footer { margin-top: 4px; border-top: 2px solid #14181d; padding-top: 2px; font-size: 7.6pt; display: flex; justify-content: space-between; gap: 12px; }
  footer .claim { font-weight: 700; }
`;

/** A CSS string literal. */
function cssString(text: string): string {
  return `"${text.replace(/[\\"]/g, (c) => `\\${c}`).replace(/[\r\n]+/g, " ").replace(/</g, "\\3C ")}"`;
}

/** Her two identifiers and the page number at the foot of every printed page. */
function pageBoxes(r: DoctorReport): string {
  const p = r.patient;
  const ids = `${p.name ?? p.preferredName}, DOB ${p.birthDate ? reportDate(p.birthDate) : "not in record"}, record ID ${p.recordId ?? "none"}. Check-in summary ${reportDate(r.from)} to ${reportDate(r.to)}. Synthetic demo data.`;
  const box = 'font-family: "Helvetica Neue", Helvetica, Arial, sans-serif; font-size: 7pt; color: #444444;';
  return `
  @page {
    @bottom-left { content: ${cssString(ids)}; ${box} }
    @bottom-right { content: "Page " counter(page) " of " counter(pages); ${box} }
  }`;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

type Tile = { label: string; big: string; small?: string; lines: string[]; source: string; watch?: boolean };

function tileHtml(t: Tile): string {
  return `<div class="tile${t.watch ? " watch" : ""}"><div class="label">${esc(t.label)}</div><div class="big">${esc(t.big)}${t.small ? ` <small>${esc(t.small)}</small>` : ""}</div>${t.lines.map((l) => `<div class="line">${l}</div>`).join("")}<div class="src">${esc(t.source)}</div></div>`;
}

/** The six tiles of "What was collected this week": a number, a line of detail and where it came from, all counts of the data. */
function collectedTiles(r: DoctorReport): Tile[] {
  const c = r.checkins;
  const reported = r.symptoms.filter((s) => s.source !== "photo");
  const topics = new Set(reported.map((s) => s.about));
  const top = r.highest && r.highest.source !== "photo" ? r.highest : (reported[0] ?? null);
  const slots = r.medicines.adherence.flatMap((a) => [a.morning, a.evening]);
  const sent = slots.filter((s) => s !== "no reminder").length;
  const taken = slots.filter((s) => s === "taken").length;
  const photos = r.medicines.labelChecks;
  const differing = r.medicines.labelMismatches.length;
  const rates = r.vitals.readings.flatMap((v) => (v.heartRate !== null ? [Math.round(v.heartRate)] : []));
  const checkinBits = [
    c.notToday > 0 ? `${c.notToday} &ldquo;Not today&rdquo;` : "",
    c.missed > 0 ? `${c.missed} missed` : "",
    c.inProgress > 0 ? `${c.inProgress} started, not finished` : "",
    c.none > 0 ? `${c.none} with no check-in sent` : "",
  ].filter(Boolean);
  const ruleIds = [...new Set(r.flags.map((f) => f.ruleId))];
  const labsLine = r.patient.record === "ok" ? `${plural(r.labs.length, "lab test")} &middot; ${plural(r.patient.conditions.length, "active problem")}` : "No record copy stored";
  return [
    { label: "Check-ins", big: String(c.answered), small: `of ${r.days.length} days answered`, lines: [checkinBits.length > 0 ? checkinBits.join(" &middot; ") : "No day missed"], source: "From her daily check-ins" },
    {
      label: "What she reported",
      big: String(reported.length),
      small: reported.length === 1 ? "symptom report" : "symptom reports",
      lines: [top ? `${plural(topics.size, "topic")} &middot; highest ${levelBadge(top.level)}` : "Nothing above Level 0"],
      source: "Her answers and words; levels set by fixed rules",
      watch: Boolean(top && top.level >= 3),
    },
    {
      label: "Medicines",
      big: String(taken),
      small: sent > 0 ? `of ${sent} reminders confirmed` : "reminders confirmed",
      lines: [
        photos.total > 0 ? `${plural(photos.total, "label photo")} checked${differing > 0 ? `, ${differing} differ${differing === 1 ? "s" : ""} from her list` : ""}` : "No label photos",
        r.medicines.refills.length > 0 ? plural(r.medicines.refills.length, "refill reminder") : "",
      ].filter(Boolean),
      source: "From the reminders and photos in her chat",
    },
    {
      label: "Camera vitals",
      big: String(r.vitals.readings.length),
      small: r.vitals.readings.length === 1 ? "reading" : "readings",
      lines: [rates.length > 0 ? `heart rate ${num(Math.min(...rates))}${Math.min(...rates) === Math.max(...rates) ? "" : ` to ${num(Math.max(...rates))}`} beats/min` : "None taken this week"],
      source: "Presage camera estimate, not a medical measurement",
    },
    {
      label: "Record flags",
      big: String(r.flags.length),
      small: r.flags.length === 1 ? "for your review" : "for your review",
      lines: [ruleIds.length > 0 ? esc(ruleIds.join(", ")) : "No open rule flags"],
      source: "Fixed rules on her FinchNode record",
      watch: r.flags.length > 0,
    },
    {
      label: "Her record",
      big: String(r.medicines.active.length),
      small: r.medicines.active.length === 1 ? "medicine" : "medicines",
      lines: [labsLine],
      source: r.patient.record === "ok" ? `FinchNode, data as of ${reportDate(r.patient.dataAsOf ?? "unknown")}` : "FinchNode",
    },
  ];
}

/** "In brief": what the week's data says, in plain words and in the data's own terms. No assessment, no advice. */
function briefLines(r: DoctorReport): string[] {
  const c = r.checkins;
  const datesOf = (o: CheckinOutcome) => c.perDay.filter((d) => d.outcome === o).map((d) => shortDate(d.day));
  const out: string[] = [];
  const checkin = [`Answered ${c.answered} of ${r.days.length} check-ins.`];
  if (c.notToday > 0) checkin.push(`&ldquo;Not today&rdquo; on ${esc(andList(datesOf("not_today")))}.`);
  if (c.missed > 0) checkin.push(`Missed ${esc(andList(datesOf("missed")))}.`);
  out.push(checkin.join(" "));

  const reported = r.symptoms.filter((s) => s.source !== "photo");
  const top = reported[0];
  if (!top) {
    out.push("No symptoms above Level 0 were reported.");
  } else {
    const followUp = r.followUps.find((f) => f.day === top.day && f.about === top.about && f.answer);
    out.push(
      `Highest level: ${levelBadge(top.level)} ${esc(top.about)}, ${esc(shortDate(top.day))}.${top.words ? ` Her words: ${quoted(top.words)}` : ""}${followUp ? ` Her follow-up that day: ${quoted(followUp.answer!)}.` : ""}`,
    );
  }

  const t = r.medicines.totals;
  const days = r.medicines.adherence.length;
  const m = r.medicines.labelMismatches[0];
  out.push(
    `Medicine reminders confirmed: morning ${t.morning.taken} of ${days} days, evening ${t.evening.taken} of ${days}.${
      m ? ` Label photo ${esc(shortDate(m.day))} read ${esc(strengthText(m.label))}${m.onHerList ? `; her list has ${esc(strengthText(m.onHerList))}` : ""}; she was told to check with her pharmacist.` : ""
    }`,
  );

  const rates = r.vitals.readings.flatMap((v) => (v.heartRate !== null ? [Math.round(v.heartRate)] : []));
  if (r.vitals.readings.length > 0) {
    out.push(`Camera vitals: ${plural(r.vitals.readings.length, "estimate")}${rates.length > 0 ? `, heart rate ${num(Math.min(...rates))}${Math.min(...rates) === Math.max(...rates) ? "" : ` to ${num(Math.max(...rates))}`} beats/min` : ""}.`);
  }
  return out;
}

/** What an item of evidence says, short: medicines by name, each lab as its latest value and date with the one before it. The record source and id are on page 2. */
function evidenceBrief(evidence: Evidence[]): string {
  const seen = new Set<string>();
  const items = evidence.filter((e) => {
    const key = `${e.value}|${e.date}`;
    return seen.has(key) ? false : (seen.add(key), true);
  });
  const medicines: string[] = [];
  const labsByName = new Map<string, { value: string; date: string }[]>();
  const papers: string[] = [];
  for (const e of items) {
    if (e.resourceId.startsWith("paper:")) {
      papers.push(evidenceLine(e));
      continue;
    }
    const colon = e.value.indexOf(": ");
    if (colon < 0) {
      medicines.push(esc(medicationName(e.value).replace(/\s+(?:extended-release |delayed-release )?(?:oral )?(?:tablet|capsule)(?: \(\d+ hour\))?$/i, "")));
      continue;
    }
    const name = labName(e.value.slice(0, colon));
    labsByName.set(name, [...(labsByName.get(name) ?? []), { value: unitText(e.value.slice(colon + 2)), date: e.date ?? "" }]);
  }
  const parts: string[] = [];
  if (medicines.length > 0) parts.push(`Medicines: ${medicines.join(", ")}`);
  for (const [name, list] of labsByName) {
    const byNewest = [...list].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    const [latest, ...earlier] = byNewest as [{ value: string; date: string }, ...{ value: string; date: string }[]];
    parts.push(`${esc(name)} ${esc(latest.value)}${latest.date ? ` (${esc(reportDate(latest.date))})` : ""}${earlier.length > 0 ? `, earlier ${earlier.map((x) => `${esc(x.value.split(" ")[0])}${x.date ? ` (${esc(reportDate(x.date))})` : ""}`).join(", ")}` : ""}`);
  }
  parts.push(...papers);
  return parts.join(". ");
}

/** The doctor report as a printable HTML page (US letter): page 1 the summary, page 2 the reference detail. */
export function renderDoctorReportHtml(r: DoctorReport): string {
  const p = r.patient;
  const tz = p.timezone;
  const zone = zoneName(r.generatedAt, tz);
  const name = p.name ?? p.preferredName;
  const clock = (hhmm: string | null) => (hhmm ? `${esc(hhmm)} ${esc(zone)}` : "");
  const generated = `${reportDate(r.generatedOn)}, ${new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(r.generatedAt))} ${zone} (${tz})`;
  const sources = p.sources.length > 0 ? andList(p.sources) : "her health record";
  const sex = p.gender ? p.gender.charAt(0).toUpperCase() + p.gender.slice(1).toLowerCase() : "sex not in record";
  const who = `${esc(name)} &middot; born ${p.birthDate ? esc(reportDate(p.birthDate)) : "not in record"} &middot; ${p.age !== null ? `${esc(p.age)} years` : "age not in record"} &middot; ${esc(sex)}`;

  const c = r.checkins;
  const tiles = collectedTiles(r).map(tileHtml).join("");
  const brief = briefLines(r).map((l) => `<li>${l}</li>`).join("");

  // Day by day.
  const levelOfDay = (day: string) => r.symptoms.filter((s) => s.day === day).reduce((m, s) => Math.max(m, s.level), -1);
  const head = r.days.map((d) => `<th>${esc(weekday(d))}<br>${esc(reportDate(d).replace(/, \d{4}$/, ""))}</th>`).join("");
  const outcomeRow = c.perDay.map((d) => `<td class="${d.outcome === "missed" ? "bad" : ""}">${esc(OUTCOME_WORDS[d.outcome])}</td>`).join("");
  const levelRow = r.days
    .map((d) => {
      const level = levelOfDay(d);
      const answered = c.perDay.find((x) => x.day === d)?.outcome === "checked_in";
      return `<td>${level >= 0 ? `<span class="lv lv${Math.min(level, 5)}">${esc(level)}</span>` : answered ? `<span class="lv lv0">0</span>` : ""}</td>`;
    })
    .join("");
  const doseRow = (slot: "morning" | "evening") =>
    r.medicines.adherence.map((a) => `<td class="${a[slot] === "not confirmed" ? "bad" : a[slot] === "no reminder" ? "muted" : ""}">${esc(DOSE_WORDS[a[slot]])}</td>`).join("");
  const legend = [0, 1, 2, 3, 4, 5].map((l) => `${l} ${esc(l === 0 ? "fine" : LEVEL_WORDS[l] ?? "")}`).join(" &middot; ");
  const week = `
    <div class="wrap"><table class="week">
      <tr><th>${esc(r.to.slice(0, 4))}</th>${head}</tr>
      <tr><td>Check-in</td>${outcomeRow}</tr>
      <tr><td>Highest level</td>${levelRow}</tr>
      <tr><td>Morning medicines</td>${doseRow("morning")}</tr>
      <tr><td>Evening medicines</td>${doseRow("evening")}</tr>
    </table></div>
    <div class="legend">Levels, set by fixed rules: ${legend}.</div>`;

  // For your review: one card per rule flag, the label photos and the hospital papers.
  const flagCards = r.flags.map(
    (f) => `<div class="flag"><div class="rule">${esc(f.ruleId)}</div><div><b>${esc(DOCTOR_RULE_LABELS[f.ruleId])}</b><div class="what">${evidenceBrief(f.evidence)}</div></div><div class="chip">${esc(FLAG_STATUS[f.status])}</div></div>`,
  );
  const m = r.medicines;
  const review = r.flags.length === 0 ? `<p class="muted">No open rule flags.</p>` : flagCards.join("");

  // What she reported.
  const symptoms = r.symptoms.length === 0 ? `<p class="muted">Nothing above Level 0 this week.</p>` : symptomTable(r.symptoms);
  const shown = new Set(r.symptoms.map((x) => `${x.day}|${x.words}`));
  const extraNotes = r.notes.filter((n) => !shown.has(`${n.day}|${n.text}`));
  const notes =
    extraNotes.length === 0 ? "" : `<h3>Her other notes for you</h3><ul>${extraNotes.map((n) => `<li>${esc(reportDate(n.day))}, ${esc(n.about)}: ${quoted(n.text)}</li>`).join("")}</ul>`;
  const questions =
    r.visitQuestions.length === 0
      ? `<p class="muted">None this week.</p>`
      : `<ul>${r.visitQuestions.map((q) => `<li>${esc(reportDate(q.day))}: ${quoted(q.text)}</li>`).join("")}</ul>`;

  // Page 2: camera vitals, labs, medications, problem list, the evidence behind each flag, and where it all comes from.
  const range = r.vitals.usualRange;
  const afib = /atrial fibrillation/i.test(range?.note ?? "");
  const rangeLine = afib
    ? "Atrial fibrillation is on her record, so readings are not compared with a usual range."
    : range?.compareHeartRate && range.heartRate
      ? `Usual clinic heart rate ${esc(num(range.heartRate.low))} to ${esc(num(range.heartRate.high))} beats/min (${esc(range.heartRate.readings)} readings).`
      : "Not compared with a usual range (not enough clinic readings).";
  const readings = r.vitals.readings.map((v) => {
    const parts = [
      v.heartRate !== null ? `heart rate ${esc(num(Math.round(v.heartRate)))} beats/min` : "heart rate not read",
      ...(v.breathingRate !== null ? [`breathing rate ${esc(num(Math.round(v.breathingRate)))} breaths/min`] : []),
    ];
    const compared = v.inUsualRange === undefined ? "" : v.inUsualRange ? ", within her usual range" : ", outside her usual range";
    return `<li>${esc(reportDate(v.day))} ${clock(v.time)}: ${parts.join(", ")}${compared} <span class="muted">(${esc(v.method === "relay_call" ? "video call" : v.method === "scan_screen" ? "scan screen" : v.method)})</span></li>`;
  });
  const vitals = `<p><b>Camera vitals</b> (wellness estimates, not medical-grade measurements). ${rangeLine} ${
    readings.length === 0 ? `<span class="muted">None recorded this week.</span>` : ""
  }</p>${readings.length > 0 ? `<ul>${readings.join("")}</ul>` : ""}`;
  const refText = (l: DoctorReport["labs"][number]) =>
    l.low !== null && l.high !== null ? `${num(l.low)} to ${num(l.high)}` : l.low !== null ? `&ge; ${num(l.low)}` : l.high !== null ? `&le; ${num(l.high)}` : "none given";
  const refFlag = (l: DoctorReport["labs"][number]) =>
    l.high !== null && l.value > l.high ? "above reference range" : l.low !== null && l.value < l.low ? "below reference range" : "within reference range";
  const labs =
    r.labs.length === 0
      ? `<p class="muted">No lab results in her record.</p>`
      : `<div class="wrap"><table class="one"><tr><th>Lab test (latest in her record)</th><th>LOINC</th><th>Result</th><th>Reference range</th><th>Compared with range</th><th>Date</th><th>Previous result</th></tr>${r.labs
          .map(
            (l) =>
              `<tr><td>${esc(labName(l.name))}</td><td class="code">${esc(l.loinc ?? "")}</td><td><b>${esc(num(l.value))}</b> ${esc(unitText(l.unit))}</td><td>${refText(l)} ${esc(unitText(l.unit))}</td><td class="${refFlag(l).startsWith("within") ? "muted" : "bad"}">${esc(refFlag(l))}</td><td>${esc(reportDate(l.date))}</td><td class="muted">${l.previous ? `${esc(num(l.previous.value))}, ${esc(reportDate(l.previous.date))}` : "none"}</td></tr>`,
          )
          .join("")}</table></div>`;
  const medNotes = (a: DoctorReport["medicines"]["active"][number]): string[] => [
    ...m.labelMismatches
      .filter((l) => l.onHerList === a.plain)
      .map((l) => `Label photo ${esc(reportDate(l.day))} read ${esc(strengthText(l.label))} (strength differs); she was told to check with her pharmacist.`),
    ...m.paperChecks.flatMap((pc) =>
      pc.discrepancies
        .filter((d) => d.recordName === a.recordName)
        .map((d) => `${d.kind === "stopped_but_active" ? "Marked stopped" : d.kind === "dose_differs" ? `Listed as ${esc(strengthText(d.paperStrength ?? "another strength"))}` : "Listed"} on hospital papers dated ${esc(reportDate(pc.paperDate ?? pc.day))} (R6).`),
    ),
    ...m.refills
      .filter((f) => f.medicine === a.plain)
      .map((f) => `Refill reminder ${esc(reportDate(f.remindedOn))}, runs out ${esc(reportDate(f.runsOut))}; ${f.status === "asked" ? "she says she asked for it" : f.status === "snoozed" ? "she asked to be reminded tomorrow" : "no answer yet"}${f.familyTold ? "; family told" : ""}.`),
  ];
  const offList = [
    ...m.labelMismatches.filter((l) => l.outcome === "not_on_list").map((l) => `<li>Label photo ${esc(reportDate(l.day))} read ${esc(strengthText(l.label))}, not on her medication list; she was told to check with her pharmacist.</li>`),
    ...m.paperChecks.flatMap((pc) => pc.discrepancies.filter((d) => d.kind === "new_not_in_record").map((d) => `<li>${discrepancyLine(d)} (hospital papers dated ${esc(reportDate(pc.paperDate ?? pc.day))}).</li>`)),
  ];
  const meds =
    m.active.length === 0
      ? `<p class="muted">No medication list (no record copy stored).</p>`
      : `<div class="wrap"><table class="one"><tr><th>Medication (generic name, strength, dose form)</th><th>Directions as in the record</th><th>RxNorm</th><th>Last fill</th></tr>${m.active
          .map((a) => {
            const notes = medNotes(a);
            const row = `<tr${notes.length > 0 ? ' class="has-note"' : ""}><td><b>${esc(medicationName(a.recordName))}</b></td><td>${esc(a.sig ?? "no directions in record")}</td><td class="code">${esc(a.rxnorm ?? "")}</td><td>${a.lastFill ? `${esc(reportDate(a.lastFill))}, ${esc(a.daysSupply)} days` : '<span class="muted">none on record</span>'}</td></tr>`;
            return notes.length > 0 ? `${row}<tr class="note"><td colspan="4">This week: ${notes.join(" ")}</td></tr>` : row;
          })
          .join("")}</table></div>${offList.length > 0 ? `<ul>${offList.join("")}</ul>` : ""}`;
  const problems =
    p.conditions.length === 0
      ? `<p class="muted">None listed.</p>`
      : `<ul class="two">${p.conditions.map((cd) => `<li>${esc(cd.name)}${cd.code ? ` <span class="code">${esc(SYSTEM_NAMES[cd.system ?? ""] ?? cd.system ?? "")} ${esc(cd.code)}</span>` : ""}</li>`).join("")}</ul>`;
  const evidenceRows = r.flags.map((f) => {
    const seen = new Set<string>();
    const evidence = f.evidence.filter((e) => {
      const key = `${e.value}|${e.date}`;
      return seen.has(key) ? false : (seen.add(key), true);
    });
    const status = `${esc(FLAG_STATUS[f.status])}; <span class="muted">stored ${esc(reportDate(f.createdOn))}${f.toldOn ? `, told ${esc(reportDate(f.toldOn))}` : ""}${f.notedOn ? `, noted ${esc(reportDate(f.notedOn))}` : ""}</span>`;
    return `<li><b>${esc(f.ruleId)}${f.severity ? ` <span class="muted">${esc(f.severity)}</span>` : ""}.</b> ${evidence.map(evidenceLine).join("; ")}. ${status}</li>`;
  });
  const about = `<div class="about"><b>Made from:</b> her check-ins, reminders and photos in Relay (what she tapped or typed), Presage camera estimates from video calls, and her FinchNode record (${esc(sources)}; record ID <span class="code">${esc(p.recordId ?? "none")}</span>; ${p.record === "ok" ? `data as of ${esc(reportDate(p.dataAsOf ?? "unknown"))}` : "no record copy stored"}). Levels and flags come from fixed rules. <b>Not included:</b> medical conclusions, dosing advice, or anything she did not report and her record does not show.</div>`;

  const title = `Check-in summary: ${name}, ${reportDate(r.from)} to ${reportDate(r.to)}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>${CSS}${pageBoxes(r)}</style>
</head>
<body>
<div class="page">
  <div class="banner">${SYNTHETIC_BANNER}</div>
  <header>
    <div><h1>Weekly check-in summary</h1><div class="who">${who}</div></div>
    <div class="meta"><b>${esc(reportDate(r.from))} to ${esc(reportDate(r.to))}</b> (${r.days.length} days)<br>Generated ${esc(generated)}</div>
  </header>

  <section><h2>What was collected this week</h2><div class="tiles">${tiles}</div></section>

  <section><h2>In brief</h2><ul>${brief}</ul></section>

  <section><h2>Day by day</h2>${week}</section>

  <section><h2>For your review <small>(flags from fixed rules; no assessment is made)</small></h2>${review}</section>

  <section><h2>What she reported <small>(her words; levels set by fixed rules)</small></h2>${symptoms}${notes}</section>

  <section><h2>Her questions for the visit</h2>${questions}</section>

  <!-- Page 1 above stands alone; the reference detail follows. -->
  <section class="reference"><h2>Camera vitals and labs <small>(estimates and her record)</small></h2>${vitals}${labs}</section>

  <section><h2>Medications <small>(her active list from the record as of ${esc(reportDate(r.to))}, with this week's events)</small></h2>${meds}</section>

  <section><h2>Problem list <small>(from her record)</small></h2>${problems}</section>

  <section><h2>Evidence behind each flag <small>(value, date, record source and id)</small></h2>${evidenceRows.length === 0 ? `<p class="muted">No open rule flags.</p>` : `<ul>${evidenceRows.join("")}</ul>`}</section>

  <section><h2>About this report</h2>${about}</section>

  <footer><span class="claim">${REPORT_FOOTER}</span><span>${SYNTHETIC_BANNER}</span></footer>
</div>
</body>
</html>
`;
}
