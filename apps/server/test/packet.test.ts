import { describe, expect, it } from "vitest";
import { buildContextPacket, type ContextPacket } from "../src/context/packet.ts";
import { QUESTION_BANK } from "../src/context/questions.ts";
import { loadRxNavCache, loadSnapshot } from "../src/finchnode/fixtures.ts";
import { normalizeHealthRecord, type PatientRecord } from "../src/finchnode/normalize.ts";
import { fingerprint, runRules } from "../src/rules/index.ts";

const rxnav = loadRxNavCache();
const recordFor = (subject: string): PatientRecord => normalizeHealthRecord(loadSnapshot(subject), { rxnav });

function packetFor(subject: string, extra: Partial<Parameters<typeof buildContextPacket>[0]> = {}): ContextPacket {
  const record = recordFor(subject);
  const checkinDate = record.dataAsOf ?? "2026-09-01";
  return buildContextPacket({ record, ruleResults: runRules({ record, checkinDate }), checkinDate, ...extra });
}

const CONDITION_QUESTIONS = new Set(
  QUESTION_BANK.filter((q) => typeof q.appliesTo === "object" && "condition" in q.appliesTo).map((q) => q.id),
);

describe("context packet for Harriet (patient-demo-polypharmacy)", () => {
  const packet = packetFor("patient-demo-polypharmacy");

  it("has her name, age on the check-in date and the dates", () => {
    expect(packet.patient).toEqual({ preferredName: "Harriet", age: 78 });
    expect(packet.checkinDate).toBe("2026-09-01");
    expect(packet.dataAsOf).toBe("2026-09-01");
    expect(packet.sharing).toBe("status");
  });

  it("has her usual heart-rate range from 10 clinic readings", () => {
    expect(packet.usualRange).toEqual({ heartRate: { low: 65, high: 91, readings: 10 } });
  });

  it("lists active conditions and medications with dose, last fill and source", () => {
    expect(packet.conditions).toHaveLength(10);
    expect(packet.conditions).toContain("Heart failure");
    expect(packet.medications).toHaveLength(14);
    const apixaban = packet.medications.find((m) => m.rxnorm === "1364445");
    expect(apixaban).toMatchObject({ dose: "5 MG", lastFill: "2026-07-02" });
    expect(apixaban?.source).toMatch(/Northstar/);
    expect(packet.medications.every((m) => m.lastFill !== undefined && m.source !== "")).toBe(true);
  });

  it("keeps the latest value of each lab test", () => {
    const egfr = packet.recentLabs.find((l) => l.name.startsWith("Glomerular filtration rate"));
    expect(egfr).toMatchObject({ value: 31, date: "2026-07-14" });
    expect(packet.recentLabs.find((l) => l.name === "Potassium")).toEqual({
      name: "Potassium",
      value: 4.9,
      unit: "mmol/L",
      date: "2026-07-14",
      refRange: "3.5 - 5.1 mmol/L",
    });
    const names = packet.recentLabs.map((l) => l.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("has 3 open flags derived from rule results: R1, R3, R4", () => {
    expect(packet.openFlags.map((f) => f.ruleId)).toEqual(["R1", "R3", "R4"]);
    expect(packet.openFlags.every((f) => f.status === "new" && /^[0-9a-f]{16}$/.test(f.flagId))).toBe(true);
    const record = recordFor("patient-demo-polypharmacy");
    const r1 = runRules({ record, checkinDate: "2026-09-01" }).find((r) => r.ruleId === "R1")!;
    expect(packet.openFlags[0]!.flagId).toBe(fingerprint(r1));
  });

  it("asks at most 3 questions with 1 to 5 buttons of at most 80 characters", () => {
    expect(packet.todaysQuestions.length).toBeGreaterThan(0);
    expect(packet.todaysQuestions.length).toBeLessThanOrEqual(3);
    for (const q of packet.todaysQuestions) {
      expect(q.buttons.length).toBeGreaterThanOrEqual(1);
      expect(q.buttons.length).toBeLessThanOrEqual(5);
      for (const b of q.buttons) expect(b.length).toBeLessThanOrEqual(80);
      expect(Object.keys(q).sort()).toEqual(["buttons", "id", "text"]);
    }
  });

  it("uses stored flags instead of rule results when given, dropping cleared ones", () => {
    const p = packetFor("patient-demo-polypharmacy", {
      flags: [
        { flagId: "a", ruleId: "R1", status: "told", message: "m1" },
        { flagId: "b", ruleId: "R3", status: "cleared", message: "m3" },
        { flagId: "c", ruleId: "R4", status: "noted", message: "m4" },
      ],
    });
    expect(p.openFlags).toEqual([
      { flagId: "a", ruleId: "R1", status: "told", message: "m1" },
      { flagId: "c", ruleId: "R4", status: "noted", message: "m4" },
    ]);
  });

  it("passes through sharing, memories (capped) and family messages", () => {
    const memories = Array.from({ length: 15 }, (_, i) => `memory ${i}`);
    const p = packetFor("patient-demo-polypharmacy", {
      sharing: "all",
      memories,
      pendingFamilyMessages: [{ id: "fm1", from: "Maya", kind: "voice" }],
      preferredName: "Hattie",
    });
    expect(p.sharing).toBe("all");
    expect(p.memories).toEqual(memories.slice(0, 10));
    expect(p.pendingFamilyMessages).toEqual([{ id: "fm1", from: "Maya", kind: "voice" }]);
    expect(p.patient.preferredName).toBe("Hattie");
  });

  it("is pure: same input, same packet", () => {
    expect(packetFor("patient-demo-polypharmacy")).toEqual(packet);
  });
});

describe("context packet edge cases", () => {
  it("consent-partial: no condition questions, only medication-based ones and mood", () => {
    const packet = packetFor("patient-demo-consent-partial");
    const ids = packet.todaysQuestions.map((q) => q.id);
    expect(ids).toContain("mood");
    expect(ids.some((id) => CONDITION_QUESTIONS.has(id))).toBe(false);
    for (const id of ids) {
      const entry = QUESTION_BANK.find((q) => q.id === id)!;
      expect(entry.needs.every((c) => c === "medications")).toBe(true);
    }
    expect(packet.conditions).toEqual([]);
    expect(packet.recentLabs).toEqual([]);
    expect(packet.usualRange).toEqual({});
    expect(packet.patient.age).toBeNull();
    expect(packet.medications.map((m) => m.name)).toEqual(["lisinopril 10 MG Oral Tablet", "atorvastatin 20 MG Oral Tablet"]);
  });

  it("sparse record: only the generic mood question and empty lists", () => {
    const packet = packetFor("patient-demo-sparse");
    expect(packet.todaysQuestions.map((q) => q.id)).toEqual(["mood"]);
    expect(packet.conditions).toEqual([]);
    expect(packet.medications).toEqual([]);
    expect(packet.recentLabs).toEqual([]);
    expect(packet.openFlags).toEqual([]);
    expect(packet.usualRange).toEqual({});
    expect(packet.patient.preferredName).toBe("Jonah");
  });

  it("messy coding: usual range omitted with 1 heart-rate reading, unusable labs skipped", () => {
    const packet = packetFor("patient-demo-messy-coding");
    expect(packet.usualRange).toEqual({});
    const names = packet.recentLabs.map((l) => l.name);
    expect(names.some((n) => /creatinine/i.test(n))).toBe(false);
    expect(names.some((n) => /protein/i.test(n))).toBe(false);
    const glucose = packet.recentLabs.find((l) => /glucose/i.test(l.name))!;
    expect(glucose).toMatchObject({ value: 110, unit: "mg/dL", refRange: "70 - 101 mg/dL" });
    expect(packet.medications.some((m) => /simvastatin/i.test(m.name))).toBe(false);
  });

  it("usual range threshold is configurable", () => {
    expect(packetFor("patient-demo-messy-coding", { minUsualRangeReadings: 1 }).usualRange).toEqual({
      heartRate: { low: 72, high: 72, readings: 1 },
    });
    expect(packetFor("patient-demo-polypharmacy", { minUsualRangeReadings: 11 }).usualRange).toEqual({});
  });

  it("multi-source: merged medications keep every source", () => {
    const packet = packetFor("patient-demo-multi-source");
    expect(packet.medications.length).toBeGreaterThan(0);
    expect(packet.medications.some((m) => m.source.includes(", "))).toBe(true);
  });
});
