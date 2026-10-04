import { BUTTONS_MAX_ITEMS, BUTTON_LABEL_MAX_LENGTH, buttonsPart, type ButtonsPart } from "@relaymessenger/sdk";

// The seam between the check-in engine and Relay. RelayMessenger implements
// Messenger with @relaymessenger/sdk; tests and the terminal simulator use
// FakeMessenger. The engine never imports the Relay SDK directly.

export type OutboundMessage = {
  text: string;
  /** Button labels. A tap comes back as an InboundMessage whose text equals the label. */
  buttons?: string[];
};

export type SentMessage = OutboundMessage & {
  messageId: string;
  chatId: string;
  /** ISO timestamp. */
  at: string;
};

/** What the Relay webhook's `message.received` becomes. A button tap has text equal to the label. */
export type InboundMessage = {
  chatId: string;
  messageId: string;
  text: string;
  /** The message a button tap or reply answers. */
  replyTo?: string;
  at: string;
};

export interface Messenger {
  /**
   * Send one message. `idempotencyKey` must be stable for the same logical send
   * (Relay dedupes on it), e.g. `${patientId}:${day}:question:2`.
   */
  send(chatId: string, message: OutboundMessage, idempotencyKey: string): Promise<SentMessage>;
  /**
   * Optional. Show a short activity label in a chat ("Reading your message") while the agent
   * works on a reply. Relay shows it for a 90 second lease; an implementation keeps it up
   * until clearActivity. Best effort: never throws, and a messenger without it shows nothing.
   */
  setActivity?(chatId: string, label: string): Promise<void>;
  /** Optional. Take down the label setActivity put up in this chat, if any. Best effort: never throws. */
  clearActivity?(chatId: string): Promise<void>;
}

/** Relay allows 1 to 21 visible characters in an activity label. */
export const MAX_ACTIVITY_LABEL = 21;

/** Visible characters, counted the way a person would (an emoji is one). */
function visibleLength(text: string): number {
  return [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text.trim())].length;
}

export function assertValidActivityLabel(label: string): void {
  const length = visibleLength(label);
  if (length < 1 || length > MAX_ACTIVITY_LABEL)
    throw new Error(`Activity label must be 1 to ${MAX_ACTIVITY_LABEL} visible characters, got ${length}: "${label}"`);
}

/**
 * The `buttons` part for these labels, checked by the SDK's buttonsPart against Relay's own limits
 * (1 to BUTTONS_MAX_ITEMS buttons, each label 1 to BUTTON_LABEL_MAX_LENGTH characters).
 */
export function relayButtonsPart(labels: string[]): ButtonsPart {
  const part = buttonsPart(labels.map((label) => ({ label })));
  if (typeof part === "string")
    throw new Error(`Relay messages take 1 to ${BUTTONS_MAX_ITEMS} buttons, each label 1 to ${BUTTON_LABEL_MAX_LENGTH} characters: ${part}`);
  return part;
}

export function assertValidButtons(buttons: string[] | undefined): void {
  if (buttons) relayButtonsPart(buttons);
}
