import { assertValidButtons } from "./messenger.ts";
import type { Messenger, OutboundMessage, SentMessage } from "./messenger.ts";

// In-memory Messenger for tests and the terminal simulator. Behaves like Relay
// where it matters: buttons are validated, and a repeated idempotency key
// returns the first SentMessage instead of sending again.

export type FakeMessengerOptions = {
  /** Called once per real send (not for deduped replays). */
  onSend?: (message: SentMessage) => void;
  /** Timestamp source for `at`. Defaults to the wall clock. */
  now?: () => string;
};

export class FakeMessenger implements Messenger {
  readonly sent: SentMessage[] = [];
  private readonly byKey = new Map<string, SentMessage>();
  private readonly onSend: ((message: SentMessage) => void) | undefined;
  private readonly now: () => string;
  private counter = 0;

  constructor(options: FakeMessengerOptions = {}) {
    this.onSend = options.onSend;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async send(chatId: string, message: OutboundMessage, idempotencyKey: string): Promise<SentMessage> {
    const previous = this.byKey.get(idempotencyKey);
    if (previous) return previous;
    assertValidButtons(message.buttons);
    this.counter += 1;
    const sentMessage: SentMessage = {
      text: message.text,
      ...(message.buttons ? { buttons: [...message.buttons] } : {}),
      messageId: `msg_${this.counter}`,
      chatId,
      at: this.now(),
    };
    this.byKey.set(idempotencyKey, sentMessage);
    this.sent.push(sentMessage);
    this.onSend?.(sentMessage);
    return sentMessage;
  }

  /** Messages sent to one chat, oldest first. */
  inChat(chatId: string): SentMessage[] {
    return this.sent.filter((m) => m.chatId === chatId);
  }

  /** The most recent message sent to a chat, or undefined. */
  lastIn(chatId: string): SentMessage | undefined {
    const inChat = this.inChat(chatId);
    return inChat[inChat.length - 1];
  }
}
