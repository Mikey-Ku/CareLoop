import { beforeEach, describe, expect, it } from "vitest";
import { BUTTON, explainPrompt, familyRedFlagAlert, freeTextConfirm, keepAnEye, redFlagAdvice, withLead, withTypingHint } from "../src/checkin/copy.ts";
import { createCheckinEngine } from "../src/checkin/engine.ts";
import type { CheckinEngine } from "../src/checkin/engine-types.ts";
import { LET_ME_EXPLAIN, QUESTION_BANK, SUGGESTION_YES, promptButtons, type Question } from "../src/context/questions.ts";
import { getCheckin } from "../src/db/checkins.ts";
import { linkFamilyMember, syncFamilyMembers } from "../src/db/family.ts";
import { nextFollowUp } from "../src/db/follow-ups.ts";
import { openDatabase, upsertPatient, type Db } from "../src/db/index.ts";
import { checkinNotes } from "../src/db/notes.ts";
import { observationsBetween } from "../src/db/observations.ts";
import { loadRxNavCache, loadSnapshot } from "../src/finchnode/fixtures.ts";
import { FakeLlmClient } from "../src/llm/fake.ts";
import type { CheckinExtraction, Confidence, MessageClassification, MessageKind, SymptomMention } from "../src/llm/types.ts";
import { FakeMessenger } from "../src/relay/fake-messenger.ts";
import type { SentMessage } from "../src/relay/messenger.ts";

// One understanding pass (src/checkin/engine.ts): everything she types while a question waits is read
// against all of today's unanswered questions, applied at once, and said back in one line. Red-flag
// questions are never recorded below level 3 from her words: a suggested confirm waits for her tap.
// The two live cases from 2026-10-07 are here. Synthetic data only.

const P = "harriet";
const ME = "chat_harriet";
const SARAH = "chat_sarah";
const DAY1 = "2026-09-01"; // breathing, bleeding, dizziness
const DAY2 = "2026-09-02"; // after a calm day 1: ankles, morning medicines, mood
const rxnav = loadRxNavCache();

const question = (id: string) => QUESTION_BANK.find((q) => q.id === id)!;
const breathing = question("hf-breathing-lying-flat");
const bleeding = question("anticoagulant-bleeding");
const ankles = question("hf-ankle-swelling");
const medicines = question("morning-medicines");
const mood = question("mood");

let db: Db;
let messenger: FakeMessenger;
let engine: CheckinEngine;
let llm: FakeLlmClient;
let now: string;
let inbound = 0;
let extractions: CheckinExtraction[];
let readings: MessageClassification[];

const extracted = (answers: [questionId: string, answer: string, confidence?: Confidence][], symptoms: SymptomMention[] = []): CheckinExtraction => ({
  answers: answers.map(([questionId, answer, confidence = "high"]) => ({ questionId, answer, confidence })),
  symptoms,
  memories: [],
});
const symptom = (topic: string, amount: SymptomMention["amount"], words: string, change: SymptomMention["change"] = "unknown"): SymptomMention => ({
  topic,
  ...(QUESTION_BANK.some((q) => q.id === topic) ? { questionId: topic } : {}),
  amount,
  change,
  words,
});
const as = (kind: MessageKind, extra: Partial<MessageClassification> = {}): MessageClassification => ({ kind, confidence: "high", complaints: [], memories: [], ...extra });

beforeEach(() => {
  inbound = 0;
  db = openDatabase(":memory:");
  upsertPatient(db, { id: P, finchnodePatientId: "patient-demo-polypharmacy", preferredName: "Harriet", relayChatId: ME });
  syncFamilyMembers(db, P, ["sarah"]);
  linkFamilyMember(db, "sarah", SARAH, "Sarah", `${DAY1}T08:00:00.000Z`);
  now = `${DAY1}T09:00:00.000Z`;
  extractions = [];
  readings = [];
  messenger = new FakeMessenger({ now: () => now });
  llm = new FakeLlmClient({
    extractCheckin: () => extractions.shift() ?? extracted([]),
    classifyMessage: () => readings.shift() ?? as("chat", { confidence: "low" }),
  });
  engine = createCheckinEngine({ db, messenger, clock: { now: () => now }, loadSnapshot: async (s) => loadSnapshot(s), llm }, { rxnav });
});

async function say(text: string): Promise<SentMessage[]> {
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
const asked = (q: Question, lead?: string) => msg(ME, withLead(lead, withTypingHint(q.text)), promptButtons(q));
const row = (day = DAY1) => getCheckin(db, P, day)!;
const toFamily = () => messenger.inChat(SARAH);
const observed = (topic: string) => observationsBetween(db, P, "2026-01-01", "2026-12-31").filter((o) => o.topic === topic);

/** Day 1 started and Quick questions tapped: the breathing question (red flag) waits. */
async function atBreathing(): Promise<void> {
  await engine.startDay(P, DAY1);
  await say(BUTTON.start);
  llm.calls.length = 0;
}

/** A calm day 1, then day 2 started and Quick questions tapped: the ankle question waits. */
async function atAnkles(): Promise<void> {
  await engine.startDay(P, DAY1);
  for (const t of [BUTTON.start, "Fine", "No", "No", BUTTON.later]) await say(t);
  now = `${DAY2}T09:00:00.000Z`;
  expect(await engine.startDay(P, DAY2)).toEqual({ kind: "sent", questionIds: [ankles.id, medicines.id, mood.id] });
  await say(BUTTON.start);
  llm.calls.length = 0;
}

describe("the live cases (2026-10-07)", () => {
  it('ankles, "Let me explain": ankles recorded No, the back pain noted under its own topic, then the next question with the line said back', async () => {
    await atAnkles();
    expect(brief(await tap(LET_ME_EXPLAIN, messenger.lastIn(ME)))).toEqual([msg(ME, explainPrompt("Harriet"))]);
    const words = "It has been feeling very good. I think I have a little bit of pain in the back, but it has been OK.";
    extractions.push(extracted([[ankles.id, "No"]], [symptom("back pain", "a_little", "a little bit of pain in the back")]));
    readings.push(as("more_detail"));

    expect(brief(await say(words))).toEqual([asked(medicines, "Got it: ankles feeling fine. I've noted the back pain for your doctor.")]);
    expect(row(DAY2).answers.map((a) => [a.questionId, a.answer, a.level, a.via])).toEqual([[ankles.id, "No", 0, "free_text"]]);
    // The back pain is noted under "back pain", never on the ankle question.
    expect(checkinNotes(db, row(DAY2).id).map((n) => [n.questionId, n.topic, n.text])).toEqual([[null, "back pain", "a little bit of pain in the back"]]);
    expect(observed("back pain").map((o) => o.level)).toEqual([1]);
    expect(row(DAY2)).toMatchObject({ step: "question", questionIndex: 1, explainAt: null });
    // Read against all of today's unanswered questions, with the classifier alongside.
    expect(llm.extractCalls[0]?.questions.map((q) => q.id)).toEqual([ankles.id, medicines.id, mood.id]);
    expect(llm.classifyCalls[0]?.pending).toEqual({ question: ankles.text, options: ankles.buttons });
    expect(toFamily().filter((m) => m.at.startsWith(DAY2))).toEqual([]);

    // The next message is read against what is still unanswered only.
    extractions.push(extracted([[medicines.id, "Yes"]]));
    expect(brief(await say("took them with breakfast"))).toEqual([asked(mood, "Got it: medicines taken.")]);
    expect(llm.extractCalls[1]?.questions.map((q) => q.id)).toEqual([medicines.id, mood.id]);
  });

  it("ankles, when the extraction misses the pending question: the classifier (shown that question) fills it in", async () => {
    await atAnkles();
    await tap(LET_ME_EXPLAIN, messenger.lastIn(ME));
    extractions.push(extracted([], [symptom("back pain", "a_little", "a little bit of pain in the back")]));
    readings.push(as("answer", { answer: "No", confidence: "medium" }));
    const sent = await say("It has been feeling very good. I think I have a little bit of pain in the back, but it has been OK.");
    expect(brief(sent)).toEqual([asked(medicines, "Got it: ankles feeling fine. I've noted the back pain for your doctor.")]);
    expect(row(DAY2).answers.map((a) => [a.questionId, a.answer])).toEqual([[ankles.id, "No"]]);
    expect(checkinNotes(db, row(DAY2).id).map((n) => n.topic)).toEqual(["back pain"]);
  });

  it("breathing: a reading of a little hard gets a suggested confirm, not the whole question; her tap records it", async () => {
    await atBreathing();
    const words = "Wasn't too bad... a couple moments of hard breathing at some point, but it wasn't bad otherwise.";
    extractions.push(extracted([[breathing.id, "A little hard", "medium"]], [symptom(breathing.id, "a_little", "a couple moments of hard breathing")]));
    readings.push(as("answer", { answer: "A little hard", confidence: "medium" }));

    const [confirm, ...rest] = await say(words);
    expect(rest).toEqual([]);
    expect(brief([confirm!])).toEqual([
      msg(ME, "It sounds like your breathing was a little hard at times. Is that right?", [SUGGESTION_YES, "Fine", "Yes, it was hard", LET_ME_EXPLAIN]),
    ]);
    expect(row().answers).toEqual([]);
    expect(nextFollowUp(db, P)).toBeUndefined();

    expect(brief(await tap(SUGGESTION_YES, confirm))).toEqual([asked(bleeding, keepAnEye("Harriet"))]);
    expect(row().answers[0]).toMatchObject({ questionId: breathing.id, answer: "A little hard", level: 2, via: "confirmed", freeText: words });
    expect(nextFollowUp(db, P)).toMatchObject({ reason: breathing.id, level: 2 });
    expect(toFamily()).toEqual([]);
  });
});

describe("red-flag questions: the AI never records below level 3", () => {
  it.each([
    [breathing, "Fine", "It sounds like your breathing was fine. Is that right?", [SUGGESTION_YES, "A little hard", "Yes, it was hard", LET_ME_EXPLAIN]],
    [breathing, "A little hard", "It sounds like your breathing was a little hard at times. Is that right?", [SUGGESTION_YES, "Fine", "Yes, it was hard", LET_ME_EXPLAIN]],
    [bleeding, "No", "It sounds like no unusual bruising or bleeding. Is that right?", [SUGGESTION_YES, "A little bruising", "Yes, bleeding", LET_ME_EXPLAIN]],
    [bleeding, "A little bruising", "It sounds like a little bruising. Is that right?", [SUGGESTION_YES, "No", "Yes, bleeding", LET_ME_EXPLAIN]],
  ])("a reading of %s %j is not recorded: a suggested confirm, no follow-up, no alert", async (q, answer, text, buttons) => {
    await atBreathing();
    if (q.id === bleeding.id) await say("Fine"); // bleeding waits next
    extractions.push(extracted([[q.id, answer]]));
    readings.push(as("answer", { answer, confidence: "high" }));
    expect(brief(await say("my words about it"))).toEqual([msg(ME, text, buttons)]);
    expect(row().answers.filter((a) => a.questionId === q.id)).toEqual([]);
    expect(row()).toMatchObject({ step: "question", concernAt: null });
    expect(observed(q.id)).toEqual([]);
    expect(nextFollowUp(db, P)).toBeUndefined();
    expect(toFamily()).toEqual([]);
  });

  it("a calm extraction never outvotes the classifier's level-3 reading: no suggestion, the generic confirm, nothing recorded", async () => {
    await atBreathing();
    const words = "fine mostly, had to prop myself up on pillows";
    extractions.push(extracted([[breathing.id, "Fine"]]));
    readings.push(as("answer", { answer: "Yes, it was hard" }));
    expect(brief(await say(words))).toEqual([msg(ME, freeTextConfirm(words, breathing.text), promptButtons(breathing))]);
    expect(row().answers).toEqual([]);
    expect(row().suggestions).toEqual({});
    expect(toFamily()).toEqual([]);
  });

  it("a calm reading in a message that also answers another question: that one is recorded, the red flag still waits for her tap", async () => {
    await atBreathing();
    extractions.push(extracted([[breathing.id, "Fine"], ["dizzy-on-standing", "No"]]));
    expect(brief(await say("slept fine, never dizzy"))).toEqual([
      msg(ME, withLead("Got it: no dizziness.", "It sounds like your breathing was fine. Is that right?"), [SUGGESTION_YES, "A little hard", "Yes, it was hard", LET_ME_EXPLAIN]),
    ]);
    expect(row().answers.map((a) => a.questionId)).toEqual(["dizzy-on-standing"]);
  });

  it('"Yes, that\'s right" records the suggested option, with her words kept', async () => {
    await atBreathing();
    extractions.push(extracted([[breathing.id, "Fine"]]));
    const [confirm] = await say("slept fine");
    expect(brief(await tap(SUGGESTION_YES, confirm))).toEqual([asked(bleeding)]);
    expect(row().answers).toEqual([
      { questionId: breathing.id, questionText: breathing.text, answer: "Fine", at: now, level: 0, via: "confirmed", freeText: "slept fine" },
    ]);
    expect(row().suggestions).toEqual({});
    expect(toFamily()).toEqual([]);
  });

  it('a plain typed "yes" to the suggested confirm counts as "Yes, that\'s right", never as "Yes, it was hard"', async () => {
    await atBreathing();
    extractions.push(extracted([[breathing.id, "Fine"]]));
    await say("slept fine");
    const calls = llm.calls.length;
    expect(brief(await say("Yes, that's right"))).toEqual([asked(bleeding)]);
    expect(row().answers.map((a) => [a.answer, a.via])).toEqual([["Fine", "confirmed"]]);
    expect(llm.calls).toHaveLength(calls); // a fixed rule, no LLM
    expect(toFamily()).toEqual([]);

    extractions.push(extracted([[bleeding.id, "No"]]));
    await say("no bruises");
    expect(brief(await say("yep"))).toEqual([asked(question("dizzy-on-standing"))]);
    expect(row().answers.map((a) => [a.answer, a.via])).toEqual([
      ["Fine", "confirmed"],
      ["No", "confirmed"],
    ]);
  });

  it("another tap records that option: a calmer one as it is, the level-3 one with the advice and the alert", async () => {
    await atBreathing();
    extractions.push(extracted([[breathing.id, "A little hard"]]));
    const [confirm] = await say("a bit tight");
    expect(brief(await tap("Fine", confirm))).toEqual([asked(bleeding)]);
    expect(row().answers.map((a) => [a.questionId, a.answer, a.level])).toEqual([[breathing.id, "Fine", 0]]);
    expect(row().answers[0]).not.toHaveProperty("via");

    extractions.push(extracted([[bleeding.id, "No"]]));
    const [second] = await say("no bruises");
    expect(brief(await tap("Yes, bleeding", second))).toEqual([
      msg(ME, redFlagAdvice("Harriet", ["Sarah"], 1)),
      msg(SARAH, familyRedFlagAlert({ seniorName: "Harriet", sharing: "status", questionText: bleeding.text, answer: "Yes, bleeding" })),
      asked(question("dizzy-on-standing")),
    ]);
    expect(row().answers.at(-1)).toMatchObject({ questionId: bleeding.id, answer: "Yes, bleeding", level: 3 });
  });

  it("a level-3 reading is recorded straight away: the advice, the family alerted, then the next question", async () => {
    await atBreathing();
    const words = "terrible, I had to sit up all night to breathe";
    extractions.push(extracted([[breathing.id, "Yes, it was hard"]], [symptom(breathing.id, "a_lot", "had to sit up all night to breathe")]));
    readings.push(as("answer", { answer: "Yes, it was hard" }));
    expect(brief(await say(words))).toEqual([
      msg(ME, redFlagAdvice("Harriet", ["Sarah"], 2)),
      msg(SARAH, familyRedFlagAlert({ seniorName: "Harriet", sharing: "status", questionText: breathing.text, answer: "Yes, it was hard", words })),
      asked(bleeding),
    ]);
    expect(row().answers[0]).toMatchObject({ questionId: breathing.id, answer: "Yes, it was hard", level: 3, via: "free_text", freeText: words });
    expect(row().concernAt).not.toBeNull();
    expect(nextFollowUp(db, P)).toMatchObject({ reason: breathing.id, level: 3 });
  });

  it("an explicit yes still records straight away with the alert, whatever the reading, and while a suggestion waits", async () => {
    await atBreathing();
    readings.push(as("answer", { answer: "Fine" }));
    const sent = await say("yes, I had to sit up most of the night");
    expect(llm.extractCalls).toEqual([]); // a fixed rule: nothing to extract
    expect(brief(sent).slice(0, 2)).toEqual([
      msg(ME, redFlagAdvice("Harriet", ["Sarah"], 2)),
      msg(SARAH, familyRedFlagAlert({ seniorName: "Harriet", sharing: "status", questionText: breathing.text, answer: "Yes, it was hard", words: "yes, I had to sit up most of the night" })),
    ]);
    expect(row().answers.map((a) => [a.answer, a.level])).toEqual([["Yes, it was hard", 3]]);

    // On the bleeding question, a suggestion waits; more than a plain yes is her "Yes, bleeding".
    extractions.push(extracted([[bleeding.id, "No"]]));
    await say("no bruises I think");
    const after = await say("yes, actually my gums bled this morning");
    expect(after[0]?.text).toBe(redFlagAdvice("Harriet", ["Sarah"], 1));
    expect(row().answers.map((a) => [a.answer, a.level])).toEqual([
      ["Yes, it was hard", 3],
      ["Yes, bleeding", 3],
    ]);
  });
});
