import type { MessagePart } from "@relaymessenger/sdk";
import { assertValidButtons } from "./messenger.ts";
import type { Messenger, OutboundMessage, SentMessage } from "./messenger.ts";
import { describeRelayError, type RelayClient } from "./relay-client.ts";

// Messenger over Relay: POST /v1/chats/{chatId}/messages through the SDK.
// Buttons go out as one `buttons` part after the question's `text` part
// (messaging.md "Send"; ButtonItem in the SDK's types.d.ts). A plain button's
// tap comes back as `message.received` with one text part equal to the label,
// which the inbox hands to the engine (src/relay/inbox.ts).

/** Relay's limit on idempotency keys (IDEMPOTENCY_KEY_MAX_LENGTH in the SDK). */
export const MAX_IDEMPOTENCY_KEY = 255;

/** The message parts Relay expects for one outbound message. */
export function toRelayParts(message: OutboundMessage): MessagePart[] {
  const parts: MessagePart[] = [{ type: "text", value: message.text }];
  if (message.buttons && message.buttons.length > 0)
    parts.push({ type: "buttons", items: message.buttons.map((label) => ({ label })) });
  return parts;
}

export class RelayMessenger implements Messenger {
  private readonly relay: Pick<RelayClient, "chats">;

  /** Only `chats` is used, so the inbox can send with the client slice it already holds. */
  constructor(relay: Pick<RelayClient, "chats">) {
    this.relay = relay;
  }

  async send(chatId: string, message: OutboundMessage, idempotencyKey: string): Promise<SentMessage> {
    assertValidButtons(message.buttons);
    if (!message.text.trim()) throw new Error("Relay messages need text; got an empty message");
    if (idempotencyKey.length < 1 || idempotencyKey.length > MAX_IDEMPOTENCY_KEY)
      throw new Error(`Idempotency key must be 1 to ${MAX_IDEMPOTENCY_KEY} characters, got ${idempotencyKey.length}`);

    let response;
    try {
      // The SDK retries a send only when it carries an idempotency key, and
      // Relay replays the same Message for the same key, so retries are safe.
      response = await this.relay.chats.messages.send(chatId, {
        message: { parts: toRelayParts(message), idempotency_key: idempotencyKey },
      });
    } catch (error) {
      throw new Error(describeRelayError(`Sending a message to Relay chat ${chatId}`, error), { cause: error });
    }

    return {
      text: message.text,
      ...(message.buttons ? { buttons: [...message.buttons] } : {}),
      messageId: response.message.id,
      chatId: response.chat_id ?? chatId,
      at: response.message.created_at,
    };
  }
}
