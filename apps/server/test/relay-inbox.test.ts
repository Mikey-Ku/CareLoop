import type { Chat, MessageSendParams, RelayWebhookEvent, WebhookSubscription, WebSocketRunOptions } from "@relaymessenger/sdk";
import { describe, expect, it, vi } from "vitest";
import { familyEmergencyAbout, familyWelcome, photoCouldNotOpen, photoNotYet, photoRejected } from "../src/checkin/copy.ts";
import { familyChats, familyMembers, linkFamilyMember, syncFamilyMembers } from "../src/db/family.ts";
import { getSharing, openDatabase, upsertPatient, type Db } from "../src/db/index.ts";
import { FakeMessenger } from "../src/relay/fake-messenger.ts";
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

function callCreated(callId = nextId()) {
  return envelope("call.created", {
    call: {
      id: callId,
      chat_id: HARRIET_CHAT,
      from: person("harriet.demo"),
      to: [{ id: AGENT_ID, handle: "agent.demo", kind: "agent" }],
      status: "ringing",
      revision: 1,
      created_at: T,
      ringing_at: T,
      answered_at: null,
      ended_at: null,
    },
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
      messages: {
        send: vi.fn(async (chatId: string, _body: MessageSendParams) => ({
          chat_id: chatId,
          message: { id: nextId(), parts: [], created_at: T, sent_at: T, delivery_status: "delivered" as const, is_system_message: false as const },
        })),
      },
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

/** The texts sent to one chat through the fake Relay client, in order. */
const sentTexts = (relay: ReturnType<typeof fakeRelay>, chatId: string) =>
  relay.chats.messages.send.mock.calls.filter(([c]) => c === chatId).map(([, body]) => (body.message.parts[0]?.type === "text" ? body.message.parts[0].value : ""));

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

  it("routes a durable call.created event without waiting for the call lifetime", async () => {
    const { db, relay } = setup();
    const handler = { handle: vi.fn(async () => undefined) };
    const inbox = createRelayInbox({ db, engine: { handleInbound: vi.fn() }, patientHandle: "harriet.demo", relay, callHandler: handler, log: () => {}, now: () => T });
    const event = callCreated();
    await inbox.onEvent(event, { sequence: "call-1" });
    await inbox.drain();
    expect(handler.handle).toHaveBeenCalledTimes(1);
    expect(await processEvent({ db, engine: { handleInbound: vi.fn() }, patientHandle: "harriet.demo", relay, callHandler: handler, log: () => {}, now: () => T }, event)).toBe("call_started");
    expect(handler.handle).toHaveBeenCalledTimes(2);
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

  it("answers a photo kindly (it can't be read yet), never reads its caption as an answer, and marks the chat Read", async () => {
    const { db, inbox, engine, log, relay } = setup();
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
    const messageId = (photo.data as { id: string }).id;
    expect(relay.chats.messages.send).toHaveBeenCalledTimes(1);
    expect(relay.chats.messages.send).toHaveBeenCalledWith(HARRIET_CHAT, {
      message: { parts: [{ type: "text", value: photoNotYet("Harriet") }], idempotency_key: `harriet:photo:${messageId}` },
    });
    expect(relay.chats.markAsRead).toHaveBeenCalledWith(HARRIET_CHAT);
  });

  describe("photos read by the engine", () => {
    const SIGNED = "https://files.example.org/signed?token=synthetic-secret";
    function photoSetup(fetchImpl: typeof fetch) {
      const db = openDatabase(":memory:");
      upsertPatient(db, { id: "harriet", finchnodePatientId: "patient-demo-polypharmacy", preferredName: "Harriet", relayHandle: "harriet.demo", relayChatId: HARRIET_CHAT });
      const photos: { patientId: string; bytes: number[]; mimeType: string; attachmentId: string }[] = [];
      const engine = {
        handleInbound: vi.fn(async () => undefined),
        handlePhoto: vi.fn(async (patientId: string, image: Uint8Array, mimeType: string, attachmentId: string) => {
          photos.push({ patientId, bytes: [...image], mimeType, attachmentId });
          return "label" as const;
        }),
      };
      const relay = fakeRelay();
      const log = vi.fn();
      const inbox = createRelayInbox({ db, engine, patientHandle: "harriet.demo", relay, log, now: () => T, fetch: fetchImpl });
      return { inbox, engine, photos, relay, log };
    }
    const media = (size: number) => ({ type: "media", id: "media_1", url: SIGNED, filename: "label.png", mime_type: "image/png", size_bytes: size, reactions: null });

    it("downloads the signed URL and hands the bytes to handlePhoto; the URL is never logged", async () => {
      const fetchImpl = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-length": "3" } })) as unknown as typeof fetch;
      const { inbox, engine, photos, relay, log } = photoSetup(fetchImpl);
      await inbox.onEvent(textMessage({ chatId: HARRIET_CHAT, parts: [media(3), { type: "text", value: "my pills", reactions: null }] }), { sequence: "1" });
      await inbox.drain();
      expect(photos).toEqual([{ patientId: "harriet", bytes: [1, 2, 3], mimeType: "image/png", attachmentId: "media_1" }]);
      expect(engine.handleInbound).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledWith("relay_photo_handled", expect.objectContaining({ outcome: "label" }));
      expect(JSON.stringify(log.mock.calls)).not.toContain("synthetic-secret");
      expect(relay.chats.markAsRead).toHaveBeenCalledWith(HARRIET_CHAT);
    });

    it("a caption the safety screen catches takes the safety path first; the photo is still read", async () => {
      const fetchImpl = vi.fn(async () => new Response(new Uint8Array([1]), { status: 200 })) as unknown as typeof fetch;
      const { inbox, engine, photos } = photoSetup(fetchImpl);
      const caption = "I fell and my arm won't stop bleeding";
      const event = textMessage({ chatId: HARRIET_CHAT, parts: [media(1), { type: "text", value: caption, reactions: null }] });
      await inbox.onEvent(event, { sequence: "1" });
      await inbox.drain();
      expect(engine.handleInbound).toHaveBeenCalledWith({ chatId: HARRIET_CHAT, messageId: (event.data as { id: string }).id, text: caption, at: T });
      expect(photos).toHaveLength(1);
    });

    it("a photo over 8 MB is never downloaded and she is asked for a regular one", async () => {
      const fetchImpl = vi.fn() as unknown as typeof fetch;
      const { inbox, engine, relay } = photoSetup(fetchImpl);
      await inbox.onEvent(textMessage({ chatId: HARRIET_CHAT, parts: [media(9 * 1024 * 1024)] }), { sequence: "1" });
      await inbox.drain();
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(engine.handlePhoto).not.toHaveBeenCalled();
      expect(relay.chats.messages.send).toHaveBeenCalledWith(HARRIET_CHAT, expect.objectContaining({ message: expect.objectContaining({ parts: [{ type: "text", value: photoRejected() }] }) }));
    });

    it("a failed download gets a kind ask to send it again", async () => {
      const fetchImpl = vi.fn(async () => new Response("gone", { status: 404 })) as unknown as typeof fetch;
      const { inbox, engine, relay } = photoSetup(fetchImpl);
      await inbox.onEvent(textMessage({ chatId: HARRIET_CHAT, parts: [media(10)] }), { sequence: "1" });
      await inbox.drain();
      expect(engine.handlePhoto).not.toHaveBeenCalled();
      expect(relay.chats.messages.send).toHaveBeenCalledWith(
        HARRIET_CHAT,
        expect.objectContaining({ message: expect.objectContaining({ parts: [{ type: "text", value: photoCouldNotOpen("Harriet") }] }) }),
      );
    });
  });

  it("a photo in a family chat gets no reply", async () => {
    const { db, inbox, relay } = setup();
    linkFamilyMember(db, "sarah.demo", SARAH_CHAT, null, T);
    const photo = textMessage({
      chatId: SARAH_CHAT,
      sender: "sarah.demo",
      parts: [{ type: "media", id: nextId(), url: "https://files.example.org/signed", filename: "p.jpg", mime_type: "image/jpeg", size_bytes: 10, reactions: null }],
    });
    await inbox.onEvent(photo, { sequence: "1" });
    await inbox.drain();
    expect(relay.chats.messages.send).not.toHaveBeenCalled();
  });

  it("a family photo's caption is read like their text: an emergency gets the 911-now reply", async () => {
    const { db, inbox, relay } = setup();
    linkFamilyMember(db, "sarah.demo", SARAH_CHAT, "Sarah", T);
    const media = { type: "media", id: nextId(), url: "https://files.example.org/signed", filename: "p.jpg", mime_type: "image/jpeg", size_bytes: 10, reactions: null };
    const caption = { type: "text", value: "Mom fell and can't get up, she's bleeding", reactions: null };
    await inbox.onEvent(textMessage({ chatId: SARAH_CHAT, sender: "sarah.demo", parts: [media, caption] }), { sequence: "1" });
    await inbox.drain();
    expect(sentTexts(relay, SARAH_CHAT)).toEqual([familyEmergencyAbout("Harriet")]);
    expect(sentTexts(relay, HARRIET_CHAT)).toEqual([]);
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
    expect(relay.chats.markAsRead).toHaveBeenCalledWith(TOM_CHAT);
    expect(log).toHaveBeenCalledWith("relay_family_linked", expect.objectContaining({ handle: "tom.demo", chat_id: TOM_CHAT }));
    // Passed on to her as plain text (no display name: the handle), never through the engine.
    expect(sentTexts(relay, HARRIET_CHAT)).toEqual(['tom.demo says: "Hi, this is Tom"']);
    expect(log).toHaveBeenCalledWith("relay_family_message", {
      event_id: expect.any(String),
      event_type: "message.received",
      handle: "tom.demo",
      chat_id: TOM_CHAT,
      patient_ids: ["harriet"],
      outcomes: ["passed_on"],
    });
  });

  it("a linked family chat's messages are passed on as plain text, logged without their text, and never answer her check-in", async () => {
    const { db, inbox, engine, log, relay } = setup();
    linkFamilyMember(db, "sarah.demo", SARAH_CHAT, "Sarah", T);
    for (const [i, text] of ["Let's start", "Not today", "Sharing", "Everything"].entries())
      await inbox.onEvent(textMessage({ chatId: SARAH_CHAT, sender: "sarah.demo", text }), { sequence: String(i + 1) });
    await inbox.drain();
    expect(engine.handleInbound).not.toHaveBeenCalled();
    expect(sentTexts(relay, HARRIET_CHAT)).toEqual(['Sarah says: "Let\'s start"', 'Sarah says: "Not today"', 'Sarah says: "Sharing"', 'Sarah says: "Everything"']);
    expect(getSharing(db, "harriet")).toBe("status");
    expect(log.mock.calls.filter(([event]) => event === "relay_family_message")).toHaveLength(4);
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

describe("family welcome", () => {
  const WELCOME = familyWelcome("Harriet");
  const welcomesTo = (relay: ReturnType<typeof fakeRelay>, chatId: string) =>
    relay.chats.messages.send.mock.calls.filter(([c, body]) => c === chatId && body.message.parts[0]?.type === "text" && body.message.parts[0].value === WELCOME);

  it("contact.added for a configured family member sends the welcome once, through Relay, keyed by patient and handle", async () => {
    const { inbox, relay, log } = setup();
    await inbox.onEvent(contactAdded("@Sarah.Demo", SARAH_CHAT), { sequence: "1" });
    await inbox.drain();
    expect(relay.chats.messages.send).toHaveBeenCalledTimes(1);
    expect(relay.chats.messages.send).toHaveBeenCalledWith(SARAH_CHAT, {
      message: { parts: [{ type: "text", value: WELCOME }], idempotency_key: "welcome:harriet:sarah.demo" },
    });
    expect(log).toHaveBeenCalledWith("relay_family_welcomed", expect.objectContaining({ handle: "sarah.demo", chat_id: SARAH_CHAT, patient_id: "harriet" }));
  });

  it("her later first message, a repeat contact.added and a rename send nothing more", async () => {
    const { db, inbox, relay } = setup();
    await inbox.onEvent(contactAdded("sarah.demo", SARAH_CHAT), { sequence: "1" });
    await inbox.onEvent(textMessage({ chatId: SARAH_CHAT, sender: "sarah.demo", text: "Hi" }), { sequence: "2" });
    await inbox.onEvent(contactAdded("sarah.demo", SARAH_CHAT), { sequence: "3" });
    await inbox.drain();
    linkFamilyMember(db, "sarah.demo", SARAH_CHAT, "Sarah New Name", T);
    await inbox.onEvent(contactAdded("sarah.demo", SARAH_CHAT), { sequence: "4" });
    await inbox.drain();
    expect(welcomesTo(relay, SARAH_CHAT)).toHaveLength(1);
    // Besides the one welcome, only her "Hi" passed on to Harriet and its acknowledgement.
    expect(relay.chats.messages.send).toHaveBeenCalledTimes(3);
  });

  it("a family member's first message, when contact.added never came, gets the welcome; the engine never sees it", async () => {
    const { inbox, relay, engine } = setup();
    await inbox.onEvent(textMessage({ chatId: TOM_CHAT, sender: "Tom.Demo", text: "Hi, this is Tom" }), { sequence: "1" });
    await inbox.onEvent(textMessage({ chatId: TOM_CHAT, sender: "tom.demo", text: "Anyone there?" }), { sequence: "2" });
    await inbox.drain();
    expect(welcomesTo(relay, TOM_CHAT)).toHaveLength(1);
    expect(relay.chats.messages.send.mock.calls[0]![1].message.idempotency_key).toBe("welcome:harriet:tom.demo");
    expect(engine.handleInbound).not.toHaveBeenCalled();
  });

  it("re-linking to another chat sends no second welcome", async () => {
    const { db, inbox, relay } = setup();
    linkFamilyMember(db, "sarah.demo", SARAH_CHAT, null, T);
    await inbox.onEvent(contactAdded("sarah.demo", OTHER_CHAT), { sequence: "1" });
    await inbox.drain();
    expect(familyChats(db, "harriet").find((f) => f.handle === "sarah.demo")?.chatId).toBe(OTHER_CHAT);
    expect(relay.chats.messages.send).not.toHaveBeenCalled();
  });

  it("the senior, strangers and group chats get no welcome", async () => {
    const { inbox, relay } = setup({ linked: false });
    await inbox.onEvent(contactAdded("harriet.demo", HARRIET_CHAT), { sequence: "1" });
    await inbox.onEvent(contactAdded("stranger.demo", OTHER_CHAT), { sequence: "2" });
    await inbox.onEvent(textMessage({ chatId: GROUP_CHAT, isGroup: true, sender: "sarah.demo", text: "@agent hi" }), { sequence: "3" });
    await inbox.drain();
    expect(relay.chats.messages.send).not.toHaveBeenCalled();
  });

  it("uses the senior's preferred name from her patient row", async () => {
    const db = openDatabase(":memory:");
    upsertPatient(db, { id: "harriet", finchnodePatientId: "patient-demo-polypharmacy", preferredName: "Hattie", relayHandle: "harriet.demo" });
    syncFamilyMembers(db, "harriet", ["sarah.demo"]);
    const messenger = new FakeMessenger({ now: () => T });
    const deps = { db, engine: { handleInbound: vi.fn() }, patientHandle: "harriet.demo", relay: fakeRelay(), messenger, log: () => {}, now: () => T };
    expect(await processEvent(deps, contactAdded("sarah.demo", SARAH_CHAT))).toBe("family_linked");
    expect(messenger.inChat(SARAH_CHAT).map((m) => m.text)).toEqual([familyWelcome("Hattie")]);
    expect(deps.relay.chats.messages.send).not.toHaveBeenCalled();
  });

  it("a failed send is logged and never fails the event or undoes the link", async () => {
    const { db, inbox, relay, log } = setup();
    relay.chats.messages.send.mockRejectedValueOnce(new Error("503"));
    await inbox.onEvent(contactAdded("sarah.demo", SARAH_CHAT), { sequence: "1" });
    await inbox.drain();
    expect(rows(db)[0]).toMatchObject({ processedAt: T, error: null });
    expect(familyChats(db, "harriet").map((f) => f.chatId)).toEqual([SARAH_CHAT]);
    expect(log).toHaveBeenCalledWith("relay_family_welcome_failed", expect.objectContaining({ handle: "sarah.demo", error: expect.stringContaining("503") }));
  });

  it("a family member first linked by a full sync gets the welcome after the sync resolves", async () => {
    const db = openDatabase(":memory:");
    upsertPatient(db, { id: "harriet", finchnodePatientId: "patient-demo-polypharmacy", preferredName: "Harriet", relayHandle: "harriet.demo" });
    syncFamilyMembers(db, "harriet", ["sarah.demo", "tom.demo"]);
    linkFamilyMember(db, "tom.demo", TOM_CHAT, null, T);
    const chat = (id: string, handle: string): Chat => ({ id, display_name: null, handles: [person(handle)], is_group: false, created_at: T, updated_at: T });
    const relay = fakeRelay({ chats: [chat(SARAH_CHAT, "sarah.demo"), chat(TOM_CHAT, "tom.demo"), chat(HARRIET_CHAT, "harriet.demo")] });
    const inbox = createRelayInbox({ db, engine: { handleInbound: vi.fn() }, patientHandle: "harriet.demo", relay, log: () => {}, now: () => T });
    await inbox.onFullSync({ throughSequence: "91", reason: "checkpoint_outside_retention" });
    await inbox.drain();
    // Sarah is new; Tom was already linked.
    expect(welcomesTo(relay, SARAH_CHAT)).toHaveLength(1);
    expect(welcomesTo(relay, TOM_CHAT)).toHaveLength(0);
    expect(relay.chats.messages.send).toHaveBeenCalledTimes(1);
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

  it("sends the family welcome through the messenger it is given, not one of its own", async () => {
    const { db, engine } = setup();
    const messenger = new FakeMessenger({ now: () => T });
    const relay = fakeRelay();
    relay.websocket.run.mockImplementation(async (options: WebSocketRunOptions) => {
      await options.onEvent(contactAdded("sarah.demo", SARAH_CHAT), { sequence: "1" });
      await vi.waitFor(() => expect(messenger.inChat(SARAH_CHAT).map((m) => m.text)).toEqual([familyWelcome("Harriet")]));
    });
    await runRelayInbox({ relay, db, engine, messenger, patientHandle: "harriet.demo", log: () => {} });
    expect(relay.chats.messages.send).not.toHaveBeenCalled();
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
