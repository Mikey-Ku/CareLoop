import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  BUTTON,
  READING_ACTIVITY,
  complaintReply,
  didntUnderstand,
  familyRedFlagAlert,
  freeTextConfirm,
  redFlagAdvice,
  smallTalkFallback,
} from "../src/checkin/copy.ts";
import { MAX_SMALL_TALK_REPLY, SMALL_TALK_MEMORIES, checkedSmallTalk, createCheckinEngine } from "../src/checkin/engine.ts";
import type { CheckinEngine } from "../src/checkin/engine-types.ts";
import { PAPER_CONFIRM_BUTTONS } from "../src/checkin/paper-check.ts";
import { QUESTION_BANK } from "../src/context/questions.ts";
import { getCheckin, updateCheckin } from "../src/db/checkins.ts";
import { linkFamilyMember, syncFamilyMembers } from "../src/db/family.ts";
import { openDatabase, upsertPatient, type Db } from "../src/db/index.ts";
import { MAX_MEMORY_LENGTH, addMemories, recentMemories } from "../src/db/memories.ts";
import { loadRxNavCache, loadSnapshot } from "../src/finchnode/fixtures.ts";
import { FakeLlmClient, type FakeLlmScript } from "../src/llm/fake.ts";
import { LlmUnavailableError, type AnswerMapping, type SmallTalkReply } from "../src/llm/types.ts";
import { FakeMessenger } from "../src/relay/fake-messenger.ts";
import type { SentMessage } from "../src/relay/messenger.ts";
import type { ExtractedPaper } from "../src/rules/paper-diff.ts";

// Free text (src/checkin/engine.ts "Free text"): what Harriet types instead of tapping,
// read by a FakeLlmClient. Synthetic data only.

const P = "harriet";
const SUBJECT = "patient-demo-polypharmacy";
const ME = "chat_harriet";
const FAMILY = "chat_family";
const DAY1 = "2026-09-01"; // hf-breathing-lying-flat, anticoagulant-bleeding, dizzy-on-standing
const DAY2 = "2026-09-02"; // after a calm DAY1: hf-ankle-swelling, morning-medicines, mood
const rxnav = loadRxNavCache();

const question = (id: string) => QUESTION_BANK.find((q) => q.id === id)!;
const breathing = question("hf-breathing-lying-flat");
const bleeding = question("anticoagulant-bleeding");
const ankles = question("hf-ankle-swelling");
const medicines = question("morning-medicines");

let db: Db;
let messenger: FakeMessenger;
let engine: CheckinEngine;
let llm: FakeLlmClient | undefined;
let now: string;
let inbound = 0;
/** What happened, in order: sends, activity changes and LLM calls. */
let events: string[];

const mapping = (answer: string, confidence: AnswerMapping["confidence"] = "high", otherComplaints: string[] = []): AnswerMapping => ({
  answer,
  confidence,
  otherComplaints,
});
const chat = (text: string, memories: string[] = [], complaints: string[] = []): SmallTalkReply => ({ text, memories, complaints });

/** A fresh engine, with an LLM scripted by `script` (none when `script` is undefined). */
function setup(script?: FakeLlmScript) {
  db = openDatabase(":memory:");
  upsertPatient(db, { id: P, finchnodePatientId: SUBJECT, preferredName: "Harriet", relayChatId: ME });
  syncFamilyMembers(db, P, ["sarah"]);
  linkFamilyMember(db, "sarah", FAMILY, "Sarah", `${DAY1}T08:00:00.000Z`);
  now = `${DAY1}T09:00:00.000Z`;
  events = [];
  messenger = new FakeMessenger({
    now: () => now,
    onSend: (m) => events.push(`send ${m.chatId === ME ? "her" : "family"}`),
    onActivity: (a) => events.push(a.kind === "set" ? `activity ${a.label}` : "activity cleared"),
  });
  // Wrap each scripted method so the event log shows when the LLM was called.
  const logged: FakeLlmScript | undefined = script && {
    ...(script.mapAnswer && {
      mapAnswer: (input) => {
        events.push("llm mapAnswer");
        return script.mapAnswer!(input);
      },
    }),
    ...(script.smallTalk && {
      smallTalk: (input) => {
        events.push("llm smallTalk");
        return script.smallTalk!(input);
      },
    }),
  };
  llm = logged ? new FakeLlmClient(logged) : undefined;
  engine = createCheckinEngine(
    { db, messenger, clock: { now: () => now }, loadSnapshot: async (s) => loadSnapshot(s), llm },
    { rxnav, missedCheckinTime: "12:00" },
  );
}

/** She types (no replyTo). Returns what was sent because of it. */
async function say(text: string, chatId = ME, messageId = `in_${++inbound}`): Promise<SentMessage[]> {
  const before = messenger.sent.length;
  await engine.handleInbound({ chatId, messageId, text, at: now });
  return messenger.sent.slice(before);
}

/** A button tap on a message. */
async function tap(label: string, on: SentMessage | undefined): Promise<SentMessage[]> {
  if (!on) throw new Error(`no message to tap "${label}" on`);
  const before = messenger.sent.length;
  await engine.handleInbound({ chatId: ME, messageId: `in_${++inbound}`, text: label, replyTo: on.messageId, at: now });
  return messenger.sent.slice(before);
}

const brief = (messages: SentMessage[]) => messages.map(({ chatId, text, buttons }) => ({ chatId, text, buttons }));
const msg = (chatId: string, text: string, buttons?: string[]) => ({ chatId, text, buttons });
const memories = () => recentMemories(db, P, 50);

/** Day 1 started and "Let's start" tapped: the breathing (red-flag) question is pending. */
async function atBreathing(): Promise<void> {
  await engine.startDay(P, DAY1);
  await say(BUTTON.start);
}

/** A calm day 1, then day 2 started and "Let's start" tapped: the ankle question (ordinary) is pending. */
async function atAnkles(): Promise<void> {
  await engine.startDay(P, DAY1);
  for (const t of [BUTTON.start, "No", "No", "No", BUTTON.later]) await say(t);
  now = `${DAY2}T09:00:00.000Z`;
  expect(await engine.startDay(P, DAY2)).toEqual({ kind: "sent", questionIds: ["hf-ankle-swelling", "morning-medicines", "mood"] });
  await say(BUTTON.start);
  events = [];
}

beforeEach(() => {
  inbound = 0;
});

describe("free text on an ordinary question", () => {
  it('"bit puffy" is recorded as "A little" with her words, and the check-in goes on', async () => {
    setup({ mapAnswer: () => mapping("A little", "medium") });
    await atAnkles();
    expect(brief(await say("bit puffy"))).toEqual([msg(ME, medicines.text, medicines.buttons)]);
    expect(llm?.mapAnswerCalls).toEqual([{ question: ankles.text, options: ankles.buttons, reply: "bit puffy" }]);
    const row = getCheckin(db, P, DAY2)!;
    expect(row).toMatchObject({ step: "question", questionIndex: 1 });
    expect(row.answers).toEqual([
      { questionId: "hf-ankle-swelling", questionText: ankles.text, answer: "A little", at: now, via: "free_text", freeText: "bit puffy" },
    ]);
    // The rest of the day runs on taps as usual.
    await say("Yes");
    await say("Good");
    expect(getCheckin(db, P, DAY2)?.answers.map((a) => a.answer)).toEqual(["A little", "Yes", "Good"]);
  });

  it("shows the reading label in her chat before the LLM call and clears it after the reply", async () => {
    setup({ mapAnswer: () => mapping("A little") });
    await atAnkles();
    await say("bit puffy");
    expect(events).toEqual([`activity ${READING_ACTIVITY}`, "llm mapAnswer", "send her", "activity cleared"]);
    expect(messenger.activityIn(ME)).toBeUndefined();
  });

  it("matches the option case-insensitively but stores the button label", async () => {
    setup({ mapAnswer: () => mapping("a LITTLE") });
    await atAnkles();
    await say("ankles a bit swollen");
    expect(getCheckin(db, P, DAY2)?.answers[0]?.answer).toBe("A little");
  });

  it.each([
    ["low confidence", mapping("A little", "low")],
    ['"unclear"', mapping("unclear", "high")],
    ["an answer that isn't one of the buttons", mapping("Maybe", "high")],
  ])("%s gets didn't understand with the buttons, and nothing is recorded", async (_, result) => {
    setup({ mapAnswer: () => result });
    await atAnkles();
    expect(brief(await say("hmm, not sure"))).toEqual([msg(ME, didntUnderstand(ankles.buttons), ankles.buttons)]);
    expect(getCheckin(db, P, DAY2)).toMatchObject({ step: "question", questionIndex: 0, answers: [] });
    expect(messenger.activityIn(ME)).toBeUndefined();
  });

  it.each([
    ["LlmUnavailableError", new LlmUnavailableError("down")],
    ["any other error", new Error("bug")],
  ])("an LLM that throws (%s) gets didn't understand with the buttons", async (_, error) => {
    setup({ mapAnswer: () => error });
    await atAnkles();
    expect(brief(await say("bit puffy"))).toEqual([msg(ME, didntUnderstand(ankles.buttons), ankles.buttons)]);
    expect(getCheckin(db, P, DAY2)?.answers).toEqual([]);
    expect(events.at(-1)).toBe("activity cleared");
  });

  it("a tap on the didn't-understand message answers the question", async () => {
    setup({ mapAnswer: () => mapping("unclear", "low") });
    await atAnkles();
    const [didnt] = await say("eh");
    expect(brief(await tap("No", didnt))).toEqual([msg(ME, medicines.text, medicines.buttons)]);
  });

  it("with no LLM, free text gets didn't understand as before", async () => {
    setup();
    await atAnkles();
    expect(brief(await say("bit puffy"))).toEqual([msg(ME, didntUnderstand(ankles.buttons), ankles.buttons)]);
    expect(messenger.activities).toEqual([]);
  });

  it("typing a label (or Not today) never calls the LLM", async () => {
    setup({ mapAnswer: () => mapping("No") });
    await atAnkles();
    await say(" a little ");
    expect(getCheckin(db, P, DAY2)?.answers[0]).not.toHaveProperty("via");
    await say("not today");
    expect(llm?.calls).toEqual([]);
    expect(getCheckin(db, P, DAY2)?.status).toBe("skipped");
  });

  it("other complaints from the mapping are saved as memories (deduped), never acted on", async () => {
    setup({ mapAnswer: () => mapping("A little", "high", ["my knee aches", "tired lately"]) });
    await atAnkles();
    const sent = await say("bit puffy, and my knee aches, tired lately");
    expect(brief(sent)).toEqual([msg(ME, medicines.text, medicines.buttons)]);
    expect(memories().sort()).toEqual(["my knee aches", "tired lately"]);
    // The same complaints again (and "A little" isn't a button here): didn't understand, no new memories.
    expect(brief(await say("took them, knee aches"))).toEqual([msg(ME, didntUnderstand(medicines.buttons), medicines.buttons)]);
    expect(memories()).toHaveLength(2);
    expect(messenger.inChat(FAMILY).filter((m) => m.at.startsWith(DAY2))).toEqual([]);
  });

  it("an unclear mapping still saves its other complaints", async () => {
    setup({ mapAnswer: () => mapping("unclear", "low", ["dizzy in the shower"]) });
    await atAnkles();
    await say("dizzy in the shower this morning");
    expect(memories()).toEqual(["dizzy in the shower"]);
  });

  it("a swipe-reply to the current question with free text is read too", async () => {
    setup({ mapAnswer: () => mapping("A little") });
    await atAnkles();
    const current = messenger.lastIn(ME);
    expect(brief(await tap("puffy ankles", current))).toEqual([msg(ME, medicines.text, medicines.buttons)]);
  });

  it("if the check-in moved on while the LLM read, the answer is not used for the new question", async () => {
    let checkinId = 0;
    setup({
      mapAnswer: () => {
        // Something else answered the ankle question meanwhile.
        updateCheckin(db, checkinId, { questionIndex: 1 });
        return mapping("A little");
      },
    });
    await atAnkles();
    checkinId = getCheckin(db, P, DAY2)!.id;
    expect(brief(await say("bit puffy"))).toEqual([msg(ME, didntUnderstand(medicines.buttons), medicines.buttons)]);
    expect(getCheckin(db, P, DAY2)?.answers).toEqual([]);
    expect(llm?.calls).toHaveLength(1);
  });

  it("a replayed message id never calls the LLM again or sends twice", async () => {
    setup({ mapAnswer: () => mapping("A little") });
    await atAnkles();
    expect(await say("bit puffy", ME, "relay_in_1")).toHaveLength(1);
    expect(await say("bit puffy", ME, "relay_in_1")).toEqual([]);
    expect(llm?.mapAnswerCalls).toHaveLength(1);
    expect(getCheckin(db, P, DAY2)?.answers).toHaveLength(1);
  });

  it("a failed send leaves the label cleared and the message handled (a retry calls the LLM no more)", async () => {
    setup({ mapAnswer: () => mapping("A little") });
    await atAnkles();
    const send = messenger.send.bind(messenger);
    messenger.send = async () => {
      throw new Error("relay down");
    };
    await expect(say("bit puffy", ME, "relay_in_2")).rejects.toThrow(/relay down/);
    expect(messenger.activityIn(ME)).toBeUndefined();
    messenger.send = send;
    await say("bit puffy", ME, "relay_in_2");
    expect(llm?.mapAnswerCalls).toHaveLength(1);
  });
});

describe("free text on a red-flag question", () => {
  const HER_WORDS = "nah fine, had to prop myself up on pillows";

  it("quotes her words with the question and its buttons, records nothing, and asks the LLM only for other complaints afterwards", async () => {
    // The LLM's answer ("Yes", high) is ignored: only her tap counts on a red-flag question.
    setup({ mapAnswer: () => mapping("Yes", "high", ["had to prop myself up on pillows"]) });
    await atBreathing();
    events = [];
    expect(brief(await say(HER_WORDS))).toEqual([msg(ME, freeTextConfirm(HER_WORDS, breathing.text), breathing.buttons)]);
    expect(getCheckin(db, P, DAY1)).toMatchObject({ step: "question", questionIndex: 0, answers: [] });
    // The confirm goes out first, with no reading label; the LLM is asked afterwards.
    expect(events).toEqual(["send her", "llm mapAnswer"]);
    expect(llm?.mapAnswerCalls).toEqual([{ question: breathing.text, options: breathing.buttons, reply: HER_WORDS }]);
    // Saved in the background, so her next tap never waits for it.
    await vi.waitFor(() => expect(memories()).toEqual(["had to prop myself up on pillows"]));
    // No red flag, no family alert from free text.
    expect(messenger.inChat(FAMILY)).toEqual([]);
  });

  it('a tap on "Yes" on the confirm raises the red flag exactly as a normal tap', async () => {
    setup({ mapAnswer: () => mapping("No", "high") });
    await atBreathing();
    const [confirm] = await say(HER_WORDS);
    const sent = await tap("Yes", confirm);
    expect(brief(sent)).toEqual([
      msg(ME, redFlagAdvice("Harriet", ["Sarah"])),
      msg(FAMILY, familyRedFlagAlert({ seniorName: "Harriet", sharing: "status", questionText: breathing.text, answer: "Yes" })),
      msg(ME, bleeding.text, bleeding.buttons),
    ]);
    const answer = getCheckin(db, P, DAY1)!.answers[0]!;
    expect(answer).toMatchObject({ questionId: breathing.id, answer: "Yes" });
    expect(answer).not.toHaveProperty("via");
  });

  it('a tap on "No" on the confirm records No and moves on', async () => {
    setup({ mapAnswer: () => mapping("Yes", "high") });
    await atBreathing();
    const [confirm] = await say(HER_WORDS);
    expect(brief(await tap("No", confirm))).toEqual([msg(ME, bleeding.text, bleeding.buttons)]);
    expect(getCheckin(db, P, DAY1)?.answers.map((a) => [a.questionId, a.answer])).toEqual([[breathing.id, "No"]]);
    expect(messenger.inChat(FAMILY)).toEqual([]);
  });

  it("works with no LLM at all", async () => {
    setup();
    await atBreathing();
    const [confirm] = await say(HER_WORDS);
    expect(brief([confirm!])).toEqual([msg(ME, freeTextConfirm(HER_WORDS, breathing.text), breathing.buttons)]);
    expect(brief(await tap("Yes", confirm))[0]).toEqual(msg(ME, redFlagAdvice("Harriet", ["Sarah"])));
  });

  it("works when the LLM is down", async () => {
    setup({ mapAnswer: () => new LlmUnavailableError("down") });
    await atBreathing();
    expect(brief(await say(HER_WORDS))).toEqual([msg(ME, freeTextConfirm(HER_WORDS, breathing.text), breathing.buttons)]);
    expect(llm?.mapAnswerCalls).toHaveLength(1);
    expect(memories()).toEqual([]);
  });

  it("her tap on the confirm doesn't wait for the background LLM call", async () => {
    let release: (() => void) | undefined;
    const slow = new FakeLlmClient();
    slow.mapAnswer = (input) => {
      slow.calls.push({ method: "mapAnswer", input });
      return new Promise((resolve) => (release = () => resolve(mapping("No", "high", ["pillows"]))));
    };
    setup();
    engine = createCheckinEngine(
      { db, messenger, clock: { now: () => now }, loadSnapshot: async (s) => loadSnapshot(s), llm: slow },
      { rxnav, missedCheckinTime: "12:00" },
    );
    await atBreathing();
    const [confirm] = await say(HER_WORDS);
    expect(brief(await tap("Yes", confirm))[0]).toEqual(msg(ME, redFlagAdvice("Harriet", ["Sarah"])));
    release?.();
    await vi.waitFor(() => expect(memories()).toEqual(["pillows"]));
  });

  it("a replayed message id sends no second confirm and asks the LLM once", async () => {
    setup({ mapAnswer: () => mapping("Yes", "high") });
    await atBreathing();
    await say(HER_WORDS, ME, "relay_in_9");
    expect(await say(HER_WORDS, ME, "relay_in_9")).toEqual([]);
    expect(llm?.mapAnswerCalls).toHaveLength(1);
  });

  it("a tap on an old confirm after the check-in moved on only re-prompts", async () => {
    setup();
    await atBreathing();
    const [confirm] = await say(HER_WORDS);
    await tap("No", confirm);
    expect(brief(await tap("Yes", confirm))).toEqual([msg(ME, bleeding.text, bleeding.buttons)]);
    expect(getCheckin(db, P, DAY1)?.answers.map((a) => a.answer)).toEqual(["No"]);
    expect(messenger.inChat(FAMILY)).toEqual([]);
  });
});

describe("small talk (nothing pending)", () => {
  it("sends the model's reply, saves what she shared, and passes recent memories along", async () => {
    setup({ smallTalk: () => chat("That sounds lovely, Harriet. Enjoy the visit.", ["granddaughter Mia visits Sunday"]) });
    addMemories(db, P, ["has a cat called Biscuit"], `${DAY1}T08:00:00.000Z`);
    expect(brief(await say("my granddaughter Mia is visiting on Sunday"))).toEqual([msg(ME, "That sounds lovely, Harriet. Enjoy the visit.")]);
    expect(llm?.smallTalkCalls).toEqual([
      { seniorName: "Harriet", message: "my granddaughter Mia is visiting on Sunday", memories: ["has a cat called Biscuit"] },
    ]);
    expect(memories()).toEqual(["granddaughter Mia visits Sunday", "has a cat called Biscuit"]);
    expect(events).toEqual([`activity ${READING_ACTIVITY}`, "llm smallTalk", "send her", "activity cleared"]);
  });

  it("a health complaint gets the fixed complaint reply, not the model's words, and no family alert", async () => {
    setup({ smallTalk: () => chat("Oh no, try some rest.", ["went to the garden"], ["my chest feels tight"]) });
    expect(brief(await say("went to the garden but my chest feels tight"))).toEqual([msg(ME, complaintReply("Harriet"))]);
    expect(memories().sort()).toEqual(["my chest feels tight", "went to the garden"]);
    expect(messenger.inChat(FAMILY)).toEqual([]);
  });

  it("with no LLM, the fixed fallback (and no label)", async () => {
    setup();
    expect(brief(await say("good morning"))).toEqual([msg(ME, smallTalkFallback("Harriet"))]);
    expect(messenger.activities).toEqual([]);
  });

  it.each([
    ["the LLM is unavailable", () => new LlmUnavailableError("down")],
    ["a reply with a long dash", () => chat("Lovely \u2014 enjoy it.")],
    ["an empty reply", () => chat("   ")],
    ["a reply that is too long", () => chat("word ".repeat(MAX_SMALL_TALK_REPLY))],
  ])("%s: the fixed fallback", async (_, reply) => {
    setup({ smallTalk: reply });
    expect(brief(await say("good morning"))).toEqual([msg(ME, smallTalkFallback("Harriet"))]);
    expect(messenger.activityIn(ME)).toBeUndefined();
  });

  it("after the day's check-in is done, too", async () => {
    setup({ smallTalk: () => chat("You're welcome, Harriet.") });
    await engine.startDay(P, DAY1);
    for (const t of [BUTTON.start, "No", "No", "No", BUTTON.later]) await say(t);
    expect(brief(await say("thanks dear"))).toEqual([msg(ME, "You're welcome, Harriet.")]);
  });

  it("a button label with nothing pending is a late tap: ignored, no LLM", async () => {
    setup({ smallTalk: () => chat("Hello.") });
    expect(await say(BUTTON.willAskDoctor)).toEqual([]);
    expect(await say("yes")).toEqual([]);
    expect(llm?.calls).toEqual([]);
  });

  it("while a paper read-back waits for her, free text is left alone", async () => {
    setup({ smallTalk: () => chat("Hello.") });
    const paper: ExtractedPaper = { kind: "discharge", date: "2026-08-30", medications: [{ name: "aspirin", strength: "81 mg", change: "stopped" }], synthetic: true };
    await engine.startPaperCheck(P, paper, "att_1");
    expect(await say("what is this?")).toEqual([]);
    expect(llm?.calls).toEqual([]);
    // Her tap on the read-back still works.
    expect((await say(PAPER_CONFIRM_BUTTONS[1]!))[0]?.text).toMatch(/Thank you for checking/);
  });

  it("a replayed message id never calls the LLM again", async () => {
    setup({ smallTalk: () => chat("Hello, Harriet.") });
    await say("hi there", ME, "relay_in_5");
    expect(await say("hi there", ME, "relay_in_5")).toEqual([]);
    expect(llm?.smallTalkCalls).toHaveLength(1);
  });

  it("passes at most SMALL_TALK_MEMORIES recent memories, newest first", async () => {
    setup({ smallTalk: () => chat("Hello.") });
    for (let i = 0; i < SMALL_TALK_MEMORIES + 3; i++) addMemories(db, P, [`memory ${i}`], `2026-08-${String(10 + i).padStart(2, "0")}T08:00:00.000Z`);
    await say("hello");
    const passed = llm?.smallTalkCalls[0]?.memories ?? [];
    expect(passed).toHaveLength(SMALL_TALK_MEMORIES);
    expect(passed[0]).toBe(`memory ${SMALL_TALK_MEMORIES + 2}`);
  });
});

describe("family chats never reach free text", () => {
  it("free text in a family chat during her question, or with nothing pending, does nothing and calls no LLM", async () => {
    setup({ mapAnswer: () => mapping("A little"), smallTalk: () => chat("Hello.") });
    expect(await say("hello", FAMILY)).toEqual([]);
    await atAnkles();
    const before = messenger.sent.length;
    expect(await say("bit puffy", FAMILY)).toEqual([]);
    expect(await say("nah fine, had to prop myself up", FAMILY)).toEqual([]);
    expect(messenger.sent.length).toBe(before);
    expect(llm?.calls).toEqual([]);
    expect(messenger.activities).toEqual([]);
    expect(getCheckin(db, P, DAY2)?.answers).toEqual([]);
  });
});

describe("checkedSmallTalk", () => {
  it("keeps a short reply, trimmed", () => {
    expect(checkedSmallTalk("  Hello, Harriet.  ")).toBe("Hello, Harriet.");
  });

  it("refuses empty, too long, or long-dash replies", () => {
    expect(checkedSmallTalk(" ")).toBeUndefined();
    expect(checkedSmallTalk("a".repeat(MAX_SMALL_TALK_REPLY + 1))).toBeUndefined();
    expect(checkedSmallTalk("Nice \u2013 really")).toBeUndefined();
  });
});

describe("memories", () => {
  beforeEach(() => setup());

  it("adds trimmed memories, skips blanks and ones she already has (any case or spacing)", () => {
    expect(addMemories(db, P, ["  likes  tea ", "", "   "], "2026-09-01T08:00:00.000Z")).toBe(1);
    expect(addMemories(db, P, ["Likes tea", "walks the dog", "walks the dog"], "2026-09-01T09:00:00.000Z")).toBe(1);
    expect(recentMemories(db, P, 10)).toEqual(["walks the dog", "likes tea"]);
  });

  it("caps a long memory", () => {
    addMemories(db, P, ["x".repeat(MAX_MEMORY_LENGTH + 50)], "2026-09-01T08:00:00.000Z");
    expect(recentMemories(db, P, 1)[0]).toHaveLength(MAX_MEMORY_LENGTH);
  });

  it("returns the newest n, skips deleted ones, and nothing for n <= 0", () => {
    addMemories(db, P, ["one"], "2026-09-01T08:00:00.000Z");
    addMemories(db, P, ["two"], "2026-09-02T08:00:00.000Z");
    addMemories(db, P, ["three"], "2026-09-03T08:00:00.000Z");
    db.prepare("UPDATE memories SET deleted_at = ? WHERE text = 'three'").run("2026-09-04T08:00:00.000Z");
    expect(recentMemories(db, P, 1)).toEqual(["two"]);
    expect(recentMemories(db, P, 5)).toEqual(["two", "one"]);
    expect(recentMemories(db, P, 0)).toEqual([]);
    // A deleted memory doesn't block saving it again.
    expect(addMemories(db, P, ["three"], "2026-09-05T08:00:00.000Z")).toBe(1);
  });
});
