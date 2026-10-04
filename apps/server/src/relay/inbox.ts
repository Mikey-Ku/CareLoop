import type { CallWebhookEvent, MessageWebhookData, RelayWebhookEvent, WebSocketFullSyncContext } from "@relaymessenger/sdk";
import { familyWelcome, photoCouldNotOpen, photoNotYet, photoRejected } from "../checkin/copy.ts";
import type { CheckinEngine } from "../checkin/engine-types.ts";
import { normalizeHandle } from "../config.ts";
import { getCheckinPatient, patientForChat } from "../db/checkins.ts";
import { familyMembersForChat, linkFamilyMember } from "../db/family.ts";
import type { Db } from "../db/index.ts";
import { MAX_IMAGE_BYTES } from "../llm/types.ts";
import type { InboundMessage, Messenger } from "./messenger.ts";
import { consoleLog, describeRelayError, sameHandle, type RelayClient, type RelayLog } from "./relay-client.ts";
import { RelayMessenger } from "./relay-messenger.ts";
import type { CallEventHandler } from "../calls/service.ts";
import { passOnFamilyMessage } from "./family-inbound.ts";

// Durable inbox for Relay's acknowledged WebSocket, after Relay-SDK
// cookbook/websocket-agent. `onEvent` commits the whole event by `event_id`
// into relay_events (migration 3) before it resolves; the SDK sends its
// cumulative ACK only after that. A processor then works through unprocessed
// rows in arrival order, outside the socket callback, so slow work (the engine,
// REST sends) never holds the socket and a crash never loses an event.
//
// Linking: the senior's direct chat is stored on patients.relay_chat_id; each
// family member's own direct chat with the agent (a family chat) on
// family_members.chat_id. Both are linked from contact.added, or from the first
// direct message when that arrives first. Only the senior's chat reaches the
// check-in engine. A family member's text is passed on to her chat as plain text
// (src/relay/family-inbound.ts: safety screen in the third person first, never an
// answer or a sharing change); their photos get no reply. Voice memos are later.
//
// Photos: a media part in her chat is downloaded from its signed URL (promptly: it expires in
// about an hour) with a size guard (MAX_IMAGE_BYTES, 8 MB), and the bytes go to the engine's
// handlePhoto (src/checkin/engine.ts), which reads it with the LLM. The URL and the bytes are never
// logged. An engine without handlePhoto (tests) gets the old kind reply, photoNotYet.
//
// Family welcome: the first time a family member's chat is linked for a senior
// (it had no chat before), the agent sends familyWelcome there once, with the
// idempotency key `welcome:<patientId>:<handle>`. A re-link to another chat, a
// rename or a repeat event sends nothing. Best effort: a failed send is logged
// and never undoes the link or fails the event.

/** The engine as the inbox uses it: every message, and her photos when it reads them. */
export type InboxEngine = Pick<CheckinEngine, "handleInbound"> & Partial<Pick<CheckinEngine, "handlePhoto">>;

export type InboxDeps = {
  db: Db;
  engine: InboxEngine;
  /** Downloads her photos from their signed URL. Defaults to the global fetch. */
  fetch?: typeof fetch;
  /** The senior's Relay handle (PATIENT_RELAY_HANDLE). */
  patientHandle: string;
  /** Used to mark the senior's chat Read after her message is handled, to list chats on FULL sync, and to send the family welcome. */
  relay: Pick<RelayClient, "chats">;
  /** Sends the family welcome and the reply to her photos. Defaults to a RelayMessenger over `relay`. */
  messenger?: Messenger;
  log?: RelayLog;
  now?: () => string;
  /** Starts or updates a call after its event is durably committed. */
  callHandler?: CallEventHandler;
};

/** What the processor did with one event; stored in the log line, useful in tests. */
export type EventOutcome =
  | "handled"
  | "patient_linked"
  | "family_linked"
  | "family_message"
  | "other_contact"
  | "outbound"
  | "group_ignored"
  | "agent_sender_ignored"
  | "unknown_chat"
  | "media_skipped"
  | "photo_handled"
  | "photo_not_downloaded"
  | "no_text"
  | "call_started"
  | "ignored_type";

// ---------------------------------------------------------------------------
// Durable store

/** Commit one event. Returns false for a duplicate `event_id` (Relay redelivers after a dropped connection). */
export function acceptEvent(db: Db, event: RelayWebhookEvent, sequence: string, now: string): boolean {
  const info = db
    .prepare(
      `INSERT OR IGNORE INTO relay_events (event_id, sequence, event_type, payload_json, received_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(event.event_id, sequence, event.event_type, JSON.stringify(event), now);
  return info.changes === 1;
}

type StoredEvent = { eventId: string; payloadJson: string };

function nextUnprocessed(db: Db): StoredEvent | undefined {
  // rowid follows insertion order, which is socket order.
  return db
    .prepare(`SELECT event_id AS eventId, payload_json AS payloadJson FROM relay_events WHERE processed_at IS NULL ORDER BY rowid LIMIT 1`)
    .get() as StoredEvent | undefined;
}

function markProcessed(db: Db, eventId: string, now: string, error: string | null): void {
  db.prepare(`UPDATE relay_events SET processed_at = ?, error = ? WHERE event_id = ?`).run(now, error, eventId);
}

// ---------------------------------------------------------------------------
// Patient linking

type PatientLink = { id: string; relayHandle: string | null; relayChatId: string | null };

/**
 * The patient the configured handle belongs to: the row whose relay_handle
 * matches, else the only patient when the database holds exactly one (the
 * demo seeds Harriet before her handle is known).
 */
function patientForHandle(db: Db, handle: string): PatientLink | undefined {
  const rows = db
    .prepare(`SELECT id, relay_handle AS relayHandle, relay_chat_id AS relayChatId FROM patients ORDER BY id`)
    .all() as PatientLink[];
  const matched = rows.find((row) => sameHandle(row.relayHandle, handle));
  if (matched) return matched;
  if (rows.length === 1 && rows[0]!.relayHandle === null) return rows[0];
  return undefined;
}

/**
 * Store the senior's direct chat id (and her handle). A targeted UPDATE, not
 * upsertPatient, so fields this code doesn't know (sharing, timezone) are left alone.
 */
function linkPatientChat(db: Db, patientHandle: string, chatId: string): { patientId: string; changed: boolean } | undefined {
  const patient = patientForHandle(db, patientHandle);
  if (!patient) return undefined;
  const changed = patient.relayChatId !== chatId || patient.relayHandle === null;
  if (changed)
    db.prepare(`UPDATE patients SET relay_handle = ?, relay_chat_id = ? WHERE id = ?`).run(
      patient.relayHandle ?? normalizeHandle(patientHandle),
      chatId,
      patient.id,
    );
  return { patientId: patient.id, changed };
}

// ---------------------------------------------------------------------------
// Family linking and the welcome

type FamilyLink = { patientIds: string[]; changed: boolean; firstLinked: string[] };

/**
 * linkFamilyMember, plus which patients this handle had no chat for until now
 * (`firstLinked`): those are the ones that get the welcome.
 */
function linkFamily(db: Db, handle: string, chatId: string, displayName: string | null, now: string): FamilyLink | undefined {
  const unlinked = new Set(
    (db.prepare(`SELECT patient_id AS patientId FROM family_members WHERE handle = ? AND chat_id IS NULL`).all(normalizeHandle(handle)) as { patientId: string }[]).map(
      (r) => r.patientId,
    ),
  );
  const linked = linkFamilyMember(db, handle, chatId, displayName, now);
  if (!linked) return undefined;
  return { ...linked, firstLinked: linked.patientIds.filter((id) => unlinked.has(id)) };
}

/** Send familyWelcome to a newly linked family chat, once per senior. Never throws. */
async function welcomeFamily(deps: InboxDeps, log: RelayLog, handle: string, chatId: string, patientIds: string[], fields: Record<string, unknown> = {}): Promise<void> {
  if (patientIds.length === 0) return;
  const messenger = deps.messenger ?? new RelayMessenger(deps.relay);
  const normalized = normalizeHandle(handle);
  for (const patientId of patientIds) {
    const patient = getCheckinPatient(deps.db, patientId);
    if (!patient) continue;
    const at = { ...fields, handle: normalized, chat_id: chatId, patient_id: patientId };
    try {
      await messenger.send(chatId, { text: familyWelcome(patient.preferredName) }, `welcome:${patientId}:${normalized}`);
      log("relay_family_welcomed", at);
    } catch (error) {
      log("relay_family_welcome_failed", { ...at, error: error instanceof Error ? error.message : String(error) });
    }
  }
}

// ---------------------------------------------------------------------------
// Processing one event

function textOf(data: MessageWebhookData): string {
  return data.parts
    .flatMap((part) => (part.type === "text" ? [part.value] : []))
    .join("\n")
    .trim();
}

/** Turn one committed event into app work. Throws on failure; the caller records the error. */
export async function processEvent(deps: InboxDeps, event: RelayWebhookEvent): Promise<EventOutcome> {
  const log = deps.log ?? consoleLog;
  const now = deps.now ?? (() => new Date().toISOString());
  const base = { event_id: event.event_id, event_type: event.event_type };

  if (event.event_type === "call.created" || event.event_type === "call.updated" || event.event_type === "call.ended") {
    if (!deps.callHandler) {
      log("relay_call_ignored", base);
      return "call_started";
    }
    // CallService.handle returns as soon as the bridge has been scheduled. It never holds the
    // durable inbox drain open for the lifetime of the media session.
    await deps.callHandler.handle(event as CallWebhookEvent);
    log("relay_call_routed", base);
    return "call_started";
  }

  if (event.event_type === "contact.added") {
    const { contact, chat_id: chatId } = event.data;
    if (sameHandle(contact.handle, deps.patientHandle)) {
      const linked = linkPatientChat(deps.db, deps.patientHandle, chatId);
      if (!linked) {
        log("relay_patient_contact_unmatched", { ...base, chat_id: chatId });
        return "other_contact";
      }
      log("relay_patient_linked", { ...base, patient_id: linked.patientId, chat_id: chatId, changed: linked.changed });
      return "patient_linked";
    }
    // A configured family member: this is their family chat.
    const family = linkFamily(deps.db, contact.handle, chatId, contact.display_name || null, now());
    if (family) {
      log("relay_family_linked", { ...base, handle: normalizeHandle(contact.handle), chat_id: chatId, patient_ids: family.patientIds, changed: family.changed });
      await welcomeFamily(deps, log, contact.handle, chatId, family.firstLinked, base);
      return "family_linked";
    }
    log("relay_contact_added", { ...base, handle: normalizeHandle(contact.handle), chat_id: chatId });
    return "other_contact";
  }

  if (event.event_type !== "message.received") return "ignored_type";

  const data = event.data;
  if (data.direction !== "inbound") return "outbound";
  if (data.chat.is_group === true) {
    // The agent only receives group messages that mention it, and the app uses no
    // groups (a Relay chat holds at most one person; family members have family chats).
    log("relay_group_message_ignored", { ...base, chat_id: data.chat.id });
    return "group_ignored";
  }
  if (data.sender_handle.kind !== "user") return "agent_sender_ignored";

  let patient = patientForChat(deps.db, data.chat.id);
  if (!patient && data.chat.is_group === false && sameHandle(data.sender_handle.handle, deps.patientHandle)) {
    // Her first message can arrive before (or without) contact.added being
    // processed; her direct chat is the one she writes from.
    if (linkPatientChat(deps.db, deps.patientHandle, data.chat.id)) patient = patientForChat(deps.db, data.chat.id);
  }
  if (!patient) {
    // A family chat, or a family member's first message before contact.added
    // (mirrors her fallback above). Logged without the text; family replies are build step 7.
    let family = familyMembersForChat(deps.db, data.chat.id);
    if (family.length === 0) {
      const linked = linkFamily(deps.db, data.sender_handle.handle, data.chat.id, data.sender_handle.display_name, now());
      if (linked) {
        log("relay_family_linked", { ...base, handle: normalizeHandle(data.sender_handle.handle), chat_id: data.chat.id, patient_ids: linked.patientIds, changed: linked.changed });
        family = familyMembersForChat(deps.db, data.chat.id);
        await welcomeFamily(deps, log, data.sender_handle.handle, data.chat.id, linked.firstLinked, base);
      }
    }
    if (family.length > 0) {
      const at = { ...base, handle: family[0]!.handle, chat_id: data.chat.id, patient_ids: family.map((f) => f.patientId) };
      // Text only (a photo or empty message gets nothing). Their words are never logged.
      const text = data.parts.some((part) => part.type === "media") ? "" : textOf(data);
      if (!text) {
        log("relay_family_message_ignored", at);
        return "family_message";
      }
      const messenger = deps.messenger ?? new RelayMessenger(deps.relay);
      const outcomes = await passOnFamilyMessage({ db: deps.db, messenger, now }, family, { chatId: data.chat.id, messageId: data.id, text });
      log("relay_family_message", { ...at, outcomes });
      await markRead(deps, log, base, data.chat.id);
      return "family_message";
    }
  }
  if (!patient) {
    log("relay_unknown_chat", { ...base, chat_id: data.chat.id });
    return "unknown_chat";
  }

  const media = data.parts.find((part) => part.type === "media");
  if (media && media.type === "media") {
    // The caption is never read as an answer. Neither the signed URL nor the bytes are logged.
    const messenger = deps.messenger ?? new RelayMessenger(deps.relay);
    const at = { ...base, chat_id: data.chat.id, patient_id: patient.id, mime_type: media.mime_type, size_bytes: media.size_bytes };
    if (!deps.engine.handlePhoto) {
      log("relay_media_skipped", at);
      await messenger.send(data.chat.id, { text: photoNotYet(patient.preferredName) }, `${patient.id}:photo:${data.id}`);
      await markRead(deps, log, base, data.chat.id);
      return "media_skipped";
    }
    const download = await downloadPhoto(deps.fetch ?? fetch, media.url, media.size_bytes);
    if (!download.ok) {
      log("relay_photo_not_downloaded", { ...at, reason: download.reason });
      const text = download.reason === "too_large" ? photoRejected() : photoCouldNotOpen(patient.preferredName);
      await messenger.send(data.chat.id, { text }, `${patient.id}:photo:${data.id}`);
      await markRead(deps, log, base, data.chat.id);
      return "photo_not_downloaded";
    }
    const outcome = await deps.engine.handlePhoto(patient.id, download.bytes, media.mime_type, media.id);
    log("relay_photo_handled", { ...at, outcome });
    await markRead(deps, log, base, data.chat.id);
    return "photo_handled";
  }

  // A plain button tap is one text part equal to the button's label, with
  // reply_to naming the buttons message (ButtonItem docs in the SDK types).
  const text = textOf(data);
  if (!text) return "no_text";

  const inbound: InboundMessage = {
    chatId: data.chat.id,
    messageId: data.id,
    text,
    ...(data.reply_to?.message_id ? { replyTo: data.reply_to.message_id } : {}),
    at: data.sent_at ?? event.created_at,
  };
  await deps.engine.handleInbound(inbound);
  await markRead(deps, log, base, data.chat.id);
  return "handled";
}

/** How long a photo download may take. */
export const PHOTO_DOWNLOAD_TIMEOUT_MS = 20_000;

type Download = { ok: true; bytes: Uint8Array } | { ok: false; reason: "too_large" | "http_error" | "network_error" };

/**
 * Download a photo from its signed URL with a size guard (MAX_IMAGE_BYTES): Relay's size, the
 * Content-Length and the bytes themselves are each checked. Never throws, never logs the URL.
 */
export async function downloadPhoto(fetchFn: typeof fetch, url: string, sizeBytes: number | null | undefined): Promise<Download> {
  if (typeof sizeBytes === "number" && sizeBytes > MAX_IMAGE_BYTES) return { ok: false, reason: "too_large" };
  try {
    const response = await fetchFn(url, { signal: AbortSignal.timeout(PHOTO_DOWNLOAD_TIMEOUT_MS) });
    if (!response.ok) return { ok: false, reason: "http_error" };
    const length = Number(response.headers.get("content-length") ?? NaN);
    if (Number.isFinite(length) && length > MAX_IMAGE_BYTES) return { ok: false, reason: "too_large" };
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MAX_IMAGE_BYTES) return { ok: false, reason: "too_large" };
    return { ok: true, bytes };
  } catch {
    return { ok: false, reason: "network_error" };
  }
}

/**
 * Read receipts never advance on their own (agent-events.md). Best effort:
 * a failed receipt must not turn a handled message into an error.
 */
async function markRead(deps: InboxDeps, log: RelayLog, base: Record<string, unknown>, chatId: string): Promise<void> {
  try {
    await deps.relay.chats.markAsRead(chatId);
  } catch (error) {
    log("relay_mark_read_failed", { ...base, error: describeRelayError("Marking the chat Read", error) });
  }
}

// ---------------------------------------------------------------------------
// Socket callbacks and the processor

export type RelayInbox = {
  onEvent(event: RelayWebhookEvent, context: { sequence: string }): Promise<void>;
  onFullSync(context: WebSocketFullSyncContext): Promise<void>;
  /** Process every unprocessed event, oldest first. Resolves when the inbox is empty. */
  drain(): Promise<void>;
  /** Schedule a drain soon (after the current callback returns). */
  wake(): void;
  /** Stop scheduling and wait for the drain in progress. */
  stop(): Promise<void>;
};

export function createRelayInbox(deps: InboxDeps): RelayInbox {
  const log = deps.log ?? consoleLog;
  const now = deps.now ?? (() => new Date().toISOString());
  // Drains run one at a time on a promise chain, so events are handled in
  // order and a wake during a drain is never lost (it queues another pass).
  let tail: Promise<void> = Promise.resolve();
  let stopped = false;

  async function drainLoop(): Promise<void> {
    for (;;) {
      if (stopped) return;
      const row = nextUnprocessed(deps.db);
      if (!row) return;
      let error: string | null = null;
      let eventType = "unknown";
      try {
        const event = JSON.parse(row.payloadJson) as RelayWebhookEvent;
        eventType = event.event_type;
        const outcome = await processEvent(deps, event);
        if (outcome === "handled") log("relay_event_handled", { event_id: row.eventId, event_type: eventType });
      } catch (caught) {
        error = caught instanceof Error ? caught.message : String(caught);
        log("relay_event_failed", { event_id: row.eventId, event_type: eventType, error });
      }
      markProcessed(deps.db, row.eventId, now(), error);
    }
  }

  function drain(): Promise<void> {
    tail = tail.then(drainLoop).catch((error: unknown) => {
      // Only a database failure gets here; the row stays unprocessed for the next pass.
      log("relay_inbox_drain_failed", { error: error instanceof Error ? error.message : String(error) });
    });
    return tail;
  }

  function wake(): void {
    if (stopped) return;
    setImmediate(() => {
      void drain();
    });
  }

  return {
    async onEvent(event, { sequence }) {
      // Commit first; resolving is what lets the SDK ACK this sequence.
      const inserted = acceptEvent(deps.db, event, sequence, now());
      if (!inserted) log("relay_event_duplicate", { event_id: event.event_id, event_type: event.event_type, sequence });
      else wake();
    },

    async onFullSync(context) {
      // Relay sends full_sync when our checkpoint is older than its 30-day
      // replay window; events through `throughSequence` are superseded and
      // will not be replayed (docs.relayapp.im/websocket/full-sync). The docs
      // ask the agent to rebuild the state it keeps from GET /v1/chats and
      // commit it as one snapshot before resolving (the SDK sends
      // full_sync_complete only after this resolves). This app mirrors no chat
      // history: the only Relay state it keeps is which direct chat belongs to
      // whom (the senior's chat and each family chat). So the snapshot we
      // rebuild is those links: walk every page of chats, find her direct chat
      // and each configured family member's, and commit the links together
      // with a record of the sync. A missed message from her is not replayed;
      // the next check-in starts fresh.
      // Any failed read throws, so the SDK reconnects and Relay asks again;
      // a partial walk never becomes the checkpoint.
      let chatsSeen = 0;
      let patientChatId: string | undefined;
      const others: { handle: string; displayName: string | null; chatId: string }[] = [];
      const page = await deps.relay.chats.listChats({ limit: 100 });
      for await (const chat of page) {
        chatsSeen += 1;
        if (chat.is_group) continue;
        for (const h of chat.handles) {
          if (h.kind !== "user") continue;
          if (sameHandle(h.handle, deps.patientHandle)) patientChatId = chat.id;
          else others.push({ handle: h.handle, displayName: h.display_name, chatId: chat.id });
        }
      }
      let familyLinked = 0;
      const welcomes: { handle: string; chatId: string; patientIds: string[] }[] = [];
      deps.db.transaction(() => {
        if (patientChatId) linkPatientChat(deps.db, deps.patientHandle, patientChatId);
        // Only configured family members match; anyone else is skipped.
        for (const o of others) {
          const linked = linkFamily(deps.db, o.handle, o.chatId, o.displayName, now());
          if (!linked) continue;
          familyLinked += 1;
          if (linked.firstLinked.length > 0) welcomes.push({ handle: o.handle, chatId: o.chatId, patientIds: linked.firstLinked });
        }
        deps.db
          .prepare(`INSERT INTO relay_full_syncs (through_sequence, reason, chats_seen, completed_at) VALUES (?, ?, ?, ?)`)
          .run(context.throughSequence, context.reason, chatsSeen, now());
      })();
      log("relay_full_sync", {
        through_sequence: context.throughSequence,
        reason: context.reason,
        chats_seen: chatsSeen,
        patient_chat_found: Boolean(patientChatId),
        family_chats_found: familyLinked,
      });
      // A family member first linked here (their contact.added fell in the superseded
      // window) still gets the welcome once: queued on the processor, so the socket
      // callback never waits on a send.
      if (welcomes.length > 0) {
        tail = tail
          .then(async () => {
            for (const w of welcomes) await welcomeFamily(deps, log, w.handle, w.chatId, w.patientIds, { through_sequence: context.throughSequence });
          })
          .catch((error: unknown) => {
            log("relay_family_welcome_failed", { error: error instanceof Error ? error.message : String(error) });
          });
      }
    },

    drain,
    wake,

    async stop() {
      stopped = true;
      await tail;
    },
  };
}

// ---------------------------------------------------------------------------
// Entry points the agent process wires

/**
 * WebSocket delivery needs the agent to have zero saved webhook subscriptions
 * (with one, Relay refuses the upgrade with 409). Throws a message explaining
 * how to remove them; never deletes anything itself.
 */
export async function assertNoWebhookSubscriptions(relay: Pick<RelayClient, "webhookSubscriptions">): Promise<void> {
  let subscriptions;
  try {
    ({ subscriptions } = await relay.webhookSubscriptions.list());
  } catch (error) {
    throw new Error(describeRelayError("Listing webhook subscriptions", error), { cause: error });
  }
  if (subscriptions.length === 0) return;
  const listed = subscriptions.map((s) => `${s.id} -> ${s.target_url}`).join("; ");
  throw new Error(
    `This agent has ${subscriptions.length} webhook subscription(s) (${listed}). ` +
      "Relay delivers events over the WebSocket only when an agent has none, and while one exists it sends every event to the webhook instead. " +
      "Delete them in Relay Console (the agent's Webhooks tab), or with DELETE /v1/webhook-subscriptions/{id} " +
      "(SDK: relay.webhookSubscriptions.delete(id)), then start the agent again. Pending events move to the WebSocket without being lost.",
  );
}

export type RunRelayInboxOptions = {
  relay: RelayClient;
  db: Db;
  engine: InboxEngine;
  /** Downloads her photos. Defaults to the global fetch. */
  fetch?: typeof fetch;
  patientHandle: string;
  signal?: AbortSignal;
  log?: RelayLog;
  now?: () => string;
  callHandler?: CallEventHandler;
};

/**
 * Hold the agent's Relay WebSocket until `signal` aborts: commit each event,
 * then process it from the inbox. Events left unprocessed by a previous run
 * are processed first. Resolves when the socket is closed by `signal`.
 */
export async function runRelayInbox(options: RunRelayInboxOptions): Promise<void> {
  const log = options.log ?? consoleLog;
  await assertNoWebhookSubscriptions(options.relay);
  const inbox = createRelayInbox({
    db: options.db,
    engine: options.engine,
    patientHandle: options.patientHandle,
    relay: options.relay,
    log,
    ...(options.now ? { now: options.now } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.callHandler ? { callHandler: options.callHandler } : {}),
  });
  inbox.wake();
  try {
    await options.relay.websocket.run({
      ...(options.signal ? { signal: options.signal } : {}),
      onEvent: (event, context) => inbox.onEvent(event, context),
      onFullSync: (context) => inbox.onFullSync(context),
      onConnectionState: (state) => log("relay_socket", { state }),
      onError: (error) => {
        // Reconnects and unknown event types land here; the SDK keeps going.
        log("relay_socket_error", { error: describeRelayError("Relay WebSocket", error) });
      },
    });
  } finally {
    await inbox.stop();
  }
}
