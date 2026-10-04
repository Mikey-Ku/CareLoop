import { RelayAPIError, type AgentMe, type WebhookSubscription } from "@relaymessenger/sdk";
import { describe, expect, it, vi } from "vitest";
import { describeRelayError, relayApiOrigin, verifyRelayAccess, type RelayClient } from "../src/relay/relay-client.ts";
import { ACTIVITY_RENEW_MS, MAX_ACTIVITY_RENEWALS, RelayMessenger, toRelayParts, type Every } from "../src/relay/relay-messenger.ts";

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

  it("builds exactly the parts Relay took before the SDK helpers: text, then one buttons part", () => {
    expect(toRelayParts({ text: "Ready?", buttons: ["Let's start", "Not today"] })).toEqual([
      { type: "text", value: "Ready?" },
      { type: "buttons", items: [{ label: "Let's start" }, { label: "Not today" }] },
    ]);
    expect(toRelayParts({ text: "Ready?", buttons: [] })).toEqual([{ type: "text", value: "Ready?" }]);
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

const ACTIVITY_ID = "0199cccc-0000-7000-8000-0000000000cc";

/** The fake client plus Relay's activity calls. */
function fakeRelayWithActivity() {
  const relay = fakeRelay();
  const activity = (id: string | null) => ({
    chat_id: CHAT,
    agent_id: ME.id,
    version: "1",
    activity: id ? { id, text: "Reading your message", emoji: null, updated_at: T, expires_at: T } : null,
  });
  const chats = {
    ...relay.chats,
    setActivity: vi.fn(async (_chatId: string, body: { text: string; activity_id?: string }) => activity(body.activity_id ?? ACTIVITY_ID)),
    clearActivity: vi.fn(async (_chatId: string, _query?: { activity_id?: string }) => undefined),
  };
  return { ...relay, chats };
}

/** A manual timer: `tick()` runs every pending callback once. */
function manualEvery() {
  const timers = new Set<{ fn: () => void; ms: number }>();
  const every: Every = (fn, ms) => {
    const t = { fn, ms };
    timers.add(t);
    return () => timers.delete(t);
  };
  return { every, timers, tick: () => [...timers].forEach((t) => t.fn()) };
}

describe("RelayMessenger activity labels", () => {
  it("sets a label with the SDK, then clears only its own activity id", async () => {
    const relay = fakeRelayWithActivity();
    const timer = manualEvery();
    const messenger = new RelayMessenger(relay, { every: timer.every, log: () => {} });
    await messenger.setActivity(CHAT, "Reading your message");
    expect(relay.chats.setActivity).toHaveBeenCalledWith(CHAT, { text: "Reading your message" });
    expect([...timer.timers].map((t) => t.ms)).toEqual([ACTIVITY_RENEW_MS]);
    await messenger.clearActivity(CHAT);
    expect(relay.chats.clearActivity).toHaveBeenCalledWith(CHAT, { activity_id: ACTIVITY_ID });
    expect(timer.timers.size).toBe(0);
    // Nothing to clear twice.
    await messenger.clearActivity(CHAT);
    expect(relay.chats.clearActivity).toHaveBeenCalledTimes(1);
  });

  it("renews with the activity id every 60 seconds while it is up, and stops after a few renewals", async () => {
    const relay = fakeRelayWithActivity();
    const timer = manualEvery();
    const messenger = new RelayMessenger(relay, { every: timer.every, log: () => {} });
    await messenger.setActivity(CHAT, "Reading your message");
    timer.tick();
    expect(relay.chats.setActivity).toHaveBeenLastCalledWith(CHAT, { text: "Reading your message", activity_id: ACTIVITY_ID });
    for (let i = 0; i < MAX_ACTIVITY_RENEWALS + 2; i++) timer.tick();
    expect(relay.chats.setActivity).toHaveBeenCalledTimes(1 + MAX_ACTIVITY_RENEWALS);
    expect(timer.timers.size).toBe(0);
    // Still cleared by id afterwards.
    await messenger.clearActivity(CHAT);
    expect(relay.chats.clearActivity).toHaveBeenCalledWith(CHAT, { activity_id: ACTIVITY_ID });
  });

  it("stops renewing when Relay says the activity was replaced or cleared (409)", async () => {
    const relay = fakeRelayWithActivity();
    const timer = manualEvery();
    const lines: string[] = [];
    const messenger = new RelayMessenger(relay, { every: timer.every, log: (event, fields) => lines.push(`${event} ${JSON.stringify(fields)}`) });
    await messenger.setActivity(CHAT, "Reading your message");
    relay.chats.setActivity.mockRejectedValueOnce(new RelayAPIError("Activity replaced", { status: 409 }));
    timer.tick();
    await vi.waitFor(() => expect(lines).toHaveLength(1));
    expect(lines[0]).toMatch(/^relay_activity_failed .*HTTP 409/);
    expect(timer.timers.size).toBe(0);
  });

  it("is best effort: a failed set or clear is logged and swallowed", async () => {
    const relay = fakeRelayWithActivity();
    const lines: string[] = [];
    const messenger = new RelayMessenger(relay, { every: manualEvery().every, log: (event, fields) => lines.push(`${event} ${JSON.stringify(fields)}`) });
    relay.chats.setActivity.mockRejectedValueOnce(new RelayAPIError("Forbidden", { status: 403 }));
    await expect(messenger.setActivity(CHAT, "Reading your message")).resolves.toBeUndefined();
    await messenger.clearActivity(CHAT); // nothing was set
    expect(relay.chats.clearActivity).not.toHaveBeenCalled();
    await messenger.setActivity(CHAT, "Reading your message");
    relay.chats.clearActivity.mockRejectedValueOnce(new Error("socket hang up"));
    await expect(messenger.clearActivity(CHAT)).resolves.toBeUndefined();
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^relay_activity_failed .*Setting the activity label.*HTTP 403/);
    expect(lines[1]).toMatch(/^relay_activity_failed .*Clearing the activity label.*socket hang up/);
  });

  it("refuses a label Relay would refuse (over 21 visible characters) without calling Relay", async () => {
    const relay = fakeRelayWithActivity();
    const lines: string[] = [];
    const messenger = new RelayMessenger(relay, { every: manualEvery().every, log: (event) => lines.push(event) });
    await messenger.setActivity(CHAT, "Reading your long message");
    await messenger.setActivity(CHAT, "  ");
    expect(relay.chats.setActivity).not.toHaveBeenCalled();
    expect(lines).toEqual(["relay_activity_failed", "relay_activity_failed"]);
  });

  it("a new label replaces the old one in the same chat (no second renewal timer)", async () => {
    const relay = fakeRelayWithActivity();
    const timer = manualEvery();
    const messenger = new RelayMessenger(relay, { every: timer.every, log: () => {} });
    await messenger.setActivity(CHAT, "Reading your message");
    await messenger.setActivity(CHAT, "Still reading");
    expect(timer.timers.size).toBe(1);
    expect(relay.chats.setActivity).toHaveBeenLastCalledWith(CHAT, { text: "Still reading" });
  });

  it("does nothing on a client slice without the activity calls", async () => {
    const relay = fakeRelay();
    const messenger = new RelayMessenger({ chats: relay.chats });
    await expect(messenger.setActivity(CHAT, "Reading your message")).resolves.toBeUndefined();
    await expect(messenger.clearActivity(CHAT)).resolves.toBeUndefined();
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
