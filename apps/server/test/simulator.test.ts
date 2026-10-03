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

async function simulate(script: string, extra: { day?: string; sharing?: "status" | "status_vitals" | "all" } = {}) {
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
const FAMILY = "Family group";

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

  it("harriet-paper: read-back with confirm buttons, then the R6 result mentions aspirin", async () => {
    const { exitCode, lines, bubbles } = await simulate("harriet-paper.txt");
    expect(exitCode).toBe(0);
    const readback = bubbles.find((b) => /discharge papers/.test(b.text) && b.buttons.length > 0);
    expect(readback?.chat).toBe(PHONE);
    expect(readback?.buttons[0]).toMatch(/^Yes/);
    expectInOrder(bubbles, [
      { chat: PHONE, text: /Here's what I read/ },
      { chat: PHONE, text: /aspirin.*(active|medication list)/s },
    ]);
    expect(lines.some((l) => /\[sim\] R6 flag/.test(l))).toBe(true);
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
    const lines = renderMessage({ chatId: "c", messageId: "m", at, text: "Hi\nthere", buttons: ["A", "B"] }, "Family group", painter(false), true);
    expect(lines).toEqual(["--- Family group, 09:05 ---", "Hi", "there", "   [1] A", "   [2] B"]);
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
    expect(stdout).toMatch(/--- Family group, \d\d:\d\d ---\nHarriet checked in/);
    expect(stdout).not.toMatch(/\x1b\[/);
  }, 30_000);
});
