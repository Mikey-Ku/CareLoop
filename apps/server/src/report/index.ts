import type { Db } from "../db/index.ts";
import type { RxNavCache } from "../finchnode/rxnav.ts";
import { buildDoctorReport, weekStart } from "./build.ts";
import { renderDoctorReportHtml } from "./render.ts";

// The doctor report (MVP feature 4): src/report/build.ts gathers the week, src/report/render.ts
// prints it. `npm run report` (src/cli/report.ts) writes the page; GET /report/:patientId
// (src/app.ts) serves the same HTML as the shareable link.

export * from "./build.ts";
export * from "./render.ts";

/** The patients in the database, by id. */
export function patientIds(db: Db): string[] {
  return (db.prepare(`SELECT id FROM patients ORDER BY id`).all() as { id: string }[]).map((r) => r.id);
}

/** Whether a patient exists. */
export function hasPatient(db: Db, patientId: string): boolean {
  return db.prepare(`SELECT 1 FROM patients WHERE id = ?`).get(patientId) !== undefined;
}

/**
 * The report page for the 7 days ending on `day` (default: her latest check-in date), from the
 * database and her stored record. The CLI and the route both call this, so they serve the same HTML.
 */
export function doctorReportPage(db: Db, patientId: string, options: { day?: string; now?: string; rxnav?: RxNavCache } = {}): string {
  return renderDoctorReportHtml(
    buildDoctorReport(db, patientId, {
      ...(options.day ? { to: options.day, from: weekStart(options.day) } : {}),
      ...(options.now ? { now: options.now } : {}),
      ...(options.rxnav ? { rxnav: options.rxnav } : {}),
    }),
  );
}

/** What GET /report/:patientId serves (src/app.ts AppDeps.doctorReport): the page, or undefined for an unknown patient. */
export function doctorReportRoute(db: Db, options: { now?: () => string; rxnav?: RxNavCache } = {}): (patientId: string, day: string | undefined) => string | undefined {
  return (patientId, day) =>
    hasPatient(db, patientId)
      ? doctorReportPage(db, patientId, { ...(day ? { day } : {}), ...(options.now ? { now: options.now() } : {}), ...(options.rxnav ? { rxnav: options.rxnav } : {}) })
      : undefined;
}
