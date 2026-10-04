import { describe, expect, it } from "vitest";
import { emergencyDecision } from "../src/calls/emergency.ts";
import { interviewQuestions, ShortInterview } from "../src/calls/interview.ts";
import { QuietMeasurement } from "../src/calls/quiet-measurement.ts";
import { runScreening } from "../src/calls/screening.ts";
import { withinRelayAnswerDeadline } from "../src/calls/service.ts";
import { createRelayVideoFrameAdapter } from "../src/vitals/relay-frame-adapter.ts";
import { emptyVitalsResult } from "../src/vitals/types.ts";
import { openDatabase, upsertPatient } from "../src/db/index.ts";

describe("call interview and safety", () => {
  it("asks one short question at a time and enters quiet measurement after sufficient evidence", () => {
    const interview = new ShortInterview();
    expect(interview.nextQuestion()).toBe(interviewQuestions[0]);
    expect(interview.addPatientTurn("My breathing has been harder today").nextQuestion).toBe(interviewQuestions[1]);
    interview.addPatientTurn("It started this morning and is worse");
    interview.addPatientTurn("Moderate");
    expect(interview.addPatientTurn("A little ankle swelling").complete).toBe(true);
    expect(interview.phase).toBe("quiet_measurement");
  });

  it("gives crisis precedence over an urgent phrase", () => {
    const decision = emergencyDecision([
      { speaker: "patient", text: "I have chest pain" },
      { speaker: "patient", text: "I do not want to live anymore" },
    ]);
    expect(decision?.concernLevel).toBe("crisis");
    expect(decision?.recommendedHumanAction).toBe("crisis_support_now");
  });

  it("does not interpret symptoms when Gemini is unavailable", async () => {
    const result = await runScreening(
      {} as never,
      {
        callId: "call-1",
        patientId: "patient-1",
        transcript: [{ speaker: "patient", text: "I feel tired" }],
        currentVitals: emptyVitalsResult("relay_video"),
        contextPacket: {} as never,
        recentMemories: [],
        symptomObservations: [],
      },
    );
    expect(result.recommendedHumanAction).toBe("monitor_and_document");
    expect(result.uncertainty.join(" ")).toMatch(/unavailable/i);
    expect(result.patientResponseText).toMatch(/Thank you|care team/i);
  });
});

describe("quiet measurement", () => {
  it("requires permission, a complete timing window, and rejects speaking as unusable", () => {
    const quiet = new QuietMeasurement(30_000);
    expect(quiet.recordFrame(1, false, 0)).toBe(false);
    quiet.requestPermission(true);
    quiet.recordFrame(2, false, 1_000);
    quiet.recordFrame(3, true, 31_000);
    expect(quiet.status).toBe("complete");
    const result = quiet.finish({
      heartRate: 72,
      breathingRate: 15,
      heartRateConfidence: 0.9,
      breathingRateConfidence: 0.9,
      heartRateStable: true,
      breathingRateStable: true,
      confidence: 0.9,
      measuredAt: new Date().toISOString(),
      source: "relay_video",
      validation: [],
      errors: [],
    });
    expect(result.heartRate).toBeNull();
    expect(result.breathingRate).toBeNull();
    expect(result.errors.at(-1)?.code).toBe("quiet_window_unusable");
  });

  it("never turns zero confidence into a usable reading", () => {
    const quiet = new QuietMeasurement(30_000);
    quiet.requestPermission(true);
    quiet.recordFrame(1, false, 1_000);
    quiet.recordFrame(2, false, 31_000);
    const result = quiet.finish({ ...emptyVitalsResult("relay_video"), heartRate: 70, breathingRate: 14, confidence: 0 });
    expect(result.heartRate).toBeNull();
    expect(result.confidence).toBeNull();
  });
});

describe("Relay and persistence boundaries", () => {
  it("rejects malformed frames and keeps monotonic timestamps", () => {
    const timestamps: number[] = [];
    const adapter = createRelayVideoFrameAdapter({
      sendFrame: (_buffer, _width, _height, _stride, _format, timestampUs) => {
        timestamps.push(timestampUs);
        return true;
      },
    }, { nowUs: () => 100 });
    expect(adapter.send({ buffer: new Uint8Array(2), width: 2, height: 2, stride: 8, pixelFormat: "RGBA" }).accepted).toBe(false);
    const unsupported = adapter.send({ buffer: new Uint8Array(16), width: 2, height: 2, stride: 8, pixelFormat: "I420" });
    expect(unsupported.accepted).toBe(false);
    if (!unsupported.accepted) expect(unsupported.reason).toBe("unsupported_pixel_format");
    expect(adapter.send({ buffer: new Uint8Array(16), width: 2, height: 2, stride: 8, pixelFormat: "RGBA", timestampUs: 20 }).accepted).toBe(true);
    expect(adapter.send({ buffer: new Uint8Array(16), width: 2, height: 2, stride: 8, pixelFormat: "RGBA", timestampUs: 20 }).accepted).toBe(true);
    expect(timestamps[1]).toBeGreaterThan(timestamps[0]!);
  });

  it("stores call metadata and transcript text, never raw media fields", () => {
    const db = openDatabase(":memory:");
    upsertPatient(db, { id: "p1", finchnodePatientId: "subject", preferredName: "Patient" });
    db.prepare(`INSERT INTO call_sessions (call_id, patient_id, relay_chat_id, status, phase, started_at) VALUES ('c1', 'p1', 'chat', 'ended', 'complete', '2026-10-03T00:00:00Z')`).run();
    const columns = db.prepare(`PRAGMA table_info(call_sessions)`).all() as { name: string }[];
    expect(columns.map((column) => column.name)).not.toContain("audio");
    expect(columns.map((column) => column.name)).not.toContain("video");
  });

  it("keeps the documented Relay 32 second answer deadline", () => {
    expect(withinRelayAnswerDeadline("2026-10-03T00:00:00.000Z", "2026-10-03T00:00:31.999Z")).toBe(true);
    expect(withinRelayAnswerDeadline("2026-10-03T00:00:00.000Z", "2026-10-03T00:00:32.001Z")).toBe(false);
  });
});

describe("call copy scan (the house rules cover the call's fixed texts)", () => {
  const DASHES = /[–—]/;
  const DOSING = /\b(should|could|must|needs? to) (take|stop|start|increase|decrease|double|skip|halve)\b/i;

  it("fixed call texts: no long dashes, no dosing advice, no diagnosis; 911 only in the emergency and crisis texts", async () => {
    const crisis = emergencyDecision([{ speaker: "patient", text: "I do not want to live anymore" }])!;
    const urgent = emergencyDecision([{ speaker: "patient", text: "I have chest pain" }])!;
    const db = openDatabase(":memory:");
    const fallback = await runScreening(
      { db, loadSnapshot: async () => { throw new Error("unused"); } },
      { callId: "c", patientId: "p", transcript: [{ speaker: "patient", text: "my knee aches" }], currentVitals: emptyVitalsResult("relay_video", []), contextPacket: {} as never, recentMemories: [], symptomObservations: [] },
    );
    db.close();
    for (const text of [crisis.patientResponseText, urgent.patientResponseText, fallback.patientResponseText, fallback.caregiverSummary, ...interviewQuestions]) {
      expect(DASHES.test(text), text).toBe(false);
      expect(DOSING.test(text), text).toBe(false);
      expect(/\bdiagnos(e|ed|es|is|ing)\b/i.test(text), text).toBe(false);
    }
    expect(crisis.patientResponseText).toMatch(/988/);
    expect(urgent.patientResponseText).toMatch(/call 911 now/);
    for (const text of [fallback.patientResponseText, fallback.caregiverSummary, ...interviewQuestions]) expect(/\b911\b/.test(text), text).toBe(false);
  });
});
