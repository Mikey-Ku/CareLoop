import { beforeEach, describe, expect, it } from "vitest";
import { familyChats, familyMembers, familyMembersForChat, linkFamilyMember, syncFamilyMembers } from "../src/db/family.ts";
import { openDatabase, upsertPatient, type Db } from "../src/db/index.ts";

// Synthetic handles and chat ids only.
const P = "harriet";
const T1 = "2026-09-01T09:00:00.000Z";
const T2 = "2026-09-02T09:00:00.000Z";

let db: Db;
beforeEach(() => {
  db = openDatabase(":memory:");
  upsertPatient(db, { id: P, finchnodePatientId: "patient-demo-polypharmacy", preferredName: "Harriet", relayChatId: "chat_harriet" });
});

describe("syncFamilyMembers", () => {
  it("adds one row per configured handle, normalized, in configured order, none linked", () => {
    expect(syncFamilyMembers(db, P, ["@Sarah", "tom", " SARAH ", ""])).toEqual({ added: ["sarah", "tom"], notConfigured: [] });
    expect(familyMembers(db, P)).toEqual([
      { patientId: P, handle: "sarah", displayName: null, chatId: null, linkedAt: null },
      { patientId: P, handle: "tom", displayName: null, chatId: null, linkedAt: null },
    ]);
    expect(familyChats(db, P)).toEqual([]);
  });

  it("keeps existing links on a second sync", () => {
    syncFamilyMembers(db, P, ["sarah", "tom"]);
    linkFamilyMember(db, "sarah", "chat_sarah", "Sarah Demo", T1);
    expect(syncFamilyMembers(db, P, ["sarah", "tom", "ann"])).toEqual({ added: ["ann"], notConfigured: [] });
    expect(familyChats(db, P)).toEqual([{ handle: "sarah", displayName: "Sarah Demo", chatId: "chat_sarah" }]);
    expect(familyMembers(db, P).find((m) => m.handle === "sarah")?.linkedAt).toBe(T1);
  });

  it("leaves a removed handle's row (and its link) in place and reports it", () => {
    syncFamilyMembers(db, P, ["sarah", "tom"]);
    linkFamilyMember(db, "tom", "chat_tom", null, T1);
    expect(syncFamilyMembers(db, P, ["sarah"])).toEqual({ added: [], notConfigured: ["tom"] });
    expect(familyChats(db, P).map((f) => f.handle)).toEqual(["tom"]);
  });

  it("rows go when the patient is deleted", () => {
    syncFamilyMembers(db, P, ["sarah"]);
    db.prepare("DELETE FROM patients WHERE id = ?").run(P);
    expect(familyMembers(db, P)).toEqual([]);
  });
});

describe("linkFamilyMember", () => {
  beforeEach(() => {
    syncFamilyMembers(db, P, ["sarah", "tom"]);
  });

  it("links a configured member by handle (case and @ ignored) and reports a change once", () => {
    expect(linkFamilyMember(db, "@SARAH", "chat_sarah", "Sarah Demo", T1)).toEqual({ patientIds: [P], changed: true });
    expect(linkFamilyMember(db, "sarah", "chat_sarah", undefined, T2)).toEqual({ patientIds: [P], changed: false });
    expect(familyMembers(db, P)[0]).toEqual({ patientId: P, handle: "sarah", displayName: "Sarah Demo", chatId: "chat_sarah", linkedAt: T1 });
    expect(familyMembersForChat(db, "chat_sarah").map((m) => m.handle)).toEqual(["sarah"]);
  });

  it("returns undefined for a handle that is no configured family member", () => {
    expect(linkFamilyMember(db, "stranger", "chat_x", null, T1)).toBeUndefined();
    expect(familyMembersForChat(db, "chat_x")).toEqual([]);
  });

  it("a new chat for the same person replaces the old one", () => {
    linkFamilyMember(db, "tom", "chat_tom_old", null, T1);
    expect(linkFamilyMember(db, "tom", "chat_tom_new", null, T2)).toEqual({ patientIds: [P], changed: true });
    expect(familyChats(db, P)).toEqual([{ handle: "tom", displayName: null, chatId: "chat_tom_new" }]);
  });

  it("familyChats lists linked members in configured order", () => {
    linkFamilyMember(db, "tom", "chat_tom", null, T1);
    linkFamilyMember(db, "sarah", "chat_sarah", null, T2);
    expect(familyChats(db, P).map((f) => f.handle)).toEqual(["sarah", "tom"]);
  });
});
