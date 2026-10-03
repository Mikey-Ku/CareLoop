import type { Chat, RelayWebhookEvent, WebhookSubscription, WebSocketRunOptions } from "@relaymessenger/sdk";
import { describe, expect, it, vi } from "vitest";
import { familyChats, familyMembers, linkFamilyMember, syncFamilyMembers } from "../src/db/family.ts";
import { openDatabase, upsertPatient, type Db } from "../src/db/index.ts";
import { acceptEvent, assertNoWebhookSubscriptions, createRelayInbox, processEvent, runRelayInbox } from "../src/relay/inbox.ts";
import type { InboundMessage } from "../src/relay/messenger.ts";
import type { RelayClient } from "../src/relay/relay-client.ts";

// Synthetic ids and handles only.
const HARRIET_CHAT = "0199aaaa-0000-7000-8000-000000000001";
const OTHER_CHAT = "0199aaaa-0000-7000-8000-000000000002";
const GROUP_CHAT = "0199aaaa-0000-7000-8000-000000000003";
const SARAH_CHAT = "0199aaaa-0000-7000-8000-000000000004";
const TOM_CHAT = "0199aaaa-0000-7000-8000-000000000005";
const AGENT_ID = "0199aaaa-0000-7000-8000-0000000000aa";
const T = "2026-09-01T13:00:00Z";

let counter = 0;
const nextId = () => `0199bbbb-0000-7000-8000-${String(++counter).padStart(12, "0")}`;

function person(handle: string) {
  return {
    id: nextId(),
    handle,
    kind: "user" as const,
    joined_at: T,
    display_name: null,
    image_url: null,
    subtitle: null,
    verified: false,
    is_contact: true,
  };
}

function envelope<D>(eventType: string, data: D, eventId = nextId()) {
  return {
    api_version: "v1",
    webhook_version: "2026-08-30",
    event_type: eventType,
    event_id: eventId,
    created_at: T,
    trace_id: "trace-synthetic",
    agent_id: AGENT_ID,
    data,
  } as unknown as RelayWebhookEvent;
}

function textMessage(opts: { chatId: string; text?: string; sender?: string; isGroup?: boolean; replyTo?: string; parts?: unknown[]; eventId?: string }) {
  return envelope(
    "message.received",
    {
      chat: { id: opts.chatId, is_group: opts.isGroup ?? false },
      id: nextId(),
      direction: "inbound",
      sender_handle: person(opts.sender ?? "harriet.demo"),
      parts: opts.parts ?? [{ type: "text", value: opts.text ?? "hello", reactions: null }],
      sent_at: T,
      ...(opts.replyTo ? { reply_to: { message_id: opts.replyTo, part_index: 1 } } : {}),
    },
    opts.eventId,
  );
}

function contactAdded(handle: string, chatId: string) {
  return envelope("contact.added", {
    contact: { id: nextId(), handle, display_name: "Synthetic Person", timezone: null, age_range: null, links: [], about: null },
    chat_id: chatId,
  });
}

function fakeRelay(overrides: { chats?: Chat[]; subscriptions?: unknown[] } = {}) {
  const chats = overrides.chats ?? [];
  return {
    chats: {
      create: vi.fn(),
      update: vi.fn(),
      listChats: vi.fn(async () => ({
        data: chats,
        async *[Symbol.asyncIterator]() {
          yield* chats;
        },
      })),
      markAsRead: vi.fn(async () => undefined),
      messages: { send: vi.fn() },
    },
    me: { retrieve: vi.fn() },
    webhookSubscriptions: { list: vi.fn(async () => ({ subscriptions: (overrides.subscriptions ?? []) as WebhookSubscription[] })) },
    websocket: { run: vi.fn(async (_options: WebSocketRunOptions) => undefined) },
  } satisfies RelayClient;
}

function setup(opts: { linked?: boolean; handle?: string | null } = {}) {
  const db = openDatabase(":memory:");
  upsertPatient(db, {
    id: "harriet",
    finchnodePatientId: "patient-demo-polypharmacy",
    preferredName: "Harriet",
    relayHandle: opts.handle === undefined ? "harriet.demo" : opts.handle,
    relayChatId: opts.linked === false ? null : HARRIET_CHAT,
  });
  // Two configured family members, neither has messaged the agent yet.
  syncFamilyMembers(db, "harriet", ["sarah.demo", "tom.demo"]);
  const handled: InboundMessage[] = [];
  const engine = { handleInbound: vi.fn(async (m: InboundMessage) => void handled.push(m)) };
  const relay = fakeRelay();
  const log = vi.fn();
  const inbox = createRelayInbox({ db, engine, patientHandle: "@Harriet.Demo", relay, log, now: () => T });
  return { db, engine, handled, relay, log, inbox };
}

const rows = (db: Db) =>
  db.prepare("SELECT event_id AS eventId, sequence, event_type AS eventType, processed_at AS processedAt, error FROM relay_events ORDER BY rowid").all() as {
    eventId: string;
    sequence: string;
    eventType: string;
    processedAt: string | null;
    error: string | null;
  }[];

const chatIdOf = (db: Db) => (db.prepare("SELECT relay_chat_id AS c, relay_handle AS h FROM patients WHERE id = 'harriet'").get() as { c: string | null; h: string | null });

describe("onEvent: commit before ACK", () => {
  it("has the event in SQLite by the time onEvent resolves, before any processing", async () => {
    const { db, inbox, engine } = setup();
    const event = textMessage({ chatId: HARRIET_CHAT, text: "Let's start" });
    await inbox.onEvent(event, { sequence: "42" });
    expect(rows(db)).toEqual([{ eventId: event.event_id, sequence: "42", eventType: "message.received", processedAt: null, error: null }]);
    expect(engine.handleInbound).not.toHaveBeenCalled();
    await inbox.drain();
    expect(engine.handleInbound).toHaveBeenCalledTimes(1);
    expect(rows(db)[0]!.processedAt).toBe(T);
  });

  it("ignores a duplicate event_id: one row, handled once", async () => {
    const { db, inbox, engine, log } = setup();
    const event = textMessage({ chatId: HARRIET_CHAT, text: "Good" });
    await inbox.onEvent(event, { sequence: "1" });
    await inbox.drain();
    await inbox.onEvent(event, { sequence: "1" });
    await inbox.drain();
    expect(rows(db)).toHaveLength(1);
    expect(engine.handleInbound).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith("relay_event_duplicate", expect.objectContaining({ event_id: event.event_id }));
  });

  it("acceptEvent reports whether the row is new", () => {
    const { db } = setup();
    const event = textMessage({ chatId: HARRIET_CHAT });
    expect(acceptEvent(db, event, "7", T)).toBe(true);
    expect(acceptEvent(db, event, "7", T)).toBe(false);
  });

  it("wakes the processor on its own after onEvent", async () => {
    const { inbox, engine } = setup();
    await inbox.onEvent(textMessage({ chatId: HARRIET_CHAT, text: "Fine" }), { sequence: "1" });
    await vi.waitFor(() => expect(engine.handleInbound).toHaveBeenCalledTimes(1));
    await inbox.stop();
  });
});

describe("message.received", () => {
  it("passes a button tap to the engine as the label text, with her chat id and reply_to", async () => {
    const { inbox, handled, relay } = setup();
    const question = nextId();
    const event = textMessage({ chatId: HARRIET_CHAT, text: "Let's start", replyTo: question });
    await inbox.onEvent(event, { sequence: "1" });
    await inbox.drain();
    expect(handled).toEqual([
      { chatId: HARRIET_CHAT, messageId: (event.data as { id: string }).id, text: "Let's start", replyTo: question, at: T },
    ]);
    expect(relay.chats.markAsRead).toHaveBeenCalledWith(HARRIET_CHAT);
  });

  it("joins several text parts and leaves replyTo out when there is none", async () => {
    const { db, handled } = setup();
    const event = textMessage({
      chatId: HARRIET_CHAT,
      parts: [
        { type: "text", value: "A little tired", reactions: null },
        { type: "link", value: "https://example.org", reactions: null },
        { type: "text", value: "but fine", reactions: null },
      ],
    });
    const outcome = await processEvent({ db, engine: { handleInbound: async (m) => void handled.push(m) }, patientHandle: "harriet.demo", relay: fakeRelay(), log: () => {} }, event);
    expect(outcome).toBe("handled");
    expect(handled[0]!.text).toBe("A little tired\nbut fine");
    expect(handled[0]).not.toHaveProperty("replyTo");
  });

  it("ignores a message from a chat that belongs to no patient", async () => {
    const { db, inbox, engine, log } = setup();
    await inbox.onEvent(textMessage({ chatId: OTHER_CHAT, sender: "stranger.demo", text: "hi" }), { sequence: "1" });
    await inbox.drain();
    expect(engine.handleInbound).not.toHaveBeenCalled();
    expect(rows(db)[0]).toMatchObject({ processedAt: T, error: null });
    expect(log).toHaveBeenCalledWith("relay_unknown_chat", expect.objectContaining({ chat_id: OTHER_CHAT }));
  });

  it("ignores group chat messages (the app uses no groups)", async () => {
    const { inbox, engine } = setup();
    await inbox.onEvent(textMessage({ chatId: GROUP_CHAT, isGroup: true, sender: "sarah.demo", text: "@agent how is Mom?" }), { sequence: "1" });
    await inbox.drain();
    expect(engine.handleInbound).not.toHaveBeenCalled();
  });

  it("ignores outbound echoes and other agents", async () => {
    const { db } = setup();
    const deps = { db, engine: { handleInbound: vi.fn() }, patientHandle: "harriet.demo", relay: fakeRelay(), log: () => {} };
    const outbound = textMessage({ chatId: HARRIET_CHAT });
    (outbound.data as { direction: string }).direction = "outbound";
    expect(await processEvent(deps, outbound)).toBe("outbound");
    const fromAgent = textMessage({ chatId: HARRIET_CHAT });
    (fromAgent.data as { sender_handle: { kind: string } }).sender_handle.kind = "agent";
    expect(await processEvent(deps, fromAgent)).toBe("agent_sender_ignored");
    expect(deps.engine.handleInbound).not.toHaveBeenCalled();
  });

  it("skips a photo for now (run 6) without calling the engine", async () => {
    const { db, inbox, engine, log } = setup();
    const photo = textMessage({
      chatId: HARRIET_CHAT,
      parts: [
        { type: "media", id: nextId(), url: "https://files.example.org/signed", filename: "paper.jpg", mime_type: "image/jpeg", size_bytes: 1000, reactions: null },
        { type: "text", value: "my discharge paper", reactions: null },
      ],
    });
    await inbox.onEvent(photo, { sequence: "1" });
    await inbox.drain();
    expect(engine.handleInbound).not.toHaveBeenCalled();
    expect(rows(db)[0]).toMatchObject({ processedAt: T, error: null });
    expect(log).toHaveBeenCalledWith("relay_media_skipped", expect.anything());
  });

  it("links her chat from her first message when contact.added never came", async () => {
    const { db, inbox, engine } = setup({ linked: false });
    await inbox.onEvent(textMessage({ chatId: OTHER_CHAT, sender: "harriet.demo", text: "hi" }), { sequence: "1" });
    await inbox.drain();
    expect(chatIdOf(db).c).toBe(OTHER_CHAT);
    expect(engine.handleInbound).toHaveBeenCalledWith(expect.objectContaining({ chatId: OTHER_CHAT, text: "hi" }));
  });

  it("links a family member from their first direct message when contact.added never came; the engine never sees it", async () => {
    const { db, inbox, engine, log, relay } = setup();
    await inbox.onEvent(textMessage({ chatId: TOM_CHAT, sender: "Tom.Demo", text: "Hi, this is Tom" }), { sequence: "1" });
    await inbox.drain();
    expect(familyChats(db, "harriet")).toEqual([{ handle: "tom.demo", displayName: null, chatId: TOM_CHAT }]);
    expect(engine.handleInbound).not.toHaveBeenCalled();
    expect(relay.chats.markAsRead).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith("relay_family_linked", expect.objectContaining({ handle: "tom.demo", chat_id: TOM_CHAT }));
    expect(log).toHaveBeenCalledWith("relay_family_message_ignored", { event_id: expect.any(String), event_type: "message.received", handle: "tom.demo", chat_id: TOM_CHAT, patient_ids: ["harriet"] });
  });

  it("a linked family chat's messages are logged without their text and never answer her check-in", async () => {
    const { db, inbox, engine, log } = setup();
    linkFamilyMember(db, "sarah.demo", SARAH_CHAT, null, T);
    for (const [i, text] of ["Let's start", "Not today", "Sharing", "Everything"].entries())
      await inbox.onEvent(textMessage({ chatId: SARAH_CHAT, sender: "sarah.demo", text }), { sequence: String(i + 1) });
    await inbox.drain();
    expect(engine.handleInbound).not.toHaveBeenCalled();
    expect(log.mock.calls.filter(([event]) => event === "relay_family_message_ignored")).toHaveLength(4);
    expect(JSON.stringify(log.mock.calls)).not.toContain("Not today");
    expect(rows(db).every((r) => r.processedAt === T && r.error === null)).toBe(true);
  });

  it("a stranger writing from an unknown chat links nobody", async () => {
    const { db, inbox, engine } = setup();
    await inbox.onEvent(textMessage({ chatId: OTHER_CHAT, sender: "stranger.demo", text: "hello" }), { sequence: "1" });
    await inbox.drain();
    expect(familyChats(db, "harriet")).toEqual([]);
    expect(chatIdOf(db).c).toBe(HARRIET_CHAT);
    expect(engine.handleInbound).not.toHaveBeenCalled();
  });

  it("records a processing error on the row and still processes the next event", async () => {
    const { db, inbox, engine } = setup();
    engine.handleInbound.mockRejectedValueOnce(new Error("engine blew up"));
    const first = textMessage({ chatId: HARRIET_CHAT, text: "one" });
    const second = textMessage({ chatId: HARRIET_CHAT, text: "two" });
    await inbox.onEvent(first, { sequence: "1" });
    await inbox.onEvent(second, { sequence: "2" });
    await inbox.drain();
    expect(engine.handleInbound).toHaveBeenCalledTimes(2);
    expect(rows(db).map((r) => [r.sequence, r.processedAt, r.error])).toEqual([
      ["1", T, "engine blew up"],
      ["2", T, null],
    ]);
  });

  it("processes events in arrival order", async () => {
    const { inbox, handled } = setup();
    for (const [i, text] of ["a", "b", "c"].entries()) await inbox.onEvent(textMessage({ chatId: HARRIET_CHAT, text }), { sequence: String(i + 1) });
    await inbox.drain();
    expect(handled.map((m) => m.text)).toEqual(["a", "b", "c"]);
  });

  it("a failed read receipt does not turn a handled message into an error", async () => {
    const { db, inbox, relay, engine } = setup();
    relay.chats.markAsRead.mockRejectedValueOnce(new Error("network"));
    await inbox.onEvent(textMessage({ chatId: HARRIET_CHAT, text: "ok" }), { sequence: "1" });
    await inbox.drain();
    expect(engine.handleInbound).toHaveBeenCalledTimes(1);
    expect(rows(db)[0]!.error).toBeNull();
  });
});

describe("contact.added", () => {
  it("links the senior's direct chat when her handle matches (case and @ ignored)", async () => {
    const { db, inbox, log } = setup({ linked: false });
    await inbox.onEvent(contactAdded("Harriet.Demo", HARRIET_CHAT), { sequence: "1" });
    await inbox.drain();
    expect(chatIdOf(db)).toEqual({ c: HARRIET_CHAT, h: "harriet.demo" });
    expect(log).toHaveBeenCalledWith("relay_patient_linked", expect.objectContaining({ patient_id: "harriet", chat_id: HARRIET_CHAT }));
    // Her chat is never a family chat.
    expect(familyChats(db, "harriet")).toEqual([]);
  });

  it("links the only patient when no patient has a handle yet, and stores the handle", async () => {
    const { db, inbox } = setup({ linked: false, handle: null });
    await inbox.onEvent(contactAdded("harriet.demo", HARRIET_CHAT), { sequence: "1" });
    await inbox.drain();
    expect(chatIdOf(db)).toEqual({ c: HARRIET_CHAT, h: "harriet.demo" });
  });

  it("links a configured family member's own chat (their family chat), not the senior's", async () => {
    const { db, inbox, log } = setup({ linked: false });
    await inbox.onEvent(contactAdded("@Sarah.Demo", SARAH_CHAT), { sequence: "1" });
    await inbox.drain();
    expect(chatIdOf(db).c).toBeNull();
    expect(familyChats(db, "harriet")).toEqual([{ handle: "sarah.demo", displayName: "Synthetic Person", chatId: SARAH_CHAT }]);
    expect(familyMembers(db, "harriet").find((m) => m.handle === "tom.demo")?.chatId).toBeNull();
    expect(log).toHaveBeenCalledWith("relay_family_linked", expect.objectContaining({ handle: "sarah.demo", chat_id: SARAH_CHAT, patient_ids: ["harriet"] }));
  });

  it("only logs a contact who is neither the senior nor a configured family member", async () => {
    const { db, inbox, log } = setup();
    await inbox.onEvent(contactAdded("stranger.demo", OTHER_CHAT), { sequence: "1" });
    await inbox.drain();
    expect(familyChats(db, "harriet")).toEqual([]);
    expect(log).toHaveBeenCalledWith("relay_contact_added", expect.objectContaining({ handle: "stranger.demo", chat_id: OTHER_CHAT }));
  });
});

describe("other events", () => {
  it("marks unhandled event types processed", async () => {
    const { db, inbox, engine } = setup();
    await inbox.onEvent(envelope("chat.typing_indicator.started", { chat_id: HARRIET_CHAT, contact: person("harriet.demo") }), { sequence: "1" });
    await inbox.onEvent(envelope("message.delivered", { chat: { id: HARRIET_CHAT }, id: nextId(), direction: "outbound", sender_handle: person("x"), parts: [] }), { sequence: "2" });
    await inbox.drain();
    expect(rows(db).every((r) => r.processedAt === T && r.error === null)).toBe(true);
    expect(engine.handleInbound).not.toHaveBeenCalled();
  });
});

describe("onFullSync", () => {
  it("walks every chat, re-links her direct chat and records the sync before resolving", async () => {
    const db = openDatabase(":memory:");
    upsertPatient(db, { id: "harriet", finchnodePatientId: "patient-demo-polypharmacy", preferredName: "Harriet", relayHandle: "harriet.demo" });
    syncFamilyMembers(db, "harriet", ["sarah.demo", "tom.demo"]);
    const chat = (id: string, isGroup: boolean, handles: string[]): Chat => ({
      id,
      display_name: null,
      handles: handles.map(person),
      is_group: isGroup,
      created_at: T,
      updated_at: T,
    });
    const relay = fakeRelay({
      chats: [
        chat(GROUP_CHAT, true, ["harriet.demo", "sarah.demo"]),
        chat(SARAH_CHAT, false, ["sarah.demo"]),
        chat(OTHER_CHAT, false, ["stranger.demo"]),
        chat(HARRIET_CHAT, false, ["harriet.demo"]),
      ],
    });
    const inbox = createRelayInbox({ db, engine: { handleInbound: vi.fn() }, patientHandle: "harriet.demo", relay, log: () => {}, now: () => T });
    await inbox.onFullSync({ throughSequence: "91", reason: "checkpoint_outside_retention" });
    expect(chatIdOf(db).c).toBe(HARRIET_CHAT);
    // Family chats are re-linked too; a group chat never becomes one, and Tom has no chat yet.
    expect(familyChats(db, "harriet").map((f) => [f.handle, f.chatId])).toEqual([["sarah.demo", SARAH_CHAT]]);
    expect(db.prepare("SELECT through_sequence AS s, reason AS r, chats_seen AS n FROM relay_full_syncs").all()).toEqual([{ s: "91", r: "checkpoint_outside_retention", n: 4 }]);
  });

  it("rejects without recording when a chat read fails, so the SDK does not complete the sync", async () => {
    const db = openDatabase(":memory:");
    const relay = fakeRelay();
    relay.chats.listChats.mockRejectedValueOnce(new Error("503"));
    const inbox = createRelayInbox({ db, engine: { handleInbound: vi.fn() }, patientHandle: "harriet.demo", relay, log: () => {} });
    await expect(inbox.onFullSync({ throughSequence: "5", reason: "checkpoint_outside_retention" })).rejects.toThrow("503");
    expect(db.prepare("SELECT COUNT(*) AS n FROM relay_full_syncs").get()).toEqual({ n: 0 });
  });
});

describe("assertNoWebhookSubscriptions", () => {
  it("passes with zero subscriptions", async () => {
    await expect(assertNoWebhookSubscriptions(fakeRelay())).resolves.toBeUndefined();
  });

  it("throws a message that says how to remove them, and deletes nothing", async () => {
    const relay = fakeRelay({
      subscriptions: [{ id: "sub-1", target_url: "https://hooks.example.org/relay", subscribed_events: ["message.received"], is_active: true, created_at: T, updated_at: T }],
    });
    const error = await assertNoWebhookSubscriptions(relay).catch((e: unknown) => e as Error);
    expect(error).toBeInstanceOf(Error);
    expect(error!.message).toMatch(/1 webhook subscription/);
    expect(error!.message).toContain("sub-1");
    expect(error!.message).toMatch(/WebSocket/);
    expect(error!.message).toMatch(/Relay Console/);
    expect(error!.message).toContain("webhookSubscriptions.delete");
  });
});

describe("runRelayInbox", () => {
  it("refuses to connect while webhook subscriptions exist", async () => {
    const db = openDatabase(":memory:");
    const relay = fakeRelay({ subscriptions: [{ id: "sub-1", target_url: "https://hooks.example.org" }] });
    await expect(runRelayInbox({ relay, db, engine: { handleInbound: vi.fn() }, patientHandle: "harriet.demo", log: () => {} })).rejects.toThrow(/webhook subscription/);
    expect(relay.websocket.run).not.toHaveBeenCalled();
  });

  it("wires the socket callbacks to the inbox and processes what arrives", async () => {
    const { db, engine } = setup();
    const relay = fakeRelay();
    const controller = new AbortController();
    const event = textMessage({ chatId: HARRIET_CHAT, text: "Not today" });
    let committedBeforeResolve = false;
    relay.websocket.run.mockImplementation(async (options: WebSocketRunOptions) => {
      expect(options.signal).toBe(controller.signal);
      await options.onEvent(event, { sequence: "1" });
      committedBeforeResolve = db.prepare("SELECT 1 FROM relay_events WHERE event_id = ?").get(event.event_id) !== undefined;
      await vi.waitFor(() => expect(engine.handleInbound).toHaveBeenCalled());
    });
    await runRelayInbox({ relay, db, engine, patientHandle: "harriet.demo", signal: controller.signal, log: () => {} });
    expect(committedBeforeResolve).toBe(true);
    expect(engine.handleInbound).toHaveBeenCalledWith(expect.objectContaining({ text: "Not today", chatId: HARRIET_CHAT }));
  });

  it("first processes events a previous run committed but never processed", async () => {
    const { db, engine } = setup();
    acceptEvent(db, textMessage({ chatId: HARRIET_CHAT, text: "left over" }), "9", T);
    const relay = fakeRelay();
    relay.websocket.run.mockImplementation(async () => {
      await vi.waitFor(() => expect(engine.handleInbound).toHaveBeenCalled());
    });
    await runRelayInbox({ relay, db, engine, patientHandle: "harriet.demo", log: () => {} });
    expect(engine.handleInbound).toHaveBeenCalledWith(expect.objectContaining({ text: "left over" }));
  });
});
