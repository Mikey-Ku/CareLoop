import { beforeEach, describe, expect, it } from "vitest";
import {
  BUTTON,
  openReplyUnavailable,
  FOLLOW_UP_BUTTONS,
  SHARING_MENU_BUTTON,
  checkinDone,
  checkinDoneAfterConcern,
  crisisReply,
  familyCrisisAlert,
  familyDailyStatus,
  familyRedFlagAlert,
  familyRelay,
  familyRelayDone,
  familyRelayWaiting,
  familyUrgentAlert,
  feelingLowReply,
  flagOffer,
  medicineQuestionReply,
  noteSaved,
  redFlagAdvice,
  smallTalkFallback,
  typedReplyUnavailable,
  urgentReply,
  withLead,
  withTypingHint,
} from "../src/checkin/copy.ts";
import { DEFAULT_FOLLOW_UP_DELAY_MINUTES, createCheckinEngine } from "../src/checkin/engine.ts";
import type { CheckinEngine } from "../src/checkin/engine-types.ts";
import { PAPER_CONFIRM_BUTTONS } from "../src/checkin/paper-check.ts";
import { explicitYesAnswer, followUpTopic, isExplicitYes, reactionFor } from "../src/checkin/reactions.ts";
import { QUESTION_BANK, promptButtons, type Question } from "../src/context/questions.ts";
import { getCheckin } from "../src/db/checkins.ts";
import { linkFamilyMember, syncFamilyMembers, waitingFamilyRelays } from "../src/db/family.ts";
import { nextFollowUp } from "../src/db/follow-ups.ts";
import { openDatabase, setSharing, upsertPatient, type Db } from "../src/db/index.ts";
import { recentMemories } from "../src/db/memories.ts";
import { checkinNotes, visitQuestions } from "../src/db/notes.ts";
import { loadRxNavCache, loadSnapshot } from "../src/finchnode/fixtures.ts";
import { FakeLlmClient, type FakeLlmScript } from "../src/llm/fake.ts";
import { LlmUnavailableError, type MessageClassification, type MessageKind } from "../src/llm/types.ts";
import { FakeMessenger } from "../src/relay/fake-messenger.ts";
import type { SentMessage } from "../src/relay/messenger.ts";
import type { ExtractedPaper } from "../src/rules/paper-diff.ts";
import { screenMessage } from "../src/safety/screen.ts";

// What the engine does with each kind of typed message (src/checkin/engine.ts "Typed
// messages", src/checkin/reactions.ts), with the real safety screen and a scripted
// FakeLlmClient. Synthetic data only.

const P = "harriet";
const SUBJECT = "patient-demo-polypharmacy";
const ME = "chat_harriet";
const SARAH = "chat_sarah";
const TOM = "chat_tom";
const DAY1 = "2026-09-01"; // hf-breathing-lying-flat, anticoagulant-bleeding, dizzy-on-standing
const rxnav = loadRxNavCache();
// Phrases the fixed screen catches (src/safety/screen.ts).
const CRISIS = "I want to end my life";
const URGENT = "I have chest pain";

const question = (id: string) => QUESTION_BANK.find((q) => q.id === id)!;
const breathing = question("hf-breathing-lying-flat");
const bleeding = question("anticoagulant-bleeding");
const dizzy = question("dizzy-on-standing");

let db: Db;
let messenger: FakeMessenger;
let engine: CheckinEngine;
let llm: FakeLlmClient | undefined;
let now: string;
let inbound = 0;

const as = (kind: MessageKind, extra: Partial<MessageClassification> = {}): MessageClassification => ({
  kind,
  confidence: "high",
  complaints: [],
  memories: [],
  ...extra,
});

/** A fresh engine with Sarah linked, and an LLM scripted by `script` (none when undefined). */
function setup(script?: FakeLlmScript, options: { family?: boolean } = {}) {
  db = openDatabase(":memory:");
  upsertPatient(db, { id: P, finchnodePatientId: SUBJECT, preferredName: "Harriet", relayChatId: ME });
  syncFamilyMembers(db, P, ["sarah", "tom"]);
  if (options.family ?? true) linkFamilyMember(db, "sarah", SARAH, "Sarah", `${DAY1}T08:00:00.000Z`);
  now = `${DAY1}T13:00:00.000Z`;
  messenger = new FakeMessenger({ now: () => now });
  llm = script ? new FakeLlmClient(script) : undefined;
  engine = createCheckinEngine(
    { db, messenger, clock: { now: () => now }, loadSnapshot: async (s) => loadSnapshot(s), llm },
    { rxnav, missedCheckinTime: "12:00" },
  );
}

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
/** A question as she gets it on her first check-ins: `lead` before it, the typing hint under it, "Let me explain" on a symptom question. */
const asked = (q: Pick<Question, "id" | "text" | "buttons">, lead?: string) => msg(ME, withLead(lead, withTypingHint(q.text)), promptButtons(q));
const checkin = () => getCheckin(db, P, DAY1)!;

async function atBreathing(): Promise<SentMessage> {
  await engine.startDay(P, DAY1);
  const [q] = await say(BUTTON.start);
  return q!;
}

beforeEach(() => {
  inbound = 0;
});

describe("the fixed rules (src/checkin/reactions.ts)", () => {
  it("explicit yes: yes, yeah, yep, 'yes but ...', 'I did'; not a no in disguise", () => {
    for (const t of ["yes", "Yes.", "YES!", "yeah", "Yep, propped up on pillows", "yup", "Yes but it was weirder I don't know how to explainit", "I did", "well, yes", "oh yes it did"])
      expect(isExplicitYes(t), t).toBe(true);
    for (const t of ["no", "Not really but I have more info", "yeah no", "yes, not really", "I did not", "I didn't", "yesterday was fine", "nah fine", "maybe yes", ""])
      expect(isExplicitYes(t), t).toBe(false);
  });

  it("an explicit yes stands for the level-3 answer of a red-flag question only", () => {
    expect(explicitYesAnswer(breathing, "yeah")).toBe("Yes, it was hard");
    expect(explicitYesAnswer(bleeding, "I did, a big bruise")).toBe("Yes, bleeding");
    expect(explicitYesAnswer(question("morning-medicines"), "yes")).toBeUndefined();
    expect(explicitYesAnswer(breathing, "no")).toBeUndefined();
  });

  it("reactionFor: kinds to reactions, by what was pending", () => {
    const r = (kind: string, at: Parameters<typeof reactionFor>[1], confidence: MessageClassification["confidence"] = "high") =>
      reactionFor({ kind: kind as MessageKind, confidence }, at);
    expect(r("crisis", "none")).toBe("crisis");
    expect(r("urgent_symptom", "question")).toBe("urgent_symptom");
    expect(r("answer", "question")).toBe("answer");
    expect(r("answer", "none")).toBe("small_talk");
    expect(r("more_detail", "question")).toBe("note");
    expect(r("more_detail", "none")).toBe("small_talk");
    expect(r("more_detail", "step", "low")).toBe("didnt_understand");
    expect(r("medicine_question", "step")).toBe("medicine_question");
    expect(r("feeling_low", "none")).toBe("feeling_low");
    expect(r("family_message", "question")).toBe("family_message");
    expect(r("chat", "question")).toBe("small_talk");
    expect(r("chat", "question", "low")).toBe("didnt_understand");
    expect(r("chat", "none", "low")).toBe("small_talk");
    expect(r("made_up_kind", "none")).toBe("small_talk");
  });

  it("follow-up topics from the stored reason", () => {
    expect(followUpTopic("hf-breathing-lying-flat")).toBe("breathing");
    expect(followUpTopic("anticoagulant-bleeding")).toBe("bleeding");
    expect(followUpTopic("hf-ankle-swelling")).toBe("ankles");
    expect(followUpTopic("dizzy-on-standing")).toBe("dizziness");
    expect(followUpTopic("knee pain")).toBe("general");
    expect(followUpTopic("crisis")).toBe("crisis");
    expect(followUpTopic("urgent_symptom")).toBe("general");
    expect(followUpTopic("general")).toBe("general");
  });

  it("the test phrases are ones the real safety screen catches, and today's words are not", () => {
    expect(screenMessage(CRISIS)?.kind).toBe("crisis");
    expect(screenMessage(URGENT)?.kind).toBe("urgent_symptom");
    expect(screenMessage("Not really but I have more info")).toBeUndefined();
    expect(screenMessage("Yes but it was weirder I don't know how to explainit")).toBeUndefined();
  });
});

describe("1. the safety screen comes first", () => {
  it("a crisis mid-question: fixed reply, Sarah alerted with no detail, the question not asked again, no LLM, a follow-up", async () => {
    setup({ classifyMessage: () => as("answer", { answer: "Fine" }) });
    await atBreathing();
    const sent = await say(CRISIS);
    expect(brief(sent)).toEqual([msg(ME, crisisReply("Harriet", ["Sarah"])), msg(SARAH, familyCrisisAlert({ seniorName: "Harriet", sharing: "status" }))]);
    expect(sent[1]!.text).not.toContain(CRISIS);
    expect(llm?.calls).toEqual([]);
    expect(messenger.activities).toEqual([]);
    // Paused, not ended: still on the breathing question, nothing recorded, the concern remembered.
    expect(checkin()).toMatchObject({ step: "question", questionIndex: 0, answers: [], concernAt: now });
    expect(nextFollowUp(db, P)).toMatchObject({ reason: "crisis", checkinId: checkin().id, dueAt: "2026-09-01T16:00:00.000Z", sentAt: null });
    // Her words are not saved as a memory.
    expect(recentMemories(db, P, 10)).toEqual([]);
  });

  it("at sharing all the family alert carries her words", async () => {
    setup();
    setSharing(db, P, "all");
    await atBreathing();
    const sent = await say(CRISIS);
    expect(sent[1]).toMatchObject({ chatId: SARAH, text: familyCrisisAlert({ seniorName: "Harriet", sharing: "all", words: CRISIS }) });
    expect(sent[1]!.text).toContain(CRISIS);
  });

  it("with no family chat linked, her reply claims no one was told", async () => {
    setup(undefined, { family: false });
    await atBreathing();
    const sent = await say(CRISIS);
    expect(brief(sent)).toEqual([msg(ME, crisisReply("Harriet", []))]);
    expect(sent[0]!.text).not.toMatch(/know\.$/);
  });

  it("with nothing pending it still alerts every family chat and schedules a follow-up", async () => {
    setup({ smallTalk: () => ({ text: "Hello.", memories: [], complaints: [] }) });
    linkFamilyMember(db, "tom", TOM, "Tom", now);
    const sent = await say(CRISIS);
    expect(brief(sent)).toEqual([
      msg(ME, crisisReply("Harriet", ["Sarah", "Tom"])),
      msg(SARAH, familyCrisisAlert({ seniorName: "Harriet", sharing: "status" })),
      msg(TOM, familyCrisisAlert({ seniorName: "Harriet", sharing: "status" })),
    ]);
    expect(nextFollowUp(db, P)).toMatchObject({ reason: "crisis", checkinId: null });
  });

  it("an urgent symptom mid-question pauses the check-in; she carries on from the question, and no flag is offered", async () => {
    setup();
    const q = await atBreathing();
    const sent = await say(URGENT);
    expect(brief(sent)).toEqual([msg(ME, urgentReply("Harriet", ["Sarah"])), msg(SARAH, familyUrgentAlert({ seniorName: "Harriet", sharing: "status" }))]);
    // The breathing question's own buttons still answer it.
    expect(brief(await tap("Fine", q))).toEqual([asked(bleeding)]);
    await say("No");
    const end = await say("No");
    expect(end.map((m) => m.text)).not.toContain(flagOffer());
    expect(end[0]).toMatchObject({ chatId: ME, text: checkinDoneAfterConcern("Harriet"), buttons: [SHARING_MENU_BUTTON] });
    expect(nextFollowUp(db, P)?.reason).toBe("urgent_symptom");
  });

  it("wins even while a paper read-back waits for her", async () => {
    setup();
    const paper: ExtractedPaper = { kind: "discharge", date: "2026-08-30", medications: [{ name: "aspirin", strength: "81 mg", change: "stopped" }], synthetic: true };
    await engine.startPaperCheck(P, paper, "att_1");
    expect((await say(URGENT))[0]?.text).toBe(urgentReply("Harriet", ["Sarah"]));
    // The read-back still takes her tap.
    expect((await say(PAPER_CONFIRM_BUTTONS[1]!))[0]?.text).toMatch(/Thank you for checking/);
  });

  it("after a safety hit at the greeting, the noon job doesn't also send a missed alert", async () => {
    setup();
    await engine.startDay(P, DAY1);
    await say(CRISIS);
    expect(await engine.runMissedCheckin(P, DAY1)).toBe("nothing_to_do");
  });
});

describe("2. the LLM reads it; when it can't", () => {
  it("during a check-in step it says the trouble is ours and offers the buttons", async () => {
    setup({ classifyMessage: () => new LlmUnavailableError("down") });
    await atBreathing();
    for (const t of ["Fine", "No", "No"]) await say(t); // the flag offer waits
    const buttons = [BUTTON.tellMeMore, BUTTON.later];
    expect(brief(await say("ok go ahead"))).toEqual([msg(ME, typedReplyUnavailable(buttons), buttons)]);
  });

  it("her open reply at the greeting when the model is down: the honest line, then the questions", async () => {
    const down = () => new LlmUnavailableError("down");
    setup({ classifyMessage: down, extractCheckin: down });
    await engine.startDay(P, DAY1);
    expect(brief(await say("ok go ahead"))).toEqual([asked(breathing, openReplyUnavailable("Harriet"))]);
  });

  it("with nothing pending, the fixed small-talk fallback", async () => {
    setup({ classifyMessage: () => new LlmUnavailableError("down") });
    expect(brief(await say("hello dear"))).toEqual([msg(ME, smallTalkFallback("Harriet"))]);
  });

  it("the classifier gets her name, her words and what she was asked (the answers, not Let me explain)", async () => {
    setup({ classifyMessage: () => as("more_detail") });
    await atBreathing();
    await say("it was odd");
    expect(llm?.classifyCalls[0]).toEqual({ seniorName: "Harriet", message: "it was odd", pending: { question: breathing.text, options: breathing.buttons }, context: expect.any(String) });
  });

  it("her open reply goes to the extraction with today's questions, and to the classifier with nothing pending", async () => {
    setup({});
    await engine.startDay(P, DAY1);
    await say("slept fine");
    expect(llm?.extractCalls).toEqual([
      {
        seniorName: "Harriet",
        message: "slept fine",
        questions: [breathing, bleeding, dizzy].map((q) => ({ id: q.id, question: q.text, options: q.buttons })),
        context: expect.any(String),
      },
    ]);
    expect(llm?.classifyCalls).toEqual([{ seniorName: "Harriet", message: "slept fine", pending: undefined, context: expect.any(String) }]);
  });
});

describe("3. reactions by kind", () => {
  it("crisis from the model (the screen missed it): the same reaction as the screen", async () => {
    const words = "everything feels pointless and I'd rather just disappear";
    expect(screenMessage(words)).toBeUndefined();
    setup({ classifyMessage: () => as("crisis") });
    await atBreathing();
    expect(brief(await say(words))).toEqual([msg(ME, crisisReply("Harriet", ["Sarah"])), msg(SARAH, familyCrisisAlert({ seniorName: "Harriet", sharing: "status" }))]);
    expect(nextFollowUp(db, P)?.reason).toBe("crisis");
  });

  it("an urgent symptom from the model wins over an explicit yes on a red-flag question", async () => {
    const words = "yes and my left arm is numb and heavy";
    expect(screenMessage(words)).toBeUndefined();
    setup({ classifyMessage: () => as("urgent_symptom") });
    await atBreathing();
    expect(brief(await say(words))[0]).toEqual(msg(ME, urgentReply("Harriet", ["Sarah"])));
    expect(checkin().answers).toEqual([]);
  });

  it("an answer at the flag offer counts as that button", async () => {
    setup({ classifyMessage: () => as("answer", { answer: BUTTON.later }) });
    await atBreathing();
    for (const t of ["Fine", "No", "No"]) await say(t);
    expect(brief(await say("not now, thanks"))).toEqual([msg(ME, checkinDone("Harriet"), [SHARING_MENU_BUTTON]), expect.anything()]);
    expect(checkin()).toMatchObject({ step: "done" });
  });

  it("a medicine question: fixed reply, saved for her visit, the question again", async () => {
    setup({ classifyMessage: () => as("medicine_question") });
    await atBreathing();
    await say("Fine");
    const words = "can I skip the water pill on Sunday?";
    expect(brief(await say(words))).toEqual([msg(ME, medicineQuestionReply("Harriet")), asked(bleeding)]);
    expect(visitQuestions(db, P).map((v) => v.text)).toEqual([words]);
    expect(messenger.inChat(SARAH)).toEqual([]);
  });

  it("feeling low: warm fixed reply, saved as a memory, no alert", async () => {
    setup({ classifyMessage: () => as("feeling_low") });
    const words = "I miss Tom a lot today";
    expect(brief(await say(words))).toEqual([msg(ME, feelingLowReply("Harriet"))]);
    expect(recentMemories(db, P, 5)).toEqual([words]);
    expect(messenger.inChat(SARAH)).toEqual([]);
    expect(llm?.smallTalkCalls).toEqual([]);
  });

  it("a family message goes to every linked family chat in her own words (not the model's version), and she hears who got it", async () => {
    setup({ classifyMessage: () => as("family_message", { forFamily: "Sarah I love her" }) });
    linkFamilyMember(db, "tom", TOM, "Tom", now);
    const words = "  Tell Sarah I love her ";
    expect(brief(await say(words))).toEqual([
      msg(SARAH, familyRelay("Harriet", "Tell Sarah I love her")),
      msg(TOM, familyRelay("Harriet", "Tell Sarah I love her")),
      msg(ME, familyRelayDone("Harriet", ["Sarah", "Tom"])),
    ]);
    expect(waitingFamilyRelays(db, P)).toEqual([]);
  });

  it("a long family message is cut at 500 characters", async () => {
    setup({ classifyMessage: () => as("family_message") });
    const words = `Tell Sarah ${"so much ".repeat(80)}`;
    const [toSarah] = await say(words);
    expect(toSarah?.text.length).toBeLessThan(560);
    expect(toSarah?.text).toMatch(/\.\.\."$/);
  });

  it("with no family chat linked, a family message waits and is passed on once someone links", async () => {
    setup({ classifyMessage: () => as("family_message") }, { family: false });
    expect(brief(await say("Tell Sarah I love her"))).toEqual([msg(ME, familyRelayWaiting("Harriet"))]);
    expect(await engine.passOnFamilyMessages(P)).toBe(0);
    linkFamilyMember(db, "sarah", SARAH, "Sarah", now);
    expect(await engine.passOnFamilyMessages(P)).toBe(1);
    expect(brief(messenger.inChat(SARAH))).toEqual([msg(SARAH, familyRelay("Harriet", "Tell Sarah I love her"))]);
    expect(await engine.passOnFamilyMessages(P)).toBe(0);
  });

  it("chat during a question: the model's small talk, then the question again", async () => {
    setup({ classifyMessage: () => as("chat"), smallTalk: () => ({ text: "That sounds like a lovely morning, Harriet.", memories: ["sun on the porch"], complaints: [] }) });
    await atBreathing();
    expect(brief(await say("the sun is lovely on the porch"))).toEqual([
      msg(ME, "That sounds like a lovely morning, Harriet."),
      asked(breathing),
    ]);
    expect(recentMemories(db, P, 5)).toEqual(["sun on the porch"]);
    // A tap on the re-sent question answers it.
    expect(brief(await tap("Fine", messenger.lastIn(ME)))).toEqual([asked(bleeding)]);
  });

  it("chat during a question when small talk fails: the trouble is ours, with the buttons", async () => {
    setup({ classifyMessage: () => as("chat"), smallTalk: () => new LlmUnavailableError("busy") });
    await atBreathing();
    expect(brief(await say("the sun is lovely"))).toEqual([msg(ME, typedReplyUnavailable(breathing.buttons), promptButtons(breathing))]);
  });
});

describe("4. a red flag: warmer, calmer, no flag offer, a follow-up", () => {
  it("advice with what's still to come, the remaining questions, no flag offer, closing 'this afternoon', follow-up in 180 minutes", async () => {
    setup();
    await atBreathing();
    expect(brief(await say("Yes, it was hard"))).toEqual([
      msg(ME, redFlagAdvice("Harriet", ["Sarah"], 2)),
      msg(SARAH, familyRedFlagAlert({ seniorName: "Harriet", sharing: "status", questionText: breathing.text, answer: "Yes, it was hard" })),
      asked(bleeding),
    ]);
    expect(redFlagAdvice("Harriet", ["Sarah"], 2)).toMatch(/^Thank you for telling me, Harriet\. I've let Sarah know\. Please call your doctor today about this\. If it gets much worse, call 911\./);
    expect(DEFAULT_FOLLOW_UP_DELAY_MINUTES).toBe(180);
    expect(nextFollowUp(db, P)).toMatchObject({ reason: breathing.id, dueAt: "2026-09-01T16:00:00.000Z" });
    await say("No");
    expect(brief(await say("No"))).toEqual([
      msg(ME, checkinDoneAfterConcern("Harriet"), [SHARING_MENU_BUTTON]),
      msg(SARAH, familyDailyStatus({ seniorName: "Harriet", sharing: "status", outcome: "checked_in", answers: [], flags: [] })),
    ]);
    expect(checkin()).toMatchObject({ status: "answered", step: "done", pendingFlagId: null });
  });

  it("a second red flag in the same check-in joins the waiting follow-up as a general one", async () => {
    setup();
    await atBreathing();
    await say("Yes, it was hard");
    const [advice] = await say("Yes, bleeding");
    expect(advice?.text).toBe(redFlagAdvice("Harriet", ["Sarah"], 1));
    expect(nextFollowUp(db, P)?.reason).toBe("general");
    expect(db.prepare("SELECT COUNT(*) AS n FROM follow_ups").get()).toEqual({ n: 1 });
  });

  it("the follow-up delay is an engine option", async () => {
    setup();
    engine = createCheckinEngine(
      { db, messenger, clock: { now: () => now }, loadSnapshot: async (s) => loadSnapshot(s) },
      { rxnav, followUpDelayMinutes: 2 },
    );
    await atBreathing();
    await say("Yes, it was hard");
    expect(nextFollowUp(db, P)?.dueAt).toBe("2026-09-01T13:02:00.000Z");
  });

  it("without a concern the day still ends with the flag offer and 'tomorrow'", async () => {
    setup();
    await atBreathing();
    await say("Fine");
    await say("No");
    expect((await say("No"))[0]?.text).toBe(flagOffer());
    expect((await say(BUTTON.later))[0]?.text).toBe(checkinDone("Harriet"));
    expect(nextFollowUp(db, P)).toBeUndefined();
  });
});

describe("today's live conversation, with the new behaviour", () => {
  it('"Not really but I have more info" is noted with the buttons; "Yes but it was weirder..." is her Yes, calmly handled, with a follow-up', async () => {
    const readings: MessageClassification[] = [as("more_detail"), as("more_detail")];
    setup({ classifyMessage: () => readings.shift() ?? new LlmUnavailableError("no more") });
    setSharing(db, P, "all");
    await atBreathing();

    // She offers more: written down for her doctor, and the buttons come back (not the same confirm again).
    expect(brief(await say("Not really but I have more info"))).toEqual([msg(ME, noteSaved("Harriet"), promptButtons(breathing))]);
    expect(checkin().answers).toEqual([]);

    // Her typed "Yes" counts, with her words kept.
    const words = "Yes but it was weirder I don't know how to explainit";
    expect(brief(await say(words))).toEqual([
      msg(ME, redFlagAdvice("Harriet", ["Sarah"], 2)),
      msg(SARAH, familyRedFlagAlert({ seniorName: "Harriet", sharing: "all", questionText: breathing.text, answer: "Yes, it was hard", words })),
      asked(bleeding),
    ]);
    expect(checkin().answers[0]).toMatchObject({ questionId: breathing.id, answer: "Yes, it was hard", via: "free_text", freeText: words });
    expect(checkinNotes(db, checkin().id).map((n) => [n.questionId, n.text])).toEqual([
      [breathing.id, "Not really but I have more info"],
      [breathing.id, words],
    ]);
    expect(nextFollowUp(db, P)).toMatchObject({ reason: breathing.id });

    // The rest of the questions, then no flag offer and "this afternoon"; Sarah sees her notes at "all".
    expect(brief(await say("No"))).toEqual([asked(dizzy)]);
    const end = brief(await say("No"));
    expect(end[0]).toEqual(msg(ME, checkinDoneAfterConcern("Harriet"), [SHARING_MENU_BUTTON]));
    expect(end.map((m) => m.text)).not.toContain(flagOffer());
    expect(end[1]?.chatId).toBe(SARAH);
    expect(end[1]?.text).toContain(`Harriet also wrote (kept for the doctor):\n- ${breathing.text} "Not really but I have more info"`);
    expect(end).toHaveLength(2);

    // This afternoon: the follow-up about her breathing.
    now = "2026-09-01T16:00:00.000Z";
    expect(await engine.runDueFollowUps(now)).toBe(1);
    expect(messenger.lastIn(ME)).toMatchObject({ text: "Checking in again, Harriet. How is your breathing now?", buttons: Object.values(FOLLOW_UP_BUTTONS) });
  });
});
