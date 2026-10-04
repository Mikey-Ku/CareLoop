import { buildCareFacts, topicAbout, type CareFacts, type CheckinOutcome } from "../care/facts.ts";
import { isActiveCondition } from "../context/questions.ts";
import { getCheckinPatient } from "../db/checkins.ts";
import { latestSnapshot, type Db } from "../db/index.ts";
import { loadRxNavCache } from "../finchnode/fixtures.ts";
import { activeMedications, ageOn, asOf, normalizeHealthRecord, type Measurement, type PatientRecord } from "../finchnode/normalize.ts";
import type { RxNavCache } from "../finchnode/rxnav.ts";
import type { HealthRecord } from "../finchnode/types.ts";
import { latestFill, plusDays } from "../meds/refills.ts";
import { plainName } from "../meds/schedule.ts";
import type { Evidence, RuleId, Severity } from "../rules/index.ts";
import type { Discrepancy } from "../rules/paper-diff.ts";

// The doctor report (docs/BRIEF.md MVP feature 4): one week of what she told us, from our own
// database, next to her FinchNode record. Plain data only; src/report/render.ts words it. The
// day-by-day part is the care summaries' data layer (buildCareFacts, src/care/facts.ts), one call
// per day of the week, so the report and the daily summaries can never disagree. The rest is the
// week's own: follow-ups and how they went, hospital paper checks (R6), flags with their dates,
// and her medication list with fill dates from the record. Rules decided every level and flag
// stored here; nothing in this file decides anything new.

export const REPORT_DAYS = 7;
const DEFAULT_TZ = "America/Detroit";

export type ReportSymptom = {
  day: string;
  level: number;
  topic: string;
  /** The topic in plain words ("breathing when lying flat", "knee pain"). */
  about: string;
  /** Her answer to the check-in question about it, when she answered one ("Yes, it was hard"). */
  answer: string | null;
  /** Her words: typed with it, or her note on that topic that day. */
  words: string | null;
  /** button, typed, follow_up, safety or photo (symptom_observations.source). */
  source: string;
};

export type ReportFollowUp = {
  day: string;
  about: string;
  level: number | null;
  /** Local "HH:MM" it went out, null when it hasn't. */
  sentAt: string | null;
  /** Better, About the same, Worse; null when not answered. */
  answer: string | null;
  answeredAt: string | null;
};

export type ReportFlag = {
  ruleId: RuleId;
  status: "new" | "told" | "noted";
  severity: Severity | null;
  /** Local date it was first stored. */
  createdOn: string;
  toldOn: string | null;
  notedOn: string | null;
  evidence: Evidence[];
};

export type ReportDose = "taken" | "not confirmed" | "no reminder";

export type ReportPaperCheck = {
  day: string;
  organization: string | null;
  paperDate: string | null;
  outcome: "flag" | "checked" | "skipped" | "rejected" | "awaiting";
  discrepancies: Discrepancy[];
};

export type DoctorReport = {
  /** Local date the report was made, and the instant. */
  generatedOn: string;
  generatedAt: string;
  from: string;
  to: string;
  days: string[];
  patient: {
    id: string;
    preferredName: string;
    /** As in the record; null without a stored record. */
    name: string | null;
    birthDate: string | null;
    /** Age on the last day of the week. */
    age: number | null;
    gender: string | null;
    /** FinchNode's patient record id (the record has no MRN). */
    recordId: string | null;
    /** Active conditions with their code as in the record ("http://snomed.info/sct|433144002"). */
    conditions: { name: string; system: string | null; code: string | null; onsetDate: string | null }[];
    /** The record's sources by name ("Northstar Health System (Synthetic)"). */
    sources: string[];
    dataAsOf: string | null;
    record: "ok" | "none";
    timezone: string;
  };
  checkins: {
    perDay: { day: string; outcome: CheckinOutcome; mood: string | null }[];
    answered: number;
    notToday: number;
    missed: number;
    inProgress: number;
    none: number;
  };
  /** The week's highest ladder level, the earliest at that level. */
  highest: ReportSymptom | null;
  /** Everything the ladder put at level 1 and up, highest first, then by date. One per topic and day. */
  symptoms: ReportSymptom[];
  followUps: ReportFollowUp[];
  vitals: {
    readings: { day: string; time: string; heartRate: number | null; breathingRate: number | null; method: string; confidence: number | null; inUsualRange?: boolean }[];
    usualRange: CareFacts["vitals"]["usualRange"];
  };
  medicines: {
    active: {
      key: string;
      /** As in the record ("apixaban 5 MG Oral Tablet"). */
      recordName: string;
      /** Plain name and strength ("apixaban 5 mg"), as reminders and label checks say it. */
      plain: string;
      rxnorm: string | null;
      sig: string | null;
      lastFill: string | null;
      daysSupply: number | null;
      runsOut: string | null;
    }[];
    adherence: { day: string; morning: ReportDose; evening: ReportDose }[];
    totals: { morning: { taken: number; notConfirmed: number }; evening: { taken: number; notConfirmed: number } };
    labelMismatches: { day: string; outcome: "strength_differs" | "not_on_list"; label: string; onHerList: string | null }[];
    refills: { medicine: string; runsOut: string; status: "reminded" | "asked" | "snoozed"; remindedOn: string; familyTold: boolean }[];
    paperChecks: ReportPaperCheck[];
  };
  /** The latest usable result of each lab test (LOINC) in her record as of the last day, with the one before it. */
  labs: { loinc: string | null; name: string; value: number; unit: string; date: string; low: number | null; high: number | null; previous: { value: number; date: string } | null }[];
  flags: ReportFlag[];
  visitQuestions: { day: string; text: string }[];
  notes: { day: string; about: string; text: string }[];
};

export type BuildDoctorReportOptions = {
  /** First day (YYYY-MM-DD). Default: six days before `to`. */
  from?: string;
  /** Last day, the check-in date (YYYY-MM-DD). Default: her latest check-in date, else today in her time zone. */
  to?: string;
  /** Her FinchNode record, normalized. Default: the latest stored snapshot. */
  record?: PatientRecord;
  rxnav?: RxNavCache;
  /** The instant the report is made (ISO). Default: now. */
  now?: string;
};

/** The first day of a report week ending on `day`. */
export function weekStart(day: string): string {
  return plusDays(day, -(REPORT_DAYS - 1));
}

/** YYYY-MM-DD of an instant in a time zone. */
export function localDay(iso: string, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(iso));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** "HH:MM" of an instant in a time zone. */
export function localClock(iso: string, timezone: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));
}

/** Every day from `from` to `to`, both included. */
export function daysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to && out.length < 366; d = plusDays(d, 1)) out.push(d);
  return out;
}

/** Her latest check-in date, if she has one. */
export function latestCheckinDay(db: Db, patientId: string): string | undefined {
  const row = db.prepare(`SELECT MAX(date) AS day FROM checkins WHERE patient_id = ?`).get(patientId) as { day: string | null };
  return row.day ?? undefined;
}

/** Her stored record copy, normalized, if there is one. */
export function storedRecord(db: Db, patientId: string, rxnav: RxNavCache): PatientRecord | undefined {
  const snapshot = latestSnapshot(db, patientId);
  return snapshot ? normalizeHealthRecord(JSON.parse(snapshot.rawJson) as HealthRecord, { rxnav }) : undefined;
}

const shortWords = (text: string | null | undefined): string | null => {
  const t = (text ?? "").replace(/\s+/g, " ").trim();
  if (!t) return null;
  return t.length > 240 ? `${t.slice(0, 240).trimEnd()}...` : t;
};

type FlagRow = {
  ruleId: RuleId;
  status: "new" | "told" | "noted";
  severity: Severity | null;
  evidenceJson: string;
  createdAt: string;
  toldOn: string | null;
  notedAt: string | null;
};
type FollowUpRow = { reason: string; level: number | null; createdAt: string; day: string | null; sentAt: string | null; answer: string | null; answeredAt: string | null };
type PaperRow = { createdAt: string; extractedJson: string | null; confirmedAt: string | null; discrepanciesJson: string | null };

/**
 * One week of her data for her doctor: `from` to `to` (default the 7 days ending on her latest check-in
 * date), from the local database and her FinchNode record. Read only; nothing is written.
 */
export function buildDoctorReport(db: Db, patientId: string, options: BuildDoctorReportOptions = {}): DoctorReport {
  const patientRow = getCheckinPatient(db, patientId);
  if (!patientRow) throw new Error(`Unknown patient "${patientId}"`);
  const tz = (db.prepare(`SELECT timezone FROM patients WHERE id = ?`).get(patientId) as { timezone: string | null }).timezone ?? DEFAULT_TZ;
  const now = options.now ?? new Date().toISOString();
  const rxnav = options.rxnav ?? loadRxNavCache();

  const to = options.to ?? latestCheckinDay(db, patientId) ?? localDay(now, tz);
  const from = options.from ?? weekStart(to);
  if (from > to) throw new Error(`The report's first day (${from}) is after its last (${to}).`);
  const days = daysBetween(from, to);

  const fullRecord = options.record ?? storedRecord(db, patientId, rxnav);
  const record = fullRecord ? asOf(fullRecord, to) : undefined;

  // The care summaries' facts, one day at a time.
  const facts = days.map((day) => buildCareFacts(db, { patientId, day, trigger: "report", rxnav }));

  const perDay = facts.map((f) => ({ day: f.day, outcome: f.checkin.outcome, mood: f.checkin.mood }));
  const count = (o: CheckinOutcome) => perDay.filter((d) => d.outcome === o).length;

  const symptoms: ReportSymptom[] = facts.flatMap((f) =>
    f.severity.symptoms.map((s) => {
      const answer = f.checkin.answers.find((a) => a.questionId === s.topic)?.answer ?? null;
      const note = f.notes.find((n) => n.about === s.about)?.text ?? null;
      return { day: f.day, level: s.level, topic: s.topic, about: s.about, answer, words: shortWords(s.words !== s.topic ? s.words : null) ?? shortWords(note), source: s.source };
    }),
  );
  symptoms.sort((a, b) => b.level - a.level || (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));

  const followUps: ReportFollowUp[] = (
    db
      .prepare(
        `SELECT f.reason, f.level, f.created_at AS createdAt, c.date AS day, f.sent_at AS sentAt, f.answer, f.answered_at AS answeredAt
         FROM follow_ups f LEFT JOIN checkins c ON c.id = f.checkin_id WHERE f.patient_id = ? ORDER BY f.created_at, f.id`,
      )
      .all(patientId) as FollowUpRow[]
  )
    .map((r) => ({ ...r, day: r.day ?? localDay(r.createdAt, tz) }))
    .filter((r) => r.day >= from && r.day <= to)
    .map((r) => ({
      day: r.day,
      about: topicAbout(r.reason),
      level: r.level,
      sentAt: r.sentAt ? localClock(r.sentAt, tz) : null,
      answer: r.answer,
      answeredAt: r.answeredAt ? localClock(r.answeredAt, tz) : null,
    }));

  const readings = facts.flatMap((f) =>
    f.vitals.readings.map((r) => ({
      day: f.day,
      time: localClock(r.takenAt, tz),
      heartRate: r.heartRate,
      breathingRate: r.breathingRate,
      method: r.method,
      confidence: r.confidence,
      ...(r.inUsualRange !== undefined ? { inUsualRange: r.inUsualRange } : {}),
    })),
  );
  const usualRange = facts.at(-1)?.vitals.usualRange ?? null;

  const active = record
    ? activeMedications(record).map((m) => {
        const fill = latestFill(record.dispenses, m.key);
        return {
          key: m.key,
          recordName: m.name,
          plain: plainName(m),
          rxnorm: m.rxnorm ?? null,
          sig: m.sig ?? null,
          lastFill: fill?.date ?? null,
          daysSupply: fill?.daysSupply ?? null,
          runsOut: fill ? plusDays(fill.date, fill.daysSupply) : null,
        };
      })
    : [];

  const adherence = facts.map((f) => {
    const slot = (s: "morning" | "evening"): ReportDose => f.medicines.doses.find((d) => d.slot === s)?.status ?? "no reminder";
    return { day: f.day, morning: slot("morning"), evening: slot("evening") };
  });
  const tally = (s: "morning" | "evening") => ({
    taken: adherence.filter((a) => a[s] === "taken").length,
    notConfirmed: adherence.filter((a) => a[s] === "not confirmed").length,
  });

  const labelMismatches = facts.flatMap((f) => f.medicines.labelMismatches.map((l) => ({ day: f.day, ...l })));

  // A refill shows on each day it was reminded or answered; the week keeps its latest state.
  const refillMap = new Map<string, DoctorReport["medicines"]["refills"][number]>();
  for (const f of facts)
    for (const r of f.medicines.refills) {
      const key = `${r.medicine}|${r.runsOut}`;
      const seen = refillMap.get(key);
      refillMap.set(key, { medicine: r.medicine, runsOut: r.runsOut, status: r.status, remindedOn: seen?.remindedOn ?? f.day, familyTold: r.familyTold || (seen?.familyTold ?? false) });
    }

  const paperChecks: ReportPaperCheck[] = (
    db.prepare(`SELECT created_at AS createdAt, extracted_json AS extractedJson, confirmed_at AS confirmedAt, discrepancies_json AS discrepanciesJson FROM paper_scans WHERE patient_id = ? ORDER BY id`).all(patientId) as PaperRow[]
  )
    .map((p) => ({ ...p, day: localDay(p.createdAt, tz) }))
    .filter((p) => p.day >= from && p.day <= to)
    .map((p) => {
      const paper = JSON.parse(p.extractedJson ?? "null") as { organization?: string; date?: string } | null;
      const outcome = p.discrepanciesJson ? (JSON.parse(p.discrepanciesJson) as { outcome: ReportPaperCheck["outcome"]; discrepancies?: Discrepancy[] }) : null;
      return {
        day: p.day,
        organization: paper?.organization ?? null,
        paperDate: paper?.date ?? null,
        outcome: outcome?.outcome ?? "awaiting",
        discrepancies: outcome?.discrepancies ?? [],
      };
    });

  const flags: ReportFlag[] = (
    db
      .prepare(
        `SELECT rule_id AS ruleId, status, severity, evidence_json AS evidenceJson, created_at AS createdAt, told_on AS toldOn, noted_at AS notedAt
         FROM flags WHERE patient_id = ? AND status != 'cleared' ORDER BY rule_id, created_at, id`,
      )
      .all(patientId) as FlagRow[]
  ).map((f) => ({
    ruleId: f.ruleId,
    status: f.status,
    severity: f.severity,
    createdOn: localDay(f.createdAt, tz),
    toldOn: f.toldOn,
    notedOn: f.notedAt ? localDay(f.notedAt, tz) : null,
    evidence: JSON.parse(f.evidenceJson) as Evidence[],
  }));

  // Latest usable numeric result per lab test, newest first, with the result before it.
  const labGroups = new Map<string, Measurement[]>();
  for (const m of record?.labs ?? []) {
    if (!m.usable || m.value === undefined || m.date === undefined) continue;
    labGroups.set(m.key, [...(labGroups.get(m.key) ?? []), m]);
  }
  const labs = [...labGroups.values()]
    .map((group) => group.sort((a, b) => (a.date! < b.date! ? -1 : a.date! > b.date! ? 1 : 0)))
    .map((group) => {
      const last = group.at(-1)!;
      const prev = group.at(-2);
      return {
        loinc: last.loinc ?? null,
        name: last.name,
        value: last.value!,
        unit: last.unit ?? "",
        date: last.date!,
        low: last.referenceRange?.low ?? null,
        high: last.referenceRange?.high ?? null,
        previous: prev ? { value: prev.value!, date: prev.date! } : null,
      };
    })
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

  const birthDate = record?.demographics.birthDate ?? null;
  return {
    generatedOn: localDay(now, tz),
    generatedAt: now,
    from,
    to,
    days,
    patient: {
      id: patientId,
      preferredName: patientRow.preferredName,
      name: record?.demographics.name ?? null,
      birthDate,
      age: birthDate ? ageOn(birthDate, to) : null,
      gender: record?.demographics.gender ?? null,
      recordId: record?.demographics.recordId ?? null,
      conditions: record
        ? record.conditions.filter(isActiveCondition).map((c) => {
            const bar = c.key.lastIndexOf("|");
            const coded = bar > 0 && !c.key.startsWith("name|");
            return { name: c.name, system: coded ? c.key.slice(0, bar) : null, code: coded ? c.key.slice(bar + 1) : null, onsetDate: c.onsetDate ?? null };
          })
        : [],
      sources: record ? record.sources.map((s) => s.name ?? s.system) : [],
      dataAsOf: record?.dataAsOf ?? null,
      record: record ? "ok" : "none",
      timezone: tz,
    },
    checkins: { perDay, answered: count("checked_in"), notToday: count("not_today"), missed: count("missed"), inProgress: count("in_progress"), none: count("none") },
    highest: symptoms[0] ?? null,
    symptoms,
    followUps,
    vitals: { readings, usualRange },
    medicines: {
      active,
      adherence,
      totals: { morning: tally("morning"), evening: tally("evening") },
      labelMismatches,
      refills: [...refillMap.values()],
      paperChecks,
    },
    labs,
    flags,
    visitQuestions: facts.flatMap((f) => f.visitQuestions.map((text) => ({ day: f.day, text }))),
    notes: facts.flatMap((f) => f.notes.map((n) => ({ day: f.day, about: n.about, text: n.text }))),
  };
}
