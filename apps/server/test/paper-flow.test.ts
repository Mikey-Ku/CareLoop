import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  BUTTON,
  familyDailyStatus,
  flagDetail,
  flagNotedReply,
  flagOffer,
  withTypingHint,
} from "../src/checkin/copy.ts";
import { createCheckinEngine } from "../src/checkin/engine.ts";
import type { CheckinEngine } from "../src/checkin/engine-types.ts";
import { PAPER_CONFIRM_BUTTONS, paperReadback } from "../src/checkin/paper-check.ts";
import { PAPER_LATER_REPLY, PAPER_NO_RECORD_REPLY, PAPER_REJECTED_REPLY } from "../src/checkin/paper-flow.ts";
import { QUESTION_BANK, promptButtons, type Question } from "../src/context/questions.ts";
import { getCheckin } from "../src/db/checkins.ts";
import { linkFamilyMember, syncFamilyMembers } from "../src/db/family.ts";
import {
  latestSnapshot,
  nextFlagToOffer,
  notedFlags,
  openDatabase,
  openFlags,
  setSharing,
  upsertPatient,
  type Db,
  type FlagSummary,
} from "../src/db/index.ts";
import { getPaperScan, latestPaperScan } from "../src/db/paper-scans.ts";
import { ConsentInactiveError } from "../src/finchnode/client.ts";
import { FIXTURES_DIR, loadRxNavCache, loadSnapshot } from "../src/finchnode/fixtures.ts";
import { normalizeHealthRecord } from "../src/finchnode/normalize.ts";
import type { HealthRecord } from "../src/finchnode/types.ts";
import { FakeMessenger } from "../src/relay/fake-messenger.ts";
import type { SentMessage } from "../src/relay/messenger.ts";
import { diffPaper, type ExtractedPaper } from "../src/rules/paper-diff.ts";

const P = "harriet";
const SUBJECT = "patient-demo-polypharmacy";
const ME = "chat_harriet";
const FAMILY = "chat_family";
const DAY1 = "2026-09-01";
const DAY2 = "2026-09-02";
const [YES, NO] = PAPER_CONFIRM_BUTTONS as [string, string];
const rxnav = loadRxNavCache();

const PAPER = JSON.parse(readFileSync(join(FIXTURES_DIR, "papers", "harriet-discharge.extracted.json"), "utf8")) as ExtractedPaper;
/** Only "continue" lines that match her record: R6 checked. */
const MATCHING: ExtractedPaper = { ...PAPER, medications: PAPER.medications.filter((m) => m.change === "continue") };
const R6 = diffPaper(normalizeHealthRecord(loadSnapshot(SUBJECT), { rxnav }), PAPER);

const question = (id: string) => QUESTION_BANK.find((q) => q.id === id)!;

let db: Db;
let messenger: FakeMessenger;
let engine: CheckinEngine;
let now: string;
let inbound = 0;
let loads = 0;

function setup(load: (subject: string) => Promise<HealthRecord> = async (s) => loadSnapshot(s)) {
  db = openDatabase(":memory:");
  upsertPatient(db, { id: P, finchnodePatientId: SUBJECT, preferredName: "Harriet", relayChatId: ME });
  syncFamilyMembers(db, P, ["sarah"]);
  linkFamilyMember(db, "sarah", FAMILY, "Sarah", `${DAY1}T08:00:00.000Z`); // Sarah's own chat with the agent
  now = `${DAY1}T09:00:00.000Z`;
  loads = 0;
  messenger = new FakeMessenger({ now: () => now });
  engine = createCheckinEngine(
    {
      db,
      messenger,
      clock: { now: () => now },
      loadSnapshot: async (s) => {
        loads += 1;
        return load(s);
      },
    },
    { rxnav },
  );
}

beforeEach(() => setup());

async function say(text: string, chatId = ME, messageId = `in_${++inbound}`): Promise<SentMessage[]> {
  const before = messenger.sent.length;
  await engine.handleInbound({ chatId, messageId, text, at: now });
  return messenger.sent.slice(before);
}

const brief = (messages: SentMessage[]) => messages.map(({ chatId, text, buttons }) => ({ chatId, text, buttons }));
const msg = (chatId: string, text: string, buttons?: string[]) => ({ chatId, text, buttons });
const r6Flags = () => openFlags(db, P).filter((f) => f.ruleId === "R6");
const statusOf = (rule: string) => openFlags(db, P).find((f) => f.ruleId === rule)?.status;
const DETAIL = msg(ME, flagDetail(R6.message), [BUTTON.willAskDoctor, BUTTON.later]);

// The check-in's questions are read from its row, so these tests don't depend on which questions a day picks.
const todaysQuestions = (day = DAY1) => getCheckin(db, P, day)!.questionIds.map(question);
const currentQuestion = (day = DAY1) => {
  const row = getCheckin(db, P, day)!;
  return question(row.questionIds[row.questionIndex]!);
};
/** A button that isn't a red-flag answer, so no alert goes out. */
const safeAnswer = (q: { buttons: string[]; redFlagAnswers: string[] }) => q.buttons.find((b) => !q.redFlagAnswers.includes(b))!;
const asked = (q: Pick<Question, "id" | "text" | "buttons">) => msg(ME, withTypingHint(q.text), promptButtons(q));
/** Answer every remaining question safely; returns what the last answer produced. */
async function answerAll(day = DAY1): Promise<SentMessage[]> {
  let last: SentMessage[] = [];
  while (getCheckin(db, P, day)?.step === "question") last = await say(safeAnswer(currentQuestion(day)));
  return last;
}

describe("starting a paper check", () => {
  it("stores the read paper unconfirmed and sends the read-back with the two confirm buttons; no check-in", async () => {
    const { scanId } = await engine.startPaperCheck(P, PAPER, "att_1");
    expect(brief(messenger.sent)).toEqual([msg(ME, paperReadback(PAPER), [YES, NO])]);
    expect(getPaperScan(db, scanId)).toMatchObject({
      patientId: P,
      relayAttachmentId: "att_1",
      paper: PAPER,
      confirmedAt: null,
      outcome: null,
      phase: "awaiting_confirm",
    });
    expect(db.prepare("SELECT COUNT(*) AS n FROM checkins").get()).toEqual({ n: 0 });
    expect(loads).toBe(0);
  });

  it("the same attachment twice is one paper check and one read-back", async () => {
    const a = await engine.startPaperCheck(P, PAPER, "att_1");
    const b = await engine.startPaperCheck(P, PAPER, "att_1");
    expect(b.scanId).toBe(a.scanId);
    expect(messenger.sent).toHaveLength(1);
    expect(db.prepare("SELECT COUNT(*) AS n FROM paper_scans").get()).toEqual({ n: 1 });
  });

  it("unknown patients are refused", async () => {
    await expect(engine.startPaperCheck("nobody", PAPER)).rejects.toThrow(/Unknown patient/);
  });
});

describe('"Yes, that\'s right"', () => {
  it("compares with a fresh snapshot, stores an R6 flag, tells her plainly (so it is told); I'll ask my doctor marks it noted", async () => {
    expect(R6.status).toBe("flag");
    expect(R6.message).toMatch(/aspirin/);
    const { scanId } = await engine.startPaperCheck(P, PAPER);

    expect(brief(await say(YES))).toEqual([DETAIL]);
    expect(loads).toBe(1);
    expect(latestSnapshot(db, P)).toBeDefined();
    const [flag] = r6Flags();
    expect(flag).toMatchObject({ ruleId: "R6", status: "told", message: R6.message, severity: "medium" });
    expect(db.prepare("SELECT told_on, offered_on FROM flags WHERE id = ?").get(Number(flag!.flagId))).toEqual({ told_on: DAY1, offered_on: null });
    const scan = getPaperScan(db, scanId)!;
    expect(scan).toMatchObject({ phase: "confirmed", confirmedAt: now });
    expect(scan.outcome).toMatchObject({ outcome: "flag", flagId: Number(flag!.flagId), followUp: "pending" });
    expect(scan.outcome?.outcome === "flag" && scan.outcome.discrepancies).toEqual([
      expect.objectContaining({ kind: "stopped_but_active", paperName: "aspirin" }),
    ]);
    // Only R6 synced: the record flags are untouched.
    expect(openFlags(db, P).map((f) => f.ruleId)).toEqual(["R6"]);

    now = `${DAY1}T09:05:00.000Z`;
    expect(brief(await say(BUTTON.willAskDoctor))).toEqual([msg(ME, flagNotedReply())]);
    expect(statusOf("R6")).toBe("noted");
    expect(getPaperScan(db, scanId)?.outcome).toMatchObject({ followUp: "noted" });
    // Nothing pending any more: the same buttons do nothing.
    expect(await say(BUTTON.willAskDoctor)).toEqual([]);
    expect(await say(YES)).toEqual([]);
  });

  it("papers that match her list: she hears that, no flag is stored", async () => {
    const { scanId } = await engine.startPaperCheck(P, MATCHING);
    const sent = await say(YES);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.text).toMatch(/match your medication list/);
    expect(sent[0]?.buttons).toBeUndefined();
    expect(r6Flags()).toEqual([]);
    expect(getPaperScan(db, scanId)).toMatchObject({ phase: "confirmed", outcome: { outcome: "checked", flagId: null } });
  });

  it("record consent ended before her Yes: she is pointed to her doctor, nothing compared, snapshots deleted", async () => {
    setup(async () => {
      throw new ConsentInactiveError(410, "consent_inactive", "gone");
    });
    await engine.startPaperCheck(P, PAPER);
    expect(brief(await say(YES))).toEqual([msg(ME, PAPER_NO_RECORD_REPLY)]);
    expect(r6Flags()).toEqual([]);
    expect(latestPaperScan(db, P)?.outcome).toMatchObject({ outcome: "skipped", reason: "record_consent_ended" });
  });

  it("a failed snapshot load leaves the message unhandled, so the retry works", async () => {
    let fail = true;
    setup(async (s) => {
      if (fail) throw new Error("network down");
      return loadSnapshot(s);
    });
    await engine.startPaperCheck(P, PAPER);
    await expect(say(YES, ME, "relay_yes")).rejects.toThrow("network down");
    expect(latestPaperScan(db, P)?.phase).toBe("awaiting_confirm");
    fail = false;
    expect(brief(await say(YES, ME, "relay_yes"))).toEqual([DETAIL]);
  });
});

describe('"No, something\'s off"', () => {
  it("thanks her, points her to her doctor or pharmacist, and stores nothing as confirmed", async () => {
    const { scanId } = await engine.startPaperCheck(P, PAPER);
    expect(brief(await say(NO))).toEqual([msg(ME, PAPER_REJECTED_REPLY)]);
    expect(PAPER_REJECTED_REPLY).toMatch(/doctor or pharmacist/);
    expect(getPaperScan(db, scanId)).toMatchObject({ phase: "rejected", confirmedAt: null, outcome: { outcome: "rejected" } });
    expect(r6Flags()).toEqual([]);
    expect(loads).toBe(0);
    // A late "Yes" compares nothing.
    expect(await say(YES)).toEqual([]);
    expect(loads).toBe(0);
  });
});

describe("R6 in the flag lifecycle", () => {
  it('"Later" leaves it told, like "Later" after a check-in flag\'s detail: never offered again on its own, not on the visit-prep list', async () => {
    await engine.startPaperCheck(P, PAPER);
    await say(YES);
    expect(brief(await say(BUTTON.later))).toEqual([msg(ME, PAPER_LATER_REPLY)]);
    expect(PAPER_LATER_REPLY).not.toMatch(/again/);
    expect(PAPER_LATER_REPLY).toMatch(/doctor or pharmacist/);
    const r6 = r6Flags()[0]!;
    expect(r6.status).toBe("told");
    expect(latestPaperScan(db, P)?.outcome).toMatchObject({ followUp: "later" });
    // Heard today, so the day's check-in offers no other flag.
    expect(nextFlagToOffer(db, P, DAY1)).toBeUndefined();
    expect(notedFlags(db, P)).toEqual([]);

    // Next morning: R1, R3, R4 are synced as new; once she has noted them there is nothing left to offer.
    now = `${DAY2}T09:00:00.000Z`;
    await engine.startDay(P, DAY2);
    expect(openFlags(db, P).map((f) => f.ruleId).sort()).toEqual(["R1", "R3", "R4", "R6"]);
    expect(nextFlagToOffer(db, P, DAY2)?.ruleId).not.toBe("R6");
    db.prepare("UPDATE flags SET status = 'noted', noted_at = ? WHERE rule_id != 'R6'").run(now);
    expect(nextFlagToOffer(db, P, DAY2)).toBeUndefined();
    expect(statusOf("R6")).toBe("told");
    expect(notedFlags(db, P).map((f) => f.ruleId)).not.toContain("R6");
    // The paper's buttons are spent: a late tap doesn't reach the paper check.
    await say(BUTTON.willAskDoctor);
    expect(statusOf("R6")).toBe("told");
  });

  it("no tap at all: heard is told, so it is never offered again on its own", async () => {
    await engine.startPaperCheck(P, PAPER);
    await say(YES);
    now = `${DAY2}T09:00:00.000Z`;
    await engine.startDay(P, DAY2);
    db.prepare("UPDATE flags SET status = 'noted', noted_at = ? WHERE rule_id != 'R6'").run(now);
    expect(nextFlagToOffer(db, P, DAY2)).toBeUndefined();
    // Her "I'll ask my doctor" on the paper's message still works the next day (then the greeting comes again).
    expect(brief(await say(BUTTON.willAskDoctor))[0]).toEqual(msg(ME, flagNotedReply()));
    expect(statusOf("R6")).toBe("noted");
  });

  it('"Later" on a flag stored new before this change still makes it told', async () => {
    await engine.startPaperCheck(P, PAPER);
    await say(YES);
    db.prepare("UPDATE flags SET status = 'new', told_at = NULL, told_on = NULL WHERE rule_id = 'R6'").run();
    await say(BUTTON.later);
    expect(statusOf("R6")).toBe("told");
    expect(db.prepare("SELECT told_on FROM flags WHERE rule_id = 'R6'").get()).toEqual({ told_on: DAY1 });
  });

  it("at sharing all, a noted R6 flag is in the family's daily status", async () => {
    setSharing(db, P, "all");
    await engine.startDay(P, DAY1);
    db.prepare("UPDATE flags SET status = 'noted', noted_at = ?").run(now);
    await engine.startPaperCheck(P, PAPER);
    await say(YES);
    await say(BUTTON.willAskDoctor);
    await say("Let's start");
    const family = (await answerAll()).find((m) => m.chatId === FAMILY)!;
    const flags = openFlags(db, P).map((f: FlagSummary) => ({ message: f.message }));
    expect(flags.map((f) => f.message)).toContain(R6.message);
    const row = getCheckin(db, P, DAY1)!;
    expect(family.text).toBe(
      familyDailyStatus({
        seniorName: "Harriet",
        sharing: "all",
        outcome: "checked_in",
        answers: row.answers.map(({ questionId, questionText, answer }) => ({ questionId, questionText, answer })),
        flags,
      }),
    );
  });

  it("the same paper confirmed twice keeps one open R6 flag", async () => {
    await engine.startPaperCheck(P, PAPER, "att_1");
    await say(YES);
    await say(BUTTON.willAskDoctor);
    await engine.startPaperCheck(P, PAPER, "att_2");
    expect(brief(await say(YES))).toEqual([DETAIL]);
    expect(r6Flags()).toHaveLength(1);
    expect(statusOf("R6")).toBe("noted");
  });
});

describe("paper check alongside the check-in", () => {
  it("the confirm buttons win over a pending question; afterwards the question comes again", async () => {
    await engine.startDay(P, DAY1);
    await say("Let's start");
    await engine.startPaperCheck(P, PAPER);
    const [first, second] = todaysQuestions();

    expect(brief(await say(YES))).toEqual([DETAIL]);
    expect(getCheckin(db, P, DAY1)).toMatchObject({ step: "question", questionIndex: 0, answers: [] });
    expect(brief(await say(BUTTON.willAskDoctor))).toEqual([msg(ME, flagNotedReply()), asked(first!)]);
    expect(brief(await say(safeAnswer(first!)))).toEqual([asked(second!)]);
  });

  it("everything else keeps going to the check-in while a read-back waits", async () => {
    await engine.startDay(P, DAY1);
    await say("Let's start");
    await engine.startPaperCheck(P, PAPER);
    const [first, second] = todaysQuestions();
    expect(brief(await say(safeAnswer(first!)))).toEqual([asked(second!)]);
    expect(latestPaperScan(db, P)?.phase).toBe("awaiting_confirm");
    // "No, something's off" then hands the question back.
    expect(brief(await say(NO))).toEqual([
      msg(ME, PAPER_REJECTED_REPLY),
      asked(second!),
    ]);
  });

  it("an R6 flag heard today means the check-in offers no other flag; the follow-up still works after", async () => {
    await engine.startDay(P, DAY1);
    await engine.startPaperCheck(P, PAPER);
    await say(YES); // R6 told, follow-up pending
    await say("Let's start");
    // The paper check told her a flag today, so the check-in finishes without another flag.
    const end = await answerAll();
    expect(getCheckin(db, P, DAY1)?.step).toBe("done");
    expect(end.some((m) => m.text === flagOffer())).toBe(false);
    // The follow-up still works afterwards.
    expect(brief(await say(BUTTON.willAskDoctor))).toEqual([msg(ME, flagNotedReply())]);
    expect(statusOf("R6")).toBe("noted");
  });

  it("a check-in flag detail keeps its own I'll ask my doctor", async () => {
    await engine.startDay(P, DAY1);
    await say("Let's start");
    await answerAll();
    expect(getCheckin(db, P, DAY1)?.step).toBe("flag_offer");
    await say("Tell me more");
    await engine.startPaperCheck(P, PAPER);
    await say(YES);
    await say(BUTTON.willAskDoctor);
    expect(statusOf("R1")).toBe("noted");
    expect(statusOf("R6")).toBe("told");
    expect(getCheckin(db, P, DAY1)?.step).toBe("done");
    await say(BUTTON.willAskDoctor);
    expect(statusOf("R6")).toBe("noted");
  });

  it("a family chat's taps never reach the paper check", async () => {
    await engine.startPaperCheck(P, PAPER);
    expect(await say(YES, FAMILY)).toEqual([]);
    expect(latestPaperScan(db, P)?.phase).toBe("awaiting_confirm");
  });
});

describe("idempotency", () => {
  it("replayed inbound ids: one comparison, one flag, one reply each", async () => {
    await engine.startPaperCheck(P, PAPER);
    await say(YES, ME, "relay_yes");
    await say(YES, ME, "relay_yes");
    expect(loads).toBe(1);
    expect(r6Flags()).toHaveLength(1);
    await say(BUTTON.willAskDoctor, ME, "relay_noted");
    await say(BUTTON.willAskDoctor, ME, "relay_noted");
    expect(messenger.sent.map((m) => m.text)).toEqual([paperReadback(PAPER), DETAIL.text, flagNotedReply()]);
  });

  it("a replayed No stays a No", async () => {
    await engine.startPaperCheck(P, PAPER);
    await say(NO, ME, "relay_no");
    await say(NO, ME, "relay_no");
    expect(messenger.inChat(ME).filter((m) => m.text === PAPER_REJECTED_REPLY)).toHaveLength(1);
  });
});
