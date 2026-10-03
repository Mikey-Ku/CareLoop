import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { BUTTON, familyDailyStatus, flagDetail, flagNotedReply, flagOffer } from "../src/checkin/copy.ts";
import { createCheckinEngine } from "../src/checkin/engine.ts";
import type { CheckinEngine } from "../src/checkin/engine-types.ts";
import { PAPER_CONFIRM_BUTTONS, paperReadback } from "../src/checkin/paper-check.ts";
import { PAPER_LATER_REPLY, PAPER_NO_RECORD_REPLY, PAPER_REJECTED_REPLY } from "../src/checkin/paper-flow.ts";
import { QUESTION_BANK } from "../src/context/questions.ts";
import { getCheckin } from "../src/db/checkins.ts";
import { linkFamilyMember, syncFamilyMembers } from "../src/db/family.ts";
import { latestSnapshot, openDatabase, openFlags, setSharing, upsertPatient, type Db, type FlagSummary } from "../src/db/index.ts";
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
const DAY1 = "2026-09-01"; // questions: dizzy-on-standing, morning-medicines, mood
const DAY2 = "2026-09-02"; // questions: hf-ankle-swelling, hf-breathing-lying-flat, anticoagulant-bleeding
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
  it("compares with a fresh snapshot, stores an R6 flag as new, tells her plainly; I'll ask my doctor marks it noted", async () => {
    expect(R6.status).toBe("flag");
    expect(R6.message).toMatch(/aspirin/);
    const { scanId } = await engine.startPaperCheck(P, PAPER);

    expect(brief(await say(YES))).toEqual([DETAIL]);
    expect(loads).toBe(1);
    expect(latestSnapshot(db, P)).toBeDefined();
    const [flag] = r6Flags();
    expect(flag).toMatchObject({ ruleId: "R6", status: "new", message: R6.message, severity: "medium" });
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
  it('"Later" keeps it new: it is in openFlags and offered in the next day\'s check-in', async () => {
    await engine.startPaperCheck(P, PAPER);
    await say(YES);
    expect(brief(await say(BUTTON.later))).toEqual([msg(ME, PAPER_LATER_REPLY)]);
    const r6 = r6Flags()[0]!;
    expect(r6.status).toBe("new");
    // Heard today, so the day's check-in offers no other flag.
    expect(db.prepare("SELECT offered_on FROM flags WHERE id = ?").get(Number(r6.flagId))).toEqual({ offered_on: DAY1 });

    // Next morning: R1, R3, R4 are synced as new too; she has already noted them, so R6 is next in line.
    now = `${DAY2}T09:00:00.000Z`;
    await engine.startDay(P, DAY2);
    expect(openFlags(db, P).map((f) => f.ruleId).sort()).toEqual(["R1", "R3", "R4", "R6"]);
    db.prepare("UPDATE flags SET status = 'noted', noted_at = ? WHERE rule_id != 'R6'").run(now);
    for (const t of ["Let's start", "No", "No"]) await say(t);
    expect(brief(await say("No"))).toEqual([msg(ME, flagOffer(), [BUTTON.tellMeMore, BUTTON.later])]);
    expect(getCheckin(db, P, DAY2)?.pendingFlagId).toBe(Number(r6.flagId));
    expect(brief(await say("Tell me more"))).toEqual([DETAIL]);
    await say(BUTTON.willAskDoctor);
    expect(statusOf("R6")).toBe("noted");
  });

  it("at sharing all, a noted R6 flag is in the family's daily status", async () => {
    setSharing(db, P, "all");
    await engine.startDay(P, DAY1);
    db.prepare("UPDATE flags SET status = 'noted', noted_at = ?").run(now);
    await engine.startPaperCheck(P, PAPER);
    await say(YES);
    await say(BUTTON.willAskDoctor);
    for (const t of ["Let's start", "No", "Yes"]) await say(t);
    const family = (await say("Good")).find((m) => m.chatId === FAMILY)!;
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
    const dizzy = question("dizzy-on-standing");
    const meds = question("morning-medicines");

    expect(brief(await say(YES))).toEqual([DETAIL]);
    expect(getCheckin(db, P, DAY1)).toMatchObject({ step: "question", questionIndex: 0, answers: [] });
    expect(brief(await say(BUTTON.willAskDoctor))).toEqual([msg(ME, flagNotedReply()), msg(ME, dizzy.text, dizzy.buttons)]);
    expect(brief(await say("No"))).toEqual([msg(ME, meds.text, meds.buttons)]);
  });

  it("everything else keeps going to the check-in while a read-back waits", async () => {
    await engine.startDay(P, DAY1);
    await say("Let's start");
    await engine.startPaperCheck(P, PAPER);
    expect(brief(await say("No"))).toEqual([msg(ME, question("morning-medicines").text, question("morning-medicines").buttons)]);
    expect(latestPaperScan(db, P)?.phase).toBe("awaiting_confirm");
    // "No, something's off" then hands the question back.
    expect(brief(await say(NO))).toEqual([
      msg(ME, PAPER_REJECTED_REPLY),
      msg(ME, question("morning-medicines").text, question("morning-medicines").buttons),
    ]);
  });

  it("an R6 flag heard today means the check-in offers no other flag; the follow-up still works after", async () => {
    await engine.startDay(P, DAY1);
    await engine.startPaperCheck(P, PAPER);
    await say(YES); // R6 told, follow-up pending
    for (const t of ["Let's start", "No", "Yes"]) await say(t);
    // The paper check marked today as offered, so the check-in finishes without another flag.
    const end = await say("Good");
    expect(getCheckin(db, P, DAY1)?.step).toBe("done");
    expect(end.some((m) => m.text === flagOffer())).toBe(false);
    // The follow-up still works afterwards.
    expect(brief(await say(BUTTON.willAskDoctor))).toEqual([msg(ME, flagNotedReply())]);
    expect(statusOf("R6")).toBe("noted");
  });

  it("a check-in flag detail keeps its own I'll ask my doctor", async () => {
    await engine.startDay(P, DAY1);
    for (const t of ["Let's start", "No", "Yes", "Good", "Tell me more"]) await say(t);
    await engine.startPaperCheck(P, PAPER);
    await say(YES);
    await say(BUTTON.willAskDoctor);
    expect(statusOf("R1")).toBe("noted");
    expect(statusOf("R6")).toBe("new");
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
