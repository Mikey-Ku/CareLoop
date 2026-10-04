import { describe, expect, it } from "vitest";
import { claimCaregiverInvite, createCaregiverInvite, decideCaregiverInvite, linkApprovedCaregiver } from "../src/db/caregivers.ts";
import { openDatabase } from "../src/db/index.ts";
import { SYNTHETIC_PROFILES } from "../src/finchnode/demo-profiles.ts";
import { ensureDemoUser } from "../src/relay/users.ts";

describe("multi-user synthetic fixtures", () => {
  it("catalogues distinct record-bearing synthetic subjects", () => {
    expect(SYNTHETIC_PROFILES).toHaveLength(6);
    expect(new Set(SYNTHETIC_PROFILES.map((profile) => profile.subject)).size).toBe(SYNTHETIC_PROFILES.length);
    expect(SYNTHETIC_PROFILES.map((profile) => profile.subject)).toContain("patient-demo-polypharmacy");
  });

  it("gives each Relay user an isolated local account and can reuse a subject", () => {
    const db = openDatabase(":memory:");
    const users = Array.from({ length: SYNTHETIC_PROFILES.length + 1 }, (_, index) =>
      ensureDemoUser(db, { chatId: `chat-user-${index}`, handle: `user-${index}`, checkinTime: "09:00", timezone: "America/Detroit" }),
    );
    const first = users[0]!;
    const reused = users.at(-1)!;

    expect(first.patientId).not.toBe(reused.patientId);
    expect(reused.profileSubject).toBe(first.profileSubject);
    expect(db.prepare("SELECT COUNT(*) AS count FROM patients").get()).toEqual({ count: SYNTHETIC_PROFILES.length + 1 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM checkins").get()).toEqual({ count: 0 });
    db.close();
  });

  it("reuses the local account for the same Relay identity", () => {
    const db = openDatabase(":memory:");
    const first = ensureDemoUser(db, { chatId: "chat-harriet", handle: "harriet", checkinTime: "09:00", timezone: "America/Detroit" });
    const again = ensureDemoUser(db, { chatId: "chat-harriet", handle: "@HARRIET", checkinTime: "10:00", timezone: "America/Detroit" });

    expect(again.patientId).toBe(first.patientId);
    expect(again.created).toBe(false);
    expect(db.prepare("SELECT COUNT(*) AS count FROM patients").get()).toEqual({ count: 1 });
    db.close();
  });

  it("pairs a caregiver by Relay handle and code, not phone number", () => {
    const db = openDatabase(":memory:");
    const senior = ensureDemoUser(db, { chatId: "chat-harriet", handle: "harriet", checkinTime: "09:00", timezone: "America/Detroit" });
    const now = "2026-10-04T12:00:00.000Z";
    const invite = createCaregiverInvite(db, { patientId: senior.patientId, handle: "@Sarah", name: "Sarah", now, code: "483921" });

    expect(claimCaregiverInvite(db, { handle: "sarah", chatId: "chat-sarah", code: "wrong", now })).toBeUndefined();
    const claimed = claimCaregiverInvite(db, { handle: "@SARAH", chatId: "chat-sarah", code: "483921", now });
    expect(claimed).toMatchObject({ id: invite.id, status: "claimed", claimedChatId: "chat-sarah", requestedHandle: "sarah" });
    expect(decideCaregiverInvite(db, { patientId: senior.patientId, approve: true, now })).toMatchObject({ id: invite.id, status: "approved" });
    expect(linkApprovedCaregiver(db, { ...claimed!, status: "approved" }, now)).toBe(true);
    expect(db.prepare("SELECT patient_id AS patientId, handle, chat_id AS chatId FROM family_members").all()).toEqual([
      { patientId: senior.patientId, handle: "sarah", chatId: "chat-sarah" },
    ]);
    db.close();
  });
});
