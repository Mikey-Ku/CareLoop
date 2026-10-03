import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  BUTTON,
  checkinDone,
  checkinGreeting,
  familyDailyStatus,
  flagOffer,
  SHARING_BUTTONS,
  SHARING_MENU_BUTTON,
  sharingChangedFamily,
  sharingChangedSenior,
  sharingMenu,
} from "../src/checkin/copy.ts";
import { createCheckinEngine } from "../src/checkin/engine.ts";
import type { CheckinEngine } from "../src/checkin/engine-types.ts";
import { QUESTION_BANK } from "../src/context/questions.ts";
import { getCheckin } from "../src/db/checkins.ts";
import { linkFamilyMember, syncFamilyMembers } from "../src/db/family.ts";
import { getSharing, openDatabase, openFlags, upsertPatient, type Db } from "../src/db/index.ts";
import { loadRxNavCache, loadSnapshot } from "../src/finchnode/fixtures.ts";
import { FakeMessenger } from "../src/relay/fake-messenger.ts";
import type { SentMessage } from "../src/relay/messenger.ts";

const P = "harriet";
const SUBJECT = "patient-demo-polypharmacy";
const ME = "chat_harriet";
const FAMILY = "chat_family";
const DAY1 = "2026-09-01"; // questions: hf-breathing-lying-flat, anticoagulant-bleeding, dizzy-on-standing
const rxnav = loadRxNavCache();
const LEVEL_BUTTONS = [SHARING_BUTTONS.status, SHARING_BUTTONS.status_vitals, SHARING_BUTTONS.all];

const question = (id: string) => QUESTION_BANK.find((q) => q.id === id)!;

let db: Db;
let messenger: FakeMessenger;
let engine: CheckinEngine;
let now: string;
let inbound = 0;

beforeEach(() => {
  db = openDatabase(":memory:");
  upsertPatient(db, { id: P, finchnodePatientId: SUBJECT, preferredName: "Harriet", relayChatId: ME });
  syncFamilyMembers(db, P, ["sarah"]);
  linkFamilyMember(db, "sarah", FAMILY, "Sarah", `${DAY1}T08:00:00.000Z`); // Sarah's own chat with the agent
  now = `${DAY1}T09:00:00.000Z`;
  messenger = new FakeMessenger({ now: () => now });
  engine = createCheckinEngine({ db, messenger, clock: { now: () => now }, loadSnapshot: async (s) => loadSnapshot(s) }, { rxnav });
});

async function say(text: string, chatId = ME, messageId = `in_${++inbound}`): Promise<SentMessage[]> {
  const before = messenger.sent.length;
  await engine.handleInbound({ chatId, messageId, text, at: now });
  return messenger.sent.slice(before);
}

const brief = (messages: SentMessage[]) => messages.map(({ chatId, text, buttons }) => ({ chatId, text, buttons }));
const msg = (chatId: string, text: string, buttons?: string[]) => ({ chatId, text, buttons });

describe("the sharing menu", () => {
  it('"Sharing" with nothing pending shows the menu with the current level and three buttons', async () => {
    expect(brief(await say("Sharing"))).toEqual([msg(ME, sharingMenu("status"), LEVEL_BUTTONS)]);
    expect(brief(await say("  sharing "))).toEqual([msg(ME, sharingMenu("status"), LEVEL_BUTTONS)]); // case-insensitive, trimmed
  });

  it("a tap on a level changes it, tells her, and tells the family it changed (not why)", async () => {
    await say("Sharing");
    const sent = await say(SHARING_BUTTONS.status_vitals);
    expect(brief(sent)).toEqual([
      msg(ME, sharingChangedSenior("status_vitals")),
      msg(FAMILY, sharingChangedFamily("Harriet", "status_vitals")),
    ]);
    expect(getSharing(db, P)).toBe("status_vitals");
    // The menu now shows the new level.
    expect((await say("Sharing"))[0]?.text).toBe(sharingMenu("status_vitals"));
  });

  it("picking the level she already has: she hears it, the family hears nothing", async () => {
    await say("Sharing");
    expect(brief(await say(SHARING_BUTTONS.status))).toEqual([msg(ME, sharingChangedSenior("status"))]);
    expect(messenger.inChat(FAMILY)).toEqual([]);
  });

  it("a family chat cannot open the menu or change the level", async () => {
    syncFamilyMembers(db, P, ["sarah", "tom"]);
    linkFamilyMember(db, "tom", "chat_tom", null, now);
    for (const chat of [FAMILY, "chat_tom"]) {
      expect(await say("Sharing", chat)).toEqual([]);
      expect(await say(SHARING_BUTTONS.all, chat)).toEqual([]);
    }
    expect(await say(SHARING_BUTTONS.all, "chat_stranger")).toEqual([]);
    expect(getSharing(db, P)).toBe("status");
    expect(messenger.sent).toEqual([]);
  });

  it("each linked family member is told in their own chat, keyed by handle", async () => {
    syncFamilyMembers(db, P, ["sarah", "tom", "ann"]); // Ann hasn't messaged the agent: skipped
    linkFamilyMember(db, "tom", "chat_tom", null, now);
    const send = vi.spyOn(messenger, "send");
    await say("Sharing");
    const sent = await say(SHARING_BUTTONS.all, ME, "relay_tap_9");
    const told = sharingChangedFamily("Harriet", "all");
    expect(brief(sent)).toEqual([msg(ME, sharingChangedSenior("all")), msg(FAMILY, told), msg("chat_tom", told)]);
    expect(told).toContain("Harriet changed what you see here");
    expect(send.mock.calls.filter(([chatId]) => chatId !== ME).map(([, , key]) => key)).toEqual([
      `${P}:${DAY1}:sharing-changed:relay_tap_9:family:sarah`,
      `${P}:${DAY1}:sharing-changed:relay_tap_9:family:tom`,
    ]);
  });

  it("a replayed tap is handled once", async () => {
    await say("Sharing");
    await say(SHARING_BUTTONS.all, ME, "relay_tap_1");
    await say(SHARING_BUTTONS.all, ME, "relay_tap_1");
    expect(messenger.inChat(FAMILY)).toHaveLength(1);
  });

  it("the check-in's last message carries a single Sharing button that opens the menu", async () => {
    await engine.startDay(P, DAY1);
    for (const t of ["Let's start", "No", "No", "No"]) await say(t);
    const done = (await say("Later"))[0]!;
    expect(done).toMatchObject({ chatId: ME, text: checkinDone("Harriet"), buttons: [SHARING_MENU_BUTTON] });
    expect(brief(await say(done.buttons![0]!))).toEqual([msg(ME, sharingMenu("status"), LEVEL_BUTTONS)]);
  });
});

describe("sharing in the middle of a check-in", () => {
  it("the menu doesn't break it: after the change the pending question comes again and she carries on", async () => {
    await engine.startDay(P, DAY1);
    await say("Let's start");
    await say("No"); // breathing
    const bleeding = question("anticoagulant-bleeding");
    const dizzy = question("dizzy-on-standing");

    expect(brief(await say("Sharing"))).toEqual([msg(ME, sharingMenu("status"), LEVEL_BUTTONS)]);
    expect(getCheckin(db, P, DAY1)).toMatchObject({ step: "question", questionIndex: 1 });

    expect(brief(await say(SHARING_BUTTONS.all))).toEqual([
      msg(ME, sharingChangedSenior("all")),
      msg(FAMILY, sharingChangedFamily("Harriet", "all")),
      msg(ME, bleeding.text, bleeding.buttons),
    ]);
    expect(brief(await say("No"))).toEqual([msg(ME, dizzy.text, dizzy.buttons)]);
    expect(brief(await say("Sometimes"))).toEqual([msg(ME, flagOffer(), [BUTTON.tellMeMore, BUTTON.later])]);
    const last = await say("Later");

    // The day's family status uses the new level.
    const row = getCheckin(db, P, DAY1)!;
    expect(row.answers.map((a) => a.answer)).toEqual(["No", "No", "Sometimes"]);
    expect(last.at(-1)).toMatchObject({
      chatId: FAMILY,
      text: familyDailyStatus({
        seniorName: "Harriet",
        sharing: "all",
        outcome: "checked_in",
        answers: row.answers.map(({ questionId, questionText, answer }) => ({ questionId, questionText, answer })),
        flags: [],
      }),
    });
  });

  it("at the greeting the greeting comes again; at a flag offer the offer comes again", async () => {
    await engine.startDay(P, DAY1);
    await say("Sharing");
    expect(brief(await say(SHARING_BUTTONS.status)).at(-1)).toEqual(msg(ME, checkinGreeting("Harriet", 3), [BUTTON.start, BUTTON.notToday]));
    for (const t of ["Let's start", "No", "No", "No"]) await say(t);
    await say("Sharing");
    expect(brief(await say(SHARING_BUTTONS.status)).at(-1)).toEqual(msg(ME, flagOffer(), [BUTTON.tellMeMore, BUTTON.later]));
    expect(getCheckin(db, P, DAY1)?.step).toBe("flag_offer");
    // The offer still works.
    expect((await say("Tell me more"))[0]?.buttons).toEqual([BUTTON.willAskDoctor, BUTTON.later]);
    expect(openFlags(db, P).filter((f) => f.status === "told")).toHaveLength(1);
  });

  it("Sharing and its level buttons work as taps on any message, even an old menu, without answering the question", async () => {
    await engine.startDay(P, DAY1);
    await say("Let's start");
    const oldMenu = (await say("Sharing"))[0]!;
    await say("No"); // breathing, answered by typing
    const tapOn = async (text: string, replyTo: string) => {
      const before = messenger.sent.length;
      await engine.handleInbound({ chatId: ME, messageId: `in_${++inbound}`, text, replyTo, at: now });
      return messenger.sent.slice(before);
    };
    const bleeding = question("anticoagulant-bleeding");
    expect(brief(await tapOn(SHARING_BUTTONS.all, oldMenu.messageId)).at(-1)).toEqual(msg(ME, bleeding.text, bleeding.buttons));
    expect(getSharing(db, P)).toBe("all");
    expect((await tapOn(SHARING_MENU_BUTTON, "msg_unknown"))[0]?.text).toBe(sharingMenu("all"));
    expect(getCheckin(db, P, DAY1)).toMatchObject({ step: "question", questionIndex: 1 });
    expect(getCheckin(db, P, DAY1)?.answers).toHaveLength(1);
  });

  it("a menu left open: answering the question instead just carries on", async () => {
    await engine.startDay(P, DAY1);
    await say("Let's start");
    await say("Sharing");
    expect(brief(await say("No"))).toEqual([msg(ME, question("anticoagulant-bleeding").text, question("anticoagulant-bleeding").buttons)]);
    expect(getSharing(db, P)).toBe("status");
  });
});
