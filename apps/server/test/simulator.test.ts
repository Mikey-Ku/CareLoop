import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  checkinDone,
  checkinDoneAfterConcern,
  checkinGreeting,
  crisisReply,
  familyCrisisAlert,
  familyDailyStatus,
  familyRedFlagAlert,
  flagOffer,
  followUpReply,
  keepAnEye,
  keepAnEyeReply,
  noteSaved,
  notedForDoctor,
  openReplyThanks,
  openReplyUnavailable,
  redFlagAdvice,
  symptomNotedReply,
  TYPING_HINT,
  withLead,
  withTypingHint,
} from "../src/checkin/copy.ts";
import { painter, renderMessage, renderTable, useColor } from "../src/cli/sim-render.ts";
import { SimClock, nextDay, parseScript, runSimulation } from "../src/cli/simulator.ts";
import { loadConfig } from "../src/config.ts";
import { QUESTION_BANK } from "../src/context/questions.ts";
import { REPO_ROOT } from "../src/finchnode/fixtures.ts";
import { FakeLlmClient } from "../src/llm/fake.ts";

const SERVER_DIR = join(REPO_ROOT, "apps", "server");
const DEMO_DIR = join(REPO_ROOT, "scripts", "demo");
const BREATHING_TEXT = QUESTION_BANK.find((q) => q.id === "hf-breathing-lying-flat")!.text;

type Bubble = { chat: string; text: string; buttons: string[] };

async function simulate(script: string, extra: { day?: string; sharing?: "status" | "status_vitals" | "all"; family?: string[] } = {}) {
  const lines: string[] = [];
  const exitCode = await runSimulation({
    dbPath: ":memory:",
    inputs: parseScript(readFileSync(join(DEMO_DIR, script), "utf8")),
    output: (line) => lines.push(line),
    config: loadConfig({}),
    ...extra,
  });
  return { exitCode, lines, bubbles: bubbles(lines) };
}

/** Rendered messages back as { chat, text, buttons }: a "--- Chat, HH:MM ---" header, then text and "[n]" button lines. */
function bubbles(lines: string[]): Bubble[] {
  const out: Bubble[] = [];
  let current: Bubble | undefined;
  for (const line of lines) {
    const header = /^--- (.+), \d\d:\d\d ---$/.exec(line);
    if (header) {
      current = { chat: header[1]!, text: "", buttons: [] };
      out.push(current);
      continue;
    }
    if (!current) continue;
    if (line.startsWith("[sim]") || /^Harriet> /.test(line) || line.startsWith("   (taps") || line.startsWith("=====")) {
      current = undefined;
      continue;
    }
    const button = /^ {3}\[\d+\] (.+)$/.exec(line);
    if (button) current.buttons.push(button[1]!);
    else current.text = current.text ? `${current.text}\n${line}` : line;
  }
  // A message can hold blank lines; the blank line before the next header isn't part of it.
  for (const b of out) b.text = b.text.trim();
  return out;
}

/** Each matcher must match a later bubble than the one before it. */
function expectInOrder(list: Bubble[], matchers: { chat: string; text: RegExp }[]): void {
  let from = 0;
  for (const m of matchers) {
    const index = list.findIndex((b, i) => i >= from && b.chat === m.chat && m.text.test(b.text));
    expect(index, `no "${m.chat}" message matching ${m.text} after message ${from}:\n${list.map((b) => `${b.chat}: ${b.text}`).join("\n")}`).toBeGreaterThanOrEqual(0);
    from = index + 1;
  }
}

const PHONE = "Harriet's phone";
/** Sarah, the default family member, in her own chat with the agent. */
const FAMILY = "Sarah's phone (family)";
const TOM = "Tom's phone (family)";

describe("demo scripts", () => {
  it("harriet-day1: greeting, both red-flag questions and one more, a flag she'll ask her doctor about, family status", async () => {
    const { exitCode, lines, bubbles } = await simulate("harriet-day1.txt");
    expect(exitCode).toBe(0);
    expect(lines[0]).toMatch(/Harriet \(patient-demo-polypharmacy\)/);
    expect(lines.slice(0, 3).join("\n")).toMatch(/2026-09-01/);
    expect(lines.slice(0, 3).join("\n")).toMatch(/[Ss]ynthetic/);
    expect(lines).toContain("[sim] Check-in for 2026-09-01 sent with 3 questions: hf-breathing-lying-flat, anticoagulant-bleeding, dizzy-on-standing.");
    expectInOrder(bubbles, [
      { chat: PHONE, text: /Good morning, Harriet/ },
      { chat: PHONE, text: /breathing last night/ },
      { chat: PHONE, text: /bruising or bleeding/ },
      { chat: PHONE, text: /dizzy/ },
      { chat: PHONE, text: /worth asking your doctor/ },
      { chat: PHONE, text: /eGFR/ },
      { chat: FAMILY, text: /Harriet checked in/ },
    ]);
    expect(bubbles.find((b) => /Good morning/.test(b.text))?.buttons).toEqual(["Quick questions", "Not today"]);
    // Her open reply answered nothing: thanks, then every question with buttons (silence is never "No").
    expect(lines).toContain("[sim] Her next open reply is read as answering nothing (a stand-in for the LLM).");
    expect(bubbles[1]).toEqual({ chat: PHONE, text: withLead(openReplyThanks("Harriet"), withTypingHint(BREATHING_TEXT)), buttons: ["Fine", "A little hard", "Yes, it was hard", "Let me explain"] });
    // /flags at the end: R1 noted, the others still new.
    expect(lines.find((l) => /^\d+\s+R1\s/.test(l))).toMatch(/noted/);
    expect(lines.find((l) => /^\d+\s+R3\s/.test(l))).toMatch(/new/);
    // Status sharing: the family sees no medical detail.
    expect(bubbles.filter((b) => b.chat === FAMILY).map((b) => b.text).join("\n")).not.toMatch(/eGFR|metformin/);
  });

  // The wording of the alert and the status belongs to src/checkin/copy.ts; these compare with it.
  const alertAt = (sharing: "status" | "all") =>
    familyRedFlagAlert({ seniorName: "Harriet", sharing, questionText: BREATHING_TEXT, answer: "Yes, it was hard" });
  const checkedIn = familyDailyStatus({ seniorName: "Harriet", sharing: "status", outcome: "checked_in", answers: [], flags: [] });

  it("harriet-red-flag (her first check-in, no --day): calm advice, alert to the family, the check-in goes on, no flag offer, a follow-up", async () => {
    const { exitCode, lines, bubbles } = await simulate("harriet-red-flag.txt");
    expect(exitCode).toBe(0);
    expect(lines.slice(0, 3).join("\n")).toMatch(/2026-09-01/);
    expectInOrder(bubbles, [
      { chat: PHONE, text: /Good morning, Harriet/ },
      { chat: PHONE, text: /breathing last night/ },
      { chat: PHONE, text: /^Thank you for telling me, Harriet\. I've let Sarah know\..*if it gets much worse, call 911\. When you're ready, I have 2 more questions/i },
      { chat: FAMILY, text: /^Harriet reported/ },
      { chat: PHONE, text: /bruising or bleeding/ },
      { chat: PHONE, text: /dizzy/ },
      { chat: PHONE, text: /^Thank you, Harriet\. I'll check on you again this afternoon\.$/ },
      { chat: FAMILY, text: /Harriet checked in/ },
      { chat: PHONE, text: /^Checking in again, Harriet\. How is your breathing now\?$/ },
      { chat: PHONE, text: /^I'm glad to hear that, Harriet/ },
    ]);
    // One worry at a time: no flag offer on a red-flag day.
    expect(bubbles.some((b) => /worth asking your doctor/.test(b.text))).toBe(false);
    expect(lines.some((l) => /^\[sim\] Follow-up check-in scheduled for 12:02 \(hf-breathing-lying-flat\)\. Type \/later/.test(l))).toBe(true);
    expect(lines).toContain("[sim] Later, 12:02: 1 follow-up check-in sent.");
    expect(bubbles.find((b) => /How is your breathing now/.test(b.text))?.buttons).toEqual(["Better", "About the same", "Worse"]);
    // At sharing "status" the alert carries no medical detail.
    const alert = bubbles.find((b) => b.chat === FAMILY && /^Harriet reported/.test(b.text));
    expect(alert?.text).toBe(alertAt("status"));
    expect(alert?.text).not.toMatch(/breathing/);
  });

  it("harriet-red-flag-typed (the live conversation, at all): detail noted, her typed Yes counted, calm advice, no flag offer, a follow-up", async () => {
    const { exitCode, lines, bubbles } = await simulate("harriet-red-flag-typed.txt", { sharing: "all" });
    expect(exitCode).toBe(0);
    const words = "Yes but it was weirder I don't know how to explainit";
    expectInOrder(bubbles, [
      { chat: PHONE, text: /breathing last night/ },
      { chat: PHONE, text: new RegExp(`^${noteSaved("Harriet").replace(/[.?]/g, "\\$&")}$`) },
      { chat: PHONE, text: /^Thank you for telling me, Harriet\. I've let Sarah know\./ },
      { chat: FAMILY, text: /^Harriet reported/ },
      { chat: PHONE, text: /bruising or bleeding/ },
      { chat: PHONE, text: /dizzy/ },
      { chat: PHONE, text: /^Thank you, Harriet\. I'll check on you again this afternoon\.$/ },
      { chat: FAMILY, text: /Harriet also wrote \(kept for the doctor\):/ },
      { chat: PHONE, text: /How is your breathing now\?/ },
      { chat: PHONE, text: /^Thank you for letting me know, Harriet/ },
    ]);
    // Detail never re-sends the same confirm; the buttons come back with the note.
    expect(bubbles.some((b) => /^You wrote:/.test(b.text))).toBe(false);
    expect(bubbles.find((b) => b.text === noteSaved("Harriet"))?.buttons).toEqual(["Fine", "A little hard", "Yes, it was hard", "Let me explain"]);
    expect(bubbles.find((b) => b.chat === PHONE && /I've let Sarah know/.test(b.text))?.text).toBe(redFlagAdvice("Harriet", ["Sarah"], 2));
    const alert = bubbles.find((b) => b.chat === FAMILY && /^Harriet reported/.test(b.text));
    expect(alert?.text).toBe(familyRedFlagAlert({ seniorName: "Harriet", sharing: "all", questionText: BREATHING_TEXT, answer: "Yes, it was hard", words }));
    // About the same on the follow-up is level 2: keep an eye on it, no 911.
    const lastToHer = bubbles.filter((b) => b.chat === PHONE).at(-1)?.text;
    expect(lastToHer).toBe(followUpReply("Harriet", "same", "breathing"));
    expect(lastToHer).not.toMatch(/911/);
    const status = bubbles.find((b) => b.chat === FAMILY && /checked in today/.test(b.text))?.text ?? "";
    expect(status).toContain('"Not really but I have more info"');
    expect(status).toContain(`"${words}"`);
    expect(bubbles.some((b) => /worth asking your doctor/.test(b.text))).toBe(false);
    expect(lines.filter((l) => /^\[sim\] Her next typed message is read as more_detail/.test(l))).toHaveLength(2);
  });

  it("harriet-crisis: the screen catches it without an LLM, Sarah is alerted with no detail, the check-in pauses, then carries on", async () => {
    const { exitCode, lines, bubbles } = await simulate("harriet-crisis.txt");
    expect(exitCode).toBe(0);
    expectInOrder(bubbles, [
      { chat: PHONE, text: /breathing last night/ },
      { chat: PHONE, text: /988/ },
      { chat: FAMILY, text: /very hard time/ },
      { chat: PHONE, text: /How are you feeling now\?/ },
      { chat: PHONE, text: /988 any time/ },
      { chat: PHONE, text: /breathing last night/ },
      { chat: PHONE, text: /bruising or bleeding/ },
      { chat: PHONE, text: /dizzy/ },
      { chat: PHONE, text: /^That's everything for today, Harriet\./ },
      { chat: FAMILY, text: /Harriet checked in/ },
    ]);
    const crisisAt = bubbles.findIndex((b) => b.text === crisisReply("Harriet", ["Sarah"]));
    expect(crisisAt).toBeGreaterThan(0);
    // Nothing else is asked in the same reply: Sarah's alert comes next, then the follow-up.
    expect(bubbles[crisisAt + 1]).toEqual({ chat: FAMILY, text: familyCrisisAlert({ seniorName: "Harriet", sharing: "status" }), buttons: [] });
    expect(bubbles[crisisAt + 2]?.text).toMatch(/^Checking in again/);
    expect(bubbles.filter((b) => b.chat === FAMILY).map((b) => b.text).join("\n")).not.toMatch(/end my life|988/);
    expect(lines.some((l) => /Free text off/.test(l))).toBe(true);
    expect(lines.some((l) => /Follow-up check-in scheduled for \d\d:\d\d \(crisis\)/.test(l))).toBe(true);
    // The follow-up already came, so the closing doesn't promise another.
    expect(bubbles.some((b) => b.text === checkinDoneAfterConcern("Harriet"))).toBe(false);
  });

  it("harriet-red-flag at sharing all: the family alert says what she answered", async () => {
    const { bubbles } = await simulate("harriet-red-flag.txt", { sharing: "all" });
    const alert = bubbles.find((b) => b.chat === FAMILY && /^Harriet reported/.test(b.text));
    expect(alert?.text).toBe(alertAt("all"));
    expect(alert?.text).toMatch(/breathing/);
  });

  it("harriet-red-flag with two family members: each gets the alert and the status in their own chat", async () => {
    const { exitCode, lines, bubbles } = await simulate("harriet-red-flag.txt", { family: ["sarah", "tom"] });
    expect(exitCode).toBe(0);
    expect(lines.some((l) => l.includes("[sim] Family, each in their own chat with the agent (pre-linked here): Sarah's phone (family) @sarah, Tom's phone (family) @tom."))).toBe(true);
    for (const chat of [FAMILY, TOM]) expect(bubbles.filter((b) => b.chat === chat).map((b) => b.text)).toEqual([alertAt("status"), checkedIn]);
    expectInOrder(bubbles, [
      { chat: PHONE, text: /911/ },
      { chat: FAMILY, text: /^Harriet reported/ },
      { chat: TOM, text: /^Harriet reported/ },
      { chat: PHONE, text: /bruising or bleeding/ },
    ]);
  });

  it("--family with no one: family messages go nowhere and the check-in still runs", async () => {
    const { exitCode, lines, bubbles } = await simulate("harriet-not-today.txt", { family: [] });
    expect(exitCode).toBe(0);
    expect(lines.some((l) => /\[sim\] No family members/.test(l))).toBe(true);
    expect(bubbles.every((b) => b.chat === PHONE)).toBe(true);
  });

  it("harriet-not-today: kind reply, family told, noon job does nothing", async () => {
    const { exitCode, lines, bubbles } = await simulate("harriet-not-today.txt");
    expect(exitCode).toBe(0);
    expectInOrder(bubbles, [
      { chat: PHONE, text: /Good morning, Harriet/ },
      { chat: PHONE, text: /Harriet/ },
      { chat: FAMILY, text: /not today/i },
    ]);
    expect(bubbles.some((b) => b.chat === FAMILY && /hasn't/.test(b.text))).toBe(false);
    expect(lines.some((l) => /\[sim\] Noon: nothing to do/.test(l))).toBe(true);
  });

  it("harriet-two-days: day 2 rests the red-flag questions; her one message answers the rest, and the next flag is offered", async () => {
    const { exitCode, lines, bubbles } = await simulate("harriet-two-days.txt");
    expect(exitCode).toBe(0);
    expectInOrder(bubbles, [
      { chat: PHONE, text: /breathing last night/ },
      { chat: PHONE, text: /eGFR/ },
      { chat: FAMILY, text: /Harriet checked in/ },
      { chat: PHONE, text: /Good morning, Harriet/ },
      // straight after her one message, with what was understood said back first
      { chat: PHONE, text: /^Got it: ankles feeling fine, medicines taken and feeling good\.\n\nThere's one thing in your health record/ },
      { chat: PHONE, text: /aspirin/ },
      { chat: FAMILY, text: /Harriet checked in/ },
    ]);
    // Day 2 asks no question: her open reply covered all three. Only day 1's three questions were sent.
    expect(bubbles.filter((b) => b.chat === PHONE && b.text.includes(TYPING_HINT))).toHaveLength(3);
    expect(bubbles.some((b) => /swollen|morning medicines/.test(b.text))).toBe(false);
    expect(lines).toContain('[sim] Her next open reply is read as answering hf-ankle-swelling "No", morning-medicines "Yes", mood "Good" (a stand-in for the LLM).');
    expect(lines).toContain("===== 2026-09-02 =====");
    expect(lines).toContain("[sim] Check-in for 2026-09-02 sent with 3 questions: hf-ankle-swelling, morning-medicines, mood.");
    expect(bubbles.filter((b) => /breathing last night|bruising or bleeding/.test(b.text))).toHaveLength(2); // day 1 only
    expect(bubbles.filter((b) => /eGFR/.test(b.text))).toHaveLength(1);
    expect(lines.find((l) => /^\d+\s+R1\s/.test(l))).toMatch(/noted/);
    expect(lines.find((l) => /^\d+\s+R3\s/.test(l))).toMatch(/noted/);
  });

  it("harriet-paper: read-back through the engine, R6 stored as a flag, then noted", async () => {
    const { exitCode, lines, bubbles } = await simulate("harriet-paper.txt");
    expect(exitCode).toBe(0);
    const readback = bubbles.find((b) => /Here's what I read/.test(b.text));
    expect(readback?.chat).toBe(PHONE);
    expect(readback?.buttons).toEqual(["Yes, that's right", "No, something's off"]);
    expectInOrder(bubbles, [
      { chat: PHONE, text: /Here's what I read/ },
      { chat: PHONE, text: /aspirin.*(active|medication list)/s },
      { chat: PHONE, text: /added it to your list/ },
    ]);
    expect(bubbles.find((b) => /aspirin.*active/s.test(b.text))?.buttons).toEqual(["I'll ask my doctor", "Later"]);
    expect(lines.some((l) => /\[sim\] R6 flag/.test(l))).toBe(true);
    // /flags at the end: R6 noted, the record flags untouched.
    expect(lines.find((l) => /^\d+\s+R6\s/.test(l))).toMatch(/noted/);
    expect(lines.find((l) => /^\d+\s+R1\s/.test(l))).toMatch(/new/);
    // A paper check is not a check-in: the family heard only her "not today".
    expect(bubbles.filter((b) => b.chat === FAMILY)).toHaveLength(1);
  });

  it("harriet-open: one message answers ankles and dizziness, one noted line, only breathing is asked, then a calm finish", async () => {
    const { exitCode, lines, bubbles } = await simulate("harriet-open.txt");
    expect(exitCode).toBe(0);
    expect(lines).toContain("[sim] Check-in for 2026-09-02 sent with 3 questions: hf-ankle-swelling, hf-breathing-lying-flat, dizzy-on-standing.");
    const day2 = bubbles.slice(bubbles.findLastIndex((b) => b.chat === PHONE && /^Good morning, Harriet/.test(b.text)));
    expect(day2).toEqual([
      { chat: PHONE, text: checkinGreeting("Harriet", 3), buttons: ["Quick questions", "Not today"] },
      {
        chat: PHONE,
        text: withLead(
          "Got it: ankles a little swollen and a little dizzy at times. I've noted the ankles and the dizziness for your doctor.",
          withTypingHint(BREATHING_TEXT),
        ),
        buttons: ["Fine", "A little hard", "Yes, it was hard", "Let me explain"],
      },
      { chat: PHONE, text: flagOffer(), buttons: ["Tell me more", "Later"] },
      { chat: PHONE, text: checkinDone("Harriet"), buttons: ["Sharing"] },
      { chat: FAMILY, text: checkedIn, buttons: [] },
    ]);
    expect(lines).toContain(
      '[sim] Her next open reply is read as answering hf-ankle-swelling "A little", dizzy-on-standing "Sometimes", mentioning hf-ankle-swelling (a little, same), dizzy-on-standing (a little, same) (a stand-in for the LLM).',
    );
  });

  it("harriet-ladder: levels 0, 1, 2 and 3 in one day, each with its own reaction; 911 only at 3", async () => {
    const { exitCode, lines, bubbles } = await simulate("harriet-ladder.txt", { sharing: "all" });
    expect(exitCode).toBe(0);
    const bleeding = QUESTION_BANK.find((q) => q.id === "anticoagulant-bleeding")!.text;
    const dizzy = QUESTION_BANK.find((q) => q.id === "dizzy-on-standing")!.text;
    const phone = bubbles.filter((b) => b.chat === PHONE).map((b) => b.text);
    // 0: Fine on breathing, straight to the next question.
    expect(phone).toContain(withTypingHint(bleeding));
    // 2: A little bruising, folded into the next question; a follow-up; no alert.
    expect(phone).toContain(withLead(keepAnEye("Harriet"), withTypingHint(dizzy)));
    expect(lines.some((l) => /Follow-up check-in scheduled for 12:03 \(anticoagulant-bleeding\)/.test(l))).toBe(true);
    // 1: Sometimes on dizziness, folded into the flag offer (still offered on a level-2 day).
    expect(phone).toContain(withLead(notedForDoctor(), flagOffer()));
    expect(phone).toContain(checkinDoneAfterConcern("Harriet"));
    // Her knee, in chat: level 1.
    expect(phone).toContain(symptomNotedReply("Harriet", ["knee pain"]));
    // 3: Worse on the follow-up.
    expectInOrder(bubbles, [
      { chat: FAMILY, text: /Harriet mentioned some bruising or bleeding \(we're keeping an eye on it\)\./ },
      { chat: PHONE, text: /How is the bruising or bleeding now\?/ },
      { chat: PHONE, text: /^Thank you for telling me, Harriet\. I've let Sarah know\. Please call your doctor today about this\. If it gets much worse, call 911\.$/ },
      { chat: FAMILY, text: /feels worse than earlier today/ },
    ]);
    // 911 appears once in her chat, at level 3; Sarah got no alert before it.
    expect(phone.filter((t) => /911/.test(t))).toHaveLength(1);
    expect(bubbles.filter((b) => b.chat === FAMILY).map((b) => b.text)).toHaveLength(2);
  });

  it("harriet-sharing: menu mid check-in, the question comes back, family told, status at all, then back to status", async () => {
    const { exitCode, lines, bubbles } = await simulate("harriet-sharing.txt");
    expect(exitCode).toBe(0);
    expectInOrder(bubbles, [
      { chat: PHONE, text: /bruising or bleeding/ },
      { chat: PHONE, text: /You decide how much your family sees/ },
      { chat: PHONE, text: /^Done\. Your family now sees/ },
      { chat: FAMILY, text: /^Harriet changed what you see here\./ },
      { chat: PHONE, text: /bruising or bleeding/ },
      { chat: PHONE, text: /dizzy/ },
      { chat: PHONE, text: /That's everything for today/ },
      { chat: FAMILY, text: /Harriet's answers:/ },
      { chat: PHONE, text: /You decide how much your family sees/ },
      { chat: FAMILY, text: /From now on: whether Harriet checked in each day/ },
    ]);
    expect(bubbles.find((b) => /You decide/.test(b.text))?.buttons).toEqual(["Just check-ins", "Check-ins and heart rate", "Everything"]);
    expect(bubbles.find((b) => /That's everything for today/.test(b.text))?.buttons).toEqual(["Sharing"]);
    // The family is told it changed, never why.
    for (const b of bubbles.filter((x) => x.chat === FAMILY && /changed what you see here/.test(x.text))) expect(b.text).not.toMatch(/because|why/i);
    expect(lines.filter((l) => /\[sim\] Sharing level set to/.test(l))).toEqual(["[sim] Sharing level set to all.", "[sim] Sharing level set to status."]);
  });
});

describe("simulator inputs", () => {
  const run = async (inputs: string[]) => {
    const lines: string[] = [];
    const exitCode = await runSimulation({ dbPath: ":memory:", inputs, output: (l) => lines.push(l), config: loadConfig({}) });
    return { exitCode, lines, bubbles: bubbles(lines) };
  };

  it("free text goes to the engine as her message (at the greeting with no LLM: the honest line, then the questions)", async () => {
    const { exitCode, bubbles } = await run(["hello there"]);
    expect(exitCode).toBe(0);
    expect(bubbles.at(-1)).toEqual({
      chat: PHONE,
      text: withLead(openReplyUnavailable("Harriet"), withTypingHint(BREATHING_TEXT)),
      buttons: ["Fine", "A little hard", "Yes, it was hard", "Let me explain"],
    });
  });

  it("without --llm the banner says free text is off", async () => {
    const { lines } = await run([]);
    expect(lines.some((l) => /^\[sim\] Free text off: buttons only/.test(l))).toBe(true);
  });

  it("with an LLM: the reading label shows, a typed answer is mapped, a red-flag answer is quoted back for a tap", async () => {
    const llm = new FakeLlmClient({
      classifyMessage: ({ pending }) => ({
        kind: "answer",
        answer: pending?.options.includes("Sometimes") ? "Sometimes" : "No",
        confidence: "high",
        complaints: [],
        memories: [],
      }),
    });
    const lines: string[] = [];
    const inputs = ["1", "nah fine, had to prop myself up on pillows", "1", "1", "only when I get up too fast"];
    const exitCode = await runSimulation({ dbPath: ":memory:", inputs, output: (l) => lines.push(l), config: loadConfig({}), llm });
    expect(exitCode).toBe(0);
    expect(lines.some((l) => /^\[sim\] Free text on: what she types is read by fake/.test(l))).toBe(true);
    const list = bubbles(lines);
    expectInOrder(list, [
      { chat: PHONE, text: /breathing last night/ },
      { chat: PHONE, text: /^You wrote: "nah fine, had to prop myself up on pillows"\nJust to check: How was your breathing last night/ },
      { chat: PHONE, text: /bruising or bleeding/ },
      { chat: PHONE, text: /dizzy when standing/ },
      { chat: PHONE, text: /worth asking your doctor/ },
    ]);
    expect(list.find((b) => /^You wrote/.test(b.text))?.buttons).toEqual(["Fine", "A little hard", "Yes, it was hard", "Let me explain"]);
    expect(lines).toContain(`[sim] Harriet's phone shows "Reading your message".`);
    expect(llm.classifyCalls.map((c) => c.message)).toEqual(["nah fine, had to prop myself up on pillows", "only when I get up too fast"]);
  });

  it("/as stands in for the LLM on the next typed message only; a bad kind is an error", async () => {
    const { exitCode, lines, bubbles } = await run(["1", "/as answer Fine", "nah I slept fine", "/as medicine_question", "should I stop the aspirin?", "/as nonsense"]);
    expect(exitCode).toBe(1);
    expectInOrder(bubbles, [
      { chat: PHONE, text: /breathing last night/ },
      // On a red-flag question even the stand-in's "Fine" goes back to her for one tap.
      { chat: PHONE, text: /^You wrote: "nah I slept fine"/ },
      { chat: PHONE, text: /good question for your doctor or pharmacist/ },
      { chat: PHONE, text: /breathing last night/ },
    ]);
    expect(lines.some((l) => /usage: \/as </.test(l))).toBe(true);
  });

  it("/as takes symptoms after |: topic, amount, change; a bad amount or change is an error", async () => {
    const inputs = ["2", "/as chat | knee pain, a_lot, same", "my knee really hurts", "/as chat | knee, lots", "/as chat | knee, a_little, sideways"];
    const { exitCode, lines, bubbles } = await run(inputs);
    expect(exitCode).toBe(1);
    expect(lines).toContain("[sim] Her next typed message is read as chat, mentioning knee pain (a lot, same) (a stand-in for the LLM).");
    // After "Not today", "My knee really hurts" (a lot) in chat: level 2, keep an eye on it, a follow-up; no 911.
    expect(bubbles.at(-1)).toEqual({ chat: PHONE, text: keepAnEyeReply("Harriet"), buttons: [] });
    expect(lines.some((l) => /Follow-up check-in scheduled for \d\d:\d\d \(knee pain\)/.test(l))).toBe(true);
    expect(lines.filter((l) => /usage: \/as </.test(l))).toHaveLength(2);
  });

  it("/as extract reads her open reply; an answer that isn't one of the question's buttons is an error", async () => {
    const inputs = ["/as extract mood=Not great; morning-medicines=yes", "feeling low, took my pills", "/as extract mood=Maybe", "/as extract nope=No"];
    const { exitCode, lines, bubbles } = await run(inputs);
    expect(exitCode).toBe(1);
    expect(lines).toContain('[sim] Her next open reply is read as answering mood "Not great", morning-medicines "Yes" (a stand-in for the LLM).');
    // Day 1 asks breathing, bleeding and dizziness, so neither answer is one of today's: thanks, then the questions.
    expect(bubbles.at(-1)?.text).toBe(withLead(openReplyThanks("Harriet"), withTypingHint(BREATHING_TEXT)));
    expect(lines.filter((l) => /usage: \/as extract|or: \/as extract/.test(l))).toHaveLength(2);
  });

  it("/later with no follow-up waiting just says so", async () => {
    const { exitCode, lines } = await run(["/later"]);
    expect(exitCode).toBe(0);
    expect(lines).toContain("[sim] No follow-up check-in is waiting.");
  });

  it("without an LLM, the safety screen and an explicit yes on a red-flag question still work", async () => {
    const { exitCode, bubbles } = await run(["1", "yeah, had to sit up", "I have chest pain"]);
    expect(exitCode).toBe(0);
    expectInOrder(bubbles, [
      { chat: PHONE, text: /^Thank you for telling me, Harriet/ },
      { chat: PHONE, text: /bruising or bleeding/ },
      { chat: PHONE, text: /please call 911 right away/ },
    ]);
  });

  it("a button number that doesn't exist is an error and fails the script", async () => {
    const { exitCode, lines } = await run(["7"]);
    expect(exitCode).toBe(1);
    expect(lines.some((l) => /no button 7/.test(l))).toBe(true);
  });

  it("unknown commands fail the script; /quit stops it", async () => {
    expect((await run(["/nope"])).exitCode).toBe(1);
    const { lines } = await run(["/quit", "1"]);
    expect(lines.some((l) => /taps/.test(l))).toBe(false);
  });

  it("/noon on an untouched check-in tells the family", async () => {
    const { bubbles } = await run(["/noon"]);
    expect(bubbles.at(-1)?.chat).toBe(FAMILY);
    expect(bubbles.at(-1)?.text).toMatch(/hasn't/);
  });

  it("/day jumps to a date, /db counts rows, /sharing validates", async () => {
    const { exitCode, lines } = await run(["/day 2026-09-04", "/db", "/sharing all", "/sharing everyone"]);
    expect(exitCode).toBe(1);
    expect(lines).toContain("===== 2026-09-04 =====");
    expect(lines.find((l) => /^checkins\s/.test(l))).toMatch(/\s2$/);
    expect(lines.some((l) => /Sharing level set to all/.test(l))).toBe(true);
    expect(lines.some((l) => /usage: \/sharing/.test(l))).toBe(true);
  });

  it("/sharing goes through the engine like her typing Sharing; with a level it taps it, and the check-in carries on", async () => {
    const { exitCode, bubbles } = await run(["1", "/sharing", "/sharing status_vitals", "1"]);
    expect(exitCode).toBe(0);
    expectInOrder(bubbles, [
      { chat: PHONE, text: /breathing last night/ },
      { chat: PHONE, text: /You decide how much your family sees/ },
      { chat: PHONE, text: /You decide how much your family sees/ },
      { chat: PHONE, text: /^Done\./ },
      { chat: FAMILY, text: /changed what you see here/ },
      { chat: PHONE, text: /breathing last night/ },
      { chat: PHONE, text: /bruising or bleeding/ },
    ]);
  });

  it("/paper then No: nothing compared, the check-in question comes back", async () => {
    const { exitCode, lines, bubbles } = await run(["1", "/paper", "2", "1"]);
    expect(exitCode).toBe(0);
    expectInOrder(bubbles, [
      { chat: PHONE, text: /breathing last night/ },
      { chat: PHONE, text: /Here's what I read/ },
      { chat: PHONE, text: /doctor or pharmacist/ },
      { chat: PHONE, text: /breathing last night/ },
      { chat: PHONE, text: /bruising or bleeding/ },
    ]);
    expect(lines.some((l) => /nothing was compared/.test(l))).toBe(true);
  });
});

describe("simulator pieces", () => {
  it("parseScript drops comments and blank lines", () => {
    expect(parseScript("# hi\n1\n\n  /next \n# bye\nhello")).toEqual(["1", "/next", "hello"]);
  });

  it("the clock starts at 09:00 local and moves a minute per tick", () => {
    const clock = new SimClock("2026-09-01");
    expect(new Date(clock.now()).getHours()).toBe(9);
    clock.tick();
    expect(new Date(clock.now()).getMinutes()).toBe(1);
    clock.setTime(12);
    expect(new Date(clock.now()).getHours()).toBe(12);
    clock.setDay("2026-09-02");
    expect(new Date(clock.now()).getDate()).toBe(2);
    expect(new Date(clock.now()).getHours()).toBe(9);
    clock.jumpTo(new Date(2026, 8, 2, 12, 3).toISOString());
    expect(new Date(clock.now()).getHours()).toBe(12);
    expect(new Date(clock.now()).getMinutes()).toBe(3);
    clock.jumpTo(new Date(2026, 8, 2, 10, 0).toISOString()); // never backwards
    expect(new Date(clock.now()).getHours()).toBe(12);
    expect(nextDay("2026-09-30")).toBe("2026-10-01");
  });

  it("colors only on a TTY without NO_COLOR", () => {
    expect(useColor({ isTTY: true }, {})).toBe(true);
    expect(useColor({ isTTY: true }, { NO_COLOR: "1" })).toBe(false);
    expect(useColor({ isTTY: false }, {})).toBe(false);
    expect(painter(false)("x", "bold")).toBe("x");
    expect(painter(true)("x", "bold")).toBe("\x1b[1mx\x1b[0m");
  });

  it("renders a message with numbered buttons and a table", () => {
    const at = new Date(2026, 8, 1, 9, 5).toISOString();
    const lines = renderMessage({ chatId: "c", messageId: "m", at, text: "Hi\nthere", buttons: ["A", "B"] }, "Sarah's phone (family)", painter(false), true);
    expect(lines).toEqual(["--- Sarah's phone (family), 09:05 ---", "Hi", "there", "   [1] A", "   [2] B"]);
    expect(renderTable(["a", "bb"], [["1", "2"]])).toEqual(["a  bb", "-  --", "1  2"]);
  });
});

describe("npm run simulate", () => {
  it("runs a demo script end to end and exits 0", async () => {
    const { stdout } = await promisify(execFile)(
      process.execPath,
      ["src/cli/simulate.ts", "--script", "../../scripts/demo/harriet-day1.txt", "--db", ":memory:"],
      { cwd: SERVER_DIR, env: { ...process.env, NO_COLOR: "1", CLOCK_DATE: "" } },
    );
    expect(stdout).toMatch(/Good morning, Harriet/);
    expect(stdout).toMatch(/--- Sarah's phone \(family\), \d\d:\d\d ---\nHarriet checked in/);
    expect(stdout).not.toMatch(/\x1b\[/);
  }, 30_000);

  it("--family sarah,tom gives each family member their own pane", async () => {
    const { stdout } = await promisify(execFile)(
      process.execPath,
      ["src/cli/simulate.ts", "--script", "../../scripts/demo/harriet-not-today.txt", "--db", ":memory:", "--family", "sarah,@Tom"],
      { cwd: SERVER_DIR, env: { ...process.env, NO_COLOR: "1", CLOCK_DATE: "" } },
    );
    expect(stdout).toMatch(/--- Sarah's phone \(family\), \d\d:\d\d ---\nHarriet said "not today"/);
    expect(stdout).toMatch(/--- Tom's phone \(family\), \d\d:\d\d ---\nHarriet said "not today"/);
    expect(stdout).not.toMatch(/Family group/);
  }, 30_000);

  it("--llm without GEMINI_API_KEY exits 1 and says why", async () => {
    const error = await promisify(execFile)(
      process.execPath,
      ["src/cli/simulate.ts", "--llm", "--script", "../../scripts/demo/harriet-not-today.txt", "--db", ":memory:"],
      { cwd: SERVER_DIR, env: { ...process.env, NO_COLOR: "1", CLOCK_DATE: "", GEMINI_API_KEY: "", LLM_PROVIDER: "gemini" } },
    ).then(
      () => undefined,
      (e: unknown) => e as { code?: number; stderr?: string },
    );
    expect(error?.code).toBe(1);
    expect(error?.stderr).toMatch(/--llm needs an LLM in \.env: free text off: GEMINI_API_KEY is not set/);
  }, 30_000);
});
