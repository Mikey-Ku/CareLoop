import { CARE_NO_REPLY, type LlmClient } from "../llm/types.ts";
import type { CareAudience, CareContacts } from "./contacts.ts";
import {
  DOCTOR_RULE_LABELS,
  FAMILY_CLOSING,
  FAMILY_RULE_LABELS,
  doctorSummary,
  familyAttention,
  familyGreeting,
  familySummary,
  familyVisible,
  localTime,
} from "./copy.ts";
import { LEVEL_WORDS, type CareFacts } from "./facts.ts";
import { guardReply, type ReplyRequest, type ReplyWriter } from "./replies.ts";

// The care texts' wording through the shared LlmClient (Gemini; one provider for the app). The model
// only words: it sees the day's facts as plain data, already cut to what its reader may see.
//   Doctor: a few overview lines on top of the fixed data sections (a model left out a level-3
//     follow-up when it wrote the whole data summary in a live test, so the data lines stay fixed).
//   Emergency contact: the body of the update, between the fixed greeting (with the AI disclosure),
//     the fixed paragraph about anything urgent, and the fixed closing.
//   Replies to their texts: worded from the facts, the summary as sent and the thread.
// So a model can't drop or soften what is urgent. Every written text is checked (checkWritten:
// length, dashes, markdown, dosing advice, diagnosis words, 911, numbers not in the facts); on any
// failure the fixed template (src/care/copy.ts) goes out instead.

/** Longest written body or reply, in characters, per reader. */
export const MAX_WRITTEN_CHARS: Record<CareAudience, number> = { doctor: 1200, family: 900 };
/** Longest doctor's overview, in characters (about 4 lines). */
export const MAX_DOCTOR_OVERVIEW_CHARS = 600;

export const DOSING_ADVICE = [
  /\b(you|she|harriet|they|he) (should|could|can|must|needs? to|ought to) (take|stop|start|increase|decrease|double|skip|halve|reduce|cut)\b/i,
  /\b(increase|decrease|double|halve|reduce|raise|lower|cut|adjust|skip|stop)\s+(her|the|his|your)\s+(dose|dosage|medication|medicine|metformin|apixaban|pills?)\b/i,
  /\b(stop|start)\s+(taking|her|the)\s+\w+/i,
];
const DIAGNOSIS = /\bdiagnos\w*|\b(likely|probably|could be|might be|sounds like|suggests?|consistent with)\s+(a |an )?(heart failure|infection|stroke|heart attack|pneumonia|fluid|kidney|bleed)/i;

/**
 * A written text fit to send, or undefined. Cleans markdown and (for the family) exclamation marks, then
 * rejects: empty or too long, long dashes, dosing advice, diagnosis words, 911 (only fixed copy says
 * 911), and any number above 20 that isn't in the facts it was written from (no invented values).
 */
export function checkWritten(text: string, audience: CareAudience, facts: unknown): string | undefined {
  const cleaned = guardReply(text, audience);
  if (!cleaned || cleaned.length > MAX_WRITTEN_CHARS[audience]) return undefined;
  if (/[–—]/.test(text)) return undefined;
  if (DOSING_ADVICE.some((re) => re.test(cleaned)) || DIAGNOSIS.test(cleaned) || /\b911\b/.test(cleaned)) return undefined;
  const known = JSON.stringify(facts);
  for (const n of cleaned.match(/\d+(?:\.\d+)?/g) ?? []) {
    if (Number(n) <= 20 && !n.includes(".")) continue; // counts and levels
    if (!known.includes(n)) return undefined;
  }
  return cleaned;
}

/** What the doctor's model sees: the day's facts with times in her time zone and numbers rounded. */
export function doctorView(f: CareFacts, contacts: CareContacts) {
  const tz = f.patient.timezone;
  const at = (iso: string | null) => (iso ? localTime(iso, tz) : null);
  const ec = contacts.emergencyContact;
  return {
    patient: { name: f.patient.fullName ?? f.patient.preferredName, age: f.patient.age, syntheticDemoPatient: true },
    day: f.day,
    recordDataAsOf: f.dataAsOf,
    checkin: { outcome: f.checkin.outcome, sentAt: at(f.checkin.startedAt), finishedAt: at(f.checkin.finishedAt), mood: f.checkin.mood, answers: f.checkin.answers.map((a) => ({ question: a.question, answer: a.answer, routine: !a.worrying })) },
    redFlags: f.redFlags.map((r) => ({ question: r.question, answer: r.answer })),
    familyAlertedInRelay: f.familyAlerted,
    severityLadder: f.severity.symptoms.map((s) => ({ level: s.level, meaning: LEVEL_WORDS[s.level], about: s.about, herWords: s.words, how: s.source })),
    herNotesForTheDoctor: f.notes,
    visitQuestionsToday: f.visitQuestions,
    medicinesToday: f.medicines,
    cameraVitals: {
      note: "camera estimate, wellness only, not a diagnostic reading",
      readings: f.vitals.readings.map((r) => ({
        at: at(r.takenAt),
        heartRateBpm: r.heartRate === null ? null : Math.round(r.heartRate),
        breathingPerMin: r.breathingRate === null ? null : Math.round(r.breathingRate),
        ...(r.inUsualRange === undefined ? {} : { inUsualRange: r.inUsualRange }),
      })),
      usualClinicHeartRate: f.vitals.usualRange?.heartRate ?? null,
      notCompared: f.vitals.usualRange?.note ?? null,
    },
    recordFlags: f.flags.map((x) => ({
      rule: `${x.ruleId} ${DOCTOR_RULE_LABELS[x.ruleId]}`,
      severity: x.severity,
      status: x.status,
      evidence: [...new Set(x.evidence.map((e) => `${e.value}${e.date ? ` (${e.date})` : ""}`))].slice(0, 5),
    })),
    recentLabs: f.recentLabs.slice(0, 6).map((l) => `${l.name} ${l.value} ${l.unit} (${l.date})`),
    medications: f.medications.map((m) => m.name),
    conditions: f.conditions,
    sharedOnHerCall: f.memories,
    emergencyContact: { name: ec.name, relationship: ec.relationship ?? null },
  };
}

/**
 * What the emergency contact's model sees: only what her sharing level lets them read (familyVisible,
 * the same cut as the family template): how the check-in went, whether something urgent came up (its
 * fixed paragraph is added by code), the camera reading as the level allows, and at "all" her answers,
 * flags she has heard, other symptoms, notes, visit questions, medicines and memories. No phone numbers.
 */
export function familyView(f: CareFacts, contacts: CareContacts) {
  const v = familyVisible(f);
  const sharing = f.patient.sharing;
  const last = f.vitals.readings.at(-1);
  const camera =
    !last || sharing === "status"
      ? null
      : {
          note: "a camera estimate, not a medical test",
          ...(last.inUsualRange === undefined ? { checked: true, comparedWithUsualRange: false } : { withinHerUsualRange: last.inUsualRange }),
          ...(sharing === "all"
            ? {
                heartRateAbout: last.heartRate === null ? null : Math.round(last.heartRate),
                breathingAbout: last.breathingRate === null ? null : Math.round(last.breathingRate),
                ...(last.inUsualRange === undefined && /atrial fibrillation/i.test(f.vitals.usualRange?.note ?? "") ? { irregularHeartbeatSoOnlyARoughEstimate: true } : {}),
              }
            : {}),
        };
  return {
    seniorName: f.patient.preferredName,
    day: f.day,
    checkin: { outcome: f.checkin.outcome, answers: v.answers.map((a) => ({ question: a.question, answer: a.answer })) },
    somethingUrgentToday: f.redFlags.length > 0,
    cameraCheck: camera,
    onHerListToAskTheDoctor: v.heardFlags.map((x) => FAMILY_RULE_LABELS[x.ruleId]),
    alsoMentioned: v.symptoms.map((s) => ({ about: s.about, howMuch: LEVEL_WORDS[s.level], herWords: s.words })),
    herNotesForTheDoctor: v.notes,
    visitQuestions: v.visitQuestions,
    medicineReminders: v.doses,
    labelPhotosThatDidntMatch: v.labelMismatches.map((l) => l.label),
    refills: v.refills,
    sharedOnHerCall: v.memories,
    doctor: { name: contacts.doctor.name },
  };
}

const viewFor = (audience: CareAudience, f: CareFacts, contacts: CareContacts) => (audience === "doctor" ? doctorView(f, contacts) : familyView(f, contacts));

export type SummaryRequest = { audience: CareAudience; facts: CareFacts; contacts: CareContacts };

/** Words care texts with the shared LlmClient. Each method throws on failure; the caller sends the template. */
export class GeminiCareWriter implements ReplyWriter {
  private readonly llm: LlmClient;

  constructor(llm: LlmClient) {
    this.llm = llm;
  }

  /** The checked body of the day's summary for one reader. */
  async writeSummary(request: SummaryRequest): Promise<string> {
    const { audience, facts, contacts } = request;
    const view = viewFor(audience, facts, contacts);
    const recipientName = audience === "doctor" ? contacts.doctor.name : contacts.emergencyContact.name;
    const text = await this.llm.writeCareMessage({ audience, recipientName, seniorName: facts.patient.preferredName, facts: view });
    const checked = checkWritten(text, audience, view);
    if (!checked || (audience === "doctor" && checked.length > MAX_DOCTOR_OVERVIEW_CHARS)) throw new Error("written summary failed the checks");
    return checked;
  }

  /** A reply from the facts the summary was built from, the summary as sent and the thread; null when none is needed. */
  async write(request: ReplyRequest): Promise<string | null> {
    const audience = request.contact.audience;
    const view = viewFor(audience, request.facts, request.contacts);
    const text = await this.llm.writeCareMessage({
      audience,
      recipientName: request.contact.name,
      seniorName: request.facts.patient.preferredName,
      facts: view,
      question: request.message,
      summaryText: request.summaryText,
      thread: request.thread,
    });
    if (text.trim() === CARE_NO_REPLY) return null;
    const checked = checkWritten(text, audience, { view, summary: request.summaryText });
    if (!checked) throw new Error("written reply failed the checks");
    return checked;
  }
}

/** The fixed parts around a written body: the doctor's overview over the fixed data sections; the family's body between the greeting, urgent paragraph and closing. */
export function wrapWritten(audience: CareAudience, body: string, facts: CareFacts, contacts: CareContacts): string {
  if (audience === "doctor") return doctorSummary(facts, contacts, body);
  const attention = familyAttention(facts, contacts);
  return [familyGreeting(facts, contacts), ...(attention ? [attention] : []), body, FAMILY_CLOSING].join("\n\n");
}

/** The fixed template for one reader. */
export function templateSummary(audience: CareAudience, facts: CareFacts, contacts: CareContacts): string {
  return audience === "doctor" ? doctorSummary(facts, contacts) : familySummary(facts, contacts);
}

/** The summary text to send: the written body inside the fixed parts, else the template. Never throws. */
export async function composeSummary(
  writer: ReplyWriter | undefined,
  request: SummaryRequest,
  log: (line: string) => void = () => {},
): Promise<{ text: string; by: "writer" | "template" }> {
  if (writer?.writeSummary) {
    try {
      const body = await writer.writeSummary(request);
      return { text: wrapWritten(request.audience, body, request.facts, request.contacts), by: "writer" };
    } catch (error) {
      log(`[care] ${request.audience} summary writer failed (${error instanceof Error ? error.message : String(error)}); sending the template`);
    }
  }
  return { text: templateSummary(request.audience, request.facts, request.contacts), by: "template" };
}
