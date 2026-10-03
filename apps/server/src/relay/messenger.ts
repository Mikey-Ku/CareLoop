// The seam between the check-in engine and Relay. Run 2 implements Messenger
// with @relaymessenger/sdk; the terminal simulator uses FakeMessenger. The
// engine never imports the Relay SDK directly.

/** Relay allows 1 to 5 buttons per message, each label up to 80 characters. */
export const MAX_BUTTONS = 5;
export const MAX_BUTTON_LABEL = 80;

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
}

export function assertValidButtons(buttons: string[] | undefined): void {
  if (!buttons) return;
  if (buttons.length < 1 || buttons.length > MAX_BUTTONS)
    throw new Error(`Relay messages take 1 to ${MAX_BUTTONS} buttons, got ${buttons.length}`);
  for (const label of buttons)
    if (label.length === 0 || label.length > MAX_BUTTON_LABEL)
      throw new Error(`Button label must be 1 to ${MAX_BUTTON_LABEL} characters: "${label}"`);
}
