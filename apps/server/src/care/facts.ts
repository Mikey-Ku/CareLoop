import { buildContextPacket, type ContextPacket } from "../context/packet.ts";
import { QUESTION_BANK, isWorryingAnswer } from "../context/questions.ts";
import { evaluateRedFlag } from "../checkin/red-flags.ts";
import { getCheckin, getCheckinPatient, type CheckinRow } from "../db/checkins.ts";
import { familyChats } from "../db/family.ts";
import { getSharing, latestSnapshot, type Db, type SharingLevel } from "../db/index.ts";
import { checkinNotes } from "../db/notes.ts";
import { normalizeHealthRecord } from "../finchnode/normalize.ts";
import type { RxNavCache } from "../finchnode/rxnav.ts";
import type { HealthRecord } from "../finchnode/types.ts";
import { plainName } from "../meds/schedule.ts";
import type { Evidence, RuleId, Severity } from "../rules/index.ts";

// The facts behind one care summary: what she said in the day's check-in (and, once
// lanes 2 and 3 land, what the calls stored), her camera vitals, the stored flags with
// their evidence, and the parts of her record a doctor would want next to them. Read
// from SQLite and the latest stored snapshot only; nothing here calls FinchNode, Relay
// or an LLM. Red flags are recomputed from her stored answers with the same fixed rule
// the check-in used (evaluateRedFlag), so the summary never decides what is urgent.
//
// Also the day's data from the rest of the app: the severity ladder's levels and topics
// (symptom_observations), her notes for the doctor (checkin_notes), her visit questions,
// medicine adherence (med_doses), label photos that didn't match her list (med_label_checks)
// and refills reminded or asked about (med_refills). Everything is plain data; what the
// emergency contact may see of it is cut by her sharing level in src/care/copy.ts.

export type CheckinOutcome = "checked_in" | "not_today" | "missed" | "in_progress" | "none";

/** Ladder levels (docs/DESIGN.md "Severity ladder") in plain words. */
export const LEVEL_WORDS: Record<number, string> = {
  1: "small, everyday",
  2: "worth watching",
  3: "call the doctor today",
  4: "emergency",
  5: "crisis",
};

/** One urgent thing today (level 3 and up). */
export type CareRedFlag = {
  /** A question id, a safety kind ("crisis", "urgent_symptom"), her topic words, or "concern". */
  questionId: string;
  /** The question as she saw it, or the topic in plain words. */
  question: string;
  /** Her answer, her words, or what happened ("Worse" on the follow-up). */
  answer: string;
  level: number;
  /** answer: a red-flag answer; typed, follow_up, safety: an observation; concern: the check-in's concern mark. */
  source: "answer" | "typed" | "follow_up" | "safety" | "button" | "photo" | "concern";
};

/** One thing the ladder levelled today, 1 and up. */
export type CareSymptom = {
  level: number;
  /** The ladder's topic: a question id, a safety kind, or her own topic words. */
  topic: string;
  /** The topic in plain words ("breathing when lying flat", "knee pain", "a medicine label check"). */
  about: string;
  /** Her words for it, when she typed them. */
  words: string | null;
  /** How it came in: a tap, her typed words, a follow-up answer, the safety screen or a label photo. */
  source: string;
};

export type CareFacts = {
  patient: {
    id: string;
    preferredName: string;
    fullName: string | null;
    age: number | null;
    timezone: string | null;
    /** Her sharing level when the summary was built; cuts what the emergency contact sees of the day's extra data. */
    sharing: SharingLevel;
  };
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
  /**
   * Everything urgent today (level 3 and up), each of which alerted her family chats in Relay: answers a
   * fixed red-flag rule treats as urgent, then the day's other level-3+ observations (a typed symptom, a
   * "Worse" on a follow-up, a safety screen hit), then a concern the check-in noted (concern_at) that
   * nothing else explains. One per topic, highest level first after the answers.
   */
  redFlags: CareRedFlag[];
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
  /** The day's severity ladder: everything at level 1 and up, highest first (symptom_observations). */
  severity: { highest: CareSymptom | null; symptoms: CareSymptom[] };
  /** Her own words kept for her doctor in the day's check-in, by topic (checkin_notes). */
  notes: { about: string; text: string }[];
  /** Questions she asked today, for her next visit (visit_questions). */
  visitQuestions: string[];
  medicines: {
    /** The day's medicines reminders: "taken" after her tap, else "not confirmed". */
    doses: { slot: "morning" | "evening"; status: "taken" | "not confirmed" }[];
    /** Label photos today that didn't match her list. */
    labelMismatches: { outcome: "strength_differs" | "not_on_list"; label: string; onHerList: string | null }[];
    /** Refills she was reminded about today, or said she asked for today. */
    refills: { medicine: string; runsOut: string; status: "reminded" | "asked" | "snoozed"; familyTold: boolean }[];
  };
};

/** Topic words for the doctor and family: a question's subject, a safety kind, or her own topic words. */
const TOPIC_ABOUT: Record<string, string> = {
  "hf-ankle-swelling": "ankle swelling",
  "hf-breathing-lying-flat": "breathing when lying flat",
  "anticoagulant-bleeding": "bruising or bleeding",
  "dizzy-on-standing": "dizziness on standing",
  "morning-medicines": "morning medicines",
  mood: "mood",
  crisis: "a crisis (safety screen)",
  urgent_symptom: "an urgent symptom (safety screen)",
  "medicine check": "a medicine label that didn't match her list",
  general: "a general follow-up",
};

/** A topic in plain words: from the table, else her own short topic words, else "another symptom". */
export function topicAbout(topic: string): string {
  const known = TOPIC_ABOUT[topic];
  if (known) return known;
  const words = topic.replace(/\s+/g, " ").trim().toLowerCase();
  return words && words.length <= 40 && /^[a-z][a-z' -]*$/.test(words) ? words : "another symptom";
}

/** Her words, one line, at most 200 characters. */
function oneLine(text: string | null | undefined): string | null {
  const t = (text ?? "").replace(/\s+/g, " ").trim();
  if (!t) return null;
  return t.length > 200 ? `${t.slice(0, 200).trimEnd()}...` : t;
}

type ObservationRow = { topic: string; level: number; source: string; words: string | null };

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
  const redFlags: CareRedFlag[] = (checkin?.answers ?? []).flatMap((a) => {
    const q = QUESTIONS.get(a.questionId);
    const red = q ? evaluateRedFlag(q, a.answer) : undefined;
    return red ? [{ questionId: red.questionId, question: red.questionText, answer: red.answer, level: 3, source: "answer" as const }] : [];
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

  // The severity ladder: one entry per topic at its highest level today, highest first.
  const observed = db
    .prepare(`SELECT topic, level, source, words FROM symptom_observations WHERE patient_id = ? AND day = ? AND level >= 1 ORDER BY level DESC, id`)
    .all(patientId, day) as ObservationRow[];
  const seenTopics = new Set<string>();
  const symptoms: CareSymptom[] = [];
  for (const o of observed) {
    if (seenTopics.has(o.topic)) continue;
    seenTopics.add(o.topic);
    symptoms.push({ level: o.level, topic: o.topic, about: topicAbout(o.topic), words: oneLine(o.words), source: o.source });
  }

  // The rest of today's urgent things, from the ladder's own record (one per topic, highest first).
  const flagged = new Set(redFlags.map((r) => r.questionId));
  for (const o of observed) {
    if (o.level < 3 || flagged.has(o.topic)) continue;
    flagged.add(o.topic);
    const q = QUESTIONS.get(o.topic);
    const what =
      o.source === "follow_up"
        ? '"Worse" on the follow-up'
        : o.topic === "crisis"
          ? "words about not wanting to live (988 given)"
          : o.topic === "urgent_symptom"
            ? "an urgent symptom (911 given)"
            : (oneLine(o.words) ?? `level ${o.level}`);
    redFlags.push({ questionId: o.topic, question: q?.text ?? topicAbout(o.topic), answer: what, level: o.level, source: o.source as CareRedFlag["source"] });
  }
  if (redFlags.length === 0 && checkin?.concernAt) {
    redFlags.push({ questionId: "concern", question: "A concern came up during the check-in", answer: "the check-in paused", level: 3, source: "concern" });
  }

  const notes = checkin ? checkinNotes(db, checkin.id).map((n) => ({ about: topicAbout(n.questionId ?? n.topic), text: oneLine(n.text) ?? "" })).filter((n) => n.text) : [];
  const visitQuestions = (
    db.prepare(`SELECT text FROM visit_questions WHERE patient_id = ? AND substr(created_at, 1, 10) = ? ORDER BY created_at, id`).all(patientId, day) as { text: string }[]
  ).flatMap((q) => oneLine(q.text) ?? []);

  const doses = (
    db.prepare(`SELECT slot, status FROM med_doses WHERE patient_id = ? AND day = ? ORDER BY CASE slot WHEN 'morning' THEN 0 ELSE 1 END`).all(patientId, day) as {
      slot: "morning" | "evening";
      status: string;
    }[]
  ).map((d) => ({ slot: d.slot, status: d.status === "taken" ? ("taken" as const) : ("not confirmed" as const) }));
  const meds = record?.medications ?? [];
  const labelMismatches = (
    db
      .prepare(
        `SELECT outcome, medication_key AS medicationKey, label_medicine AS labelMedicine, label_strength AS labelStrength FROM med_label_checks
         WHERE patient_id = ? AND substr(created_at, 1, 10) = ? AND outcome IN ('strength_differs', 'not_on_list') ORDER BY id`,
      )
      .all(patientId, day) as { outcome: "strength_differs" | "not_on_list"; medicationKey: string | null; labelMedicine: string | null; labelStrength: string | null }[]
  ).map((l) => {
    const listed = l.medicationKey ? meds.find((m) => m.key === l.medicationKey) : undefined;
    const label = [l.labelMedicine ?? "a medicine", l.labelStrength].filter(Boolean).join(" ");
    return { outcome: l.outcome, label, onHerList: listed ? plainName(listed) : null };
  });
  const refills = (
    db
      .prepare(
        `SELECT name, run_out AS runOut, status, family_told_at AS familyToldAt FROM med_refills
         WHERE patient_id = ? AND (last_reminded_day = ? OR substr(updated_at, 1, 10) = ?) ORDER BY run_out, id`,
      )
      .all(patientId, day, day) as { name: string; runOut: string; status: "reminded" | "asked" | "snoozed"; familyToldAt: string | null }[]
  ).map((r) => ({ medicine: r.name, runsOut: r.runOut, status: r.status, familyTold: r.familyToldAt !== null }));

  return {
    patient: {
      id: patientId,
      preferredName: patient.preferredName,
      fullName: record?.demographics.name ?? null,
      age: packet?.patient.age ?? null,
      timezone: (db.prepare(`SELECT timezone FROM patients WHERE id = ?`).get(patientId) as { timezone: string | null }).timezone,
      sharing: getSharing(db, patientId) ?? "status",
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
    severity: { highest: symptoms[0] ?? null, symptoms },
    notes,
    visitQuestions,
    medicines: { doses, labelMismatches, refills },
  };
}
