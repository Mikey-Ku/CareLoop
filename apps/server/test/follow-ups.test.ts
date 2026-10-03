import { beforeEach, describe, expect, it } from "vitest";
import {
  BUTTON,
  FOLLOW_UP_BUTTONS,
  crisisReply,
  familyFollowUpUpdate,
  familyFollowUpWorse,
  followUpQuestion,
  followUpReply,
  redFlagAdvice,
  withLead,
  withTypingHint,
} from "../src/checkin/copy.ts";
import { createCheckinEngine } from "../src/checkin/engine.ts";
import type { CheckinEngine } from "../src/checkin/engine-types.ts";
import { QUESTION_BANK, promptButtons, type Question } from "../src/context/questions.ts";
import { linkFamilyMember, syncFamilyMembers } from "../src/db/family.ts";
import {
  answerFollowUp,
  dueFollowUps,
  followUpForMessage,
  markFollowUpSent,
  mergedReason,
  nextFollowUp,
  openFollowUp,
  scheduleFollowUp,
} from "../src/db/follow-ups.ts";
import { openDatabase, setSharing, upsertPatient, type Db } from "../src/db/index.ts";
import { loadRxNavCache, loadSnapshot } from "../src/finchnode/fixtures.ts";
import { FakeLlmClient } from "../src/llm/fake.ts";
import { FakeMessenger } from "../src/relay/fake-messenger.ts";
import type { SentMessage } from "../src/relay/messenger.ts";

// Follow-up check-ins after a red flag or a safety hit (src/db/follow-ups.ts,
// CheckinEngine.runDueFollowUps). Synthetic data only.

const P = "harriet";
const ME = "chat_harriet";
const SARAH = "chat_sarah";
const DAY1 = "2026-09-01";
const T0 = `${DAY1}T13:00:00.000Z`; // the concern
const DUE = `${DAY1}T16:00:00.000Z`; // 180 minutes later
const LABELS = Object.values(FOLLOW_UP_BUTTONS);
const rxnav = loadRxNavCache();
const breathing = QUESTION_BANK.find((q) => q.id === "hf-breathing-lying-flat")!;

let db: Db;
let messenger: FakeMessenger;
let engine: CheckinEngine;
let now: string;
let inbound = 0;

function setup(llm?: FakeLlmClient) {
  db = openDatabase(":memory:");
  upsertPatient(db, { id: P, finchnodePatientId: "patient-demo-polypharmacy", preferredName: "Harriet", relayChatId: ME });
  syncFamilyMembers(db, P, ["sarah"]);
  linkFamilyMember(db, "sarah", SARAH, "Sarah", T0);
  now = T0;
  messenger = new FakeMessenger({ now: () => now });
  engine = createCheckinEngine({ db, messenger, clock: { now: () => now }, loadSnapshot: async (s) => loadSnapshot(s), llm }, { rxnav });
}

async function say(text: string, replyTo?: SentMessage): Promise<SentMessage[]> {
  const before = messenger.sent.length;
  await engine.handleInbound({ chatId: ME, messageId: `in_${++inbound}`, text, ...(replyTo ? { replyTo: replyTo.messageId } : {}), at: now });
  return messenger.sent.slice(before);
}

const brief = (messages: SentMessage[]) => messages.map(({ chatId, text, buttons }) => ({ chatId, text, buttons }));
const msg = (chatId: string, text: string, buttons?: string[]) => ({ chatId, text, buttons });
/** A question as she gets it on her first check-ins: `lead` before it, the typing hint under it, "Let me explain" on a symptom question. */
const asked = (q: Pick<Question, "id" | "text" | "buttons">, lead?: string) => msg(ME, withLead(lead, withTypingHint(q.text)), promptButtons(q));

/** A red flag on the breathing question (day 1, Harriet taps "Yes, it was hard", then No twice), then the follow-up sent. */
async function redFlagThenDue(): Promise<SentMessage> {
  await engine.startDay(P, DAY1);
  for (const t of [BUTTON.start, "Yes, it was hard", "No", "No"]) await say(t);
  now = DUE;
  expect(await engine.runDueFollowUps(now)).toBe(1);
  return messenger.lastIn(ME)!;
}

beforeEach(() => {
  inbound = 0;
  setup();
});

describe("runDueFollowUps", () => {
  it("sends nothing before it is due, then the topic's question with Better / About the same / Worse, once", async () => {
    await engine.startDay(P, DAY1);
    await say(BUTTON.start);
    await say("Yes, it was hard");
    expect(await engine.runDueFollowUps("2026-09-01T15:59:00.000Z")).toBe(0);
    now = DUE;
    expect(await engine.runDueFollowUps(now)).toBe(1);
    const sent = messenger.lastIn(ME)!;
    expect(brief([sent])).toEqual([msg(ME, followUpQuestion("Harriet", "breathing"), LABELS)]);
    expect(nextFollowUp(db, P)).toBeUndefined();
    expect(followUpForMessage(db, sent.messageId)).toMatchObject({ reason: breathing.id, sentAt: DUE, answeredAt: null });
    expect(await engine.runDueFollowUps(now)).toBe(0);
  });

  it("asks about bleeding after a bleeding red flag, and how she feels after a safety hit", async () => {
    await engine.startDay(P, DAY1);
    await say(BUTTON.start);
    await say("Fine");
    await say("Yes, bleeding");
    now = DUE;
    await engine.runDueFollowUps(now);
    expect(messenger.lastIn(ME)?.text).toBe(followUpQuestion("Harriet", "bleeding"));
    await say("I have chest pain");
    now = "2026-09-01T19:00:00.000Z";
    await engine.runDueFollowUps(now);
    expect(messenger.lastIn(ME)?.text).toBe(followUpQuestion("Harriet", "general"));
  });

  it("a send that fails stays unsent and goes out on the next run, once", async () => {
    await engine.startDay(P, DAY1);
    await say(BUTTON.start);
    await say("Yes, it was hard");
    now = DUE;
    const send = messenger.send.bind(messenger);
    messenger.send = async () => {
      throw new Error("relay down");
    };
    await expect(engine.runDueFollowUps(now)).rejects.toThrow(/relay down/);
    expect(nextFollowUp(db, P)).toBeDefined();
    messenger.send = send;
    expect(await engine.runDueFollowUps(now)).toBe(1);
    expect(messenger.inChat(ME).filter((m) => m.text === followUpQuestion("Harriet", "breathing"))).toHaveLength(1);
  });

  it("two runs at once send each follow-up once", async () => {
    await engine.startDay(P, DAY1);
    await say(BUTTON.start);
    await say("Yes, it was hard");
    now = DUE;
    const [a, b] = await Promise.all([engine.runDueFollowUps(now), engine.runDueFollowUps(now)]);
    expect(a + b).toBeGreaterThanOrEqual(1);
    expect(messenger.inChat(ME).filter((m) => m.text === followUpQuestion("Harriet", "breathing"))).toHaveLength(1);
  });

  it("waits while her chat isn't linked", async () => {
    scheduleFollowUp(db, { patientId: P, checkinId: null, reason: "crisis", createdAt: T0, dueAt: DUE });
    db.prepare("UPDATE patients SET relay_chat_id = NULL").run();
    expect(await engine.runDueFollowUps(DUE)).toBe(0);
    expect(nextFollowUp(db, P)).toBeDefined();
  });
});

describe("her answer", () => {
  it("Better: a short warm reply; the family hears nothing below all", async () => {
    const f = await redFlagThenDue();
    expect(brief(await say("Better", f))).toEqual([msg(ME, followUpReply("Harriet", "better", "breathing"))]);
    expect(openFollowUp(db, P)).toBeUndefined();
    expect(followUpForMessage(db, f.messageId)).toMatchObject({ answer: "Better", answeredAt: now });
    expect(messenger.inChat(SARAH).filter((m) => m.at === now)).toEqual([]);
  });

  it("About the same at sharing all: a short reply, and the family gets a line", async () => {
    setSharing(db, P, "all");
    const f = await redFlagThenDue();
    expect(brief(await say("About the same", f))).toEqual([
      msg(ME, followUpReply("Harriet", "same", "breathing")),
      msg(SARAH, familyFollowUpUpdate({ seniorName: "Harriet", topic: "breathing", answer: "same" })),
    ]);
  });

  it("Worse: red-flag advice again, and an alert to the family at every level", async () => {
    const f = await redFlagThenDue();
    expect(brief(await say("Worse", f))).toEqual([
      msg(ME, redFlagAdvice("Harriet", ["Sarah"])),
      msg(SARAH, familyFollowUpWorse({ seniorName: "Harriet", sharing: "status", topic: "breathing" })),
    ]);
  });

  it("Worse after a crisis gets the crisis reply again", async () => {
    await say("I want to end my life");
    now = DUE;
    await engine.runDueFollowUps(now);
    const f = messenger.lastIn(ME)!;
    expect(f.text).toBe(followUpQuestion("Harriet", "crisis"));
    expect((await say("Worse", f))[0]?.text).toBe(crisisReply("Harriet", ["Sarah"]));
  });

  it("typed without a reply-to, the label answers the open follow-up; a second tap does nothing", async () => {
    const f = await redFlagThenDue();
    expect(brief(await say("better"))).toEqual([msg(ME, followUpReply("Harriet", "better", "breathing"))]);
    expect(await say("Worse", f)).toEqual([]);
    expect(await say("Worse")).toEqual([]);
  });

  it("while the check-in waits on a question, her answer comes first and the question comes back", async () => {
    await engine.startDay(P, DAY1);
    await say(BUTTON.start);
    await say("I have chest pain"); // pauses on the breathing question
    now = DUE;
    await engine.runDueFollowUps(now);
    const f = messenger.lastIn(ME)!;
    expect(brief(await say("Better", f))).toEqual([msg(ME, followUpReply("Harriet", "better", "general")), asked(breathing)]);
    // The re-sent question takes her tap.
    expect((await say("Fine", messenger.lastIn(ME)))[0]?.text).toMatch(/bruising or bleeding/);
  });

  it("typed in her own words, the model maps it to a button", async () => {
    const llm = new FakeLlmClient({ classifyMessage: () => ({ kind: "answer", answer: "Better", confidence: "high", complaints: [], memories: [] }) });
    setup(llm);
    await redFlagThenDue();
    expect(brief(await say("much easier to breathe now, thanks"))).toEqual([msg(ME, followUpReply("Harriet", "better", "breathing"))]);
    expect(llm.classifyCalls.at(-1)?.pending).toEqual({ question: followUpQuestion("Harriet", "breathing"), options: LABELS });
  });
});

describe("follow_ups rows", () => {
  it("one waiting follow-up per patient: the same reason joins, another makes it general, a crisis outranks", () => {
    const id = scheduleFollowUp(db, { patientId: P, checkinId: null, reason: "hf-breathing-lying-flat", createdAt: T0, dueAt: DUE });
    expect(scheduleFollowUp(db, { patientId: P, checkinId: null, reason: "hf-breathing-lying-flat", createdAt: T0, dueAt: "2026-09-01T17:00:00.000Z" })).toBe(id);
    expect(nextFollowUp(db, P)).toMatchObject({ id, reason: "hf-breathing-lying-flat", dueAt: DUE });
    scheduleFollowUp(db, { patientId: P, checkinId: null, reason: "anticoagulant-bleeding", createdAt: T0, dueAt: DUE });
    expect(nextFollowUp(db, P)?.reason).toBe("general");
    scheduleFollowUp(db, { patientId: P, checkinId: null, reason: "crisis", createdAt: T0, dueAt: DUE });
    expect(nextFollowUp(db, P)?.reason).toBe("crisis");
    expect(mergedReason("crisis", "urgent_symptom")).toBe("crisis");
    expect(mergedReason("urgent_symptom", "urgent_symptom")).toBe("urgent_symptom");
  });

  it("a sent follow-up doesn't absorb a new concern; due ones come back earliest first", () => {
    const first = scheduleFollowUp(db, { patientId: P, checkinId: null, reason: "crisis", createdAt: T0, dueAt: DUE });
    markFollowUpSent(db, first, "msg_x", DUE);
    const second = scheduleFollowUp(db, { patientId: P, checkinId: null, reason: "urgent_symptom", createdAt: T0, dueAt: "2026-09-01T18:00:00.000Z" });
    expect(second).not.toBe(first);
    expect(dueFollowUps(db, "2026-09-01T17:00:00.000Z")).toEqual([]);
    expect(dueFollowUps(db, "2026-09-01T18:00:00.000Z").map((f) => f.id)).toEqual([second]);
    expect(openFollowUp(db, P)?.id).toBe(first);
    expect(answerFollowUp(db, first, "Better", DUE)).toBe(true);
    expect(answerFollowUp(db, first, "Worse", DUE)).toBe(false);
    expect(followUpForMessage(db, "msg_x")?.answer).toBe("Better");
  });
});
