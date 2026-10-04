import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MISSED_JOB, startAgent, type AgentDeps, type RunningAgent } from "../src/agent.ts";
import { parseCareContacts, type CareContacts } from "../src/care/contacts.ts";
import {
  doctorActionReply,
  doctorSummary,
  familyAskDoctorReply,
  familyCrisisReply,
  familyEmergencyReply,
  familySummary,
  familySymptomReply,
  noSummaryReply,
} from "../src/care/copy.ts";
import { buildCareFacts, type CareFacts } from "../src/care/facts.ts";
import { classifyInbound, guardReply, type ReplyRequest, type ReplyWriter } from "../src/care/replies.ts";
import { startCareRuntime, type CareRuntime } from "../src/care/runtime.ts";
import { GeminiCareWriter, checkWritten, doctorView, familyView } from "../src/care/writer.ts";
import { CARE_NO_REPLY, FakeLlmClient, LlmUnavailableError, type CareMessageInput } from "../src/llm/index.ts";
import { careMessageSystemPrompt } from "../src/llm/gemini.ts";
import { createCheckinEngine, type DayFinished } from "../src/checkin/engine.ts";
import type { CheckinEngine } from "../src/checkin/engine-types.ts";
import { parseScript, runSimulation, snapshotLoader } from "../src/cli/simulator.ts";
import { loadConfig } from "../src/config.ts";
import { careMessages, latestSentSummary } from "../src/db/care.ts";
import { getCheckin } from "../src/db/checkins.ts";
import { linkFamilyMember, syncFamilyMembers } from "../src/db/family.ts";
import { openDatabase, setSharing, upsertPatient, type Db } from "../src/db/index.ts";
import { insertDose, insertLabelCheck, markRefillReminded, setDoseStatus } from "../src/db/meds.ts";
import { addCheckinNote, addVisitQuestion } from "../src/db/notes.ts";
import { addObservation } from "../src/db/observations.ts";
import { normalizeHealthRecord } from "../src/finchnode/normalize.ts";
import { REPO_ROOT, loadRxNavCache, loadSnapshot } from "../src/finchnode/fixtures.ts";
import { FakeCareMessenger } from "../src/photon/fake-care-messenger.ts";
import { PhotonMessenger, type PhotonPort, type PortMessage } from "../src/photon/photon-messenger.ts";
import { FakeMessenger } from "../src/relay/fake-messenger.ts";
import type { RelayClient } from "../src/relay/relay-client.ts";
import type { SentMessage } from "../src/relay/messenger.ts";

const P = "harriet";
const SUBJECT = "patient-demo-polypharmacy";
const ME = "chat_harriet";
const FAMILY = "chat_family";
const DAY1 = "2026-09-01"; // questions: hf-breathing-lying-flat, anticoagulant-bleeding, dizzy-on-standing
const DOCTOR_PHONE = "+17345550142";
const FAMILY_PHONE = "+13135550187";
const CONTACTS: CareContacts = parseCareContacts(
  JSON.stringify({
    doctor: { name: "Dr. Patel", phone: "(734) 555-0142" },
    emergencyContact: { name: "Sarah", relationship: "daughter", phone: "313.555.0187" },
  }),
);
const rxnav = loadRxNavCache();
const DASHES = /[\u2014\u2013]/;

let db: Db;
let messenger: FakeMessenger;
let photon: FakeCareMessenger;
let care: CareRuntime;
let engine: CheckinEngine;
let logs: string[];
let now: string;
let inbound = 0;
let photonInbound = 0;

function setup(options: { writer?: ReplyWriter; onDayFinished?: (e: DayFinished) => Promise<void> | void } = {}) {
  db = openDatabase(":memory:");
  upsertPatient(db, { id: P, finchnodePatientId: SUBJECT, preferredName: "Harriet", relayChatId: ME });
  syncFamilyMembers(db, P, ["sarah"]);
  linkFamilyMember(db, "sarah", FAMILY, "Sarah", `${DAY1}T08:00:00.000Z`);
  now = `${DAY1}T13:00:00.000Z`;
  logs = [];
  const clock = { now: () => now };
  messenger = new FakeMessenger({ now: () => now });
  photon = new FakeCareMessenger();
  care = startCareRuntime({ db, patientId: P, contacts: CONTACTS, clock, messenger: photon, log: (l) => logs.push(l), ...(options.writer ? { writer: options.writer } : {}) });
  engine = createCheckinEngine(
    { db, messenger, clock, loadSnapshot: async (s) => loadSnapshot(s) },
    { rxnav, missedCheckinTime: "12:00", onDayFinished: options.onDayFinished ?? care.onDayFinished },
  );
}

afterEach(async () => {
  await care?.stop();
  db?.close();
});

const tick = () => {
  now = new Date(Date.parse(now) + 60_000).toISOString();
};

async function tap(label: string): Promise<void> {
  tick();
  const target = [...messenger.inChat(ME)].reverse().find((m: SentMessage) => m.buttons?.includes(label));
  if (!target) throw new Error(`no "${label}" button`);
  inbound += 1;
  await engine.handleInbound({ chatId: ME, messageId: `in_${inbound}`, text: label, replyTo: target.messageId, at: now });
}

/** Day 1 to the end: her three answers, then "Later" on the flag offer. */
async function checkIn(answers: [string, string, string] = ["Fine", "No", "No"]): Promise<void> {
  await engine.startDay(P, DAY1);
  await tap("Quick questions");
  for (const a of answers) await tap(a);
  // After a red flag there is no flag offer that day: the check-in already ended.
  if (messenger.lastIn(ME)?.buttons?.includes("Later")) await tap("Later");
}

async function text(from: string, body: string, messageId = `ph_${++photonInbound}`) {
  tick();
  return care.service.handleInbound({ messageId, fromPhone: from, text: body, at: now });
}

const toDoctor = () => photon.to(DOCTOR_PHONE).map((t) => t.text);
const toFamily = () => photon.to(FAMILY_PHONE).map((t) => t.text);
const facts = (): CareFacts => buildCareFacts(db, { patientId: P, day: DAY1, trigger: "day", rxnav });

describe("care facts", () => {
  beforeEach(() => setup());

  it("gathers the finished check-in, her record and open flags for the day", async () => {
    await checkIn();
    const f = facts();
    expect(f.patient).toMatchObject({ id: P, preferredName: "Harriet", fullName: "Harriet Lindqvist", age: 78 });
    expect(f.record).toBe("ok");
    expect(f.checkin.outcome).toBe("checked_in");
    expect(f.checkin.answers.map((a) => [a.questionId, a.answer])).toEqual([
      ["hf-breathing-lying-flat", "Fine"],
      ["anticoagulant-bleeding", "No"],
      ["dizzy-on-standing", "No"],
    ]);
    expect(f.redFlags).toEqual([]);
    expect(f.flags.map((x) => x.ruleId)).toEqual(["R1", "R3", "R4"]);
    expect(f.flags.every((x) => x.status === "new" && x.evidence.length > 0)).toBe(true);
    expect(f.recentLabs.some((l) => /Glomerular/.test(l.name) && l.value === 31)).toBe(true);
    expect(f.medications.length).toBe(14);
    expect(JSON.parse(JSON.stringify(f))).toEqual(f);
  });

  it("recomputes red flags from her answers and names who was alerted", async () => {
    await checkIn(["Yes, it was hard", "No", "No"]);
    const f = facts();
    expect(f.redFlags).toEqual([
      { questionId: "hf-breathing-lying-flat", question: expect.stringMatching(/breathing last night/), answer: "Yes, it was hard", level: 3, source: "answer" },
    ]);
    expect(f.familyAlerted).toEqual(["Sarah"]);
    expect(f.checkin.answers[0]?.worrying).toBe(true);
  });

  it("red flags also come from the day's level-3+ observations and the check-in's concern mark", async () => {
    await checkIn();
    const c = getCheckin(db, P, DAY1)!;
    const at = `${DAY1}T15:00:00.000Z`;
    addObservation(db, { patientId: P, checkinId: c.id, day: DAY1, topic: "anticoagulant-bleeding", level: 3, source: "follow_up", createdAt: at });
    addObservation(db, { patientId: P, checkinId: c.id, day: DAY1, topic: "chest tightness", level: 3, source: "typed", words: "tight chest", createdAt: at });
    addObservation(db, { patientId: P, checkinId: c.id, day: DAY1, topic: "crisis", level: 5, source: "safety", createdAt: at });
    expect(facts().redFlags.map((r) => [r.questionId, r.level, r.source, r.answer])).toEqual([
      ["crisis", 5, "safety", "words about not wanting to live (988 given)"],
      ["anticoagulant-bleeding", 3, "follow_up", "Worse on the follow-up"],
      ["chest tightness", 3, "typed", "tight chest"],
    ]);
    expect(facts().familyAlerted).toEqual(["Sarah"]);
  });

  it("a concern with nothing else to explain it is still a red flag", async () => {
    await engine.startDay(P, DAY1);
    db.prepare("UPDATE checkins SET concern_at = ? WHERE patient_id = ?").run(`${DAY1}T13:05:00.000Z`, P);
    expect(facts().redFlags).toEqual([{ questionId: "concern", question: "A concern came up during the check-in", answer: "the check-in paused", level: 3, source: "concern" }]);
  });

  it("takes the day's camera vitals, not comparing heart rate because she has AFib", async () => {
    await checkIn();
    db.prepare(
      `INSERT INTO vitals_readings (patient_id, taken_at, heart_rate, breathing_rate, method, confidence) VALUES (?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?)`,
    ).run(P, `${DAY1}T13:10:00.000Z`, 74.4, 16.2, "relay_call", 0.82, P, "2026-08-31T13:10:00.000Z", 99, 20, "relay_call", 0.9);
    const f = facts();
    expect(f.vitals.readings).toHaveLength(1);
    expect(f.vitals.readings[0]).toMatchObject({ heartRate: 74.4, breathingRate: 16.2, method: "relay_call" });
    expect(f.vitals.readings[0]?.inUsualRange).toBeUndefined();
    expect(f.vitals.usualRange?.compareHeartRate).toBe(false);
    expect(doctorSummary(f, CONTACTS)).toMatch(/09:10: HR 74 bpm, RR 16 \/min, confidence 0.82, method relay_call\. Not compared with usual range/);
    // The family sees the reading by her sharing level: nothing at "status", no number with AFib at
    // "status_vitals", the number with the AFib note at "all".
    expect(familySummary(f, CONTACTS)).not.toMatch(/heart|camera/i);
    setSharing(db, P, "status_vitals");
    expect(familySummary(facts(), CONTACTS)).toContain("Harriet's heart rate was checked today with the camera. This is a camera estimate, not a medical test.");
    expect(familySummary(facts(), CONTACTS)).not.toMatch(/74/);
    setSharing(db, P, "all");
    expect(familySummary(facts(), CONTACTS)).toMatch(/heart rate was about 74 beats a minute.*irregular heartbeat \(atrial fibrillation\)/s);
  });

  it("an unstarted day reads as none, and the noon job's missed as missed", async () => {
    expect(facts().checkin.outcome).toBe("none");
    await engine.startDay(P, DAY1);
    expect(facts().checkin.outcome).toBe("in_progress");
    await engine.runMissedCheckin(P, DAY1);
    expect(facts().checkin.outcome).toBe("missed");
  });
});

describe("care facts: the day's severity, notes and medicines", () => {
  beforeEach(() => setup());

  /** A day with a little of everything: a level-1 and a level-3 typed symptom, a note, a visit question, medicines. */
  async function busyDay(): Promise<void> {
    await checkIn();
    const c = getCheckin(db, P, DAY1)!;
    const at = `${DAY1}T14:00:00.000Z`;
    addObservation(db, { patientId: P, checkinId: c.id, day: DAY1, topic: "knee pain", level: 1, source: "typed", words: "my knee aches", createdAt: at });
    addObservation(db, { patientId: P, checkinId: c.id, day: DAY1, topic: "knee pain", level: 1, source: "typed", words: "still the knee", createdAt: at });
    addObservation(db, { patientId: P, checkinId: c.id, day: DAY1, topic: "chest tightness", level: 3, source: "typed", words: "tight chest this morning", createdAt: at });
    addCheckinNote(db, { patientId: P, checkinId: c.id, questionId: "dizzy-on-standing", text: "only when I get up fast", createdAt: at });
    addVisitQuestion(db, { patientId: P, text: "Can I take Tylenol with my water pill?", createdAt: at });
    const morning = insertDose(db, { patientId: P, day: DAY1, slot: "morning", sentAt: `${DAY1}T12:00:00.000Z` })!;
    setDoseStatus(db, morning, "taken", at);
    insertDose(db, { patientId: P, day: DAY1, slot: "evening", sentAt: `${DAY1}T22:00:00.000Z` });
    const apixaban = normalizeHealthRecord(loadSnapshot(SUBJECT), { rxnav }).medications.find((m) => /apixaban/i.test(m.name))!;
    insertLabelCheck(db, { patientId: P, attachmentId: "att_1", outcome: "strength_differs", medicationKey: apixaban.key, labelMedicine: "Apixaban", labelStrength: "2.5 mg", createdAt: at });
    insertLabelCheck(db, { patientId: P, attachmentId: "att_2", outcome: "match", medicationKey: apixaban.key, labelMedicine: "Apixaban", labelStrength: "5 mg", createdAt: at });
    markRefillReminded(db, { patientId: P, medicationKey: apixaban.key, fillDate: "2026-08-02", name: "apixaban 5 mg", runOut: "2026-09-04", day: DAY1, at });
  }

  it("gathers the ladder by topic (highest first), her notes, visit questions, doses, label mismatches and refills", async () => {
    await busyDay();
    const f = facts();
    expect(f.severity.highest).toMatchObject({ level: 3, about: "chest tightness", words: "tight chest this morning" });
    expect(f.severity.symptoms.map((x) => [x.level, x.about])).toEqual([
      [3, "chest tightness"],
      [1, "knee pain"],
    ]);
    expect(f.notes).toEqual([{ about: "dizziness on standing", text: "only when I get up fast" }]);
    expect(f.visitQuestions).toEqual(["Can I take Tylenol with my water pill?"]);
    expect(f.medicines.doses).toEqual([
      { slot: "morning", status: "taken" },
      { slot: "evening", status: "not confirmed" },
    ]);
    expect(f.medicines.labelMismatches).toEqual([{ outcome: "strength_differs", label: "Apixaban 2.5 mg", onHerList: "apixaban 5 mg" }]);
    expect(f.medicines.refills).toEqual([{ medicine: "apixaban 5 mg", runsOut: "2026-09-04", status: "reminded", familyTold: false }]);
  });

  it("the doctor gets all of it as data lines", async () => {
    await busyDay();
    const text = doctorSummary(facts(), CONTACTS);
    expect(text).toContain("SYMPTOMS (severity ladder; highest today L3, call the doctor today)");
    expect(text).toContain('- L3 call the doctor today: chest tightness, "tight chest this morning" (typed)');
    expect(text).toContain('- L1 small, everyday: knee pain, "my knee aches" (typed)');
    expect(text).toContain('HER NOTES FOR YOU\n- dizziness on standing: "only when I get up fast"');
    expect(text).toContain("VISIT QUESTIONS (asked today)\n- Can I take Tylenol with my water pill?");
    expect(text).toContain("- Morning medicines reminder: taken.\n- Evening medicines reminder: not confirmed.");
    expect(text).toContain("- Label photo: Apixaban 2.5 mg; her list has apixaban 5 mg (strength differs");
    expect(text).toContain("- Refill: apixaban 5 mg, runs out 2026-09-04; reminded.");
    expect(DASHES.test(text)).toBe(false);
  });

  it("the family sees the level-3 item at every sharing level, the rest only at 'all'", async () => {
    await busyDay();
    const status = familySummary(facts(), CONTACTS);
    expect(status).toContain("Harriet reported something she should call her doctor about. Please call Harriet today to check on her.");
    expect(status).not.toMatch(/chest|knee|Tylenol|get up fast|Morning medicines|Apixaban|apixaban|answered/);
    setSharing(db, P, "all");
    const all = familySummary(facts(), CONTACTS);
    expect(all).toContain('- chest tightness "tight chest this morning"\nI asked Harriet to call her doctor today.');
    expect(all).toContain("- knee pain (noted for her doctor): \"my knee aches\"");
    expect(all).toContain('- dizziness on standing: "only when I get up fast"');
    expect(all).toContain("- Can I take Tylenol with my water pill?");
    expect(all).toContain("- Morning medicines: she said she took them.\n- Evening medicines: not confirmed.");
    expect(all).toContain("- A medicine label she photographed (Apixaban 2.5 mg) didn't match her list");
    expect(all).toContain("- apixaban 5 mg runs out around 2026-09-04; I reminded her to ask for a refill.");
    expect(DASHES.test(all) || /\b911\b/.test(all)).toBe(false);
  });

  it("a safety-screen hit (level 4) is always said as something urgent, never in her words below 'all'", async () => {
    await checkIn();
    addObservation(db, { patientId: P, day: DAY1, topic: "urgent_symptom", level: 4, source: "safety", createdAt: `${DAY1}T14:00:00.000Z` });
    const status = familySummary(facts(), CONTACTS);
    expect(status).toContain("Harriet told me about something that may be urgent. Please call Harriet now to check on her.");
    expect(status).not.toMatch(/\b911\b/);
    setSharing(db, P, "all");
    expect(familySummary(facts(), CONTACTS)).toContain("I asked Harriet to call 911 if it's happening now, and then her doctor.");
  });
});

describe("care summary wording", () => {
  beforeEach(() => setup());

  it("doctor: a data summary with values, evidence and the emergency contact", async () => {
    await checkIn(["Yes, it was hard", "No", "No"]);
    const text = doctorSummary(facts(), CONTACTS);
    expect(text).toMatch(/^Daily check-in summary for Harriet Lindqvist, 78 \(synthetic demo patient\)\./);
    expect(text).toContain("CHECK-IN: Completed");
    expect(text).toMatch(/breathing last night when you lay down\? Yes, it was hard {2}\[RED FLAG\]/);
    expect(text).toContain("RED FLAGS: 1");
    expect(text).toMatch(/- L3 How was your breathing .*"Yes, it was hard"\. She was told to call her doctor today; Sarah alerted in Relay\./);
    expect(text).toMatch(/R1 .*\[medium; not yet discussed with her\]/);
    expect(text).toContain("Glomerular filtration rate: 31 mL/min");
    expect(text).toContain("Potassium: 4.9 mmol/L");
    expect(text).toContain("ACTIVE MEDICATIONS (14)");
    expect(text).toContain("Emergency contact: Sarah (daughter), +1 313-555-0187.");
    expect(text).not.toMatch(DASHES);
  });

  it("family: plain words, says it's automated, no lab jargon or unheard flags", async () => {
    await checkIn();
    const text = familySummary(facts(), CONTACTS);
    expect(text).toMatch(/^Hi Sarah\. This is Harriet's daily check-in assistant\. I'm an automated assistant, not a person\./);
    expect(text).toContain("Harriet checked in today.");
    expect(text).not.toMatch(/eGFR|Glomerular|mmol|R1|R3|R4|RED FLAG|metformin/i);
    expect(text).not.toMatch(DASHES);
    expect(text).not.toContain("!");
    expect(text).not.toMatch(/\b(dose|take more|stop taking)\b/i);
  });

  it("family: a red flag always asks them to call her, with the doctor's number", async () => {
    await checkIn(["Yes, it was hard", "No", "No"]);
    const text = familySummary(facts(), CONTACTS);
    // At the default "status": the base line only, as her family's Relay alert.
    expect(text).toContain("Harriet reported something she should call her doctor about. Please call Harriet today to check on her.");
    expect(text).toContain("Dr. Patel can be reached at +1 734-555-0142");
    expect(text).not.toMatch(/breathing|Yes, it was hard|answered|911/);
    setSharing(db, P, "all");
    const all = familySummary(facts(), CONTACTS);
    expect(all).toContain('- How was your breathing last night when you lay down? "Yes, it was hard"');
    expect(all).toContain('- "How was your breathing last night when you lay down?" Harriet answered: Yes, it was hard');
  });

  it("family: only flags she has already heard, as not emergencies", async () => {
    await checkIn();
    db.prepare("UPDATE flags SET status = 'noted' WHERE patient_id = ? AND rule_id = 'R1'").run(P);
    expect(familySummary(facts(), CONTACTS)).not.toMatch(/list to ask her doctor|answered/); // "status": neither
    setSharing(db, P, "all");
    const text = familySummary(facts(), CONTACTS);
    expect(text).toContain("Things on Harriet's list to ask her doctor about (not emergencies):");
    expect(text.match(/^- /gm)?.length).toBe(4); // three answers and one flag
    expect(text).toContain("(Harriet plans to ask her doctor)");
  });

  it("family: 'not today' is her choice, without guilt", async () => {
    await engine.startDay(P, DAY1);
    await tap("Not today");
    const text = toFamily()[0] ?? "";
    expect(text).toContain(`said "not today" to this morning's check-in. That's her choice`);
    expect(toDoctor()[0]).toContain("CHECK-IN:");
  });
});

describe("care copy scan: every care text, every sharing level", () => {
  beforeEach(() => setup());
  const DOSING = /\b(should|could|can|must|needs? to) (take|stop|start|increase|decrease|double|skip|halve)\b|\b(increase|decrease|double|halve|skip) (her|the|your) (dose|dosage|medicine)/i;

  it("no long dashes, no diagnosis, no dosing advice; 911 only at level 4 and up (or the fixed emergency and crisis replies)", async () => {
    await checkIn(["Yes, it was hard", "A little bruising", "Sometimes"]);
    const c = getCheckin(db, P, DAY1)!;
    const at = `${DAY1}T15:00:00.000Z`;
    addObservation(db, { patientId: P, checkinId: c.id, day: DAY1, topic: "knee pain", level: 1, source: "typed", words: "my knee aches", createdAt: at });
    addCheckinNote(db, { patientId: P, checkinId: c.id, questionId: "dizzy-on-standing", text: "only when I get up fast", createdAt: at });
    addVisitQuestion(db, { patientId: P, text: "Can I take Tylenol with my water pill?", createdAt: at });
    const texts: { text: string; level4: boolean; label: string }[] = [];
    for (const withUrgent of [false, true]) {
      if (withUrgent) addObservation(db, { patientId: P, checkinId: c.id, day: DAY1, topic: "urgent_symptom", level: 4, source: "safety", createdAt: at });
      for (const sharing of ["status", "status_vitals", "all"] as const) {
        setSharing(db, P, sharing);
        const f = facts();
        texts.push({ text: doctorSummary(f, CONTACTS), level4: withUrgent, label: `doctor ${sharing} ${withUrgent}` });
        texts.push({ text: familySummary(f, CONTACTS), level4: withUrgent, label: `family ${sharing} ${withUrgent}` });
      }
    }
    for (const t of [familySymptomReply(facts(), CONTACTS), familyAskDoctorReply(facts(), CONTACTS), doctorActionReply(CONTACTS), noSummaryReply(CONTACTS.doctor), noSummaryReply(CONTACTS.emergencyContact)])
      texts.push({ text: t, level4: false, label: t.slice(0, 30) });
    for (const t of [familyEmergencyReply(facts(), CONTACTS), familyCrisisReply(facts())]) texts.push({ text: t, level4: true, label: t.slice(0, 30) });
    for (const { text: t, level4, label } of texts) {
      expect(DASHES.test(t), label).toBe(false);
      expect(/\bdiagnos(e|ed|es|is|ing)\b/i.test(t), label).toBe(false); // "not a diagnostic reading" is the disclaimer
      expect(DOSING.test(t), label).toBe(false);
      if (!level4) expect(/\b911\b/.test(t), label).toBe(false);
    }
    // The doctor's data lines say what she was told at level 4 (911 if happening): that is level 4.
    expect(texts.find((t) => t.label === "family status true")?.text).not.toMatch(/\b911\b/); // detail only at "all"
  });
});

describe("sending the summaries", () => {
  beforeEach(() => setup());

  it("go out once, when the check-in ends, to both contacts", async () => {
    await engine.startDay(P, DAY1);
    await tap("Quick questions");
    await tap("Fine");
    expect(photon.sent).toEqual([]);
    await tap("No");
    await tap("No");
    await tap("Later");
    expect(toDoctor()).toHaveLength(1);
    expect(toFamily()).toHaveLength(1);
    expect(toDoctor()[0]).toContain("Daily check-in summary");
    expect(toFamily()[0]).toContain("Hi Sarah");
    // Harriet's own messages are unchanged by the hook.
    expect(messenger.lastIn(ME)?.text).toMatch(/That's everything for today/);

    expect(await care.service.sendSummaries(DAY1)).toMatchObject({ doctor: "already_sent", family: "already_sent" });
    expect(photon.sent).toHaveLength(2);
  });

  it("the noon job: a missed check-in sends them, and a second run doesn't", async () => {
    await engine.startDay(P, DAY1);
    await engine.runMissedCheckin(P, DAY1);
    expect(toFamily()[0]).toContain("hasn't answered this morning's check-in");
    await care.afterMissedCheckin(DAY1);
    await engine.runMissedCheckin(P, DAY1);
    expect(photon.sent).toHaveLength(2);
  });

  it("noon sends nothing for a check-in she started; the finished day's summary goes out when she ends it", async () => {
    await engine.startDay(P, DAY1);
    await tap("Quick questions");
    await tap("Fine");
    expect(await engine.runMissedCheckin(P, DAY1)).toBe("nothing_to_do");
    await care.afterMissedCheckin(DAY1);
    expect(photon.sent).toEqual([]);
    await tap("No");
    await tap("No");
    await tap("Later");
    expect(toFamily()).toHaveLength(1);
    expect(toFamily()[0]).toContain("Harriet checked in today.");
  });

  it("a day missed at noon and then checked in after all sends both summaries", async () => {
    await engine.startDay(P, DAY1);
    await engine.runMissedCheckin(P, DAY1);
    expect(toFamily()).toHaveLength(1);
    await tap("Quick questions");
    for (const a of ["Fine", "No", "No"]) await tap(a);
    await tap("Later");
    expect(toFamily()).toHaveLength(2);
    expect(toFamily()[1]).toContain("Harriet checked in today.");
  });

  it("one contact failing doesn't stop the other; the retry sends only the failed one", async () => {
    photon.failFor.add(DOCTOR_PHONE);
    await checkIn();
    expect(toDoctor()).toHaveLength(0);
    expect(toFamily()).toHaveLength(1);
    const rows = careMessages(db, P).filter((m) => m.kind === "summary");
    expect(rows.find((r) => r.audience === "doctor")).toMatchObject({ sentAt: null, error: expect.stringMatching(/failed/) });
    // Harriet's day still ended normally.
    expect(getCheckin(db, P, DAY1)?.status).toBe("answered");

    photon.failFor.clear();
    expect(await care.service.sendSummaries(DAY1)).toMatchObject({ doctor: "sent", family: "already_sent" });
    expect(toDoctor()).toHaveLength(1);
    expect(toFamily()).toHaveLength(1);
  });

  it("freezes the facts it sent: later changes don't rewrite the summary", async () => {
    await checkIn();
    db.prepare("UPDATE flags SET status = 'noted' WHERE patient_id = ?").run(P);
    expect(latestSentSummary(db, P, "family")?.facts.flags.every((f) => f.status === "new")).toBe(true);
  });

  it("logs mask numbers and never carry message text", async () => {
    await checkIn(["Yes, it was hard", "No", "No"]);
    await text(FAMILY_PHONE, "Is she feeling ok today?");
    const all = logs.join("\n");
    expect(all).toContain("+1 ***-***-0142");
    expect(all).not.toMatch(/7345550142|3135550187/);
    expect(all).not.toMatch(/feeling ok|breathing last night|Harriet/);
  });

  it("a throwing hook never breaks her check-in", async () => {
    setup({
      onDayFinished: () => {
        throw new Error("boom");
      },
    });
    await checkIn();
    expect(getCheckin(db, P, DAY1)?.status).toBe("answered");
    expect(messenger.lastIn(FAMILY)?.text).toBe("Harriet checked in today.");
  });

  it("the hook hears each finished day once, with its outcome", async () => {
    const events: DayFinished[] = [];
    setup({ onDayFinished: (e) => void events.push(e) });
    await checkIn();
    await engine.runMissedCheckin(P, DAY1);
    await engine.startDay(P, "2026-09-02");
    await engine.runMissedCheckin(P, "2026-09-02");
    expect(events).toEqual([
      { patientId: P, day: DAY1, outcome: "checked_in" },
      { patientId: P, day: "2026-09-02", outcome: "missed" },
    ]);
  });
});

describe("replies to the doctor and the emergency contact", () => {
  it("routes by phone number and ignores unknown numbers", async () => {
    setup();
    await checkIn();
    expect(await text("+12025550123", "who is this?")).toBe("unknown_sender");
    expect(photon.sent).toHaveLength(2);
    expect(await text("(313) 555-0187", "How was her morning?")).toBe("replied");
    expect(photon.sent.at(-1)?.phone).toBe(FAMILY_PHONE);
  });

  it("answers each Photon message once", async () => {
    setup();
    await checkIn();
    expect(await text(DOCTOR_PHONE, "Any red flags?", "ph_same")).toBe("replied");
    expect(await text(DOCTOR_PHONE, "Any red flags?", "ph_same")).toBe("duplicate");
    expect(toDoctor()).toHaveLength(2);
  });

  it("an acknowledgment needs no reply; 'thanks for the help' is not urgent", async () => {
    setup();
    await checkIn();
    for (const ack of ["Thanks", "ok!", "Thank you so much", "👍", "Got it."]) expect(await text(FAMILY_PHONE, ack), ack).toBe("no_reply");
    expect(classifyInbound("family", "thanks for the help")).toBe("answer");
    expect(toFamily()).toHaveLength(1);
  });

  it("family texts follow the ladder: an emergency gets 911 now, a crisis 988, a symptom her doctor with no 911", async () => {
    setup();
    await checkIn(["Yes, it was hard", "No", "No"]);
    const emergencies = ["Mom fell this morning", "She has chest pain", "she can't breathe", "Harriet fell in the kitchen", "She's unconscious", "Should I call 911?"];
    for (const message of emergencies) {
      expect(classifyInbound("family", message, "Harriet"), message).toBe("family_emergency");
      await text(FAMILY_PHONE, message);
      const reply = toFamily().at(-1) ?? "";
      expect(reply, message).toMatch(/^If this is happening now, please call 911 right away\. After that, call Harriet's doctor, Dr\. Patel, at \+1 734-555-0142\./);
    }
    for (const message of ["She says she wants to die", "she wants to kill herself"]) {
      expect(classifyInbound("family", message, "Harriet"), message).toBe("family_crisis");
      await text(FAMILY_PHONE, message);
      expect(toFamily().at(-1)).toMatch(/^Please call or text 988, the Suicide & Crisis Lifeline, now\..*If Harriet is in danger right now, call 911\./);
    }
    const symptoms = ["She sounds out of breath, what should I do?", "Should I take her to the hospital?", "she's really dizzy and confused", "Is this an emergency??", "her ankles are swollen", "her knee hurts", "she seems worse"];
    for (const message of symptoms) {
      expect(classifyInbound("family", message, "Harriet"), message).toBe("family_symptom");
      await text(FAMILY_PHONE, message);
      const reply = toFamily().at(-1) ?? "";
      expect(reply, message).toBe("I'm an automated assistant, so I don't have the medical knowledge to judge symptoms or decide what to do about them. Please contact Harriet's doctor, Dr. Patel, at +1 734-555-0142.");
    }
    expect(classifyInbound("family", "How did her kidney test look?", "Harriet")).toBe("answer");
    expect(classifyInbound("family", "She fell asleep early", "Harriet")).toBe("answer");
  });

  it("the same urgent reply goes out even before any summary, and even with a writer", async () => {
    let calls = 0;
    setup({ writer: { write: async () => (calls++, "made up") } });
    await text(FAMILY_PHONE, "She can't breathe");
    expect(toFamily()[0]).toBe("If this is happening now, please call 911 right away. After that, call her doctor, Dr. Patel, at +1 734-555-0142. I'm an automated assistant, so I can't judge symptoms or act on them myself.");
    expect(calls).toBe(0);
  });

  it("dose questions from family go to the doctor; the doctor asking it to act gets the contact", async () => {
    setup();
    await checkIn();
    await text(FAMILY_PHONE, "Should she stop taking the metformin?");
    expect(toFamily().at(-1)).toBe("That's a question for Harriet's doctor. I can't give advice about medicines or doses. Dr. Patel can be reached at +1 734-555-0142.");
    await text(DOCTOR_PHONE, "Please call Harriet and tell her to come in");
    expect(toDoctor().at(-1)).toMatch(/can't take action.*Sarah \(daughter\) at \+1 313-555-0187/);
  });

  it("template answers without a writer: the doctor gets data, the family plain words", async () => {
    setup();
    await checkIn(["Yes, it was hard", "No", "No"]);
    await text(DOCTOR_PHONE, "What were her latest labs?");
    expect(toDoctor().at(-1)).toMatch(/Open flags: R1 \(new\), R3 \(new\), R4 \(new\)\. Recent labs: .*Glomerular filtration rate 31/);
    await text(DOCTOR_PHONE, "How did the check-in go?");
    expect(toDoctor().at(-1)).toMatch(/Check-in completed on 2026-09-01\. .*Red flags: .*breathing last night.*"Yes, it was hard"/);
    await text(FAMILY_PHONE, "How is she doing?");
    expect(toFamily().at(-1)).toMatch(/Harriet checked in today\. Something came up today that needs attention, so please call her today\./);
    await text(FAMILY_PHONE, "What medicines is she on?");
    expect(toFamily().at(-1)).toBe("For questions about her medicines, her doctor is the right person to ask.");
    await text(FAMILY_PHONE, "What was her heart rate?");
    expect(toFamily().at(-1)).toBe("Harriet keeps her health readings between her and her doctor, so I can't share them.");
    await text(FAMILY_PHONE, "Anything on her list for the doctor? Any flags?");
    expect(toFamily().at(-1)).toMatch(/^Harriet keeps the details of her record between her and her doctor\./);
    setSharing(db, P, "all");
    // The summary's facts froze her level when sent: the answers still follow "status".
    await text(FAMILY_PHONE, "What medicines is she on?");
    expect(toFamily().at(-1)).toBe("For questions about her medicines, her doctor is the right person to ask.");
  });

  it("before any summary went out, says so", async () => {
    setup();
    await text(DOCTOR_PHONE, "Any update?");
    expect(toDoctor()[0]).toMatch(/No check-in summary has been sent yet/);
  });

  it("a writer words answers from the summary and thread; its text is cleaned and checked", async () => {
    const requests: ReplyRequest[] = [];
    let next: string | null | Error = "She checked in at 09:00 \u2014 all three answers were No!";
    setup({
      writer: {
        write: async (r) => {
          requests.push(r);
          if (next instanceof Error) throw next;
          return next;
        },
      },
    });
    await checkIn();
    await text(FAMILY_PHONE, "How did she do today?");
    expect(toFamily().at(-1)).toBe("She checked in at 09:00, all three answers were No.");
    const req = requests[0]!;
    expect(req.contact.audience).toBe("family");
    expect(req.summaryText).toBe(toFamily()[0]);
    expect(req.thread).toEqual([{ from: "assistant", text: toFamily()[0] }]);
    expect(req.facts.checkin.outcome).toBe("checked_in");

    next = "You should stop her metformin.";
    await text(FAMILY_PHONE, "anything else?");
    expect(toFamily().at(-1)).toMatch(/^I can only share what's in today's check-in/);
    expect(requests[1]?.thread.map((t) => t.from)).toEqual(["assistant", "contact", "assistant"]);

    next = new Error("overloaded");
    await text(DOCTOR_PHONE, "Any red flags?");
    expect(toDoctor().at(-1)).toMatch(/Check-in completed .*No red flags\./);
    expect(logs.some((l) => l.includes("reply writer failed (overloaded)"))).toBe(true);

    next = null;
    expect(await text(DOCTOR_PHONE, "I'll review it this afternoon.")).toBe("no_reply");
  });

  it("a failed reply send is reported, not thrown", async () => {
    setup();
    await checkIn();
    photon.failFor.add(DOCTOR_PHONE);
    expect(await text(DOCTOR_PHONE, "Any red flags?")).toBe("failed");
  });

  it("guardReply: strips markdown and dashes, keeps the doctor's !, rejects long or dosing text", () => {
    expect(guardReply("**HR** 74 \u2013 within range!", "doctor")).toBe("HR 74, within range!");
    expect(guardReply("x".repeat(801), "family")).toBeUndefined();
    expect(guardReply("x".repeat(801), "doctor")).toBe("x".repeat(801));
    expect(guardReply("Consider whether to increase her dose.", "doctor")).toBeUndefined();
    expect(guardReply("   ", "doctor")).toBeUndefined();
  });
});

describe("GeminiCareWriter (the shared LlmClient words the care texts)", () => {
  /** A writer over a FakeLlmClient answering every care text with `answer(input)`. */
  function geminiWriter(answer: (input: CareMessageInput) => string | Error) {
    const llm = new FakeLlmClient({ writeCareMessage: answer });
    return { llm, writer: new GeminiCareWriter(llm) };
  }

  it("summaries: the written body inside the fixed header, red-flag lines and footer; family facts cut to what they may see", async () => {
    const { llm, writer } = geminiWriter((input) =>
      input.audience === "doctor" ? "CHECK-IN: completed 09:00 to 09:04.\nSYMPTOMS: L3 breathing when lying flat." : "Harriet did her check-in this morning and answered all three questions.",
    );
    setup({ writer });
    await checkIn(["Yes, it was hard", "No", "No"]);
    const doctor = toDoctor()[0] ?? "";
    expect(doctor).toMatch(/^Daily check-in summary for Harriet Lindqvist, 78/);
    expect(doctor).toContain("CHECK-IN: completed 09:00 to 09:04.");
    expect(doctor).toMatch(/RED FLAGS: 1\n- L3 How was your breathing last night when you lay down\? "Yes, it was hard"/);
    expect(doctor).toMatch(/Emergency contact: Sarah \(daughter\), \+1 313-555-0187/);
    const family = toFamily()[0] ?? "";
    expect(family).toMatch(/^Hi Sarah\. This is Harriet's daily check-in assistant\. I'm an automated assistant, not a person\./);
    // The urgent paragraph is fixed and comes right after the greeting; the model's body follows.
    expect(family.indexOf("Harriet reported something she should call her doctor about")).toBeLessThan(family.indexOf("Harriet did her check-in this morning"));
    expect(family).toMatch(/Please call Harriet today to check on her\.\sIf you have questions about what this means, Dr\. Patel can be reached at \+1 734-555-0142\./);
    const [d, f] = llm.careMessageCalls;
    expect(d).toMatchObject({ audience: "doctor", recipientName: "Dr. Patel", seniorName: "Harriet" });
    expect(JSON.stringify(d?.facts)).toContain("Glomerular");
    // The family's model never sees labs, the medication list or record flags she hasn't heard.
    expect(f).toMatchObject({ audience: "family", recipientName: "Sarah" });
    expect(JSON.stringify(f?.facts)).not.toMatch(/Glomerular|metformin|apixaban|R1/);
    expect(f?.facts).toMatchObject({ somethingUrgentToday: true, checkin: { answers: [] } }); // "status": no answers
    expect(JSON.stringify(f?.facts)).not.toMatch(/555|breathing/); // no phone numbers, no red-flag detail
    expect(DASHES.test(doctor + family)).toBe(false);
  });

  it("falls back to the fixed templates when the model fails, writes a dash, an invented number, 911 or dosing advice", async () => {
    for (const bad of [
      new LlmUnavailableError("down"),
      "Harriet is fine \u2014 nothing to report.",
      "Her heart rate was 143 bpm.",
      "If it gets worse, call 911.",
      "She should stop taking her metformin.",
      "This could be heart failure getting worse.",
    ]) {
      const { writer } = geminiWriter(() => bad);
      setup({ writer });
      await checkIn();
      expect(toDoctor()[0]).toBe(doctorSummary(facts(), CONTACTS));
      expect(toFamily()[0]).toBe(familySummary(facts(), CONTACTS));
      expect(logs.some((l) => /summary writer failed/.test(l))).toBe(true);
      await care.stop();
      db.close();
    }
  });

  it("a retry sends exactly the text first planned, without asking the model again", async () => {
    let n = 0;
    const { llm, writer } = geminiWriter(() => `Written body number ${++n}.`);
    setup({ writer });
    photon.failFor.add(DOCTOR_PHONE);
    await checkIn();
    const planned = careMessages(db, P).find((m) => m.kind === "summary" && m.audience === "doctor")?.text;
    photon.failFor.delete(DOCTOR_PHONE);
    await care.service.sendSummaries(DAY1);
    expect(toDoctor()[0]).toBe(planned);
    expect(llm.careMessageCalls).toHaveLength(2);
  });

  it("replies: worded from the summary as sent and the thread; NO_REPLY means none; a failed check sends the template", async () => {
    const answers: (string | Error)[] = ["Body.", "Body.", "She answered all three questions this morning.", CARE_NO_REPLY, "Her potassium was 9.9 today."];
    const { llm, writer } = geminiWriter(() => answers.shift() ?? new LlmUnavailableError("no more"));
    setup({ writer });
    await checkIn();
    await text(FAMILY_PHONE, "How did she do this morning?");
    expect(toFamily().at(-1)).toBe("She answered all three questions this morning.");
    const reply = llm.careMessageCalls.at(-1);
    expect(reply?.question).toBe("How did she do this morning?");
    expect(reply?.summaryText).toBe(toFamily()[0]); // the summary exactly as she got it
    await text(DOCTOR_PHONE, "Noted, see you Tuesday at the clinic");
    expect(toDoctor()).toHaveLength(1); // NO_REPLY: nothing sent
    await text(DOCTOR_PHONE, "What were her latest labs?");
    expect(toDoctor().at(-1)).toMatch(/^Open flags: R1 \(new\)/); // 9.9 isn't in her facts: the template answer
  });

  it("checkWritten keeps numbers from the facts and rejects others", () => {
    const view = { hr: 74, egfr: "31 mL/min" };
    expect(checkWritten("Heart rate about 74; eGFR 31 on 2 readings.", "doctor", view)).toBe("Heart rate about 74; eGFR 31 on 2 readings.");
    expect(checkWritten("Heart rate about 75.", "doctor", view)).toBeUndefined();
    expect(checkWritten("Great news!", "family", view)).toBe("Great news.");
    expect(checkWritten("**CHECK-IN** done", "doctor", view)).toBe("CHECK-IN done");
  });

  it("the prompts differ by reader and kind, and carry the grounding rules", async () => {
    setup();
    await checkIn();
    const f = facts();
    expect(JSON.stringify(doctorView(f, CONTACTS))).toContain("Glomerular");
    expect(JSON.stringify(familyView(f, CONTACTS))).not.toContain("Glomerular");
    const base = { recipientName: "Dr. Patel", seniorName: "Harriet" };
    const doctorSummaryPrompt = careMessageSystemPrompt({ ...base, audience: "doctor" });
    const familyReplyPrompt = careMessageSystemPrompt({ ...base, recipientName: "Sarah", audience: "family", question: "How is she?" });
    expect(doctorSummaryPrompt).toMatch(/data-only/);
    expect(doctorSummaryPrompt).toMatch(/never suggest starting, stopping, skipping or changing any medicine or dose/);
    expect(familyReplyPrompt).toMatch(/warm, plain/);
    expect(familyReplyPrompt).toContain(CARE_NO_REPLY);
    expect(doctorSummaryPrompt + familyReplyPrompt).not.toMatch(DASHES);
  });
});

describe("PhotonMessenger over a fake Spectrum port", () => {
  function fakePort(messages: PortMessage[]) {
    const sent: { phone: string; text: string }[] = [];
    let stopped = 0;
    let release: () => void = () => {};
    const port: PhotonPort = {
      async sendDm(phone, text) {
        sent.push({ phone, text });
        return { id: `msg_${sent.length}` };
      },
      async *messages() {
        yield* messages;
        await new Promise<void>((resolve) => (release = resolve));
      },
      async stop() {
        stopped += 1;
        release();
      },
    };
    return { port, sent, stopped: () => stopped };
  }
  const at = new Date("2026-09-01T13:00:00Z");
  const base = { direction: "inbound" as const, isDm: true, fromPhone: DOCTOR_PHONE, text: "hi", at };

  it("sends text DMs and returns Photon's message id", async () => {
    const { port, sent } = fakePort([]);
    const m = new PhotonMessenger(port);
    expect(await m.send(DOCTOR_PHONE, "summary", "k1")).toEqual({ messageId: "msg_1" });
    expect(sent).toEqual([{ phone: DOCTOR_PHONE, text: "summary" }]);
    await expect(m.send(DOCTOR_PHONE, "  ", "k2")).rejects.toThrow(/need text/);
  });

  it("listens to inbound DM text only, survives a failing handler, and stops on abort", async () => {
    const { port, stopped } = fakePort([
      { ...base, id: "a", text: "  first  " },
      { ...base, id: "b", direction: "outbound" },
      { ...base, id: "c", isDm: false },
      { ...base, id: "d", text: undefined },
      { ...base, id: "e", fromPhone: undefined },
      { ...base, id: "f", text: "boom" },
      { ...base, id: "g", text: "last" },
    ]);
    const lines: string[] = [];
    const got: string[] = [];
    const abort = new AbortController();
    const m = new PhotonMessenger(port, (l) => lines.push(l));
    const done = m.listen(async (msg) => {
      if (msg.text === "boom") throw new Error("handler broke");
      got.push(`${msg.messageId}:${msg.text}:${msg.fromPhone}:${msg.at}`);
      if (msg.text === "last") abort.abort();
    }, abort.signal);
    await done;
    expect(got).toEqual([`a:first:${DOCTOR_PHONE}:2026-09-01T13:00:00.000Z`, `g:last:${DOCTOR_PHONE}:2026-09-01T13:00:00.000Z`]);
    expect(lines).toEqual(["[photon] handling message f failed: handler broke"]);
    expect(stopped()).toBe(1);
  });

  it("a runtime with Photon inbound answers texts as they arrive", async () => {
    setup();
    await checkIn();
    const { port } = fakePort([{ ...base, id: "x1", fromPhone: FAMILY_PHONE, text: "How is she doing?" }]);
    const transport = new PhotonMessenger(port);
    const replies: string[] = [];
    const sending = { send: async (phone: string, t: string) => (replies.push(`${phone}:${t}`), { messageId: null }) };
    const runtime = startCareRuntime({ db, patientId: P, contacts: CONTACTS, clock: { now: () => now }, messenger: sending, inbound: transport, log: () => {} });
    await new Promise((r) => setTimeout(r, 20));
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatch(new RegExp(`^\\${FAMILY_PHONE}:Harriet checked in today`));
    await runtime.stop();
  });
});

describe("the agent", () => {
  const running: RunningAgent[] = [];
  afterEach(async () => {
    for (const a of running.splice(0)) await a.stop();
  });

  it("sends the care summaries after the noon job marks the day missed, and stops the runtime on shutdown", async () => {
    const config = loadConfig({
      RELAY_AGENT_TOKEN: "tok",
      PATIENT_RELAY_HANDLE: "harriet",
      FAMILY_RELAY_HANDLES: "sarah",
      DATABASE_PATH: ":memory:",
      CLOCK_DATE: DAY1,
    });
    const agentDb = openDatabase(":memory:");
    upsertPatient(agentDb, { id: P, finchnodePatientId: SUBJECT, preferredName: "Harriet", relayHandle: "harriet", relayChatId: ME });
    const fake = new FakeCareMessenger();
    let stopped = false;
    const lines: string[] = [];
    const deps: AgentDeps = {
      config,
      db: agentDb,
      relay: {} as RelayClient,
      messenger: new FakeMessenger(),
      loadSnapshot: snapshotLoader(config, false),
      log: (l) => lines.push(l),
      now: () => new Date(`${DAY1}T10:00:00Z`),
      port: 0,
      linkPollMs: 5,
      checkinNow: true,
      relayOps: {
        assertNoWebhookSubscriptions: async () => {},
        runRelayInbox: (o) => new Promise<void>((resolve) => o.signal?.addEventListener("abort", () => resolve())),
      },
      care: async (ctx) => {
        const runtime = startCareRuntime({ ...ctx, contacts: CONTACTS, messenger: fake });
        return { ...runtime, stop: async () => ((stopped = true), runtime.stop()) };
      },
    };
    const agent = await startAgent(deps);
    running.push(agent);
    await agent.linked;
    expect(fake.sent).toEqual([]);
    await agent.scheduler.runNow(MISSED_JOB);
    expect(fake.to(DOCTOR_PHONE)).toHaveLength(1);
    expect(fake.to(FAMILY_PHONE)[0]?.text).toContain("hasn't answered this morning's check-in");
    await agent.stop();
    expect(stopped).toBe(true);
    agentDb.close();
  });
});

describe("simulator", () => {
  const DEMO = join(REPO_ROOT, "scripts", "demo", "harriet-care-summary.txt");

  async function run(photonOn: boolean) {
    const lines: string[] = [];
    const code = await runSimulation({
      dbPath: ":memory:",
      inputs: parseScript(readFileSync(DEMO, "utf8")),
      output: (l) => lines.push(l),
      config: loadConfig({}),
      photon: photonOn,
    });
    return { code, out: lines.join("\n") };
  }

  it("the care-summary demo runs end to end with --photon", async () => {
    const { code, out } = await run(true);
    expect(code).toBe(0);
    expect(out).toMatch(/--- Dr\. Patel's phone \(Photon, doctor\), \d\d:\d\d ---\nDaily check-in summary for Harriet Lindqvist/);
    expect(out).toMatch(/--- Sarah's phone \(Photon, emergency contact\), \d\d:\d\d ---\nHi Sarah\./);
    expect(out).toContain("Please contact Harriet's doctor, Dr. Patel, at +1 555-555-0100.");
    expect(out).toContain("Photon: text from family +1 ***-***-0101: none, no reply needed");
    expect(out).toMatch(/Open flags: R1 \(new\)/);
  });

  it("without --photon nothing goes over Photon until /summary", async () => {
    const { code, out } = await run(false);
    expect(code).toBe(0);
    expect(out).not.toContain("Daily check-in summary");
    // The replies still run (no summary yet): the urgent one is fixed, the rest say there's no update.
    expect(out).toContain("Please contact her doctor, Dr. Patel, at");
    expect(out).toContain("No check-in summary has been sent yet");
  });
});
