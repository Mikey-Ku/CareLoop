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

export type ChatLabel = "Harriet's phone" | "Family group" | string;

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
  "Commands:",
  "  /help                 this list",
  "  /noon                 run the noon missed check-in job for the day",
  "  /next                 move to the next day and start its check-in",
  "  /day YYYY-MM-DD       jump to a day and start its check-in",
  "  /flags                stored flags and their status",
  "  /sharing <level>      set her sharing level: status, status_vitals or all",
  "  /paper                read back her discharge paper and, on Yes, compare it with the record (R6)",
  "  /db                   row counts per table",
  "  /quit                 leave",
];
