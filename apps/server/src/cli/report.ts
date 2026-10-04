import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadConfig } from "../config.ts";
import { isCalendarDay } from "../days.ts";
import { openDatabase } from "../db/index.ts";
import { REPO_ROOT } from "../finchnode/fixtures.ts";
import { buildDoctorReport, hasPatient, latestCheckinDay, patientIds, renderDoctorReportHtml, weekStart } from "../report/index.ts";

// npm run report -- [--day YYYY-MM-DD] [--db path] [--out file.html] [--patient id]
// Writes the doctor report (two printed pages, page 1 standing alone; the 7 days ending on --day, default her latest
// check-in date) and prints its path. Default database: DATABASE_PATH; the simulator's is
// ../../data/simulator.db. Default patient: the only one in the database (or the first by id).
// Default output: data/report-<day>.html at the repo root.

const USAGE = "usage: npm run report -- [--day YYYY-MM-DD] [--db path] [--out file.html] [--patient id]";

function main(argv: string[]): number {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        day: { type: "string" },
        db: { type: "string" },
        out: { type: "string" },
        patient: { type: "string" },
        help: { type: "boolean", short: "h", default: false },
      },
    }));
  } catch (error) {
    console.error(`error: ${error instanceof Error ? error.message : String(error)}\n${USAGE}`);
    return 2;
  }
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  if (values.day !== undefined && !isCalendarDay(values.day)) {
    console.error(`error: --day must be YYYY-MM-DD, got "${values.day}"\n${USAGE}`);
    return 2;
  }
  const dbPath = values.db ?? loadConfig().databasePath;
  if (dbPath !== ":memory:" && !existsSync(dbPath)) {
    console.error(`error: no database at ${dbPath}. Run the simulator first (see README "Doctor report").`);
    return 1;
  }
  const db = openDatabase(dbPath);
  try {
    const patientId = values.patient ?? patientIds(db)[0];
    if (!patientId || !hasPatient(db, patientId)) {
      console.error(patientId ? `error: no patient "${patientId}" in ${dbPath}.` : `error: no patients in ${dbPath}.`);
      return 1;
    }
    const day = values.day ?? latestCheckinDay(db, patientId);
    if (!day) {
      console.error(`error: ${patientId} has no check-ins in ${dbPath}; pass --day.`);
      return 1;
    }
    const html = renderDoctorReportHtml(buildDoctorReport(db, patientId, { from: weekStart(day), to: day }));
    const out = resolve(values.out ?? join(REPO_ROOT, "data", `report-${day}.html`));
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, html);
    console.log(out);
    return 0;
  } finally {
    db.close();
  }
}

process.exitCode = main(process.argv.slice(2));
