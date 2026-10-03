import { RelayAPIError, type AgentMe, type WebhookSubscription } from "@relaymessenger/sdk";
import { describe, expect, it, vi } from "vitest";
import { describeRelayError, relayApiOrigin, verifyRelayAccess, type RelayClient } from "../src/relay/relay-client.ts";
import { RelayMessenger, toRelayParts } from "../src/relay/relay-messenger.ts";

// Synthetic ids and handles only.
const CHAT = "0199cccc-0000-7000-8000-000000000001";
const GROUP = "0199cccc-0000-7000-8000-000000000002";
const T = "2026-09-01T13:00:00Z";

const ME: AgentMe = {
  id: "0199cccc-0000-7000-8000-0000000000aa",
  handle: "checkin.companion",
  kind: "agent",
  display_name: "Check-in Companion",
  owner: { kind: "user", handle: "owner.demo", display_name: "Owner Demo" },
  owner_people: [{ id: "0199cccc-0000-7000-8000-0000000000bb", handle: "owner.demo", display_name: "Owner Demo" }],
  calls_enabled: true,
};

function sent(id: string, chatId = CHAT) {
  return { chat_id: chatId, message: { id, parts: [], created_at: T, sent_at: T, delivery_status: "delivered" as const, is_system_message: false as const } };
}

function fakeRelay() {
  return {
    chats: {
      create: vi.fn(async () => ({ chat: { id: GROUP, display_name: null, is_group: true, handles: [], message: sent("m-welcome", GROUP).message } })),
      update: vi.fn(async () => ({ status: "ok", chat_id: GROUP })),
      listChats: vi.fn(async () => ({ data: [], async *[Symbol.asyncIterator]() {} })),
      markAsRead: vi.fn(async () => undefined),
      messages: { send: vi.fn(async (chatId: string) => sent("m-1", chatId)) },
    },
    me: { retrieve: vi.fn(async () => ME) },
    webhookSubscriptions: { list: vi.fn(async () => ({ subscriptions: [] as WebhookSubscription[] })) },
    websocket: { run: vi.fn(async () => undefined) },
  } satisfies RelayClient;
}

describe("RelayMessenger", () => {
  it("sends text then a buttons part in the SDK shape, with the idempotency key, and returns Relay's message id", async () => {
    const relay = fakeRelay();
    const messenger = new RelayMessenger(relay);
    const result = await messenger.send(CHAT, { text: "Good morning, Harriet. Ready?", buttons: ["Let's start", "Not today"] }, "harriet:2026-09-01:greeting");
    expect(relay.chats.messages.send).toHaveBeenCalledWith(CHAT, {
      message: {
        parts: [
          { type: "text", value: "Good morning, Harriet. Ready?" },
          { type: "buttons", items: [{ label: "Let's start" }, { label: "Not today" }] },
        ],
        idempotency_key: "harriet:2026-09-01:greeting",
      },
    });
    expect(result).toEqual({
      text: "Good morning, Harriet. Ready?",
      buttons: ["Let's start", "Not today"],
      messageId: "m-1",
      chatId: CHAT,
      at: T,
    });
  });

  it("sends a plain text part when there are no buttons", async () => {
    expect(toRelayParts({ text: "Thank you." })).toEqual([{ type: "text", value: "Thank you." }]);
    const relay = fakeRelay();
    const result = await new RelayMessenger(relay).send(CHAT, { text: "Thank you." }, "k1");
    expect(result).not.toHaveProperty("buttons");
  });

  it("needs only the chats slice of the client (the inbox sends the family welcome with it)", async () => {
    const relay = fakeRelay();
    const result = await new RelayMessenger({ chats: relay.chats }).send(CHAT, { text: "Hello." }, "welcome:harriet:sarah.demo");
    expect(result.messageId).toBe("m-1");
    expect(relay.chats.messages.send).toHaveBeenCalledWith(CHAT, { message: { parts: [{ type: "text", value: "Hello." }], idempotency_key: "welcome:harriet:sarah.demo" } });
  });

  it("checks Relay's button limits before calling the API", async () => {
    const relay = fakeRelay();
    const messenger = new RelayMessenger(relay);
    await expect(messenger.send(CHAT, { text: "Pick", buttons: ["1", "2", "3", "4", "5", "6"] }, "k")).rejects.toThrow(/1 to 5 buttons/);
    await expect(messenger.send(CHAT, { text: "Pick", buttons: ["x".repeat(81)] }, "k")).rejects.toThrow(/1 to 80/);
    await expect(messenger.send(CHAT, { text: "Hi" }, "k".repeat(256))).rejects.toThrow(/Idempotency key/);
    expect(relay.chats.messages.send).not.toHaveBeenCalled();
  });

  it("maps an SDK error to a clear message with status, code and trace, and no token", async () => {
    const relay = fakeRelay();
    relay.chats.messages.send.mockRejectedValueOnce(new RelayAPIError("Contact does not accept message requests", { status: 403, code: 2030, traceId: "trace-1" }));
    const error = await new RelayMessenger(relay).send(CHAT, { text: "Hi" }, "k").then(
      () => new Error("expected the send to fail"),
      (e: unknown) => e as Error,
    );
    expect(error.message).toContain(`Relay chat ${CHAT}`);
    expect(error.message).toContain("HTTP 403");
    expect(error.message).toContain("code 2030");
    expect(error.message).toContain("trace-1");
    expect(error.message).toMatch(/first message/);
    expect(error.cause).toBeInstanceOf(RelayAPIError);
  });
});

describe("describeRelayError", () => {
  it("hints at the token on 401 without printing it", () => {
    const message = describeRelayError("Listing chats", new RelayAPIError("Unauthorized", { status: 401 }));
    expect(message).toMatch(/RELAY_AGENT_TOKEN/);
    expect(message).toContain("HTTP 401");
  });
});

describe("relayApiOrigin", () => {
  it("defaults to the production origin and refuses insecure or path-bearing URLs", () => {
    expect(relayApiOrigin(undefined)).toBe("https://api.relayapp.im");
    expect(relayApiOrigin("http://localhost:8787")).toBe("http://localhost:8787");
    expect(() => relayApiOrigin("http://api.relayapp.im")).toThrow(/HTTPS/);
    expect(() => relayApiOrigin("https://api.relayapp.im/v1")).toThrow(/origin/);
  });
});

describe("verifyRelayAccess", () => {
  it("lists one chat, then returns the agent and owner handles from /v1/me", async () => {
    const relay = fakeRelay();
    expect(await verifyRelayAccess(relay)).toEqual({ agentHandle: "checkin.companion", ownerHandle: "owner.demo", canListChats: true });
    expect(relay.chats.listChats).toHaveBeenCalledWith({ limit: 1 });
  });

  it("returns a null owner when Relay names none", async () => {
    const relay = fakeRelay();
    relay.me.retrieve.mockResolvedValueOnce({ ...ME, owner: null, owner_people: [] });
    expect((await verifyRelayAccess(relay)).ownerHandle).toBeNull();
  });

  it("fails clearly when the token cannot list chats", async () => {
    const relay = fakeRelay();
    relay.chats.listChats.mockRejectedValueOnce(new RelayAPIError("Unauthorized", { status: 401 }));
    await expect(verifyRelayAccess(relay)).rejects.toThrow(/Listing chats.*HTTP 401.*RELAY_AGENT_TOKEN/);
    expect(relay.me.retrieve).not.toHaveBeenCalled();
  });
});
