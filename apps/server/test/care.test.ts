import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MISSED_JOB, startAgent, type AgentDeps, type RunningAgent } from "../src/agent.ts";
import { ClaudeReplyWriter, NO_REPLY, systemPrompt } from "../src/care/claude-writer.ts";
import { parseCareContacts, type CareContacts } from "../src/care/contacts.ts";
import { doctorSummary, familySummary } from "../src/care/copy.ts";
import { buildCareFacts, type CareFacts } from "../src/care/facts.ts";
import { classifyInbound, guardReply, type ReplyRequest, type ReplyWriter } from "../src/care/replies.ts";
import { startCareRuntime, type CareRuntime } from "../src/care/runtime.ts";
import { createCheckinEngine, type DayFinished } from "../src/checkin/engine.ts";
import type { CheckinEngine } from "../src/checkin/engine-types.ts";
import { parseScript, runSimulation, snapshotLoader } from "../src/cli/simulator.ts";
import { loadConfig } from "../src/config.ts";
import { careMessages, latestSentSummary } from "../src/db/care.ts";
import { getCheckin } from "../src/db/checkins.ts";
import { linkFamilyMember, syncFamilyMembers } from "../src/db/family.ts";
import { openDatabase, upsertPatient, type Db } from "../src/db/index.ts";
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
async function checkIn(answers: [string, string, string] = ["No", "No", "No"]): Promise<void> {
  await engine.startDay(P, DAY1);
  await tap("Let's start");
  for (const a of answers) await tap(a);
  await tap("Later");
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
      ["hf-breathing-lying-flat", "No"],
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
    await checkIn(["Yes", "No", "No"]);
    const f = facts();
    expect(f.redFlags).toEqual([{ questionId: "hf-breathing-lying-flat", question: expect.stringMatching(/lying flat/), answer: "Yes" }]);
    expect(f.familyAlerted).toEqual(["Sarah"]);
    expect(f.checkin.answers[0]?.worrying).toBe(true);
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
    expect(familySummary(f, CONTACTS)).toMatch(/heart rate was about 74 beats a minute.*irregular heartbeat \(atrial fibrillation\)/s);
  });

  it("an unstarted day reads as none, and the noon job's missed as missed", async () => {
    expect(facts().checkin.outcome).toBe("none");
    await engine.startDay(P, DAY1);
    expect(facts().checkin.outcome).toBe("in_progress");
    await engine.runMissedCheckin(P, DAY1);
    expect(facts().checkin.outcome).toBe("missed");
  });
});

describe("care summary wording", () => {
  beforeEach(() => setup());

  it("doctor: a data summary with values, evidence and the emergency contact", async () => {
    await checkIn(["Yes", "No", "No"]);
    const text = doctorSummary(facts(), CONTACTS);
    expect(text).toMatch(/^Daily check-in summary for Harriet Lindqvist, 78 \(synthetic demo patient\)\./);
    expect(text).toContain("CHECK-IN: Completed");
    expect(text).toMatch(/lying flat last night\? Yes {2}\[RED FLAG\]/);
    expect(text).toContain("RED FLAGS: 1");
    expect(text).toContain("Sarah alerted in Relay");
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
    await checkIn(["Yes", "No", "No"]);
    const text = familySummary(facts(), CONTACTS);
    expect(text).toContain("One thing needs attention");
    expect(text).toContain("Please call Harriet today");
    expect(text).toContain("Dr. Patel can be reached at +1 734-555-0142");
  });

  it("family: only flags she has already heard, as not emergencies", async () => {
    await checkIn();
    db.prepare("UPDATE flags SET status = 'noted' WHERE patient_id = ? AND rule_id = 'R1'").run(P);
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

describe("sending the summaries", () => {
  beforeEach(() => setup());

  it("go out once, when the check-in ends, to both contacts", async () => {
    await engine.startDay(P, DAY1);
    await tap("Let's start");
    await tap("No");
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

  it("the noon fallback covers a check-in she started but didn't finish", async () => {
    await engine.startDay(P, DAY1);
    await tap("Let's start");
    await tap("No");
    expect(await engine.runMissedCheckin(P, DAY1)).toBe("nothing_to_do");
    expect(photon.sent).toEqual([]);
    await care.afterMissedCheckin(DAY1);
    expect(toFamily()[0]).toContain("started this morning's check-in but hasn't finished it yet");
    expect(photon.sent).toHaveLength(2);
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
    await checkIn(["Yes", "No", "No"]);
    await text(FAMILY_PHONE, "Is she feeling ok today?");
    const all = logs.join("\n");
    expect(all).toContain("+1 ***-***-0142");
    expect(all).not.toMatch(/7345550142|3135550187/);
    expect(all).not.toMatch(/feeling ok|lying flat|Harriet/);
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

  it("urgent-sounding family texts get the fixed doctor-first reply", async () => {
    setup();
    await checkIn(["Yes", "No", "No"]);
    const urgent = [
      "She sounds out of breath, what should I do?",
      "Should I take her to the hospital?",
      "Mom fell this morning",
      "She has chest pain",
      "she's really dizzy and confused",
      "Is this an emergency??",
      "her ankles are swollen",
    ];
    for (const message of urgent) {
      expect(classifyInbound("family", message), message).toBe("family_urgent");
      await text(FAMILY_PHONE, message);
      const reply = toFamily().at(-1) ?? "";
      expect(reply, message).toContain("I'm an automated assistant, so I don't have the medical knowledge to judge symptoms");
      expect(reply).toContain("Please contact Harriet's doctor, Dr. Patel, first at +1 734-555-0142 before acting on this.");
      expect(reply).toContain("If it looks like an emergency, call 911.");
    }
  });

  it("the same urgent reply goes out even before any summary, and even with a writer", async () => {
    let calls = 0;
    setup({ writer: { write: async () => (calls++, "made up") } });
    await text(FAMILY_PHONE, "She can't breathe");
    expect(toFamily()[0]).toContain("Please contact her doctor, Dr. Patel, first");
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
    await checkIn(["Yes", "No", "No"]);
    await text(DOCTOR_PHONE, "What were her latest labs?");
    expect(toDoctor().at(-1)).toMatch(/Open flags: R1 \(new\), R3 \(new\), R4 \(new\)\. Recent labs: .*Glomerular filtration rate 31/);
    await text(DOCTOR_PHONE, "How did the check-in go?");
    expect(toDoctor().at(-1)).toMatch(/Check-in completed on 2026-09-01\. .*Red flags: .*lying flat.*"Yes"/);
    await text(FAMILY_PHONE, "How is she doing?");
    expect(toFamily().at(-1)).toMatch(/Harriet checked in today\. One of her answers needs attention, so please call her today\./);
    await text(FAMILY_PHONE, "What medicines is she on?");
    expect(toFamily().at(-1)).toBe("Her record lists 14 medicines. For questions about any of them, her doctor is the right person to ask.");
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

describe("ClaudeReplyWriter", () => {
  beforeEach(() => setup());

  async function request(audience: "doctor" | "family"): Promise<ReplyRequest> {
    await checkIn();
    const summary = latestSentSummary(db, P, audience)!;
    const contact = audience === "doctor" ? CONTACTS.doctor : CONTACTS.emergencyContact;
    return { contact, contacts: CONTACTS, facts: summary.facts, summaryText: "the summary", thread: [], message: "How is she?" };
  }

  it("sends the tone and the grounding rules, and the facts, to the model", async () => {
    const calls: { model: string; system: string; messages: { role: string; content: string }[] }[] = [];
    const writer = new ClaudeReplyWriter({
      model: "claude-test",
      create: async (params) => {
        calls.push(params as never);
        return { content: [{ type: "text", text: "  She checked in.  " }] } as never;
      },
    });
    const req = await request("family");
    expect(await writer.write(req)).toBe("She checked in.");
    expect(calls[0]?.model).toBe("claude-test");
    expect(calls[0]?.messages[0]?.content).toContain('"preferredName":"Harriet"');
    expect(calls[0]?.messages[0]?.content).toContain("How is she?");
    expect(systemPrompt(req)).not.toBe(systemPrompt({ ...req, contact: CONTACTS.doctor }));
  });

  it("NO_REPLY or nothing means no reply", async () => {
    const req = await request("doctor");
    for (const text of [NO_REPLY, "  "]) {
      const writer = new ClaudeReplyWriter({ create: async () => ({ content: [{ type: "text", text }] }) as never });
      expect(await writer.write(req)).toBeNull();
    }
  });

  it("needs a key without an injected client", () => {
    expect(() => new ClaudeReplyWriter({})).toThrow(/ANTHROPIC_API_KEY/);
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
    expect(out).toContain("Please contact Harriet's doctor, Dr. Patel, first at +1 555-555-0100 before acting on this.");
    expect(out).toContain("Photon: text from family +1 ***-***-0101: none, no reply needed");
    expect(out).toMatch(/Open flags: R1 \(new\)/);
  });

  it("without --photon nothing goes over Photon until /summary", async () => {
    const { code, out } = await run(false);
    expect(code).toBe(0);
    expect(out).not.toContain("Daily check-in summary");
    // The replies still run (no summary yet): the urgent one is fixed, the rest say there's no update.
    expect(out).toContain("Please contact her doctor, Dr. Patel, first");
    expect(out).toContain("No check-in summary has been sent yet");
  });
});
