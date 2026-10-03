import { assertValidActivityLabel, assertValidButtons } from "./messenger.ts";
import type { Messenger, OutboundMessage, SentMessage } from "./messenger.ts";

// In-memory Messenger for tests and the terminal simulator. Behaves like Relay
// where it matters: buttons and activity labels are validated, and a repeated
// idempotency key returns the first SentMessage instead of sending again.

/** An activity label shown in (or cleared from) a chat. */
export type ActivityEvent = { chatId: string; kind: "set"; label: string; at: string } | { chatId: string; kind: "clear"; at: string };

export type FakeMessengerOptions = {
  /** Called once per real send (not for deduped replays). */
  onSend?: (message: SentMessage) => void;
  /** Called for each activity label set or cleared. */
  onActivity?: (event: ActivityEvent) => void;
  /** Timestamp source for `at`. Defaults to the wall clock. */
  now?: () => string;
};

export class FakeMessenger implements Messenger {
  readonly sent: SentMessage[] = [];
  /** Every activity label set or cleared, oldest first. */
  readonly activities: ActivityEvent[] = [];
  private readonly byKey = new Map<string, SentMessage>();
  private readonly showing = new Map<string, string>();
  private readonly onSend: ((message: SentMessage) => void) | undefined;
  private readonly onActivity: ((event: ActivityEvent) => void) | undefined;
  private readonly now: () => string;
  private counter = 0;

  constructor(options: FakeMessengerOptions = {}) {
    this.onSend = options.onSend;
    this.onActivity = options.onActivity;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  /** Unlike RelayMessenger, throws on a label Relay would refuse, so tests catch bad copy. */
  async setActivity(chatId: string, label: string): Promise<void> {
    assertValidActivityLabel(label);
    this.showing.set(chatId, label);
    this.record({ chatId, kind: "set", label, at: this.now() });
  }

  async clearActivity(chatId: string): Promise<void> {
    if (!this.showing.delete(chatId)) return;
    this.record({ chatId, kind: "clear", at: this.now() });
  }

  /** The label a chat shows right now, if any. */
  activityIn(chatId: string): string | undefined {
    return this.showing.get(chatId);
  }

  private record(event: ActivityEvent): void {
    this.activities.push(event);
    this.onActivity?.(event);
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
