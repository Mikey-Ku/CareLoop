import { buildContextPacket, type ContextPacket } from "../context/packet.ts";
import { QUESTION_BANK, isWorryingAnswer } from "../context/questions.ts";
import { evaluateRedFlag } from "../checkin/red-flags.ts";
import { getCheckin, getCheckinPatient, type CheckinRow } from "../db/checkins.ts";
import { familyChats } from "../db/family.ts";
import { latestSnapshot, type Db } from "../db/index.ts";
import { normalizeHealthRecord } from "../finchnode/normalize.ts";
import type { RxNavCache } from "../finchnode/rxnav.ts";
import type { HealthRecord } from "../finchnode/types.ts";
import type { Evidence, RuleId, Severity } from "../rules/index.ts";

// The facts behind one care summary: what she said in the day's check-in (and, once
// lanes 2 and 3 land, what the calls stored), her camera vitals, the stored flags with
// their evidence, and the parts of her record a doctor would want next to them. Read
// from SQLite and the latest stored snapshot only; nothing here calls FinchNode, Relay
// or an LLM. Red flags are recomputed from her stored answers with the same fixed rule
// the check-in used (evaluateRedFlag), so the summary never decides what is urgent.

export type CheckinOutcome = "checked_in" | "not_today" | "missed" | "in_progress" | "none";

export type CareFacts = {
  patient: { id: string; preferredName: string; fullName: string | null; age: number | null; timezone: string | null };
  /** Check-in date (YYYY-MM-DD) the summary is about. */
  day: string;
  /** What sent it: "day" (check-in ended or noon), "call:<id>", "manual:<n>". */
  trigger: string;
  /** Snapshot meta.dataAsOf, null when no record copy is stored. */
  dataAsOf: string | null;
  /** "none": no stored record copy (record consent ended, or never read). */
  record: "ok" | "none";
  checkin: {
    outcome: CheckinOutcome;
    mood: string | null;
    answers: { questionId: string; question: string; answer: string; at: string; worrying: boolean }[];
    startedAt: string | null;
    finishedAt: string | null;
  };
  /** Answers a fixed red-flag rule treats as urgent. Each one alerted her family chats in Relay. */
  redFlags: { questionId: string; question: string; answer: string }[];
  /** Family members linked in Relay, who got any red-flag alert there. */
  familyAlerted: string[];
  vitals: {
    readings: {
      takenAt: string;
      heartRate: number | null;
      breathingRate: number | null;
      method: string;
      confidence: number | null;
      /** Undefined when readings aren't compared (no usual range, or atrial fibrillation). */
      inUsualRange?: boolean;
    }[];
    usualRange: ContextPacket["usualRange"] | null;
  };
  flags: { ruleId: RuleId; status: "new" | "told" | "noted"; severity: Severity | null; message: string; evidence: Evidence[] }[];
  conditions: string[];
  medications: ContextPacket["medications"];
  recentLabs: ContextPacket["recentLabs"];
  /** Things she told the voice companion that day, newest first (memories, lane 2). */
  memories: string[];
};

export type BuildCareFactsInput = { patientId: string; day: string; trigger: string; rxnav: RxNavCache };

const QUESTIONS = new Map(QUESTION_BANK.map((q) => [q.id, q]));

function outcomeOf(c: CheckinRow | undefined): CheckinOutcome {
  if (!c) return "none";
  if (c.status === "skipped") return "not_today";
  if (c.status === "missed") return "missed";
  if (c.status === "answered" || c.finishedAt !== null) return "checked_in";
  return "in_progress";
}

type FlagRow = { ruleId: RuleId; status: "new" | "told" | "noted"; severity: Severity | null; message: string; evidenceJson: string };
type VitalsRow = { takenAt: string; heartRate: number | null; breathingRate: number | null; method: string; confidence: number | null };

export function buildCareFacts(db: Db, input: BuildCareFactsInput): CareFacts {
  const { patientId, day } = input;
  const patient = getCheckinPatient(db, patientId);
  if (!patient) throw new Error(`Unknown patient "${patientId}"`);

  const snapshot = latestSnapshot(db, patientId);
  const record = snapshot ? normalizeHealthRecord(JSON.parse(snapshot.rawJson) as HealthRecord, { rxnav: input.rxnav }) : undefined;
  const packet = record ? buildContextPacket({ record, ruleResults: [], checkinDate: day, flags: [], preferredName: patient.preferredName }) : undefined;

  const checkin = getCheckin(db, patientId, day);
  const answers = (checkin?.answers ?? []).map((a) => ({
    questionId: a.questionId,
    question: a.questionText,
    answer: a.answer,
    at: a.at,
    worrying: isWorryingAnswer(a.questionId, a.answer),
  }));
  const redFlags = (checkin?.answers ?? []).flatMap((a) => {
    const q = QUESTIONS.get(a.questionId);
    const red = q ? evaluateRedFlag(q, a.answer) : undefined;
    return red ? [{ questionId: red.questionId, question: red.questionText, answer: red.answer }] : [];
  });

  const usualRange = packet?.usualRange ?? null;
  const vitalsRows = db
    .prepare(
      `SELECT taken_at AS takenAt, heart_rate AS heartRate, breathing_rate AS breathingRate, method, confidence
       FROM vitals_readings WHERE patient_id = ? AND substr(taken_at, 1, 10) = ? ORDER BY taken_at`,
    )
    .all(patientId, day) as VitalsRow[];
  const readings = vitalsRows.map((v) => {
    const range = usualRange?.compareHeartRate ? usualRange.heartRate : undefined;
    return {
      ...v,
      ...(range && v.heartRate !== null ? { inUsualRange: v.heartRate >= range.low && v.heartRate <= range.high } : {}),
    };
  });

  const flags = (
    db
      .prepare(
        `SELECT rule_id AS ruleId, status, severity, message, evidence_json AS evidenceJson FROM flags
         WHERE patient_id = ? AND status != 'cleared'
         ORDER BY CASE severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 WHEN 'low' THEN 2 ELSE 3 END, created_at, id`,
      )
      .all(patientId) as FlagRow[]
  ).map(({ evidenceJson, ...f }) => ({ ...f, evidence: JSON.parse(evidenceJson) as Evidence[] }));

  const memories = (
    db
      .prepare(`SELECT text FROM memories WHERE patient_id = ? AND deleted_at IS NULL AND substr(created_at, 1, 10) = ? ORDER BY created_at DESC, id DESC`)
      .all(patientId, day) as { text: string }[]
  ).map((m) => m.text);

  return {
    patient: {
      id: patientId,
      preferredName: patient.preferredName,
      fullName: record?.demographics.name ?? null,
      age: packet?.patient.age ?? null,
      timezone: (db.prepare(`SELECT timezone FROM patients WHERE id = ?`).get(patientId) as { timezone: string | null }).timezone,
    },
    day,
    trigger: input.trigger,
    dataAsOf: record?.dataAsOf ?? null,
    record: record ? "ok" : "none",
    checkin: {
      outcome: outcomeOf(checkin),
      mood: checkin?.mood ?? null,
      answers,
      startedAt: checkin?.sentAt ?? null,
      finishedAt: checkin?.finishedAt ?? null,
    },
    redFlags,
    familyAlerted: redFlags.length > 0 ? familyChats(db, patientId).map((f) => f.displayName || f.handle) : [],
    vitals: { readings, usualRange },
    flags,
    conditions: packet?.conditions ?? [],
    medications: packet?.medications ?? [],
    recentLabs: packet?.recentLabs ?? [],
    memories,
  };
}
