import { createHash } from "node:crypto";
import { IDEMPOTENCY_KEY_MAX_LENGTH, RelayAPIError, partsWithButtons, type ChatActivityResponse, type ChatClearActivityParams, type ChatSetActivityParams, type MessagePart } from "@relaymessenger/sdk";
import { assertValidActivityLabel, assertValidButtons, relayButtonsPart } from "./messenger.ts";
import type { Messenger, OutboundMessage, SentMessage } from "./messenger.ts";
import { consoleLog, describeRelayError, type RelayClient, type RelayLog } from "./relay-client.ts";

// Messenger over Relay: POST /v1/chats/{chatId}/messages through the SDK.
// Buttons go out as one `buttons` part after the question's `text` part
// (messaging.md "Send"; ButtonItem in the SDK's types.d.ts). A plain button's
// tap comes back as `message.received` with one text part equal to the label,
// which the inbox hands to the engine (src/relay/inbox.ts).
//
// Activity labels (docs.relayapp.im/chats/activity): PUT /v1/chats/{chatId}/activity
// with `text` (1 to 21 visible characters) starts one and returns its id; each update
// holds it for a 90 second lease, so it is renewed with that `activity_id` every 60
// seconds while the work goes on; DELETE with the `activity_id` clears only ours.
// Best effort: a failure is logged (never her message) and swallowed.
//
// Idempotency keys: Relay remembers each key for hours, and the engine's keys repeat for a pinned
// CLOCK_DATE (`<patient>:<day>:question:0`). So with an `instanceId` (this database's, see
// src/db/app-meta.ts) the key on the wire is `<instanceId>.<24 hex of sha256(key)>`: the same for one
// database across restarts (retries stay safe), different for a fresh one. If Relay still refuses a key
// (409, code 1005: used for different content), the send is retried once under `<key>.r`.

/** Renew an activity label this often (Relay's lease is 90 seconds). */
export const ACTIVITY_RENEW_MS = 60_000;
/** Stop renewing after this many renewals, in case nobody clears it; the lease then runs out by itself. */
export const MAX_ACTIVITY_RENEWALS = 4;

/** Relay's activity calls (SDK Chats.setActivity and clearActivity). */
export type RelayActivityApi = {
  setActivity(chatId: string, body: ChatSetActivityParams): Promise<ChatActivityResponse>;
  clearActivity(chatId: string, query?: ChatClearActivityParams): Promise<void>;
};

/**
 * The client slice RelayMessenger uses. The activity calls are optional (the SDK client has them;
 * the inbox's family welcome sends without them): without them no label is shown.
 */
export type MessengerRelay = { chats: Pick<RelayClient["chats"], "messages"> & Partial<RelayActivityApi> };

/** Runs `fn` every `ms` until the returned function is called. */
export type Every = (fn: () => void, ms: number) => () => void;

export type RelayMessengerOptions = {
  /** Where activity failures go. Defaults to one JSON line on the console. */
  log?: RelayLog;
  /** Timer for renewing activity labels. Defaults to an unref'd setInterval. */
  every?: Every;
  /** This database's instance id. Without one, keys go to Relay as given. */
  instanceId?: string;
};

/** Relay's answer when a key was already used for different message content: HTTP 409, API code 1005. */
const isKeyReused = (error: unknown): boolean => error instanceof RelayAPIError && error.status === 409 && error.code === 1005;

const defaultEvery: Every = (fn, ms) => {
  const timer = setInterval(fn, ms);
  timer.unref();
  return () => clearInterval(timer);
};

/** The message parts Relay expects for one outbound message: its text, then its buttons if it has any (SDK partsWithButtons). */
export function toRelayParts(message: OutboundMessage): MessagePart[] {
  return partsWithButtons(message.text, message.buttons?.length ? relayButtonsPart(message.buttons) : undefined);
}

export class RelayMessenger implements Messenger {
  private readonly relay: MessengerRelay;
  private readonly log: RelayLog;
  private readonly every: Every;
  private readonly instanceId: string | undefined;
  /** The activity label each chat shows: its Relay id and how to stop renewing it. */
  private readonly activities = new Map<string, { id: string; stopRenewing: () => void }>();

  /** Only `chats` is used, so the inbox can send with the client slice it already holds. */
  constructor(relay: MessengerRelay, options: RelayMessengerOptions = {}) {
    this.relay = relay;
    this.log = options.log ?? consoleLog;
    this.every = options.every ?? defaultEvery;
    this.instanceId = options.instanceId;
  }

  async setActivity(chatId: string, label: string): Promise<void> {
    const chats = this.relay.chats;
    if (!chats.setActivity) return;
    try {
      assertValidActivityLabel(label);
    } catch (error) {
      this.log("relay_activity_failed", { chat_id: chatId, error: error instanceof Error ? error.message : String(error) });
      return;
    }
    this.forget(chatId);
    const text = label.trim();
    let id: string | undefined;
    try {
      // No activity_id: start a new one, replacing any the agent had in this chat.
      id = (await chats.setActivity(chatId, { text })).activity?.id;
    } catch (error) {
      this.log("relay_activity_failed", { chat_id: chatId, error: describeRelayError(`Setting the activity label in Relay chat ${chatId}`, error) });
      return;
    }
    if (!id) return;
    const activityId = id;
    let renewals = 0;
    const stopRenewing = this.every(() => {
      renewals += 1;
      if (renewals > MAX_ACTIVITY_RENEWALS) return stopRenewing();
      chats.setActivity?.(chatId, { text, activity_id: activityId }).catch((error: unknown) => {
        // 409: it was replaced or cleared meanwhile. Either way, stop renewing.
        stopRenewing();
        this.log("relay_activity_failed", { chat_id: chatId, error: describeRelayError(`Renewing the activity label in Relay chat ${chatId}`, error) });
      });
    }, ACTIVITY_RENEW_MS);
    this.activities.set(chatId, { id: activityId, stopRenewing });
  }

  async clearActivity(chatId: string): Promise<void> {
    const activity = this.activities.get(chatId);
    if (!activity) return;
    this.forget(chatId);
    try {
      // Only ours: a stale or missing activity is a no-op on Relay's side.
      await this.relay.chats.clearActivity?.(chatId, { activity_id: activity.id });
    } catch (error) {
      this.log("relay_activity_failed", { chat_id: chatId, error: describeRelayError(`Clearing the activity label in Relay chat ${chatId}`, error) });
    }
  }

  /** Stop renewing a chat's label and forget it (Relay lets it lapse unless it is cleared). */
  private forget(chatId: string): void {
    this.activities.get(chatId)?.stopRenewing();
    this.activities.delete(chatId);
  }

  async send(chatId: string, message: OutboundMessage, idempotencyKey: string): Promise<SentMessage> {
    assertValidButtons(message.buttons);
    if (!message.text.trim()) throw new Error("Relay messages need text; got an empty message");
    if (idempotencyKey.length < 1 || idempotencyKey.length > IDEMPOTENCY_KEY_MAX_LENGTH)
      throw new Error(`Idempotency key must be 1 to ${IDEMPOTENCY_KEY_MAX_LENGTH} characters, got ${idempotencyKey.length}`);

    const wireKey = this.instanceId ? `${this.instanceId}.${createHash("sha256").update(idempotencyKey).digest("hex").slice(0, 24)}` : idempotencyKey;
    let response;
    try {
      try {
        response = await this.post(chatId, message, wireKey);
      } catch (error) {
        if (!isKeyReused(error)) throw error;
        response = await this.post(chatId, message, `${wireKey}.r`);
        this.log("relay_idempotency_key_reused", {
          chat_id: chatId,
          key: wireKey,
          detail: "Relay had already used this idempotency key for different message content; the message was sent under a new key",
        });
      }
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

  private post(chatId: string, message: OutboundMessage, key: string) {
    // The SDK retries a send only when it carries an idempotency key, and
    // Relay replays the same Message for the same key, so retries are safe.
    return this.relay.chats.messages.send(chatId, { message: { parts: toRelayParts(message), idempotency_key: key } });
  }
}
