import type { RelayWebhookEvent } from "@relaymessenger/sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BUTTON, caregiverClaimReply, caregiverClaimed, syntheticWelcome } from "../src/checkin/copy.ts";
import { insertCheckin, getCheckin, patientForChat } from "../src/db/checkins.ts";
import {
  CAREGIVER_INVITE_TTL_MS,
  claimCaregiverInvite,
  createCaregiverInvite,
  decideCaregiverInvite,
  linkApprovedCaregiver,
  revokeCaregiver,
} from "../src/db/caregivers.ts";
import { familyMembersForChat } from "../src/db/family.ts";
import { openDatabase, upsertPatient, type Db } from "../src/db/index.ts";
import { FakeMessenger } from "../src/relay/fake-messenger.ts";
import { processEvent } from "../src/relay/inbox.ts";
import type { RelayClient } from "../src/relay/relay-client.ts";

const T = "2026-10-04T14:00:00.000Z";
const PATIENT_CHAT = "chat_patient";
const CAREGIVER_CHAT = "chat_caregiver";

let eventNumber = 0;

function messageEvent(options: { chatId: string; handle: string; text: string }): RelayWebhookEvent {
  eventNumber += 1;
  return {
    api_version: "v1",
    webhook_version: "2026-08-30",
    event_type: "message.received",
    event_id: `event-${eventNumber}`,
    created_at: T,
    trace_id: "trace-synthetic",
    agent_id: "agent-synthetic",
    data: {
      chat: { id: options.chatId, is_group: false },
      id: `message-${eventNumber}`,
      direction: "inbound",
      sender_handle: {
        id: `person-${eventNumber}`,
        handle: options.handle,
        kind: "user",
        joined_at: T,
        display_name: null,
        image_url: null,
        subtitle: null,
        verified: false,
        is_contact: true,
      },
      parts: [{ type: "text", value: options.text, reactions: null }],
      sent_at: T,
    },
  } as unknown as RelayWebhookEvent;
}

function fakeRelay(): Pick<RelayClient, "chats"> {
  return { chats: { markAsRead: vi.fn(async () => undefined) } } as unknown as Pick<RelayClient, "chats">;
}

function caregiverDeps(db: Db, messenger: FakeMessenger) {
  return {
    db,
    engine: { handleInbound: vi.fn(async () => undefined) },
    relay: fakeRelay(),
    messenger,
    log: vi.fn(),
    now: () => T,
  };
}

function inviteStatus(db: Db, id: number): string {
  return (db.prepare("SELECT status FROM caregiver_invites WHERE id = ?").get(id) as { status: string }).status;
}

describe("multi-user Relay onboarding", () => {
  it("gives two direct Relay users different synthetic FinchNode profiles and keeps each chat local", async () => {
    const db = openDatabase(":memory:");
    const messenger = new FakeMessenger({ now: () => T });
    const engine = { handleInbound: vi.fn(async () => undefined) };
    const deps = { db, engine, relay: fakeRelay(), messenger, now: () => T };

    expect(await processEvent(deps, messageEvent({ chatId: "chat_morgan", handle: "morgan.demo", text: "hello" }))).toBe("patient_created");
    expect(await processEvent(deps, messageEvent({ chatId: "chat_harriet", handle: "harriet.demo", text: "hello" }))).toBe("patient_created");

    expect(db.prepare("SELECT relay_handle, relay_chat_id, finchnode_subject FROM patients ORDER BY relay_chat_id").all()).toEqual([
      { relay_handle: "harriet.demo", relay_chat_id: "chat_harriet", finchnode_subject: "patient-demo-polypharmacy" },
      { relay_handle: "morgan.demo", relay_chat_id: "chat_morgan", finchnode_subject: "patient-demo-001" },
    ]);
    expect(messenger.inChat("chat_morgan").map((message) => message.text)).toEqual([syntheticWelcome("Morgan")]);
    expect(messenger.inChat("chat_harriet").map((message) => message.text)).toEqual([syntheticWelcome("Harriet")]);

    await processEvent(deps, messageEvent({ chatId: "chat_morgan", handle: "morgan.demo", text: "another message" }));
    expect(engine.handleInbound).toHaveBeenCalledWith(expect.objectContaining({ chatId: "chat_morgan", text: "another message" }));
    expect(messenger.inChat("chat_morgan")).toHaveLength(1);
  });

  it("allows two local accounts to reuse one FinchNode subject without sharing check-ins", () => {
    const db = openDatabase(":memory:");
    upsertPatient(db, {
      id: "local-a",
      finchnodePatientId: "relay-binding:local-a",
      finchnodeSubject: "patient-demo-shared",
      preferredName: "Alex",
      relayHandle: "alex.demo",
      relayChatId: "chat_alex",
    });
    upsertPatient(db, {
      id: "local-b",
      finchnodePatientId: "relay-binding:local-b",
      finchnodeSubject: "patient-demo-shared",
      preferredName: "Blair",
      relayHandle: "blair.demo",
      relayChatId: "chat_blair",
    });

    const first = insertCheckin(db, { patientId: "local-a", date: "2026-10-04", questionIds: ["mood"], sentAt: T });
    insertCheckin(db, { patientId: "local-b", date: "2026-10-04", questionIds: ["mood"], sentAt: T });
    db.prepare("UPDATE checkins SET status = 'skipped' WHERE id = ?").run(first);

    expect(patientForChat(db, "chat_alex")?.id).toBe("local-a");
    expect(patientForChat(db, "chat_blair")?.id).toBe("local-b");
    expect(getCheckin(db, "local-a", "2026-10-04")?.status).toBe("skipped");
    expect(getCheckin(db, "local-b", "2026-10-04")?.status).toBe("sent");
  });

  it("onboards an unknown direct chat once, then routes later messages to that local account", async () => {
    const db = openDatabase(":memory:");
    const messenger = new FakeMessenger({ now: () => T });
    const engine = { handleInbound: vi.fn(async () => undefined) };
    const deps = { db, engine, relay: fakeRelay(), messenger, now: () => T };

    expect(await processEvent(deps, messageEvent({ chatId: "chat_new", handle: "new.demo", text: "hi" }))).toBe("patient_created");
    expect(await processEvent(deps, messageEvent({ chatId: "chat_new", handle: "new.demo", text: "ready" }))).toBe("handled");
    expect(messenger.inChat("chat_new")).toHaveLength(1);
    expect(engine.handleInbound).toHaveBeenCalledWith(expect.objectContaining({ chatId: "chat_new", text: "ready" }));
  });
});

describe("caregiver invite lifecycle", () => {
  let db: Db;

  beforeEach(() => {
    db = openDatabase(":memory:");
    upsertPatient(db, {
      id: "patient-1",
      finchnodePatientId: "relay-binding:patient-1",
      finchnodeSubject: "patient-demo-001",
      preferredName: "Morgan",
      relayHandle: "morgan.demo",
      relayChatId: PATIENT_CHAT,
    });
  });

  it("claims a current code and sends the caregiver and patient the appropriate messages", async () => {
    const invite = createCaregiverInvite(db, { patientId: "patient-1", handle: "@sam.demo", name: "Sam", now: T, code: "JOIN-123" });
    const messenger = new FakeMessenger({ now: () => T });

    expect(await processEvent(caregiverDeps(db, messenger), messageEvent({ chatId: CAREGIVER_CHAT, handle: "sam.demo", text: " JOIN-123 " }))).toBe("caregiver_claimed");
    expect(inviteStatus(db, invite.id)).toBe("claimed");
    expect(messenger.inChat(CAREGIVER_CHAT).map((message) => message.text)).toEqual([caregiverClaimReply()]);
    expect(messenger.inChat(PATIENT_CHAT).map((message) => message.text)).toEqual([caregiverClaimed("Morgan", "sam.demo")]);
    expect(messenger.inChat(PATIENT_CHAT)[0]!.buttons).toEqual([BUTTON.approveCaregiver, BUTTON.denyCaregiver]);
  });

  it("approves a claimed invite and links the caregiver chat", () => {
    const invite = createCaregiverInvite(db, { patientId: "patient-1", handle: "sam.demo", name: "Sam", now: T, code: "APPROVE" });
    const claimed = claimCaregiverInvite(db, { handle: "sam.demo", chatId: CAREGIVER_CHAT, code: invite.code, now: T })!;
    const approved = decideCaregiverInvite(db, { patientId: "patient-1", approve: true, now: "2026-10-04T14:01:00.000Z" })!;

    expect(approved.status).toBe("approved");
    expect(linkApprovedCaregiver(db, approved, "2026-10-04T14:01:00.000Z")).toBe(true);
    expect(familyMembersForChat(db, CAREGIVER_CHAT)).toEqual([
      { patientId: "patient-1", handle: "sam.demo", displayName: "Sam", chatId: CAREGIVER_CHAT, linkedAt: "2026-10-04T14:01:00.000Z" },
    ]);
    expect(claimed.patientId).toBe("patient-1");
  });

  it("denies a claimed invite without linking the caregiver", () => {
    const invite = createCaregiverInvite(db, { patientId: "patient-1", handle: "sam.demo", name: "Sam", now: T, code: "DENY" });
    claimCaregiverInvite(db, { handle: "sam.demo", chatId: CAREGIVER_CHAT, code: invite.code, now: T });

    const denied = decideCaregiverInvite(db, { patientId: "patient-1", approve: false, now: T })!;
    expect(denied.status).toBe("denied");
    expect(linkApprovedCaregiver(db, denied, T)).toBe(false);
    expect(familyMembersForChat(db, CAREGIVER_CHAT)).toEqual([]);
  });

  it("expires an unclaimed invite at its deadline and rejects its code", () => {
    const invite = createCaregiverInvite(db, { patientId: "patient-1", handle: "sam.demo", now: T, code: "EXPIRE" });
    const deadline = new Date(Date.parse(T) + CAREGIVER_INVITE_TTL_MS).toISOString();

    expect(claimCaregiverInvite(db, { handle: "sam.demo", chatId: CAREGIVER_CHAT, code: invite.code, now: deadline })).toBeUndefined();
    expect(inviteStatus(db, invite.id)).toBe("expired");
  });

  it("revokes an approved caregiver and clears their chat link", () => {
    const invite = createCaregiverInvite(db, { patientId: "patient-1", handle: "sam.demo", name: "Sam", now: T, code: "REVOKE" });
    claimCaregiverInvite(db, { handle: "sam.demo", chatId: CAREGIVER_CHAT, code: invite.code, now: T });
    const approved = decideCaregiverInvite(db, { patientId: "patient-1", approve: true, now: T })!;
    linkApprovedCaregiver(db, approved, T);

    expect(revokeCaregiver(db, { patientId: "patient-1", handle: "@SAM.DEMO", now: "2026-10-04T15:00:00.000Z" })).toBe(true);
    expect(familyMembersForChat(db, CAREGIVER_CHAT)).toEqual([]);
    expect(inviteStatus(db, invite.id)).toBe("revoked");
  });
});
