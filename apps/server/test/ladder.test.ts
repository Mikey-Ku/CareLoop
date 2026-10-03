import { beforeEach, describe, expect, it } from "vitest";
import {
  BUTTON,
  CLARIFY_BUTTONS,
  FOLLOW_UP_BUTTONS,
  checkinDone,
  checkinDoneAfterConcern,
  clarifyAmount,
  complaintReply,
  didntUnderstand,
  familyFollowUpUpdate,
  familyFollowUpWorse,
  familyRedFlagAlert,
  feelingLowReply,
  flagOffer,
  followUpQuestion,
  followUpReply,
  freeTextConfirm,
  keepAnEye,
  keepAnEyeReply,
  notedForDoctor,
  redFlagAdvice,
  symptomNotedReply,
  urgentReply,
  withLead,
  withTypingHint,
} from "../src/checkin/copy.ts";
import { createCheckinEngine } from "../src/checkin/engine.ts";
import type { CheckinEngine } from "../src/checkin/engine-types.ts";
import { QUESTION_BANK, promptButtons, type Question } from "../src/context/questions.ts";
import { getCheckin } from "../src/db/checkins.ts";
import { addClarification, clarificationAsked, closeClarification, openClarification } from "../src/db/clarifications.ts";
import { linkFamilyMember, syncFamilyMembers } from "../src/db/family.ts";
import { nextFollowUp, scheduleFollowUp } from "../src/db/follow-ups.ts";
import { openDatabase, setSharing, upsertPatient, type Db } from "../src/db/index.ts";
import { addObservation, highestOfDay, observationsBetween, recentObservations } from "../src/db/observations.ts";
import { loadRxNavCache, loadSnapshot } from "../src/finchnode/fixtures.ts";
import { FakeLlmClient } from "../src/llm/fake.ts";
import type { MessageClassification, MessageKind, SymptomMention } from "../src/llm/types.ts";
import { FakeMessenger } from "../src/relay/fake-messenger.ts";
import type { SentMessage } from "../src/relay/messenger.ts";

// The severity ladder in the engine (src/checkin/engine.ts "Severity ladder", src/checkin/severity.ts):
// what she hears and what her family gets at each level, typed symptoms, the one clarifying question,
// the repetition rule and follow-up answers. Synthetic data only. The fixed tables are in severity.test.ts.

const P = "harriet";
const ME = "chat_harriet";
const SARAH = "chat_sarah";
const DAY1 = "2026-09-01"; // breathing, bleeding, dizziness
const DAY2 = "2026-09-02"; // after a calm day 1: ankles, morning medicines, mood
const ALARM = /911|emergenc|ambulance/i;
const rxnav = loadRxNavCache();

const question = (id: string) => QUESTION_BANK.find((q) => q.id === id)!;
const breathing = question("hf-breathing-lying-flat");
const bleeding = question("anticoagulant-bleeding");
const dizzy = question("dizzy-on-standing");
const ankles = question("hf-ankle-swelling");
const medicines = question("morning-medicines");
const mood = question("mood");

let db: Db;
let messenger: FakeMessenger;
let engine: CheckinEngine;
let llm: FakeLlmClient;
let now: string;
let inbound = 0;
/** The model's readings, one per typed message, in order. When none is left: chat it isn't sure of. */
let readings: MessageClassification[];

const as = (kind: MessageKind, extra: Partial<MessageClassification> = {}): MessageClassification => ({
  kind,
  confidence: "high",
  complaints: [],
  memories: [],
  ...extra,
});
const symptom = (topic: string, amount: SymptomMention["amount"], change: SymptomMention["change"] = "same", questionId?: string): SymptomMention => ({
  topic,
  amount,
  change,
  words: topic,
  ...(questionId ? { questionId } : {}),
});

function setup() {
  db = openDatabase(":memory:");
  upsertPatient(db, { id: P, finchnodePatientId: "patient-demo-polypharmacy", preferredName: "Harriet", relayChatId: ME });
  syncFamilyMembers(db, P, ["sarah"]);
  linkFamilyMember(db, "sarah", SARAH, "Sarah", `${DAY1}T08:00:00.000Z`);
  now = `${DAY1}T09:00:00.000Z`;
  readings = [];
  messenger = new FakeMessenger({ now: () => now });
  llm = new FakeLlmClient({
    classifyMessage: () => readings.shift() ?? as("chat", { confidence: "low" }),
    smallTalk: () => ({ text: "That sounds nice, Harriet.", memories: [], complaints: [] }),
  });
  engine = createCheckinEngine({ db, messenger, clock: { now: () => now }, loadSnapshot: async (s) => loadSnapshot(s), llm }, { rxnav });
}

async function say(text: string, reading?: MessageClassification): Promise<SentMessage[]> {
  if (reading) readings.push(reading);
  const before = messenger.sent.length;
  await engine.handleInbound({ chatId: ME, messageId: `in_${++inbound}`, text, at: now });
  return messenger.sent.slice(before);
}

async function tap(label: string, on: SentMessage | undefined): Promise<SentMessage[]> {
  if (!on) throw new Error(`no message to tap "${label}" on`);
  const before = messenger.sent.length;
  await engine.handleInbound({ chatId: ME, messageId: `in_${++inbound}`, text: label, replyTo: on.messageId, at: now });
  return messenger.sent.slice(before);
}

const brief = (messages: SentMessage[]) => messages.map(({ chatId, text, buttons }) => ({ chatId, text, buttons }));
const msg = (chatId: string, text: string, buttons?: string[]) => ({ chatId, text, buttons });
/** A question as she gets it on her first check-ins: `lead` before it, the typing hint under it, "Let me explain" on a symptom question. */
const asked = (q: Pick<Question, "id" | "text" | "buttons">, lead?: string) => msg(ME, withLead(lead, withTypingHint(q.text)), promptButtons(q));
const observations = () => observationsBetween(db, P, "2026-01-01", "2026-12-31");
const toFamily = () => messenger.inChat(SARAH).map((m) => m.text);
const toHer = () => messenger.inChat(ME).map((m) => m.text);

/** Day 1 started and "Let's start" tapped: the breathing question waits. */
async function atBreathing(): Promise<void> {
  await engine.startDay(P, DAY1);
  await say(BUTTON.start);
}

/** A calm day 1, then day 2 started and "Let's start" tapped: the ankle question waits. */
async function atAnkles(): Promise<void> {
  await engine.startDay(P, DAY1);
  for (const t of [BUTTON.start, "Fine", "No", "No", BUTTON.later]) await say(t);
  now = `${DAY2}T09:00:00.000Z`;
  expect(await engine.startDay(P, DAY2)).toEqual({ kind: "sent", questionIds: [ankles.id, medicines.id, mood.id] });
  await say(BUTTON.start);
  messenger.sent.length = 0;
}

/** Run every follow-up due by `at` and return the follow-up message she got. */
async function followUpAt(at: string): Promise<SentMessage> {
  now = at;
  expect(await engine.runDueFollowUps(now)).toBe(1);
  return messenger.lastIn(ME)!;
}

beforeEach(() => {
  inbound = 0;
  setup();
});

describe("level 0: nothing extra", () => {
  it("Fine, No, No: straight to each next message; saved as level-0 taps; no follow-up", async () => {
    await atBreathing();
    expect(brief(await say("Fine"))).toEqual([asked(bleeding)]);
    expect(brief(await say("No"))).toEqual([asked(dizzy)]);
    expect(brief(await say("No"))).toEqual([msg(ME, flagOffer(), [BUTTON.tellMeMore, BUTTON.later])]);
    expect(observations().map((o) => [o.topic, o.level, o.source, o.day])).toEqual([
      [breathing.id, 0, "button", DAY1],
      [bleeding.id, 0, "button", DAY1],
      [dizzy.id, 0, "button", DAY1],
    ]);
    expect(getCheckin(db, P, DAY1)?.answers.map((a) => a.level)).toEqual([0, 0, 0]);
    expect(nextFollowUp(db, P)).toBeUndefined();
    expect((await say(BUTTON.later))[0]?.text).toBe(checkinDone("Harriet"));
  });
});

describe("level 1: noted for her doctor, once per check-in", () => {
  it("Sometimes on dizziness: one line before the next message, no advice, no follow-up, no alert", async () => {
    setSharing(db, P, "all");
    await atBreathing();
    await say("Fine");
    await say("No");
    expect(brief(await say("Sometimes"))).toEqual([msg(ME, withLead(notedForDoctor(), flagOffer()), [BUTTON.tellMeMore, BUTTON.later])]);
    expect(nextFollowUp(db, P)).toBeUndefined();
    const end = await say(BUTTON.later);
    expect(end[0]?.text).toBe(checkinDone("Harriet"));
    expect(toFamily()).toHaveLength(1);
    expect(toFamily()[0]).toContain("Harriet mentioned some dizziness (noted for the doctor).");
    expect(getCheckin(db, P, DAY1)?.answers.at(-1)).toMatchObject({ answer: "Sometimes", level: 1 });
    expect(observations().at(-1)).toMatchObject({ topic: dizzy.id, level: 1, source: "button" });
  });

  it("a second level-1 answer in the same check-in gets no line", async () => {
    await atAnkles();
    expect(brief(await say("A little"))).toEqual([asked(medicines, notedForDoctor())]);
    expect(brief(await say("Some of them"))).toEqual([asked(mood)]);
    expect((await say("Good"))[0]?.text).toBe(flagOffer());
    expect(getCheckin(db, P, DAY2)?.answers.map((a) => a.level)).toEqual([1, 1, 0]);
  });

  it('mood "Not great" is level 1 with the warm feeling-low words, whatever was said before', async () => {
    setSharing(db, P, "all");
    await atAnkles();
    await say("A little");
    await say("Yes");
    expect((await say("Not great"))[0]?.text).toBe(withLead(feelingLowReply("Harriet"), flagOffer()));
    expect(getCheckin(db, P, DAY2)).toMatchObject({ mood: "Not great" });
    expect(nextFollowUp(db, P)).toBeUndefined();
    await say(BUTTON.later);
    expect(toFamily().at(-1)).toContain("Harriet mentioned some ankle swelling (noted for the doctor).");
  });
});

describe("level 2: worth watching", () => {
  it("A little bruising: keep an eye on it before the next question, a follow-up, no alert, a flag still offered, closing this afternoon", async () => {
    await atBreathing();
    await say("Fine");
    expect(brief(await say("A little bruising"))).toEqual([asked(dizzy, keepAnEye("Harriet"))]);
    const c = getCheckin(db, P, DAY1)!;
    expect(c.concernAt).toBeNull();
    expect(nextFollowUp(db, P)).toMatchObject({ reason: bleeding.id, level: 2, checkinId: c.id, dueAt: `${DAY1}T12:00:00.000Z` });
    expect(brief(await say("No"))).toEqual([msg(ME, flagOffer(), [BUTTON.tellMeMore, BUTTON.later])]);
    expect((await say(BUTTON.later))[0]?.text).toBe(checkinDoneAfterConcern("Harriet"));
    // Below "all" the family gets the plain status only: no alert, no detail.
    expect(toFamily()).toEqual(["Harriet checked in today."]);
  });

  it("at sharing all the day's status says it in words", async () => {
    setSharing(db, P, "all");
    await atBreathing();
    for (const t of ["Fine", "A little bruising", "No", BUTTON.later]) await say(t);
    expect(toFamily()).toHaveLength(1);
    expect(toFamily()[0]).toContain("Harriet mentioned some bruising or bleeding (we're keeping an eye on it).");
    expect(highestOfDay(db, P, DAY1)).toMatchObject({ level: 2, topic: bleeding.id });
  });

  it.each([
    ["A little hard on breathing", "A little hard", "Fine"],
    ["Often on dizziness", "Fine", "Often"],
  ])("%s is level 2 too", async (_, first, third) => {
    await atBreathing();
    await say(first);
    await say("No");
    await say(third);
    expect(observations().map((o) => o.level)).toContain(2);
    expect(nextFollowUp(db, P)?.level).toBe(2);
    expect(toFamily()).toEqual([]);
    expect(toHer().some((t) => ALARM.test(t))).toBe(false);
  });

  it("More than usual on the ankles: keep an eye on it, a follow-up about her ankles", async () => {
    await atAnkles();
    expect((await say("More than usual"))[0]?.text).toBe(withLead(keepAnEye("Harriet"), withTypingHint(medicines.text)));
    expect(nextFollowUp(db, P)).toMatchObject({ reason: ankles.id, level: 2 });
    expect((await followUpAt(`${DAY2}T12:00:00.000Z`)).text).toBe(followUpQuestion("Harriet", "ankles"));
  });
});

describe("level 3: her doctor today", () => {
  it("Yes, bleeding: the red-flag reply, an alert, a level-3 follow-up, no flag offer", async () => {
    await atBreathing();
    await say("Fine");
    const sent = await say("Yes, bleeding");
    expect(brief(sent)).toEqual([
      msg(ME, redFlagAdvice("Harriet", ["Sarah"], 1)),
      msg(SARAH, familyRedFlagAlert({ seniorName: "Harriet", sharing: "status", questionText: bleeding.text, answer: "Yes, bleeding" })),
      asked(dizzy),
    ]);
    expect(sent[0]!.text).toContain("If it gets much worse, call 911.");
    expect(nextFollowUp(db, P)).toMatchObject({ reason: bleeding.id, level: 3 });
    expect(observations().at(-1)).toMatchObject({ topic: bleeding.id, level: 3 });
    expect((await say("No")).map((m) => m.text)).not.toContain(flagOffer());
  });
});

describe("no 911, emergency or ambulance below level 3", () => {
  it("a whole day at levels 0 to 2, typed and tapped, with chat and a follow-up, never says them", async () => {
    setSharing(db, P, "all");
    await atAnkles();
    await say("bit puffy", as("answer", { answer: "A little", symptoms: [symptom("ankles", "a_little", "same", ankles.id)] }));
    await say("Some of them");
    await say("Not great");
    await say(BUTTON.later);
    await say("my knee aches a bit", as("chat", { symptoms: [symptom("knee pain", "a_little")] }));
    await say("my knee really hurts", as("chat", { symptoms: [symptom("knee pain", "a_lot")] }));
    await say("went out to the garden", as("chat", { complaints: ["back is stiff"] }));
    const f = await followUpAt(`${DAY2}T12:00:00.000Z`);
    await tap(FOLLOW_UP_BUTTONS.same, f);
    const all = [...toHer(), ...toFamily()];
    expect(all.length).toBeGreaterThan(8);
    for (const text of all) expect(text, text).not.toMatch(ALARM);
    // And they were levels 0 to 2.
    expect(Math.max(...observations().map((o) => o.level))).toBe(2);
  });
});

describe("typed answers: the model may raise a level, never lower it", () => {
  it('"A little" with ankles she calls worse than usual is level 2', async () => {
    await atAnkles();
    const sent = await say("a bit puffy, worse than yesterday", as("answer", { answer: "A little", symptoms: [symptom("ankles", "a_little", "worse", ankles.id)] }));
    expect(brief(sent)).toEqual([asked(medicines, keepAnEye("Harriet"))]);
    expect(getCheckin(db, P, DAY2)?.answers[0]).toMatchObject({ answer: "A little", level: 2, via: "free_text", freeText: "a bit puffy, worse than yesterday" });
    expect(observations().at(-1)).toMatchObject({ topic: ankles.id, level: 2, amount: "a_little", change: "worse", source: "typed" });
    expect(nextFollowUp(db, P)).toMatchObject({ reason: ankles.id, level: 2 });
  });

  it('"More than usual" stays 2 even if the symptom reads as a little', async () => {
    await atAnkles();
    await say("quite swollen", as("answer", { answer: "More than usual", symptoms: [symptom("ankles", "a_little", "same", ankles.id)] }));
    expect(getCheckin(db, P, DAY2)?.answers[0]).toMatchObject({ answer: "More than usual", level: 2 });
  });

  it("on a red-flag question a calm reading never counts, even with symptoms: the one-tap confirm, nothing recorded", async () => {
    await atBreathing();
    const words = "fine mostly, a bit tight";
    const sent = await say(words, as("answer", { answer: "Fine", symptoms: [symptom("breathing", "a_lot", "same", breathing.id)] }));
    expect(brief(sent)).toEqual([msg(ME, freeTextConfirm(words, breathing.text), promptButtons(breathing))]);
    expect(getCheckin(db, P, DAY1)?.answers).toEqual([]);
    expect(toFamily()).toEqual([]);
  });

  it("a symptom on another topic in her answer is levelled too: a lot of bleeding while answering about her ankles is level 3", async () => {
    await atAnkles();
    // Words the safety screen leaves alone ("bleeding a lot" would be an urgent symptom, level 4).
    const words = "ankles are fine but my nose bled for a while this morning";
    const sent = await say(words, as("answer", { answer: "No", symptoms: [symptom("nosebleed", "a_lot", "unknown")] }));
    expect(brief(sent)).toEqual([
      msg(ME, redFlagAdvice("Harriet", ["Sarah"], 2)),
      msg(SARAH, familyRedFlagAlert({ seniorName: "Harriet", sharing: "status", words })),
      asked(medicines),
    ]);
    expect(getCheckin(db, P, DAY2)).toMatchObject({ concernAt: now });
    expect(nextFollowUp(db, P)).toMatchObject({ reason: bleeding.id, level: 3 });
    expect(observations().filter((o) => o.day === DAY2).map((o) => [o.topic, o.level])).toEqual([
      [ankles.id, 0],
      [bleeding.id, 3],
    ]);
  });

  it("a small extra symptom gets the level-1 line", async () => {
    await atAnkles();
    const sent = await say("no swelling, knee aches", as("answer", { answer: "No", symptoms: [symptom("knee pain", "a_little")] }));
    expect(sent[0]?.text).toBe(withLead(notedForDoctor(), withTypingHint(medicines.text)));
    expect(getCheckin(db, P, DAY2)?.answers[0]).toMatchObject({ answer: "No", level: 1 });
  });
});

describe("one clarifying question at most", () => {
  const unclear = (change: SymptomMention["change"] = "same") =>
    as("answer", { answer: "unclear", confidence: "low", symptoms: [symptom("ankles", "unknown", change, ankles.id)] });
  const CLARIFY = [CLARIFY_BUTTONS.a_little, CLARIFY_BUTTONS.a_lot];

  it('"my ankles are swollen": A little, or a lot? Her tap sets the level and the answer', async () => {
    await atAnkles();
    const [ask] = await say("my ankles are swollen", unclear());
    expect(brief([ask!])).toEqual([msg(ME, clarifyAmount("Harriet"), CLARIFY)]);
    expect(getCheckin(db, P, DAY2)?.answers).toEqual([]);
    expect(brief(await tap(CLARIFY_BUTTONS.a_lot, ask))).toEqual([asked(medicines, keepAnEye("Harriet"))]);
    expect(getCheckin(db, P, DAY2)?.answers[0]).toMatchObject({ answer: "More than usual", level: 2, via: "free_text", freeText: "my ankles are swollen" });
    expect(openClarification(db, getCheckin(db, P, DAY2)!.id, ankles.id)).toBeUndefined();
    expect(nextFollowUp(db, P)?.level).toBe(2);
  });

  it("A little is level 1, or 2 when she said it was worse than usual", async () => {
    await atAnkles();
    const [ask] = await say("my ankles are swollen", unclear());
    expect((await tap(CLARIFY_BUTTONS.a_little, ask))[0]?.text).toBe(withLead(notedForDoctor(), withTypingHint(medicines.text)));
    expect(getCheckin(db, P, DAY2)?.answers[0]).toMatchObject({ answer: "A little", level: 1 });

    setup();
    await atAnkles();
    // Worse than usual, how much unclear: 2 either way, so nothing to ask.
    expect(brief(await say("my ankles are worse", unclear("worse")))).toEqual([msg(ME, didntUnderstand(ankles.buttons), promptButtons(ankles))]);
  });

  it("never twice: typed again, she gets the buttons", async () => {
    await atAnkles();
    await say("my ankles are swollen", unclear());
    expect(brief(await say("they're just swollen", unclear()))).toEqual([msg(ME, didntUnderstand(ankles.buttons), promptButtons(ankles))]);
    expect(messenger.sent.filter((m) => m.text === clarifyAmount("Harriet"))).toHaveLength(1);
  });

  it("a tap on the question's own button answers it and closes the clarification", async () => {
    await atAnkles();
    await say("my ankles are swollen", unclear());
    const c = getCheckin(db, P, DAY2)!;
    expect(openClarification(db, c.id, ankles.id)).toBeDefined();
    await say("No");
    expect(getCheckin(db, P, DAY2)?.answers[0]).toMatchObject({ answer: "No", level: 0 });
    expect(openClarification(db, c.id, ankles.id)).toBeUndefined();
    expect(clarificationAsked(db, c.id, ankles.id)).toBe(true);
    // A late "A lot" on the clarifying question is now just a tap on an old message: it answers nothing.
    const ask = messenger.sent.find((m) => m.text === clarifyAmount("Harriet"));
    expect(brief(await tap(CLARIFY_BUTTONS.a_lot, ask))).toEqual([asked(medicines)]);
    expect(getCheckin(db, P, DAY2)?.answers).toHaveLength(1);
  });

  it("dizziness: A lot is Often", async () => {
    await atBreathing();
    await say("Fine");
    await say("No");
    const [ask] = await say("I get dizzy", as("answer", { answer: "unclear", confidence: "low", symptoms: [symptom("dizzy", "unknown", "same", dizzy.id)] }));
    expect(ask?.text).toBe(clarifyAmount("Harriet"));
    await tap(CLARIFY_BUTTONS.a_lot, ask);
    expect(getCheckin(db, P, DAY1)?.answers.at(-1)).toMatchObject({ questionId: dizzy.id, answer: "Often", level: 2 });
  });

  it("never on a red-flag question: the one-tap confirm with the graded buttons instead", async () => {
    await atBreathing();
    const words = "my breathing was off";
    const sent = await say(words, as("answer", { answer: "unclear", confidence: "low", symptoms: [symptom("breathing", "unknown", "same", breathing.id)] }));
    expect(brief(sent)).toEqual([msg(ME, freeTextConfirm(words, breathing.text), promptButtons(breathing))]);
  });
});

describe("symptoms in chat: a fixed reply by level", () => {
  it("level 1 (a little knee pain): sorry, noted for her doctor; no follow-up, no family, no small talk", async () => {
    const sent = await say("my knee aches a bit", as("chat", { complaints: ["knee aches"], symptoms: [symptom("knee pain", "a_little")] }));
    expect(brief(sent)).toEqual([msg(ME, symptomNotedReply("Harriet", ["knee pain"]))]);
    expect(nextFollowUp(db, P)).toBeUndefined();
    expect(toFamily()).toEqual([]);
    expect(llm.smallTalkCalls).toEqual([]);
    expect(observations()).toMatchObject([{ topic: "knee pain", level: 1, source: "typed", checkinId: null }]);
  });

  it('level 2 ("my knee really hurts", the live test): keep an eye on it, a follow-up; no 911, no alert', async () => {
    const sent = await say("my knee really hurts", as("chat", { complaints: ["knee really hurts"], symptoms: [symptom("knee pain", "a_lot", "unknown")] }));
    expect(brief(sent)).toEqual([msg(ME, keepAnEyeReply("Harriet"))]);
    expect(sent[0]!.text).not.toMatch(ALARM);
    expect(nextFollowUp(db, P)).toMatchObject({ reason: "knee pain", level: 2 });
    expect(toFamily()).toEqual([]);
    expect((await followUpAt(`${DAY1}T12:00:00.000Z`)).text).toBe(followUpQuestion("Harriet", "general"));
  });

  it("the live breathing message: a little on breathing is worth watching (2), not an emergency", async () => {
    const words = "breathing a little sparse, tight at points, fine at others, a little cough";
    const sent = await say(words, as("chat", { symptoms: [symptom("breathing", "a_little", "unknown"), symptom("cough", "a_little", "unknown")] }));
    expect(brief(sent)).toEqual([msg(ME, keepAnEyeReply("Harriet"))]);
    expect(toFamily()).toEqual([]);
    expect(nextFollowUp(db, P)).toMatchObject({ reason: breathing.id, level: 2 });
    expect((await followUpAt(`${DAY1}T12:00:00.000Z`)).text).toBe(followUpQuestion("Harriet", "breathing"));
  });

  it("level 3 (a lot of bleeding): the red-flag reply and an alert with her words at all; no flag offer that day", async () => {
    setSharing(db, P, "all");
    await atBreathing();
    const words = "my gums bled again when I brushed, quite a bit";
    const sent = await say(words, as("chat", { symptoms: [symptom("bleeding gums", "a_lot")] }));
    expect(brief(sent)).toEqual([
      msg(ME, redFlagAdvice("Harriet", ["Sarah"])),
      msg(SARAH, familyRedFlagAlert({ seniorName: "Harriet", sharing: "all", words })),
      asked(breathing),
    ]);
    expect(nextFollowUp(db, P)).toMatchObject({ reason: bleeding.id, level: 3 });
    for (const t of ["Fine", "No"]) await say(t);
    expect((await say("No"))[0]?.text).toBe(checkinDoneAfterConcern("Harriet"));
  });

  it("only symptoms she doesn't have (none): the model's small talk", async () => {
    expect(brief(await say("my knee is fine now", as("chat", { symptoms: [symptom("knee pain", "none")] })))).toEqual([msg(ME, "That sounds nice, Harriet.")]);
    expect(observations()).toEqual([]);
  });

  it("a complaint with no symptom read: level-1 wording, saved for her doctor, no 911", async () => {
    const sent = await say("back is stiff today", as("chat", { complaints: ["back is stiff"] }));
    expect(brief(sent)).toEqual([msg(ME, complaintReply("Harriet"))]);
    expect(sent[0]!.text).not.toMatch(ALARM);
    expect(observations()).toMatchObject([{ topic: "back is stiff", level: 1, words: "back is stiff" }]);
    expect(llm.smallTalkCalls).toEqual([]);
  });

  it("while a question waits: the reply, then the question again", async () => {
    await atAnkles();
    const sent = await say("my knee aches a bit", as("chat", { symptoms: [symptom("knee pain", "a_little")] }));
    expect(brief(sent)).toEqual([msg(ME, symptomNotedReply("Harriet", ["knee pain"])), asked(ankles)]);
    expect(observations().at(-1)).toMatchObject({ topic: "knee pain", day: DAY2, checkinId: getCheckin(db, P, DAY2)!.id });
  });
});

describe("the repetition rule in the engine", () => {
  it("Sometimes on dizziness, with dizziness on two of the four days before, is level 2", async () => {
    for (const day of ["2026-08-28", "2026-08-30"])
      addObservation(db, { patientId: P, day, topic: dizzy.id, level: 1, source: "button", createdAt: `${day}T09:00:00.000Z` });
    await atBreathing();
    await say("Fine");
    await say("No");
    expect((await say("Sometimes"))[0]?.text).toBe(withLead(keepAnEye("Harriet"), flagOffer()));
    expect(nextFollowUp(db, P)).toMatchObject({ reason: dizzy.id, level: 2 });
    expect((await followUpAt(`${DAY1}T12:00:00.000Z`)).text).toBe(followUpQuestion("Harriet", "dizziness"));
  });

  it("knee pain in chat on three days is worth watching on the third", async () => {
    const knee = () => as("chat", { symptoms: [symptom("knee pain", "a_little")] });
    for (const [i, day] of ["2026-09-01", "2026-09-03", "2026-09-05"].entries()) {
      now = `${day}T09:00:00.000Z`;
      await engine.startDay(P, day);
      await say(BUTTON.notToday); // nothing pending: chat, not her open reply
      const [reply] = await say("my knee aches", knee());
      expect(reply?.text, day).toBe(i < 2 ? symptomNotedReply("Harriet", ["knee pain"]) : keepAnEyeReply("Harriet"));
    }
  });
});

describe("follow-up answers", () => {
  /** A level-2 day (A little bruising), then its follow-up sent. */
  async function levelTwoThenFollowUp(): Promise<SentMessage> {
    await atBreathing();
    for (const t of ["Fine", "A little bruising", "No", BUTTON.later]) await say(t);
    return followUpAt(`${DAY1}T12:00:00.000Z`);
  }

  it("asks about the topic", async () => {
    expect((await levelTwoThenFollowUp()).text).toBe(followUpQuestion("Harriet", "bleeding"));
  });

  it("Better: a warm close, level 0", async () => {
    const f = await levelTwoThenFollowUp();
    expect(brief(await tap(FOLLOW_UP_BUTTONS.better, f))).toEqual([msg(ME, followUpReply("Harriet", "better", "bleeding"))]);
    expect(observations().at(-1)).toMatchObject({ topic: bleeding.id, level: 0, source: "follow_up" });
  });

  it("About the same: level 2 wording, no 911; the family hears only at all", async () => {
    const f = await levelTwoThenFollowUp();
    const sent = await tap(FOLLOW_UP_BUTTONS.same, f);
    expect(brief(sent)).toEqual([msg(ME, followUpReply("Harriet", "same", "bleeding"))]);
    expect(sent[0]!.text).not.toMatch(ALARM);
    expect(observations().at(-1)).toMatchObject({ level: 2, source: "follow_up" });

    setup();
    setSharing(db, P, "all");
    const g = await levelTwoThenFollowUp();
    expect(brief(await tap(FOLLOW_UP_BUTTONS.same, g)).at(-1)).toEqual(
      msg(SARAH, familyFollowUpUpdate({ seniorName: "Harriet", topic: "bleeding", answer: "same" })),
    );
  });

  it("About the same after a red flag is level 2 too: keep an eye on it, no 911", async () => {
    await atBreathing();
    for (const t of ["Yes, it was hard", "No", "No"]) await say(t);
    const f = await followUpAt(`${DAY1}T12:00:00.000Z`);
    const [reply] = await tap(FOLLOW_UP_BUTTONS.same, f);
    expect(reply?.text).toBe(followUpReply("Harriet", "same", "breathing"));
    expect(reply?.text).not.toMatch(ALARM);
  });

  it("Worse: level 3, her doctor today and an alert at every sharing level", async () => {
    const f = await levelTwoThenFollowUp();
    expect(brief(await tap(FOLLOW_UP_BUTTONS.worse, f))).toEqual([
      msg(ME, redFlagAdvice("Harriet", ["Sarah"])),
      msg(SARAH, familyFollowUpWorse({ seniorName: "Harriet", sharing: "status", topic: "bleeding" })),
    ]);
    expect(observations().at(-1)).toMatchObject({ level: 3, source: "follow_up" });
  });

  it("Worse after an urgent symptom stays an emergency: 911 now", async () => {
    await say("I have chest pain");
    expect(observations()).toMatchObject([{ topic: "urgent_symptom", level: 4, source: "safety", words: null }]);
    const f = await followUpAt(`${DAY1}T12:00:00.000Z`);
    expect((await tap(FOLLOW_UP_BUTTONS.worse, f))[0]?.text).toBe(urgentReply("Harriet", ["Sarah"]));
  });

  it("a follow-up row from before the ladder (no level) counts as level 3", async () => {
    scheduleFollowUp(db, { patientId: P, checkinId: null, reason: breathing.id, createdAt: now, dueAt: now });
    db.prepare("UPDATE follow_ups SET level = NULL").run();
    const f = await followUpAt(now);
    expect((await tap(FOLLOW_UP_BUTTONS.worse, f))[0]?.text).toBe(redFlagAdvice("Harriet", ["Sarah"]));
  });
});

describe("rows", () => {
  it("a waiting follow-up keeps the higher level when another concern joins it", () => {
    scheduleFollowUp(db, { patientId: P, checkinId: null, reason: "knee pain", level: 2, createdAt: now, dueAt: now });
    expect(nextFollowUp(db, P)).toMatchObject({ reason: "knee pain", level: 2 });
    scheduleFollowUp(db, { patientId: P, checkinId: null, reason: "knee pain", level: 2, createdAt: now, dueAt: now });
    expect(nextFollowUp(db, P)).toMatchObject({ reason: "knee pain", level: 2 });
    scheduleFollowUp(db, { patientId: P, checkinId: null, reason: bleeding.id, level: 3, createdAt: now, dueAt: now });
    expect(nextFollowUp(db, P)).toMatchObject({ reason: "general", level: 3 });
    scheduleFollowUp(db, { patientId: P, checkinId: null, reason: bleeding.id, level: 2, createdAt: now, dueAt: now });
    expect(nextFollowUp(db, P)?.level).toBe(3);
  });

  it("a clarification is asked once per question of a check-in, and closes once", async () => {
    await atAnkles();
    const c = getCheckin(db, P, DAY2)!;
    const input = { patientId: P, checkinId: c.id, questionId: ankles.id, change: "same", words: "swollen", askedAt: now };
    const id = addClarification(db, input)!;
    expect(id).toBeGreaterThan(0);
    expect(addClarification(db, input)).toBeUndefined();
    expect(openClarification(db, c.id, ankles.id)).toMatchObject({ id, change: "same", words: "swollen", answeredAt: null });
    expect(closeClarification(db, id, "A little", now)).toBe(true);
    expect(closeClarification(db, id, "A lot", now)).toBe(false);
    expect(openClarification(db, c.id, ankles.id)).toBeUndefined();
  });

  it("observations: words tidied, the day's highest, recent ones above a level", () => {
    addObservation(db, { patientId: P, day: DAY1, topic: "knee pain", level: 1, source: "typed", words: "  my knee\n aches ", createdAt: now });
    addObservation(db, { patientId: P, day: DAY1, topic: bleeding.id, level: 2, source: "button", createdAt: now });
    addObservation(db, { patientId: P, day: DAY1, topic: dizzy.id, level: 2, source: "button", createdAt: now });
    addObservation(db, { patientId: P, day: DAY2, topic: mood.id, level: 0, source: "button", createdAt: now });
    expect(observations()[0]).toMatchObject({ words: "my knee aches", checkinId: null, questionId: null });
    expect(highestOfDay(db, P, DAY1)).toMatchObject({ topic: bleeding.id, level: 2 });
    expect(highestOfDay(db, P, "2026-09-03")).toBeUndefined();
    expect(recentObservations(db, P, 10).map((o) => o.topic)).toEqual([dizzy.id, bleeding.id, "knee pain"]);
    expect(recentObservations(db, P, 10, 0)).toHaveLength(4);
    expect(() => addObservation(db, { patientId: P, day: DAY1, topic: "x", level: 6, source: "typed", createdAt: now })).toThrow();
  });
});
