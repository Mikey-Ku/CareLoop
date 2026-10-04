import Relay, { RelayAPIError } from "@relaymessenger/sdk";
import type {
  AgentMe,
  Chat,
  ChatCreateParams,
  ChatCreateResponse,
  ChatListChatsParams,
  ChatUpdateParams,
  ChatUpdateResponse,
  MessageSendParams,
  MessageSendResponse,
  WebhookSubscriptionListResponse,
  WebSocketRunOptions,
} from "@relaymessenger/sdk";
import { DEFAULT_RELAY_API_URL, normalizeHandle, relayOrigin } from "../config.ts";

// The narrow slice of @relaymessenger/sdk (0.5.0) this app uses. Everything in
// src/relay takes a RelayClient, so tests pass a fake object and the real SDK
// `Relay` instance satisfies it structurally. Shapes follow the installed
// node_modules/@relaymessenger/sdk/dist/client.d.ts.

/** One page of a list call: its rows, plus async iteration over every page. */
export type RelayListPage<T> = AsyncIterable<T> & { data: T[] };

export interface RelayClient {
  chats: {
    create(body: ChatCreateParams): Promise<ChatCreateResponse>;
    listChats(query?: ChatListChatsParams): Promise<RelayListPage<Chat>>;
    update(chatId: string, body: ChatUpdateParams): Promise<ChatUpdateResponse>;
    markAsRead(chatId: string): Promise<void>;
    messages: {
      send(chatId: string, body: MessageSendParams): Promise<MessageSendResponse>;
    };
  };
  me: { retrieve(): Promise<AgentMe> };
  webhookSubscriptions: { list(): Promise<WebhookSubscriptionListResponse> };
  websocket: { run(options: WebSocketRunOptions): Promise<void> };
}

/** Structured log line. Never pass the Agent Token or message bodies with health details. */
export type RelayLog = (event: string, fields?: Record<string, unknown>) => void;

export const consoleLog: RelayLog = (event, fields) => {
  console.log(JSON.stringify({ event, ...fields }));
};

/** The Relay API origin (Relay's own when unset), checked by the config's relayOrigin. */
export function relayApiOrigin(value?: string): string {
  return relayOrigin(value?.trim() || DEFAULT_RELAY_API_URL);
}

/** Build the real SDK client. The token is read by the caller from .env and never logged. */
export function createRelayClient(options: { agentToken: string; apiUrl?: string | undefined }): RelayClient {
  if (!options.agentToken.trim()) throw new Error("RELAY_AGENT_TOKEN is empty. Put the Agent Token in .env.");
  return new Relay({ apiKey: options.agentToken.trim(), baseURL: relayApiOrigin(options.apiUrl) });
}

/**
 * A short, token-free description of a failed Relay call: what we tried, the
 * HTTP status, Relay's error code and trace id (for support), and its message.
 */
export function describeRelayError(action: string, error: unknown): string {
  if (error instanceof RelayAPIError) {
    const bits = [
      error.status !== undefined ? `HTTP ${error.status}` : undefined,
      error.code !== undefined ? `code ${error.code}` : undefined,
      error.traceId ? `trace ${error.traceId}` : undefined,
    ].filter(Boolean);
    const hint = relayErrorHint(error.status, error.code);
    return `${action} failed${bits.length ? ` (${bits.join(", ")})` : ""}: ${error.message}${hint ? `. ${hint}` : ""}`;
  }
  return `${action} failed: ${error instanceof Error ? error.message : String(error)}`;
}

function relayErrorHint(status: number | undefined, code: number | undefined): string | undefined {
  if (status === 401) return "Check RELAY_AGENT_TOKEN in .env (it may be wrong, revoked, or from another environment).";
  if (code === 2030) return "This person has not written to the agent yet; ask them to send it a first message.";
  if (code === 2026) return "Someone in this chat blocked the agent, or the agent blocked them.";
  if (status === 429) return "Relay is rate limiting; it will be retried.";
  return undefined;
}

/** Relay handles compare without leading @s and without case (normalizeHandle in src/config.ts). */
export function sameHandle(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  return normalizeHandle(a) === normalizeHandle(b);
}

export type RelayAccess = {
  /** The agent's own handle, from GET /v1/me. */
  agentHandle: string;
  /** The person who owns or administers the agent, if Relay can name one. */
  ownerHandle: string | null;
  /** Whether the token could list chats (the docs' recommended access check). */
  canListChats: true;
};

/**
 * Checks the Agent Token works: lists one chat (GET /v1/chats?limit=1, the
 * access check the Relay docs recommend), then reads GET /v1/me for the
 * agent's handle and its owner. Throws a token-free error on failure.
 */
export async function verifyRelayAccess(relay: Pick<RelayClient, "chats" | "me">): Promise<RelayAccess> {
  try {
    await relay.chats.listChats({ limit: 1 });
  } catch (error) {
    throw new Error(describeRelayError("Listing chats with the Agent Token", error), { cause: error });
  }
  let me: AgentMe;
  try {
    me = await relay.me.retrieve();
  } catch (error) {
    throw new Error(describeRelayError("Reading the agent (GET /v1/me)", error), { cause: error });
  }
  const ownerFromOwner = me.owner?.kind === "user" ? me.owner.handle : null;
  return {
    agentHandle: me.handle,
    ownerHandle: me.owner_people[0]?.handle ?? ownerFromOwner ?? null,
    canListChats: true,
  };
}
