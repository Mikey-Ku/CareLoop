import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  BUTTON,
  checkinDone,
  checkinGreeting,
  didntUnderstand,
  familyDailyStatus,
  familyMissedAlert,
  familyRedFlagAlert,
  flagDetail,
  flagNotedReply,
  flagOffer,
  notTodayReply,
  redFlagAdvice,
  SHARING_MENU_BUTTON,
} from "../src/checkin/copy.ts";
import { createCheckinEngine } from "../src/checkin/engine.ts";
import type { CheckinEngine } from "../src/checkin/engine-types.ts";
import { QUESTION_BANK } from "../src/context/questions.ts";
import { getCheckin } from "../src/db/checkins.ts";
import { linkFamilyMember, syncFamilyMembers } from "../src/db/family.ts";
import {
  latestSnapshot,
  openDatabase,
  openFlags,
  saveSnapshot,
  setSharing,
  upsertPatient,
  type Db,
  type FlagSummary,
} from "../src/db/index.ts";
import { FinchNodeClient } from "../src/finchnode/client.ts";
import { loadRecorded, loadRxNavCache, loadSnapshot, replayFetch } from "../src/finchnode/fixtures.ts";
import { FakeMessenger } from "../src/relay/fake-messenger.ts";
import type { SentMessage } from "../src/relay/messenger.ts";

const P = "harriet";
const SUBJECT = "patient-demo-polypharmacy";
const ME = "chat_harriet";
const FAMILY = "chat_family";
const DAY1 = "2026-09-01"; // questions: dizzy-on-standing, morning-medicines, mood
const DAY2 = "2026-09-02"; // questions: hf-ankle-swelling, hf-breathing-lying-flat, anticoagulant-bleeding
const rxnav = loadRxNavCache();

const question = (id: string) => QUESTION_BANK.find((q) => q.id === id)!;

let db: Db;
let messenger: FakeMessenger;
let engine: CheckinEngine;
let now: string;
let inbound = 0;

function setup(loadSnapshotImpl: (subject: string) => Promise<ReturnType<typeof loadSnapshot>> = async (s) => loadSnapshot(s)) {
  db = openDatabase(":memory:");
  upsertPatient(db, { id: P, finchnodePatientId: SUBJECT, preferredName: "Harriet", relayChatId: ME });
  // One family member, Sarah, already linked: FAMILY is her own chat with the agent.
  syncFamilyMembers(db, P, ["sarah"]);
  linkFamilyMember(db, "sarah", FAMILY, "Sarah", `${DAY1}T08:00:00.000Z`);
  now = `${DAY1}T09:00:00.000Z`;
  messenger = new FakeMessenger({ now: () => now });
  engine = createCheckinEngine(
    { db, messenger, clock: { now: () => now }, loadSnapshot: loadSnapshotImpl },
    { rxnav, missedCheckinTime: "12:00" },
  );
}

async function say(text: string, chatId = ME): Promise<SentMessage[]> {
  const before = messenger.sent.length;
  inbound += 1;
  await engine.handleInbound({ chatId, messageId: `in_${inbound}`, text, at: now });
  return messenger.sent.slice(before);
}

const brief = (messages: SentMessage[]) => messages.map(({ chatId, text, buttons }) => ({ chatId, text, buttons }));
const msg = (chatId: string, text: string, buttons?: string[]) => ({ chatId, text, buttons });
const flagsByRule = () => new Map(openFlags(db, P).map((f) => [f.ruleId, f] as [string, FlagSummary]));

beforeEach(() => setup());

describe("a full Harriet day", () => {
  it("greeting, three answers, flag offer, tell me more, I'll ask my doctor, done, family status", async () => {
    setSharing(db, P, "all");
    expect(await engine.startDay(P, DAY1)).toEqual({ kind: "sent", questionIds: ["dizzy-on-standing", "morning-medicines", "mood"] });
    expect(brief(messenger.sent)).toEqual([msg(ME, checkinGreeting("Harriet", 3), [BUTTON.start, BUTTON.notToday])]);

    // Snapshot saved and flags synced: R1, R3, R4 all medium, so R1 (oldest id) first.
    expect(latestSnapshot(db, P)).toBeDefined();
    const flags = flagsByRule();
    expect([...flags.keys()].sort()).toEqual(["R1", "R3", "R4"]);
    const r1 = flags.get("R1")!;

    const dizzy = question("dizzy-on-standing");
    const meds = question("morning-medicines");
    const mood = question("mood");

    expect(brief(await say("Let's start"))).toEqual([msg(ME, dizzy.text, dizzy.buttons)]);
    now = `${DAY1}T09:01:00.000Z`;
    expect(brief(await say("No"))).toEqual([msg(ME, meds.text, meds.buttons)]);
    expect(brief(await say(" yes "))).toEqual([msg(ME, mood.text, mood.buttons)]); // trimmed, case-insensitive
    expect(brief(await say("Good"))).toEqual([msg(ME, flagOffer(), [BUTTON.tellMeMore, BUTTON.later])]);

    let row = getCheckin(db, P, DAY1)!;
    expect(row).toMatchObject({ status: "answered", step: "flag_offer", pendingFlagId: Number(r1.flagId), mood: "Good", finishedAt: null });
    expect(row.answers.map((a) => [a.questionId, a.answer])).toEqual([
      ["dizzy-on-standing", "No"],
      ["morning-medicines", "Yes"],
      ["mood", "Good"],
    ]);
    expect(db.prepare("SELECT offered_on FROM flags WHERE id = ?").get(Number(r1.flagId))).toEqual({ offered_on: DAY1 });

    expect(brief(await say("Tell me more"))).toEqual([msg(ME, flagDetail(r1.message), [BUTTON.willAskDoctor, BUTTON.later])]);
    expect(flagsByRule().get("R1")?.status).toBe("told");

    const last = await say("I'll ask my doctor");
    const answers = row.answers.map(({ questionId, questionText, answer }) => ({ questionId, questionText, answer }));
    expect(brief(last)).toEqual([
      msg(ME, flagNotedReply()),
      msg(ME, checkinDone("Harriet"), [SHARING_MENU_BUTTON]),
      msg(FAMILY, familyDailyStatus({ seniorName: "Harriet", sharing: "all", outcome: "checked_in", answers, flags: [{ message: r1.message }] })),
    ]);

    row = getCheckin(db, P, DAY1)!;
    expect(row).toMatchObject({ status: "answered", step: "done", pendingFlagId: null, finishedAt: now });
    expect(flagsByRule().get("R1")?.status).toBe("noted");
    expect(flagsByRule().get("R3")?.status).toBe("new");

    // The whole day, in order: 8 to her, 1 to the family.
    expect(messenger.sent.map((m) => m.chatId)).toEqual([ME, ME, ME, ME, ME, ME, ME, ME, FAMILY]);

    // Nothing pending: free text is ignored.
    expect(await say("thanks dear")).toEqual([]);
  });

  it("at sharing level status the family gets only the outcome", async () => {
    await engine.startDay(P, DAY1);
    for (const t of ["Let's start", "No", "Yes", "Okay", "Later"]) await say(t);
    const family = messenger.inChat(FAMILY);
    expect(family.map((m) => m.text)).toEqual([
      familyDailyStatus({ seniorName: "Harriet", sharing: "status", outcome: "checked_in", answers: [], flags: [] }),
    ]);
    expect(family[0]!.text).not.toContain(question("mood").text);
  });

  it("day 2 offers the next new flag and never the noted one", async () => {
    await engine.startDay(P, DAY1);
    for (const t of ["Let's start", "No", "Yes", "Good", "Tell me more", "I'll ask my doctor"]) await say(t);
    const r3 = flagsByRule().get("R3")!;

    now = `${DAY2}T09:00:00.000Z`;
    expect(await engine.startDay(P, DAY2)).toMatchObject({ kind: "sent" });
    // Same evidence, so the noted flag is unchanged rather than re-raised.
    expect(flagsByRule().get("R1")?.status).toBe("noted");
    for (const t of ["Let's start", "No", "No"]) await say(t);
    expect(brief(await say("No"))).toEqual([msg(ME, flagOffer(), [BUTTON.tellMeMore, BUTTON.later])]);
    expect(getCheckin(db, P, DAY2)?.pendingFlagId).toBe(Number(r3.flagId));
    expect(brief(await say("Tell me more"))).toEqual([msg(ME, flagDetail(r3.message), [BUTTON.willAskDoctor, BUTTON.later])]);
  });

  it("Later keeps the flag new and offers it again the next day", async () => {
    await engine.startDay(P, DAY1);
    for (const t of ["Let's start", "No", "Yes", "Good"]) await say(t);
    const r1 = flagsByRule().get("R1")!;
    expect(brief(await say("later"))).toEqual([
      msg(ME, checkinDone("Harriet"), [SHARING_MENU_BUTTON]),
      msg(FAMILY, familyDailyStatus({ seniorName: "Harriet", sharing: "status", outcome: "checked_in", answers: [], flags: [] })),
    ]);
    expect(flagsByRule().get("R1")?.status).toBe("new");

    now = `${DAY2}T09:00:00.000Z`;
    await engine.startDay(P, DAY2);
    for (const t of ["Let's start", "No", "No", "No"]) await say(t);
    expect(getCheckin(db, P, DAY2)).toMatchObject({ step: "flag_offer", pendingFlagId: Number(r1.flagId) });
  });

  it("Later after hearing the detail leaves the flag told", async () => {
    await engine.startDay(P, DAY1);
    for (const t of ["Let's start", "No", "Yes", "Good", "Tell me more"]) await say(t);
    expect(brief(await say("Later"))[0]).toEqual(msg(ME, checkinDone("Harriet"), [SHARING_MENU_BUTTON]));
    expect(flagsByRule().get("R1")?.status).toBe("told");
  });

  it("no new flag to offer: done right after the last answer", async () => {
    await engine.startDay(P, DAY1);
    db.prepare("UPDATE flags SET status = 'noted', noted_at = ?").run(now);
    for (const t of ["Let's start", "No", "Yes"]) await say(t);
    expect(brief(await say("Good"))).toEqual([
      msg(ME, checkinDone("Harriet"), [SHARING_MENU_BUTTON]),
      msg(FAMILY, familyDailyStatus({ seniorName: "Harriet", sharing: "status", outcome: "checked_in", answers: [], flags: [] })),
    ]);
    expect(getCheckin(db, P, DAY1)).toMatchObject({ status: "answered", step: "done" });
  });
});

describe("Not today", () => {
  it("at the greeting: kind reply, family told, status skipped", async () => {
    await engine.startDay(P, DAY1);
    expect(brief(await say("Not today"))).toEqual([
      msg(ME, notTodayReply("Harriet")),
      msg(FAMILY, familyDailyStatus({ seniorName: "Harriet", sharing: "status", outcome: "not_today", answers: [], flags: [] })),
    ]);
    expect(getCheckin(db, P, DAY1)).toMatchObject({ status: "skipped", step: "done" });
    expect(await say("Let's start")).toEqual([]);
  });

  it("mid-questions keeps the answers so far and offers no flag", async () => {
    await engine.startDay(P, DAY1);
    await say("Let's start");
    await say("No");
    expect(brief(await say("not today"))).toEqual([
      msg(ME, notTodayReply("Harriet")),
      msg(FAMILY, familyDailyStatus({ seniorName: "Harriet", sharing: "status", outcome: "not_today", answers: [], flags: [] })),
    ]);
    const row = getCheckin(db, P, DAY1)!;
    expect(row).toMatchObject({ status: "skipped", step: "done" });
    expect(row.answers).toHaveLength(1);
    expect(flagsByRule().get("R1")?.status).toBe("new");
    expect(db.prepare("SELECT COUNT(*) AS n FROM flags WHERE offered_on IS NOT NULL").get()).toEqual({ n: 0 });
  });
});

describe("red flags", () => {
  async function toBreathingQuestion() {
    now = `${DAY2}T09:00:00.000Z`;
    await engine.startDay(P, DAY2);
    await say("Let's start");
    await say("No"); // ankle swelling
  }
  const breathing = question("hf-breathing-lying-flat");
  const bleeding = question("anticoagulant-bleeding");

  it("at sharing status: advice to her, alert to the family without medical detail, then the next question", async () => {
    await toBreathingQuestion();
    const sent = await say("Yes");
    expect(brief(sent)).toEqual([
      msg(ME, redFlagAdvice("Harriet")),
      msg(FAMILY, familyRedFlagAlert({ seniorName: "Harriet", sharing: "status", questionText: breathing.text, answer: "Yes" })),
      msg(ME, bleeding.text, bleeding.buttons),
    ]);
    expect(sent[1]!.text).not.toContain(breathing.text);
    expect(sent[1]!.text.toLowerCase()).not.toContain("breath");
  });

  it("at sharing all: the family alert carries the detail", async () => {
    setSharing(db, P, "all");
    await toBreathingQuestion();
    const sent = await say("Yes");
    expect(sent[1]).toMatchObject({
      chatId: FAMILY,
      text: familyRedFlagAlert({ seniorName: "Harriet", sharing: "all", questionText: breathing.text, answer: "Yes" }),
    });
    expect(sent[1]!.text).toContain(breathing.text);
  });

  it("two red flags in one check-in alert twice, each once", async () => {
    await toBreathingQuestion();
    await say("Yes");
    await say("Yes"); // bleeding
    const alert = familyRedFlagAlert({ seniorName: "Harriet", sharing: "status", questionText: bleeding.text, answer: "Yes" });
    expect(messenger.inChat(FAMILY).filter((m) => m.text === alert)).toHaveLength(2);
    expect(messenger.inChat(ME).filter((m) => m.text === redFlagAdvice("Harriet"))).toHaveLength(2);
    expect(getCheckin(db, P, DAY2)?.answers.map((a) => a.answer)).toEqual(["No", "Yes", "Yes"]);
  });
});

describe("idempotency and robustness", () => {
  it("startDay twice is idempotent", async () => {
    await engine.startDay(P, DAY1);
    expect(await engine.startDay(P, DAY1)).toEqual({ kind: "already_started" });
    expect(messenger.sent).toHaveLength(1);
    expect(db.prepare("SELECT COUNT(*) AS n FROM record_snapshots").get()).toEqual({ n: 1 });
  });

  it("concurrent startDay calls send one greeting", async () => {
    const results = await Promise.all([engine.startDay(P, DAY1), engine.startDay(P, DAY1)]);
    expect(results.map((r) => r.kind).sort()).toEqual(["already_started", "sent"]);
    expect(messenger.sent).toHaveLength(1);
  });

  it("a replayed inbound message id is handled once", async () => {
    await engine.startDay(P, DAY1);
    const tap = { chatId: ME, messageId: "relay_in_1", text: "Let's start", at: now };
    await engine.handleInbound(tap);
    await engine.handleInbound(tap);
    expect(messenger.sent).toHaveLength(2);
    expect(getCheckin(db, P, DAY1)).toMatchObject({ step: "question", questionIndex: 0 });
  });

  it("unrecognised text while a question is pending gets the buttons again and nothing else", async () => {
    await engine.startDay(P, DAY1);
    await say("Let's start");
    const dizzy = question("dizzy-on-standing");
    expect(brief(await say("what?"))).toEqual([msg(ME, didntUnderstand(dizzy.buttons), dizzy.buttons)]);
    expect(getCheckin(db, P, DAY1)).toMatchObject({ step: "question", questionIndex: 0, answers: [] });
    expect(brief(await say("hello"))).toHaveLength(1); // each unclear message gets its own reply
  });

  it("unrecognised text at the greeting and at the flag offer", async () => {
    await engine.startDay(P, DAY1);
    expect(brief(await say("hmm"))).toEqual([msg(ME, didntUnderstand([BUTTON.start, BUTTON.notToday]), [BUTTON.start, BUTTON.notToday])]);
    for (const t of ["Let's start", "No", "Yes", "Good"]) await say(t);
    expect(brief(await say("maybe"))).toEqual([msg(ME, didntUnderstand([BUTTON.tellMeMore, BUTTON.later]), [BUTTON.tellMeMore, BUTTON.later])]);
  });

  it("free text before any check-in is ignored", async () => {
    expect(await say("hello")).toEqual([]);
  });

  it("messages from an unknown chat are ignored", async () => {
    await engine.startDay(P, DAY1);
    expect(await say("Let's start", "chat_stranger")).toEqual([]);
    expect(getCheckin(db, P, DAY1)?.step).toBe("greeting");
  });

  it("messages in a family chat are ignored", async () => {
    await engine.startDay(P, DAY1);
    expect(await say("Let's start", FAMILY)).toEqual([]);
    expect(await say("Not today", FAMILY)).toEqual([]);
    expect(getCheckin(db, P, DAY1)).toMatchObject({ status: "sent", step: "greeting" });
  });
});

describe("family chats (one per family member)", () => {
  const TOM = "chat_tom";
  const ANN = "chat_ann";
  const statusText = familyDailyStatus({ seniorName: "Harriet", sharing: "status", outcome: "checked_in", answers: [], flags: [] });

  /** Family sends with their idempotency keys, from a spy on the messenger. */
  function familyKeys(spy: { mock: { calls: Parameters<FakeMessenger["send"]>[] } }): [string, string][] {
    return spy.mock.calls.filter(([chatId]) => chatId !== ME).map(([chatId, , key]) => [chatId, key]);
  }

  it("two family members both get the daily status and the red-flag alert, each keyed by handle", async () => {
    syncFamilyMembers(db, P, ["sarah", "tom"]);
    linkFamilyMember(db, "tom", TOM, "Tom", now);
    const send = vi.spyOn(messenger, "send");
    now = `${DAY2}T09:00:00.000Z`;
    await engine.startDay(P, DAY2);
    await say("Let's start");
    await say("No"); // ankle swelling
    const breathing = question("hf-breathing-lying-flat");
    const alert = familyRedFlagAlert({ seniorName: "Harriet", sharing: "status", questionText: breathing.text, answer: "Yes" });
    const sent = await say("Yes"); // red flag
    expect(brief(sent)).toEqual([
      msg(ME, redFlagAdvice("Harriet")),
      msg(FAMILY, alert),
      msg(TOM, alert),
      msg(ME, question("anticoagulant-bleeding").text, question("anticoagulant-bleeding").buttons),
    ]);
    for (const t of ["No", "Later"]) await say(t);
    expect(messenger.inChat(FAMILY).map((m) => m.text)).toEqual([alert, statusText]);
    expect(messenger.inChat(TOM).map((m) => m.text)).toEqual([alert, statusText]);
    expect(familyKeys(send)).toEqual([
      [FAMILY, `${P}:${DAY2}:red-flag:hf-breathing-lying-flat:family:sarah`],
      [TOM, `${P}:${DAY2}:red-flag:hf-breathing-lying-flat:family:tom`],
      [FAMILY, `${P}:${DAY2}:status:family:sarah`],
      [TOM, `${P}:${DAY2}:status:family:tom`],
    ]);
  });

  it("the missed alert goes to each linked family chat once", async () => {
    syncFamilyMembers(db, P, ["sarah", "tom"]);
    linkFamilyMember(db, "tom", TOM, null, now);
    const send = vi.spyOn(messenger, "send");
    await engine.startDay(P, DAY1);
    await engine.runMissedCheckin(P, DAY1);
    await engine.runMissedCheckin(P, DAY1);
    expect(familyKeys(send)).toEqual([
      [FAMILY, `${P}:${DAY1}:missed:family:sarah`],
      [TOM, `${P}:${DAY1}:missed:family:tom`],
    ]);
  });

  it("an unlinked family member is skipped, and gets messages once they link", async () => {
    syncFamilyMembers(db, P, ["sarah", "ann"]); // Ann hasn't messaged the agent yet
    await engine.startDay(P, DAY1);
    await say("Not today");
    expect(messenger.sent.map((m) => m.chatId)).toEqual([ME, ME, FAMILY]);

    // Ann messages the agent; her chat is linked (src/relay/inbox.ts does this from contact.added).
    linkFamilyMember(db, "ann", ANN, "Ann", now);
    now = `${DAY2}T09:00:00.000Z`;
    await engine.startDay(P, DAY2);
    await say("Not today");
    const notToday = familyDailyStatus({ seniorName: "Harriet", sharing: "status", outcome: "not_today", answers: [], flags: [] });
    expect(messenger.inChat(ANN).map((m) => m.text)).toEqual([notToday]);
    expect(messenger.inChat(FAMILY)).toHaveLength(2);
  });

  it("with no family member linked, family sends are skipped and her check-in carries on", async () => {
    db.prepare("UPDATE family_members SET chat_id = NULL").run();
    await engine.startDay(P, DAY1);
    for (const t of ["Let's start", "No", "Yes", "Good"]) await say(t);
    expect(brief(await say("Later"))).toEqual([msg(ME, checkinDone("Harriet"), [SHARING_MENU_BUTTON])]);
    expect(await engine.runMissedCheckin(P, DAY1)).toBe("nothing_to_do");
    expect(messenger.sent.every((m) => m.chatId === ME)).toBe(true);
  });

  it("family chats can't answer a check-in, even a linked member tapping her buttons", async () => {
    syncFamilyMembers(db, P, ["sarah", "tom"]);
    linkFamilyMember(db, "tom", TOM, null, now);
    await engine.startDay(P, DAY1);
    for (const chat of [FAMILY, TOM]) {
      expect(await say("Let's start", chat)).toEqual([]);
      expect(await say("Not today", chat)).toEqual([]);
    }
    expect(getCheckin(db, P, DAY1)).toMatchObject({ status: "sent", step: "greeting", answers: [] });
    expect(await engine.runMissedCheckin(P, DAY1)).toBe("marked_missed");
  });

  it("one family chat refusing a message doesn't hold back the others or her next question", async () => {
    syncFamilyMembers(db, P, ["sarah", "tom"]);
    linkFamilyMember(db, "tom", TOM, null, now);
    const realSend = messenger.send.bind(messenger);
    vi.spyOn(messenger, "send").mockImplementation(async (chatId, message, key) => {
      if (chatId === FAMILY) throw new Error("Sarah blocked the agent");
      return realSend(chatId, message, key);
    });
    now = `${DAY2}T09:00:00.000Z`;
    await engine.startDay(P, DAY2);
    await say("Let's start");
    await say("No");
    await expect(engine.handleInbound({ chatId: ME, messageId: "red_1", text: "Yes", at: now })).rejects.toThrow("Sarah blocked the agent");
    expect(messenger.inChat(TOM)).toHaveLength(1);
    expect(messenger.lastIn(ME)?.text).toBe(question("anticoagulant-bleeding").text);
  });
});

describe("missed check-in", () => {
  it("unanswered at noon: marked missed and the family is told once", async () => {
    await engine.startDay(P, DAY1);
    now = `${DAY1}T12:00:00.000Z`;
    expect(await engine.runMissedCheckin(P, DAY1)).toBe("marked_missed");
    expect(brief(messenger.inChat(FAMILY))).toEqual([msg(FAMILY, familyMissedAlert("Harriet", "12:00"))]);
    expect(getCheckin(db, P, DAY1)?.status).toBe("missed");
    expect(await engine.runMissedCheckin(P, DAY1)).toBe("nothing_to_do");
    expect(messenger.inChat(FAMILY)).toHaveLength(1);
  });

  it("a partly answered check-in is not missed", async () => {
    await engine.startDay(P, DAY1);
    await say("Let's start");
    await say("No");
    expect(await engine.runMissedCheckin(P, DAY1)).toBe("nothing_to_do");
    expect(getCheckin(db, P, DAY1)?.status).toBe("sent");
    expect(messenger.inChat(FAMILY)).toEqual([]);
  });

  it("no check-in that day, or one already finished: nothing to do", async () => {
    expect(await engine.runMissedCheckin(P, DAY1)).toBe("nothing_to_do");
    await engine.startDay(P, DAY1);
    await say("Not today");
    expect(await engine.runMissedCheckin(P, DAY1)).toBe("nothing_to_do");
  });

  it("she can still check in after it was marked missed", async () => {
    await engine.startDay(P, DAY1);
    await engine.runMissedCheckin(P, DAY1);
    for (const t of ["Let's start", "No", "Yes", "Good", "Later"]) await say(t);
    expect(getCheckin(db, P, DAY1)).toMatchObject({ status: "answered", step: "done" });
    expect(messenger.lastIn(FAMILY)?.text).toBe(
      familyDailyStatus({ seniorName: "Harriet", sharing: "status", outcome: "checked_in", answers: [], flags: [] }),
    );
  });
});

describe("record consent ended", () => {
  it("410 from FinchNode: snapshots deleted, she and the family told, no check-in sent", async () => {
    const client = new FinchNodeClient({
      baseUrl: "https://api.finchnode.test/demo/v1",
      fetch: replayFetch(loadRecorded("records/patient-demo-consent-revoked")),
      sleep: async () => {},
    });
    setup((subject) => client.getHealthRecord(subject));
    saveSnapshot(db, { patientId: P, fetchedAt: "2026-08-31T09:00:00Z", raw: { old: true } });

    expect(await engine.startDay(P, DAY1)).toEqual({ kind: "record_consent_ended" });
    expect(latestSnapshot(db, P)).toBeUndefined();
    expect(getCheckin(db, P, DAY1)).toBeUndefined();
    expect(messenger.sent.map((m) => m.chatId)).toEqual([ME, FAMILY]);
    expect(messenger.sent.every((m) => m.buttons === undefined)).toBe(true);
    expect(messenger.sent[0]!.text).toContain("Harriet");
    for (const m of messenger.sent) expect(m.text).not.toMatch(/\u2014/);
  });

  it("other loading errors are not swallowed", async () => {
    setup(async () => {
      throw new Error("network down");
    });
    await expect(engine.startDay(P, DAY1)).rejects.toThrow("network down");
    expect(messenger.sent).toEqual([]);
    expect(getCheckin(db, P, DAY1)).toBeUndefined();
  });
});

describe("FakeMessenger", () => {
  it("dedupes by idempotency key, numbers ids, validates buttons, calls onSend", async () => {
    const seen: string[] = [];
    const fake = new FakeMessenger({ onSend: (m) => seen.push(m.messageId), now: () => "t" });
    const a = await fake.send("c", { text: "hi", buttons: ["A"] }, "k1");
    const again = await fake.send("c", { text: "different" }, "k1");
    const b = await fake.send("d", { text: "yo" }, "k2");
    expect(again).toBe(a);
    expect([a.messageId, b.messageId]).toEqual(["msg_1", "msg_2"]);
    expect(seen).toEqual(["msg_1", "msg_2"]);
    expect(fake.lastIn("c")?.text).toBe("hi");
    expect(fake.lastIn("nobody")).toBeUndefined();
    await expect(fake.send("c", { text: "x", buttons: [] }, "k3")).rejects.toThrow(/1 to 5/);
    await expect(fake.send("c", { text: "x", buttons: ["1", "2", "3", "4", "5", "6"] }, "k4")).rejects.toThrow();
  });
});
