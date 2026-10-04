import { DOCTOR_RULE_LABELS } from "../care/copy.ts";
import { LEVEL_WORDS, type CheckinOutcome } from "../care/facts.ts";
import type { Evidence } from "../rules/index.ts";
import type { Discrepancy } from "../rules/paper-diff.ts";
import type { DoctorReport, ReportDose, ReportSymptom } from "./build.ts";

// One printable page (US letter) for her doctor, from a DoctorReport, laid out like a clinical
// summary for a visit: identifiers, problem list, Subjective (what she reported), Objective (camera
// wellness estimates and labs from her record), a reconciliation-style medication table, items for
// clinician review (never an assessment: we make none), her questions, and the footer.
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

function listJoin(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
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

function symptomRow(s: ReportSymptom): string {
  const said = [s.answer ? `Answer ${quoted(s.answer)}` : "", s.words ? `her words ${quoted(s.words)}` : ""].filter(Boolean).join("; ");
  return `<tr><td class="nw">${levelBadge(s.level)}</td><td class="nw">${esc(reportDate(s.day))}</td><td>${esc(s.about)}</td><td>${said || '<span class="muted">no words kept</span>'}</td><td class="nw">${esc(SOURCE_WORDS[s.source] ?? s.source)}</td></tr>`;
}

const CSS = `
  @page { size: letter portrait; margin: 0.3in 0.35in 0.38in 0.35in; }
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: #ffffff; color: #111111; }
  body { font-family: "Helvetica Neue", Helvetica, Arial, sans-serif; font-size: 7.8pt; line-height: 1.18; }
  .page { max-width: 7.8in; margin: 0 auto; }
  @media screen { html, body { background: #eef0f2; } .page { background: #ffffff; padding: 0.3in 0.35in; margin: 16px auto; box-shadow: 0 1px 4px rgba(0,0,0,0.15); } }
  @media screen and (max-width: 640px) { body { font-size: 9pt; } .page { padding: 16px; margin: 0; } .cols, .ids { grid-template-columns: 1fr !important; } .wrap { overflow-x: auto; } }
  .banner { border: 2px solid #111111; background: #ffe600; text-align: center; font-weight: 700; font-size: 8pt; letter-spacing: 0.04em; padding: 0 6px; margin-bottom: 3px; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  header { display: flex; justify-content: space-between; align-items: flex-end; gap: 12px; border-bottom: 2px solid #111111; padding-bottom: 2px; }
  h1 { font-size: 11.5pt; margin: 0; }
  .meta { text-align: right; font-size: 7.6pt; color: #222222; }
  .ids { display: grid; grid-template-columns: 1.2fr 0.8fr 1.6fr; gap: 0 10px; margin: 2px 0 1px 0; font-size: 8.2pt; }
  .source, .problems { font-size: 7.4pt; margin: 1px 0; }
  h2 { break-after: avoid; font-size: 8.4pt; margin: 4px 0 1px 0; padding: 0 4px; background: #e6e9ed; text-transform: uppercase; letter-spacing: 0.03em; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  h2 small { text-transform: none; font-weight: 400; letter-spacing: 0; color: #444444; }
  h3 { font-size: 7.8pt; margin: 2px 0 0 0; }
  .cols { display: grid; grid-template-columns: 1fr 1.15fr; gap: 0 10px; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; vertical-align: top; padding: 0.5px 3px; border-bottom: 1px solid #e0e0e0; }
  th { font-size: 7pt; color: #444444; font-weight: 600; border-bottom: 1px solid #999999; }
  tr { break-inside: avoid; }
  table.one td { white-space: nowrap; }
  table.one td:first-child, table.one td:nth-child(2) { white-space: normal; }
  tr.has-note td { border-bottom: none; }
  tr.note td { white-space: normal; font-size: 7.2pt; color: #333333; padding-left: 14px; }
  .week th, .week td { text-align: center; font-size: 7.4pt; }
  .week th:first-child, .week td:first-child { text-align: left; white-space: nowrap; }
  .nw { white-space: nowrap; }
  ul { margin: 0; padding-left: 11px; }
  li { margin: 0; }
  p { margin: 0; }
  .muted { color: #666666; }
  .id { font-family: Menlo, Consolas, monospace; font-size: 6.4pt; color: #555555; }
  .code { font-family: Menlo, Consolas, monospace; font-size: 6.6pt; color: #444444; white-space: nowrap; }
  .lv { display: inline-block; font-weight: 700; font-size: 7pt; border-radius: 2px; padding: 0 2px; border: 1px solid #888888; white-space: nowrap; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .lv0 { background: #ffffff; color: #444444; }
  .lv1 { background: #eef1f4; }
  .lv2 { background: #ffe8a3; border-color: #b08900; }
  .lv3, .lv4, .lv5 { background: #c62828; color: #ffffff; border-color: #8e0000; }
  .bad { font-weight: 700; }
  .flags td:first-child { font-weight: 700; white-space: nowrap; }
  .keep { break-inside: avoid; }
  footer { margin-top: 4px; border-top: 2px solid #111111; padding-top: 2px; font-size: 7.6pt; display: flex; justify-content: space-between; gap: 12px; }
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

/** The doctor report as a printable HTML page (US letter). */
export function renderDoctorReportHtml(r: DoctorReport): string {
  const p = r.patient;
  const tz = p.timezone;
  const zone = zoneName(r.generatedAt, tz);
  const name = p.name ?? p.preferredName;
  const clock = (hhmm: string | null) => (hhmm ? `${esc(hhmm)} ${esc(zone)}` : "");
  const generated = `${reportDate(r.generatedOn)}, ${new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(r.generatedAt))} ${zone} (${tz})`;
  const sources = p.sources.length > 0 ? listJoin(p.sources) : "her health record";

  // Identifiers and problem list.
  const ids = `
    <div class="ids">
      <div><b>Name:</b> ${esc(name)}<br><b>Date of birth:</b> ${p.birthDate ? esc(reportDate(p.birthDate)) : "not in record"}</div>
      <div><b>Sex:</b> ${esc(p.gender ? p.gender.charAt(0).toUpperCase() + p.gender.slice(1) : "not in record")}<br><b>Age:</b> ${p.age !== null ? `${esc(p.age)} years` : "not in record"}</div>
      <div><b>Record ID (FinchNode):</b> <span class="code">${esc(p.recordId ?? "none")}</span><br><b>Record data as of:</b> ${p.record === "ok" ? esc(reportDate(p.dataAsOf ?? "unknown")) : "no record copy stored"}</div>
    </div>
    <div class="source"><b>Source:</b> Patient-generated health data from daily check-ins, plus records from ${esc(sources)} via FinchNode. Synthetic demo data.</div>`;
  const problems = `<div class="problems"><b>Active problems (from her record):</b> ${
    p.conditions.length === 0
      ? "none listed"
      : p.conditions.map((c) => `${esc(c.name)}${c.code ? ` <span class="code">${esc(SYSTEM_NAMES[c.system ?? ""] ?? c.system ?? "")} ${esc(c.code)}</span>` : ""}`).join("; ")
  }</div>`;

  // The week at a glance.
  const c = r.checkins;
  const datesOf = (o: CheckinOutcome) => c.perDay.filter((d) => d.outcome === o).map((d) => reportDate(d.day));
  const checkinParts = [`${c.answered} answered`];
  if (c.notToday > 0) checkinParts.push(`${c.notToday} &ldquo;Not today&rdquo; (${esc(listJoin(datesOf("not_today")))})`);
  if (c.missed > 0) checkinParts.push(`${c.missed} missed (${esc(listJoin(datesOf("missed")))})`);
  if (c.inProgress > 0) checkinParts.push(`${c.inProgress} started, not finished`);
  if (c.none > 0) checkinParts.push(`${c.none} with no check-in sent`);
  const top = r.highest;
  const highestLine = top ? `${levelBadge(top.level)} ${esc(top.about)}, ${esc(reportDate(top.day))}` : "Nothing above Level 0 this week.";
  const followUpLines = r.followUps.map((f) => {
    const how = f.answer ? `${quoted(f.answer)}${f.answeredAt ? ` at ${clock(f.answeredAt)}` : ""}` : f.sentAt ? `sent ${clock(f.sentAt)}, no answer` : "not sent yet";
    return `<li>${esc(reportDate(f.day))}, ${esc(f.about)}${f.level !== null ? ` (${esc(levelText(f.level))})` : ""}: ${how}</li>`;
  });
  const t = r.medicines.totals;
  const reviewCount = r.flags.length + r.medicines.labelMismatches.length;
  const glance = `
    <ul>
      <li><b>Check-ins:</b> ${checkinParts.join(", ")}, over ${r.days.length} days.</li>
      <li><b>Highest level:</b> ${highestLine}.</li>
      <li><b>Follow-ups (${r.followUps.length}):</b> ${r.followUps.length === 0 ? "none this week." : `<ul>${followUpLines.join("")}</ul>`}</li>
      <li><b>Medicine reminders:</b> morning ${t.morning.taken} taken, ${t.morning.notConfirmed} not confirmed; evening ${t.evening.taken} taken, ${t.evening.notConfirmed} not confirmed. <b>Items for review:</b> ${reviewCount}.</li>
    </ul>`;
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
  const week = `
    <div class="wrap"><table class="week">
      <tr><th>${esc(r.to.slice(0, 4))}</th>${head}</tr>
      <tr><td>Check-in</td>${outcomeRow}</tr>
      <tr><td>Highest level</td>${levelRow}</tr>
      <tr><td>Morning medicines</td>${doseRow("morning")}</tr>
      <tr><td>Evening medicines</td>${doseRow("evening")}</tr>
    </table></div>`;

  // S: what she reported.
  const symptoms =
    r.symptoms.length === 0
      ? `<p class="muted">Nothing above Level 0 this week.</p>`
      : `<div class="wrap"><table><tr><th>Severity level</th><th>Date</th><th>About</th><th>Her answer or her own words</th><th>How reported</th></tr>${r.symptoms.map(symptomRow).join("")}</table></div>`;
  const shown = new Set(r.symptoms.map((x) => `${x.day}|${x.words}`));
  const extraNotes = r.notes.filter((n) => !shown.has(`${n.day}|${n.text}`));
  const notes =
    extraNotes.length === 0
      ? ""
      : `<h3>Her other notes for you</h3><ul>${extraNotes.map((n) => `<li>${esc(reportDate(n.day))}, ${esc(n.about)}: ${quoted(n.text)}</li>`).join("")}</ul>`;

  // O: camera wellness estimates and labs from her record.
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

  // Medications, reconciliation-style.
  const m = r.medicines;
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

  // Items for clinician review: rule flags with evidence, label photos and hospital papers.
  const flagRows = r.flags.map((f) => {
    const seen = new Set<string>();
    const evidence = f.evidence.filter((e) => {
      const key = `${e.value}|${e.date}`;
      return seen.has(key) ? false : (seen.add(key), true);
    });
    const status = `${esc(FLAG_STATUS[f.status])}; <span class="muted">stored ${esc(reportDate(f.createdOn))}${f.toldOn ? `, told ${esc(reportDate(f.toldOn))}` : ""}${f.notedOn ? `, noted ${esc(reportDate(f.notedOn))}` : ""}</span>`;
    return `<tr><td>${esc(f.ruleId)}${f.severity ? ` <span class="muted">${esc(f.severity)}</span>` : ""}</td><td><b>${esc(DOCTOR_RULE_LABELS[f.ruleId])}.</b> ${evidence.map(evidenceLine).join("; ")}.</td><td>${status}</td></tr>`;
  });
  const otherItems = [
    ...m.labelMismatches.map(
      (l) =>
        `<li>Label photo ${esc(reportDate(l.day))}: read <b>${esc(strengthText(l.label))}</b>; ${l.outcome === "strength_differs" ? `her medication list has ${esc(strengthText(l.onHerList ?? "another strength"))} (strength differs)` : "not on her medication list"}. She was told to check with her pharmacist.</li>`,
    ),
    ...m.paperChecks
      .filter((pc) => pc.outcome === "flag")
      .map((pc) => `<li>Hospital papers${pc.organization ? ` from ${esc(pc.organization)}` : ""}${pc.paperDate ? `, dated ${esc(reportDate(pc.paperDate))}` : ""}, checked ${esc(reportDate(pc.day))}: ${pc.discrepancies.map(discrepancyLine).join("; ")} (R6).</li>`),
  ];
  const review = `
    ${r.flags.length === 0 ? `<p class="muted">No open rule flags.</p>` : `<div class="wrap"><table class="flags"><tr><th>Rule, priority</th><th>What the rule found; evidence: value, date, record source and id</th><th>Status with her</th></tr>${flagRows.join("")}</table></div>`}
    ${otherItems.length > 0 ? `<ul style="margin-top:2px">${otherItems.join("")}</ul>` : ""}`;

  const questions =
    r.visitQuestions.length === 0
      ? `<p class="muted">None this week.</p>`
      : `<ul>${r.visitQuestions.map((q) => `<li>${esc(reportDate(q.day))}: ${quoted(q.text)}</li>`).join("")}</ul>`;

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
    <h1>Check-in summary for clinician review</h1>
    <div class="meta"><b>Report period:</b> ${esc(reportDate(r.from))} to ${esc(reportDate(r.to))} (${r.days.length} days)<br><b>Generated:</b> ${esc(generated)}</div>
  </header>
  ${ids}
  ${problems}

  <div class="cols">
    <section><h2>The week at a glance</h2>${glance}</section>
    <section><h2>Day by day <small>(severity level 0 to 5)</small></h2>${week}</section>
  </div>

  <section><h2>Subjective <small>(patient-reported, severity levels set by fixed rules)</small></h2>${symptoms}${notes}</section>

  <section><h2>Objective <small>(camera estimates and her record)</small></h2>${vitals}${labs}</section>

  <section class="keep"><h2>Medications <small>(her active list from the record as of ${esc(reportDate(r.to))}, with this week's events)</small></h2>${meds}</section>

  <section><h2>Items for clinician review <small>(flags from fixed rules; no assessment is made)</small></h2>${review}</section>

  <section><h2>Her questions for the visit</h2>${questions}</section>

  <footer><span class="claim">${REPORT_FOOTER}</span><span>${SYNTHETIC_BANNER}</span></footer>
</div>
</body>
</html>
`;
}
