import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  deletePatientFlags,
  deletePatientSnapshots,
  getFlag,
  getSharing,
  latestSnapshot,
  markNoted,
  markOffered,
  markTold,
  nextFlagToOffer,
  notedFlags,
  openDatabase,
  openFlags,
  saveSnapshot,
  schemaVersion,
  setSharing,
  syncFlags,
  upsertPatient,
  type Db,
} from "../src/db/index.ts";
import { SCHEMA_VERSION } from "../src/db/schema.ts";
import type { RuleId, RuleResult, Severity } from "../src/rules/index.ts";

const P = "harriet";
const T1 = "2026-09-01T09:00:00Z";
const T2 = "2026-09-02T09:00:00Z";
const T3 = "2026-09-03T09:00:00Z";

function flag(ruleId: RuleId, severity: Severity, values: Record<string, string>, message = `${ruleId} fired`): RuleResult {
  return {
    ruleId,
    status: "flag",
    severity,
    message,
    evidence: Object.entries(values).map(([resourceId, value]) => ({ resourceId, source: "Northstar", date: "2026-08-01", value })),
    details: {},
  };
}
const checked = (ruleId: RuleId): RuleResult => ({ ruleId, status: "checked", severity: undefined, message: "ok", evidence: [], details: {} });
const skipped = (ruleId: RuleId): RuleResult => ({ ruleId, status: "skipped", severity: undefined, message: "no data", evidence: [], details: {} });

function seed(db: Db) {
  upsertPatient(db, { id: P, finchnodePatientId: "fn-harriet", preferredName: "Harriet" });
}

describe("schema", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("creates every table on :memory:", () => {
    const db = openDatabase(":memory:");
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]).map((t) => t.name);
    expect(tables).toEqual(
      [
        "care_messages", "care_summaries", "checkin_notes", "checkin_prompts", "checkins", "clarifications", "family_members", "family_messages", "family_relays", "flags", "follow_ups",
        "inbound_messages", "med_doses", "med_label_checks", "med_memory_checks", "med_prompts", "med_refills", "memories", "paper_scans", "patients", "record_snapshots", "relay_events", "relay_full_syncs", "symptom_observations",
        "visit_questions", "vitals_readings",
      ].sort(),
    );
    expect(schemaVersion(db)).toBe(SCHEMA_VERSION);
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
  });

  it("reopens a file database idempotently and keeps data", () => {
    dir = mkdtempSync(join(tmpdir(), "db-test-"));
    const path = join(dir, "nested", "app.db");
    const first = openDatabase(path);
    seed(first);
    expect(first.pragma("journal_mode", { simple: true })).toBe("wal");
    first.close();

    const second = openDatabase(path);
    expect(schemaVersion(second)).toBe(SCHEMA_VERSION);
    expect(getSharing(second, P)).toBe("status");
    second.close();
  });

  it("enforces foreign keys", () => {
    const db = openDatabase(":memory:");
    expect(() => saveSnapshot(db, { patientId: "nobody", fetchedAt: T1, raw: {} })).toThrow(/FOREIGN KEY/);
  });

  describe("CHECK constraints", () => {
    let db: Db;
    beforeEach(() => {
      db = openDatabase(":memory:");
      seed(db);
    });

    it("rejects a bad sharing level and defaults to status", () => {
      expect(getSharing(db, P)).toBe("status");
      expect(() => setSharing(db, P, "everything" as never)).toThrow(/CHECK/);
      setSharing(db, P, "all");
      expect(getSharing(db, P)).toBe("all");
    });

    it("rejects a bad check-in status", () => {
      const insert = db.prepare("INSERT INTO checkins (patient_id, date, status) VALUES (?, ?, ?)");
      expect(() => insert.run(P, "2026-09-01", "lost")).toThrow(/CHECK/);
      insert.run(P, "2026-09-01", "answered");
    });

    it("rejects a bad flag status", () => {
      const insert = db.prepare(
        "INSERT INTO flags (patient_id, rule_id, fingerprint, status, message, evidence_json, created_at) VALUES (?, 'R1', 'x', ?, 'm', '[]', ?)",
      );
      expect(() => insert.run(P, "dismissed", T1)).toThrow(/CHECK/);
      insert.run(P, "new", T1);
    });

    it("rejects a bad vitals method and family message direction", () => {
      expect(() =>
        db.prepare("INSERT INTO vitals_readings (patient_id, taken_at, heart_rate, method) VALUES (?, ?, 70, 'smartwatch')").run(P, T1),
      ).toThrow(/CHECK/);
      expect(() =>
        db.prepare("INSERT INTO family_messages (patient_id, direction, kind, created_at) VALUES (?, 'sideways', 'text', ?)").run(P, T1),
      ).toThrow(/CHECK/);
    });
  });
});

describe("flag lifecycle", () => {
  let db: Db;
  beforeEach(() => {
    db = openDatabase(":memory:");
    seed(db);
  });

  it("runs new -> told -> noted -> cleared", () => {
    const r1 = flag("R1", "medium", { "obs-egfr-2": "eGFR: 31" });
    const first = syncFlags(db, P, [r1, checked("R2")], T1);
    expect(first.inserted).toHaveLength(1);
    const id = first.inserted[0]!.flagId;
    expect(openFlags(db, P)).toEqual([{ flagId: id, ruleId: "R1", status: "new", message: "R1 fired", severity: "medium" }]);

    // Same evidence on the next snapshot: nothing changes.
    expect(syncFlags(db, P, [r1], T2)).toEqual({ inserted: [], cleared: [], unchanged: 1 });

    expect(markNoted(db, "999", T2)).toBe(false);
    expect(markTold(db, id, T2)).toBe(true);
    expect(markTold(db, id, T2)).toBe(false);
    expect(getFlag(db, id)?.status).toBe("told");
    expect(syncFlags(db, P, [r1], T2).unchanged).toBe(1);

    expect(markNoted(db, id, T2)).toBe(true);
    expect(notedFlags(db, P).map((f) => f.flagId)).toEqual([id]);
    expect(syncFlags(db, P, [r1], T2).unchanged).toBe(1);

    const later = syncFlags(db, P, [checked("R1")], T3);
    expect(later.cleared).toEqual([{ flagId: id, ruleId: "R1", status: "cleared", message: "R1 fired", severity: "medium" }]);
    expect(openFlags(db, P)).toEqual([]);
    const row = db.prepare("SELECT cleared_at, told_at, noted_at FROM flags WHERE id = ?").get(Number(id));
    expect(row).toEqual({ cleared_at: T3, told_at: T2, noted_at: T2 });
    expect(markTold(db, id, T3)).toBe(false);
  });

  it("changed evidence clears the old flag and opens a new one", () => {
    const old = syncFlags(db, P, [flag("R1", "medium", { "obs-egfr-2": "eGFR: 31" })], T1).inserted[0]!;
    markTold(db, old.flagId, T1);
    const next = syncFlags(db, P, [flag("R1", "high", { "obs-egfr-3": "eGFR: 28" }, "worse")], T2);
    expect(next.cleared.map((f) => f.flagId)).toEqual([old.flagId]);
    expect(next.inserted).toHaveLength(1);
    expect(openFlags(db, P)).toEqual([{ flagId: next.inserted[0]!.flagId, ruleId: "R1", status: "new", message: "worse", severity: "high" }]);
  });

  it("a flag that clears and fires again with the same evidence is new again", () => {
    const r3 = flag("R3", "medium", { "med-apixaban": "apixaban", "med-aspirin": "aspirin" });
    const first = syncFlags(db, P, [r3], T1).inserted[0]!;
    syncFlags(db, P, [checked("R3")], T2);
    const again = syncFlags(db, P, [r3], T3).inserted[0]!;
    expect(again.flagId).not.toBe(first.flagId);
    expect(again.status).toBe("new");
  });

  it("leaves flags alone when the rule is skipped or absent", () => {
    syncFlags(db, P, [flag("R1", "medium", { a: "1" }), flag("R4", "medium", { b: "2" })], T1);
    const out = syncFlags(db, P, [skipped("R1")], T2);
    expect(out).toEqual({ inserted: [], cleared: [], unchanged: 0 });
    expect(openFlags(db, P).map((f) => f.ruleId).sort()).toEqual(["R1", "R4"]);
  });

  it("keeps several flags for one rule apart by fingerprint", () => {
    const a = flag("R5", "low", { "disp-1": "metformin" });
    const b = flag("R5", "low", { "disp-2": "lisinopril" });
    expect(syncFlags(db, P, [a, b], T1).inserted).toHaveLength(2);
    const out = syncFlags(db, P, [a], T2);
    expect(out.cleared).toHaveLength(1);
    expect(out.unchanged).toBe(1);
  });
});

describe("nextFlagToOffer", () => {
  let db: Db;
  beforeEach(() => {
    db = openDatabase(":memory:");
    seed(db);
  });

  it("offers at most one new flag per day, most severe then oldest", () => {
    syncFlags(db, P, [flag("R5", "low", { d: "x" }), flag("R3", "medium", { c: "y" })], T1);
    syncFlags(db, P, [flag("R4", "medium", { e: "z" })], T2);
    syncFlags(db, P, [flag("R1", "high", { f: "w" })], T3);

    // High first, even though it is newest.
    const day1 = nextFlagToOffer(db, P, "2026-09-03")!;
    expect(day1.ruleId).toBe("R1");
    markTold(db, day1.flagId, "2026-09-03T10:00:00Z", "2026-09-03");
    expect(nextFlagToOffer(db, P, "2026-09-03")).toBeUndefined();

    // Medium next: R3 is older than R4.
    const day2 = nextFlagToOffer(db, P, "2026-09-04")!;
    expect(day2.ruleId).toBe("R3");
    // "Later": stays new, not offered again today, offered again tomorrow.
    expect(markOffered(db, day2.flagId, "2026-09-04")).toBe(true);
    expect(getFlag(db, day2.flagId)?.status).toBe("new");
    expect(nextFlagToOffer(db, P, "2026-09-04")).toBeUndefined();
    expect(nextFlagToOffer(db, P, "2026-09-05")?.flagId).toBe(day2.flagId);
  });

  it("uses the check-in date, not the timestamp, for the told day", () => {
    syncFlags(db, P, [flag("R1", "high", { a: "1" }), flag("R3", "medium", { b: "2" })], T1);
    const first = nextFlagToOffer(db, P, "2026-09-01")!;
    markTold(db, first.flagId, "2026-10-03T15:00:00Z", "2026-09-01");
    expect(nextFlagToOffer(db, P, "2026-09-01")).toBeUndefined();
    expect(nextFlagToOffer(db, P, "2026-09-02")?.ruleId).toBe("R3");
  });

  it("returns nothing when no flag is new", () => {
    expect(nextFlagToOffer(db, P, "2026-09-01")).toBeUndefined();
  });
});

describe("deletePatientFlags (record consent ended)", () => {
  it("deletes only her flags; a check-in's pending flag becomes null; check-ins stay", () => {
    const db = openDatabase(":memory:");
    seed(db);
    upsertPatient(db, { id: "other", finchnodePatientId: "fn-other", preferredName: "Other" });
    const { inserted } = syncFlags(db, P, [flag("R1", "medium", { a: "1" }), flag("R3", "high", { b: "2" })], T1);
    syncFlags(db, "other", [flag("R1", "medium", { c: "3" })], T1);
    markTold(db, inserted[0]!.flagId, T1);
    db.prepare("INSERT INTO checkins (patient_id, date, status, pending_flag_id) VALUES (?, ?, 'answered', ?)").run(P, "2026-09-01", Number(inserted[0]!.flagId));

    expect(deletePatientFlags(db, P)).toBe(2);
    expect(openFlags(db, P)).toEqual([]);
    expect(getFlag(db, inserted[0]!.flagId)).toBeUndefined();
    expect(openFlags(db, "other")).toHaveLength(1);
    expect(db.prepare("SELECT pending_flag_id AS id FROM checkins WHERE patient_id = ?").get(P)).toEqual({ id: null });
    expect(deletePatientFlags(db, P)).toBe(0);
  });
});

describe("snapshots", () => {
  it("saves snapshots and deletes them on consent end without touching memories or check-ins", () => {
    const db = openDatabase(":memory:");
    seed(db);
    upsertPatient(db, { id: "other", finchnodePatientId: "fn-other", preferredName: "Other" });
    saveSnapshot(db, { patientId: P, fetchedAt: T1, scenario: "baseline", syncStatus: "complete", raw: { meta: { dataAsOf: "2026-09-01" } } });
    const id = saveSnapshot(db, { patientId: P, fetchedAt: T2, scenario: "baseline", syncStatus: "complete", raw: "{}" });
    saveSnapshot(db, { patientId: "other", fetchedAt: T1, raw: {} });
    expect(latestSnapshot(db, P)).toMatchObject({ id, patientId: P, fetchedAt: T2, rawJson: "{}" });

    db.prepare("INSERT INTO memories (patient_id, text, created_at) VALUES (?, ?, ?)").run(P, "Her cat is called Biscuit.", T1);
    db.prepare("INSERT INTO checkins (patient_id, date, status) VALUES (?, ?, 'answered')").run(P, "2026-09-01");

    expect(deletePatientSnapshots(db, P)).toBe(2);
    expect(latestSnapshot(db, P)).toBeUndefined();
    expect(latestSnapshot(db, "other")).toBeDefined();
    expect(db.prepare("SELECT COUNT(*) AS n FROM memories WHERE patient_id = ?").get(P)).toEqual({ n: 1 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM checkins WHERE patient_id = ?").get(P)).toEqual({ n: 1 });
  });
});
