import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import { parseScript, runSimulation } from "../src/cli/simulator.ts";
import { loadConfig } from "../src/config.ts";
import { openDatabase, upsertPatient, type Db } from "../src/db/index.ts";
import { REPO_ROOT } from "../src/finchnode/fixtures.ts";
import {
  REPORT_FOOTER,
  buildDoctorReport,
  doctorReportPage,
  doctorReportRoute,
  levelText,
  renderDoctorReportHtml,
  reportDate,
  type DoctorReport,
} from "../src/report/index.ts";

// The doctor report (MVP feature 4) from a simulated week: scripts/demo/harriet-week.txt, Wed
// 2026-08-26 to Tue 2026-09-01, run through the real check-in engine into a fresh database.

const NOW = "2026-10-03T14:05:00.000Z";
const PATIENT = "harriet";
let dir: string;
let db: Db;
let report: DoctorReport;
let html: string;

/** The page's text as a reader sees it: no style block, no tags, entities decoded. */
function visibleText(page: string): string {
  return page
    .replace(/<style[\s\S]*?<\/style>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&ldquo;|&rdquo;/g, '"')
    .replace(/&ge;/g, ">=")
    .replace(/&le;/g, "<=")
    .replace(/&middot;/g, " ")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "doctor-report-"));
  const dbPath = join(dir, "week.db");
  const lines: string[] = [];
  const exitCode = await runSimulation({
    dbPath,
    day: "2026-08-26",
    inputs: parseScript(readFileSync(join(REPO_ROOT, "scripts", "demo", "harriet-week.txt"), "utf8")),
    output: (line) => lines.push(line),
    config: loadConfig({}),
  });
  expect(exitCode, lines.join("\n")).toBe(0);
  db = openDatabase(dbPath);
  report = buildDoctorReport(db, PATIENT, { now: NOW });
  html = renderDoctorReportHtml(report);
}, 60_000);

afterAll(() => {
  db?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("doctor report from a simulated week", () => {
  it("covers the 7 days ending on her latest check-in, with her identifiers from the record", () => {
    expect(report.from).toBe("2026-08-26");
    expect(report.to).toBe("2026-09-01");
    expect(report.days).toHaveLength(7);
    expect(report.patient).toMatchObject({ name: "Harriet Lindqvist", birthDate: "1948-03-02", age: 78 });
    expect(report.patient.conditions).toContainEqual(expect.objectContaining({ name: "Atrial fibrillation", system: "http://snomed.info/sct", code: "49436004" }));
    const text = visibleText(html);
    expect(text).toContain("SYNTHETIC DEMO DATA");
    expect(text).toContain("Harriet Lindqvist");
    expect(text).toContain("Mar 2, 1948");
    expect(text).toContain(REPORT_FOOTER);
  });

  it("has the level-3 day with its date, her answer and her words, and how its follow-up went", () => {
    const three = report.symptoms[0]!;
    expect(three).toMatchObject({ day: "2026-08-28", level: 3, topic: "hf-breathing-lying-flat", answer: "Yes, it was hard", source: "typed" });
    expect(three.words).toContain("Lying flat made it hard to breathe");
    expect(report.highest).toEqual(three);
    // Symptoms are ordered by level, 3 and up first.
    expect(report.symptoms.map((s) => s.level)).toEqual([...report.symptoms.map((s) => s.level)].sort((a, b) => b - a));
    // The level-1 knee pain on her third day in five is level 2.
    expect(report.symptoms.filter((s) => s.topic === "knee pain").map((s) => [s.day, s.level])).toEqual([
      ["2026-08-30", 2],
      ["2026-08-26", 1],
      ["2026-08-27", 1],
    ]);
    expect(report.followUps.map((f) => [f.day, f.level, f.answer])).toEqual([
      ["2026-08-28", 3, "Better"],
      ["2026-08-30", 2, "About the same"],
    ]);
    const text = visibleText(html);
    // The table: one row per topic with its highest level, then when, then her answer and words.
    expect(text).toContain(`Level 3 breathing when lying flat ${reportDate("2026-08-28")} Answer "Yes, it was hard"`);
    expect(text).toContain("Lying flat made it hard to breathe so I slept sitting up in my chair");
    expect(text).toContain("Level 2 knee pain Level 2: Aug 30; Level 1: Aug 26 and Aug 27 no words kept");
    // In brief: the highest level with her words and how its follow-up went.
    expect(text).toContain(`Highest level: ${levelText(3)} breathing when lying flat, Aug 28.`);
    expect(text).toContain('Her follow-up that day: "Better".');
  });

  it("has the label mismatch, the refill, the paper discrepancy and the adherence counts", () => {
    expect(report.medicines.labelMismatches).toEqual([{ day: "2026-08-30", outcome: "strength_differs", label: "Apixaban 2.5 mg", onHerList: "apixaban 5 mg" }]);
    expect(report.medicines.refills).toEqual([
      { medicine: "trazodone hydrochloride 50 mg", runsOut: "2026-09-03", status: "asked", remindedOn: "2026-09-01", familyTold: false },
    ]);
    expect(report.medicines.paperChecks).toHaveLength(1);
    expect(report.medicines.paperChecks[0]!.discrepancies[0]).toMatchObject({ kind: "stopped_but_active", paperName: "aspirin" });
    expect(report.medicines.totals).toEqual({ morning: { taken: 6, notConfirmed: 1 }, evening: { taken: 6, notConfirmed: 1 } });
    expect(report.medicines.adherence.find((a) => a.day === "2026-08-29")).toEqual({ day: "2026-08-29", morning: "not confirmed", evening: "not confirmed" });
    expect(report.checkins).toMatchObject({ answered: 5, notToday: 1, missed: 1 });
    const text = visibleText(html);
    expect(text).toContain("Apixaban 2.5 mg");
    expect(text).toContain("trazodone hydrochloride 50 mg oral tablet");
    expect(text).toContain(`runs out ${reportDate("2026-09-03")}`);
    expect(text).toContain("aspirin 81 mg marked stopped");
    expect(text).toContain("Medicine reminders confirmed: morning 6 of 7 days, evening 6 of 7.");
    expect(text).toContain("Is the aspirin still on my list after the hospital?");
    // The assistant's own question after the label photo is not quoted as hers; the mismatch is listed above.
    expect(report.visitQuestions.map((q) => q.text)).not.toContainEqual(expect.stringContaining("A medicine label I photographed"));
    expect(text).not.toContain("A medicine label I photographed");
  });

  it("has the R1, R3 and R4 flags with their evidence: record ids, dates and values", () => {
    const byRule = new Map(report.flags.map((f) => [f.ruleId, f]));
    for (const rule of ["R1", "R3", "R4"] as const) {
      const flag = byRule.get(rule);
      expect(flag, rule).toBeDefined();
      expect(flag!.evidence.length, rule).toBeGreaterThan(0);
      for (const e of flag!.evidence) {
        expect(html, `${rule} ${e.resourceId}`).toContain(e.resourceId);
        if (e.date) expect(html, `${rule} ${e.date}`).toContain(reportDate(e.date));
      }
    }
    expect(byRule.get("R6")?.status).toBe("noted");
    const text = visibleText(html);
    expect(text).toContain("Metformin with eGFR below the review threshold");
    expect(text).toContain("eGFR (CKD-EPI 2021): 31 mL/min/1.73m2, Jul 14, 2026");
    expect(text).toContain("Potassium: 4.9 mmol/L, Jul 14, 2026");
  });

  it("matches the database on 5 spot-checked numbers", () => {
    const one = <T>(sql: string, ...args: unknown[]) => db.prepare(sql).get(...args) as T;
    // 1. Check-ins answered in the week.
    const answered = one<{ n: number }>(`SELECT COUNT(*) AS n FROM checkins WHERE patient_id = ? AND status = 'answered' AND date BETWEEN ? AND ?`, PATIENT, report.from, report.to);
    expect(report.checkins.answered).toBe(answered.n);
    // 2. Morning reminders confirmed as taken.
    const taken = one<{ n: number }>(`SELECT COUNT(*) AS n FROM med_doses WHERE patient_id = ? AND slot = 'morning' AND status = 'taken' AND day BETWEEN ? AND ?`, PATIENT, report.from, report.to);
    expect(report.medicines.totals.morning.taken).toBe(taken.n);
    // 3. The level-3 observation's day and level.
    const top = one<{ day: string; level: number }>(`SELECT day, level FROM symptom_observations WHERE patient_id = ? ORDER BY level DESC, id LIMIT 1`, PATIENT);
    expect([report.highest!.day, report.highest!.level]).toEqual([top.day, top.level]);
    // 4. The refill's run-out date.
    const refill = one<{ runOut: string }>(`SELECT run_out AS runOut FROM med_refills WHERE patient_id = ?`, PATIENT);
    expect(report.medicines.refills[0]!.runsOut).toBe(refill.runOut);
    expect(html).toContain(reportDate(refill.runOut));
    // 5. The latest eGFR in her record: value and date, as in the R1 evidence stored with the flag.
    const egfr = report.labs.find((l) => l.loinc === "98979-8")!;
    const r1 = JSON.parse(one<{ e: string }>(`SELECT evidence_json AS e FROM flags WHERE patient_id = ? AND rule_id = 'R1'`, PATIENT).e) as { date: string; value: string }[];
    const latest = r1.filter((e) => /Glomerular/.test(e.value)).at(-1)!;
    expect(latest.value).toContain(`: ${egfr.value} `);
    expect(egfr.date).toBe(latest.date);
    expect(visibleText(html)).toContain(`eGFR (CKD-EPI 2021) 98979-8 ${egfr.value} mL/min/1.73m2`);
  });
});

describe("what the first page says was collected", () => {
  const one = <T>(sql: string, ...args: unknown[]) => db.prepare(sql).get(...args) as T;

  it("opens with the collected-data tiles, and every number in them is a count of the data", () => {
    const text = visibleText(html);
    expect(text.indexOf("What was collected this week")).toBeGreaterThan(-1);
    expect(text.indexOf("What was collected this week")).toBeLessThan(text.indexOf("In brief"));
    expect(text.indexOf("In brief")).toBeLessThan(text.indexOf("Day by day"));
    expect(text.indexOf("Day by day")).toBeLessThan(text.indexOf("For your review"));
    // Check-ins answered, from the database.
    const answered = one<{ n: number }>(`SELECT COUNT(*) AS n FROM checkins WHERE patient_id = ? AND status = 'answered' AND date BETWEEN ? AND ?`, PATIENT, report.from, report.to);
    expect(text).toContain(`Check-ins ${answered.n} of 7 days answered 1 "Not today" 1 missed From her daily check-ins`);
    // Reminders confirmed over reminders sent.
    const taken = one<{ n: number }>(`SELECT COUNT(*) AS n FROM med_doses WHERE patient_id = ? AND status = 'taken' AND day BETWEEN ? AND ?`, PATIENT, report.from, report.to);
    const sent = one<{ n: number }>(`SELECT COUNT(*) AS n FROM med_doses WHERE patient_id = ? AND day BETWEEN ? AND ?`, PATIENT, report.from, report.to);
    expect(text).toContain(`Medicines ${taken.n} of ${sent.n} reminders confirmed`);
    // Label photos checked: every one, from med_label_checks, not only the ones that differ.
    const photos = one<{ n: number }>(`SELECT COUNT(*) AS n FROM med_label_checks WHERE patient_id = ?`, PATIENT);
    expect(report.medicines.labelChecks.total).toBe(photos.n);
    expect(text).toContain(`${photos.n} label photo checked, 1 differs from her list`);
    // Flags, and what her record holds.
    const flags = one<{ n: number }>(`SELECT COUNT(*) AS n FROM flags WHERE patient_id = ? AND status != 'cleared'`, PATIENT);
    expect(text).toContain(`Record flags ${flags.n} for your review R1, R3, R4, R6 Fixed rules on her FinchNode record`);
    expect(text).toContain(`Her record ${report.medicines.active.length} medicines ${report.labs.length} lab tests ${report.patient.conditions.length} active problems FinchNode, data as of Sep 1, 2026`);
    // Camera vitals: none this week, said plainly.
    expect(text).toContain("Camera vitals 0 readings None taken this week Presage camera estimate, not a medical measurement");
  });

  it("says in brief what the week holds, in the data's own terms, with no assessment", () => {
    const text = visibleText(html);
    expect(text).toContain('Answered 5 of 7 check-ins. "Not today" on Aug 31. Missed Aug 29.');
    expect(text).toContain("Label photo Aug 30 read Apixaban 2.5 mg; her list has apixaban 5 mg; she was told to check with her pharmacist.");
  });

  it("puts the reference detail on a page of its own, after page 1", () => {
    expect(html).toMatch(/<section class="reference"><h2>Camera vitals and labs/);
    expect(html.indexOf('class="reference"')).toBeGreaterThan(html.indexOf("Her questions for the visit"));
    expect(html).toContain(".reference { break-before: page; }");
    // The codes and record ids are on page 2: the problem list with SNOMED CT, the evidence with its record ids.
    const reference = html.slice(html.indexOf('class="reference"'));
    expect(reference).toContain("SNOMED CT 49436004");
    for (const flag of report.flags) for (const e of flag.evidence) if (!e.resourceId.startsWith("paper:")) expect(reference).toContain(e.resourceId); // hospital papers have no record id
  });

  it("renders a week with nothing in it, and a patient with no record copy, without breaking or inventing", () => {
    const empty = openDatabase(":memory:");
    upsertPatient(empty, { id: "nobody", finchnodePatientId: "patient-none", preferredName: "Nobody", relayHandle: null, relayChatId: null });
    const none = buildDoctorReport(empty, "nobody", { to: "2026-09-01", now: NOW });
    const page = visibleText(renderDoctorReportHtml(none));
    expect(page).toContain("Check-ins 0 of 7 days answered No day missed".replace("No day missed", "").trim());
    expect(page).toContain("Camera vitals 0 readings None taken this week");
    expect(page).toContain("Record flags 0 for your review No open rule flags");
    expect(page).toContain("No record copy stored");
    expect(page).toContain("No symptoms above Level 0 were reported.");
    expect(page).toContain("None this week.");
    empty.close();
  });
});

describe("doctor report wording", () => {
  it("has no long dashes, no dosing advice and no diagnosis phrasing", () => {
    const text = visibleText(html);
    expect(text).not.toMatch(/[‒-―]/);
    expect(text).not.toMatch(/\s-\s/);
    const dosing = [
      /\b(take more|take less|take extra|skip|double|halve|stop taking|start taking)\b/i,
      /\bstop\b/i,
      /\b(you|she|harriet|they) (should|could|can|must|needs? to|ought to) (take|stop|start|increase|decrease|double|skip|halve|reduce|cut)\b/i,
      /\b(increase|decrease|double|halve|reduce|raise|lower|cut|adjust|skip|stop)\s+(her|the|his|your)\s+(dose|dosage|medication|medicine|pills?)\b/i,
    ];
    for (const re of dosing) expect(text, String(re)).not.toMatch(re);
    // The footer says "Not a diagnosis."; nothing else may come near one.
    const own = text.replace(REPORT_FOOTER, "");
    expect(own).not.toMatch(/\b(you have|she has (a|an)|this means|diagnos\w*|likely|probably|consistent with|suggests?|indicates?|sounds like)\b/i);
    expect(own).not.toMatch(/\b(critical|abnormal)\b/i);
  });

  it("uses no Do Not Use abbreviations, no trailing zeros and always a leading zero", () => {
    const text = visibleText(html);
    expect(text).not.toMatch(/\b(QD|QOD|Q\.D\.|Q\.O\.D\.|U|IU|MS|MSO4|MgSO4|BID|TID|QID)\b/);
    expect(text).not.toMatch(/(?<![\d.])\d+\.\d*0(?![\d.])/); // 5.0, 1.50
    expect(text).not.toMatch(/(?<![\w.])\.\d/); // .5
    expect(text).toContain("levothyroxine sodium 0.075 mg oral tablet");
    expect(text).toContain("apixaban 5 mg oral tablet");
  });
});

describe("GET /report/:patientId", () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    const app = createApp({
      config: { finchnode: { baseUrl: "https://api.finchnode.com/demo/v1", apiKey: "ck_test_secret" } },
      doctorReport: doctorReportRoute(db, { now: () => NOW }),
      logError: () => {},
    });
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("returns 200 and the same HTML as the CLI's page, for the default week and for ?day=", async () => {
    const res = await fetch(`${base}/report/${PATIENT}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^text\/html/);
    const body = await res.text();
    expect(body).toBe(html);
    expect(body).toBe(doctorReportPage(db, PATIENT, { now: NOW }));

    const day = await fetch(`${base}/report/${PATIENT}?day=2026-08-30`);
    expect(day.status).toBe(200);
    expect(await day.text()).toBe(doctorReportPage(db, PATIENT, { day: "2026-08-30", now: NOW }));
  });

  it("404s an unknown patient and 400s a bad day", async () => {
    expect((await fetch(`${base}/report/nobody`)).status).toBe(404);
    expect((await fetch(`${base}/report/${PATIENT}?day=tuesday`)).status).toBe(400);
    expect((await fetch(`${base}/report/${PATIENT}?day=2026-02-30`)).status).toBe(400);
  });
});
