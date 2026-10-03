import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { painter, renderMessage, renderTable, useColor } from "../src/cli/sim-render.ts";
import { SimClock, nextDay, parseScript, runSimulation } from "../src/cli/simulator.ts";
import { loadConfig } from "../src/config.ts";
import { REPO_ROOT } from "../src/finchnode/fixtures.ts";

const SERVER_DIR = join(REPO_ROOT, "apps", "server");
const DEMO_DIR = join(REPO_ROOT, "scripts", "demo");
const RED_FLAG_DAY = "2026-09-02";

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
  it("harriet-day1: greeting, three answers, a flag she'll ask her doctor about, family status", async () => {
    const { exitCode, lines, bubbles } = await simulate("harriet-day1.txt");
    expect(exitCode).toBe(0);
    expect(lines[0]).toMatch(/Harriet \(patient-demo-polypharmacy\)/);
    expect(lines.slice(0, 3).join("\n")).toMatch(/2026-09-01/);
    expect(lines.slice(0, 3).join("\n")).toMatch(/[Ss]ynthetic/);
    expectInOrder(bubbles, [
      { chat: PHONE, text: /Good morning, Harriet/ },
      { chat: PHONE, text: /dizzy/ },
      { chat: PHONE, text: /morning medicines/ },
      { chat: PHONE, text: /feeling/ },
      { chat: PHONE, text: /worth asking your doctor/ },
      { chat: PHONE, text: /eGFR/ },
      { chat: FAMILY, text: /Harriet checked in/ },
    ]);
    expect(bubbles.find((b) => /Good morning/.test(b.text))?.buttons).toEqual(["Let's start", "Not today"]);
    // /flags at the end: R1 noted, the others still new.
    expect(lines.find((l) => /^\d+\s+R1\s/.test(l))).toMatch(/noted/);
    expect(lines.find((l) => /^\d+\s+R3\s/.test(l))).toMatch(/new/);
    // Status sharing: the family sees no medical detail.
    expect(bubbles.filter((b) => b.chat === FAMILY).map((b) => b.text).join("\n")).not.toMatch(/eGFR|metformin/);
  });

  it(`harriet-red-flag (--day ${RED_FLAG_DAY}): advice to her, alert to the family, then the check-in goes on`, async () => {
    const { exitCode, bubbles } = await simulate("harriet-red-flag.txt", { day: RED_FLAG_DAY });
    expect(exitCode).toBe(0);
    expectInOrder(bubbles, [
      { chat: PHONE, text: /Good morning, Harriet/ },
      { chat: PHONE, text: /trouble breathing/ },
      { chat: PHONE, text: /call your doctor/ },
      { chat: FAMILY, text: /should call her doctor/ },
      { chat: PHONE, text: /bruising or bleeding/ },
      { chat: PHONE, text: /worth asking your doctor/ },
      { chat: FAMILY, text: /Harriet checked in/ },
    ]);
    // At sharing "status" the alert carries no medical detail.
    const alert = bubbles.find((b) => b.chat === FAMILY && /should call her doctor/.test(b.text));
    expect(alert?.text).not.toMatch(/breathing/);
  });

  it("harriet-red-flag at sharing all: the family alert says what she answered", async () => {
    const { bubbles } = await simulate("harriet-red-flag.txt", { day: RED_FLAG_DAY, sharing: "all" });
    const alert = bubbles.find((b) => b.chat === FAMILY && /should call her doctor/.test(b.text));
    expect(alert?.text).toMatch(/breathing/);
  });

  it("harriet-red-flag with two family members: each gets the alert and the status in their own chat", async () => {
    const { exitCode, lines, bubbles } = await simulate("harriet-red-flag.txt", { day: RED_FLAG_DAY, family: ["sarah", "tom"] });
    expect(exitCode).toBe(0);
    expect(lines.some((l) => l.includes("[sim] Family, each in their own chat with the agent (pre-linked here): Sarah's phone (family) @sarah, Tom's phone (family) @tom."))).toBe(true);
    for (const chat of [FAMILY, TOM])
      expect(bubbles.filter((b) => b.chat === chat).map((b) => b.text)).toEqual([
        "Harriet reported something she should call her doctor about today. Please check in with her.",
        "Harriet checked in today.",
      ]);
    expectInOrder(bubbles, [
      { chat: PHONE, text: /call your doctor/ },
      { chat: FAMILY, text: /should call her doctor/ },
      { chat: TOM, text: /should call her doctor/ },
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

  it("harriet-two-days: day 2 offers the next flag, not the one she already noted", async () => {
    const { exitCode, lines, bubbles } = await simulate("harriet-two-days.txt");
    expect(exitCode).toBe(0);
    expectInOrder(bubbles, [
      { chat: PHONE, text: /eGFR/ },
      { chat: FAMILY, text: /Harriet checked in/ },
      { chat: PHONE, text: /Good morning, Harriet/ },
      { chat: PHONE, text: /swollen/ },
      { chat: PHONE, text: /worth asking your doctor/ },
      { chat: PHONE, text: /aspirin/ },
      { chat: FAMILY, text: /Harriet checked in/ },
    ]);
    expect(lines).toContain("===== 2026-09-02 =====");
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

  it("harriet-sharing: menu mid check-in, the question comes back, family told, status at all, then back to status", async () => {
    const { exitCode, lines, bubbles } = await simulate("harriet-sharing.txt");
    expect(exitCode).toBe(0);
    expectInOrder(bubbles, [
      { chat: PHONE, text: /morning medicines/ },
      { chat: PHONE, text: /You decide how much your family sees/ },
      { chat: PHONE, text: /^Done\. Your family now sees/ },
      { chat: FAMILY, text: /^Harriet changed what you see here\./ },
      { chat: PHONE, text: /morning medicines/ },
      { chat: PHONE, text: /feeling/ },
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

  it("free text goes to the engine as her message", async () => {
    const { exitCode, bubbles } = await run(["hello there"]);
    expect(exitCode).toBe(0);
    expect(bubbles.at(-1)?.buttons).toEqual(["Let's start", "Not today"]);
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
      { chat: PHONE, text: /dizzy/ },
      { chat: PHONE, text: /You decide how much your family sees/ },
      { chat: PHONE, text: /You decide how much your family sees/ },
      { chat: PHONE, text: /^Done\./ },
      { chat: FAMILY, text: /changed what you see here/ },
      { chat: PHONE, text: /dizzy/ },
      { chat: PHONE, text: /morning medicines/ },
    ]);
  });

  it("/paper then No: nothing compared, the check-in question comes back", async () => {
    const { exitCode, lines, bubbles } = await run(["1", "/paper", "2", "1"]);
    expect(exitCode).toBe(0);
    expectInOrder(bubbles, [
      { chat: PHONE, text: /dizzy/ },
      { chat: PHONE, text: /Here's what I read/ },
      { chat: PHONE, text: /doctor or pharmacist/ },
      { chat: PHONE, text: /dizzy/ },
      { chat: PHONE, text: /morning medicines/ },
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
});
