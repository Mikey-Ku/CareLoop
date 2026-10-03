import type { SentMessage } from "../relay/messenger.ts";

// Plain-text rendering for the terminal simulator (npm run simulate). ANSI
// colors only when asked for; the caller decides (TTY and no NO_COLOR).

const CODES = {
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  reset: "\x1b[0m",
} as const;

export type Style = keyof Omit<typeof CODES, "reset">;

export type Painter = (text: string, ...styles: Style[]) => string;

export function painter(color: boolean): Painter {
  if (!color) return (text) => text;
  return (text, ...styles) => (styles.length === 0 ? text : `${styles.map((s) => CODES[s]).join("")}${text}${CODES.reset}`);
}

/** Should the simulator color its output? Only on a TTY, and never when NO_COLOR is set. */
export function useColor(stream: { isTTY?: boolean }, env: Record<string, string | undefined> = process.env): boolean {
  return Boolean(stream.isTTY) && env.NO_COLOR === undefined;
}

/** "09:05" in local time, from an ISO timestamp. */
export function clockTime(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** "Harriet's phone", or a family member's own chat such as "Sarah's phone (family)". */
export type ChatLabel = string;

/** One message as the lines a phone would show: header, text, numbered buttons. */
export function renderMessage(message: SentMessage, chatLabel: ChatLabel, paint: Painter, family: boolean): string[] {
  const color: Style = family ? "magenta" : "cyan";
  const lines = [paint(`--- ${chatLabel}, ${clockTime(message.at)} ---`, "bold", color)];
  for (const line of message.text.split("\n")) lines.push(line);
  (message.buttons ?? []).forEach((label, i) => lines.push(`   ${paint(`[${i + 1}]`, "bold")} ${label}`));
  return lines;
}

/** A fixed-width text table. */
export function renderTable(headers: string[], rows: string[][], maxWidth = 60): string[] {
  const cells = [headers, ...rows].map((row) => row.map((c) => (c.length > maxWidth ? `${c.slice(0, maxWidth - 3)}...` : c)));
  const widths = headers.map((_, i) => Math.max(...cells.map((row) => (row[i] ?? "").length)));
  const line = (row: string[]) =>
    row
      .map((c, i) => c.padEnd(widths[i] ?? 0))
      .join("  ")
      .trimEnd();
  const [head, ...body] = cells;
  return [line(head ?? []), widths.map((w) => "-".repeat(w)).join("  "), ...body.map(line)];
}

export const HELP_LINES = [
  "Type a number to tap that button on Harriet's latest message, or any other text to send it as Harriet.",
  "With --llm, what she types is read by the LLM (an answer, detail for her doctor, a medicine question, a message for family, chat);",
  "without it, buttons only, plus the safety screen and an explicit yes on a red-flag question (no LLM needed). /as stands in for it.",
  "Each family member (--family, default sarah) has their own chat with the agent, shown as its own pane.",
  "Commands:",
  "  /help                 this list",
  "  /noon                 run the noon missed check-in job for the day",
  "  /next                 move to the next day and start its check-in",
  "  /day YYYY-MM-DD       jump to a day and start its check-in",
  "  /flags                stored flags and their status",
  "  /sharing [level]      she types \"Sharing\" (the menu); with a level she also taps it: status, status_vitals or all",
  "  /paper                start a paper check: read back her discharge paper; on Yes the engine compares it (R6)",
  "  /later                jump to the next follow-up check-in (after a red flag or an urgent message) and send it",
  "  /as KIND [answer]     read her next typed message as KIND (answer, more_detail, medicine_question, feeling_low,",
  "                        urgent_symptom, crisis, family_message, chat) without an LLM; for answer, which button",
  "      [| topic, amount, change]  ...and the symptoms she mentions, e.g. /as chat | knee pain, a_little, same",
  "                        (amount none|a_little|a_lot|unknown, change new|worse|same|better|unknown; the ladder levels them)",
  "  /db                   row counts per table",
  "  /quit                 leave",
];
