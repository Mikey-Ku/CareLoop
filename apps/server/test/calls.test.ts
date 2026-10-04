import { describe, expect, it } from "vitest";
import { MetricType } from "@smartspectra/node-sdk";
import { callCopySamples, callFirstMessage, heartRateReadback } from "../src/calls/copy.ts";
import { emergencyDecision } from "../src/calls/emergency.ts";
import { QuietMeasurement } from "../src/calls/quiet-measurement.ts";
import { loadUsualRange } from "../src/calls/screening.ts";
import { withinRelayAnswerDeadline } from "../src/calls/service.ts";
import { RelayPresageBridge } from "../src/calls/video.ts";
import { loadSnapshot } from "../src/finchnode/fixtures.ts";
import { runPresageVideo } from "../src/vitals/presage-file.ts";
import { createRelayVideoFrameAdapter } from "../src/vitals/relay-frame-adapter.ts";
import { emptyVitalsResult } from "../src/vitals/types.ts";
import { openDatabase, upsertPatient } from "../src/db/index.ts";

describe("call safety", () => {
  it("gives crisis precedence over an urgent phrase", () => {
    const decision = emergencyDecision([
      { speaker: "patient", text: "I have chest pain" },
      { speaker: "patient", text: "I do not want to live anymore" },
    ]);
    expect(decision?.hit.kind).toBe("crisis");
    expect(decision?.level).toBe(5);
  });
});

describe("the call says it is an AI", () => {
  it("first message: AI check-in assistant, short, then the open question", () => {
    const first = callFirstMessage("Harriet");
    expect(first.startsWith("Hi Harriet, I'm an AI check-in assistant.")).toBe(true);
    expect(first).toMatch(/about three minutes/);
  });
});

describe("quiet measurement", () => {
  it("requires permission, a complete timing window, and rejects talking through it as unusable", () => {
    const quiet = new QuietMeasurement(30_000);
    expect(quiet.recordFrame(1, false, 0)).toBe(false);
    quiet.requestPermission(true);
    quiet.recordFrame(2, false, 1_000);
    quiet.recordFrame(3, true, 31_000);
    expect(quiet.status).toBe("complete");
    const result = quiet.finish({
      heartRate: 72,
      breathingRate: 15,
      heartRateConfidence: 90,
      breathingRateConfidence: 90,
      heartRateStable: true,
      breathingRateStable: true,
      confidence: 90,
      measuredAt: new Date().toISOString(),
      source: "relay_video",
      validation: [],
      errors: [],
    });
    expect(result.heartRate).toBeNull();
    expect(result.breathingRate).toBeNull();
    expect(result.errors.at(-1)?.code).toBe("quiet_window_unusable");
  });

  it("never turns zero confidence into a usable reading, and keeps heart rate when breathing is missing", () => {
    const quiet = new QuietMeasurement(30_000);
    quiet.requestPermission(true);
    for (let i = 1; i <= 10; i += 1) quiet.recordFrame(i, i === 5, i * 3_100); // one loud frame
    const zero = quiet.finish({ ...emptyVitalsResult("relay_video"), heartRate: 70, breathingRate: 14, confidence: 0 });
    expect(zero.heartRate).toBeNull();
    expect(zero.confidence).toBeNull();
    const pulseOnly = quiet.finish({ ...emptyVitalsResult("relay_video"), heartRate: 70, heartRateConfidence: 40, breathingRate: null }, 10);
    expect(pulseOnly.heartRate).toBe(70);
    expect(quiet.finish({ ...emptyVitalsResult("relay_video"), heartRate: 70, heartRateConfidence: 5 }, 10).heartRate).toBeNull();
  });
});

describe("Presage: pulse and breathing only", () => {
  class FakeSession {
    on() {
      return this;
    }
    useCustomInput() {
      return this;
    }
    useFile() {
      return this;
    }
    start() {
      (this as unknown as { started: boolean }).started = true;
    }
    async stopAsync() {}
    async destroy() {}
    sendFrame() {
      return true;
    }
  }

  it("the call bridge and the file runner request only PULSE_RATE and BREATHING_RATE, never blood pressure or HRV", async () => {
    const requested: number[][] = [];
    new RelayPresageBridge({ on: () => undefined, remoteVideoTrack: undefined } as never, {
      apiKey: "test",
      sessionFactory: (options) => {
        requested.push(options.requestedMetrics);
        return new FakeSession() as never;
      },
    });
    await runPresageVideo({
      videoPath: "face.mp4",
      apiKey: "test",
      timeoutMs: 1,
      sdkFactory: (options) => {
        requested.push(options.requestedMetrics);
        return new FakeSession() as never;
      },
    });
    const wanted = [MetricType.BREATHING_RATE, MetricType.PULSE_RATE].sort();
    for (const metrics of requested) expect([...metrics].sort()).toEqual(wanted);
    expect(requested).toHaveLength(2);
  });
});

describe("heart rate read back", () => {
  it("Harriet has AFib: a camera estimate with no usual-range comparison; a patient whose range is compared hears it", async () => {
    const range = await loadUsualRange(async (s) => loadSnapshot(s), "patient-demo-polypharmacy", "2026-09-01");
    expect(range.compareHeartRate).toBe(false);
    const harriet = heartRateReadback({ heartRate: 120, breathingRate: 14 }, range);
    expect(harriet).toBe("Your heart rate is about 120 beats a minute. This is a camera estimate, not a medical test. Your breathing was about 14 breaths a minute.");
    expect(harriet).not.toMatch(/usual|range|normal|high|low/i);
    const compared = heartRateReadback({ heartRate: 120 }, { compareHeartRate: true, heartRate: { low: 65, high: 91, readings: 10 } });
    expect(compared).toMatch(/outside your usual range/);
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

describe("call copy scan (the house rules cover every fixed call text)", () => {
  const DASHES = /[–—]/;
  const DOSING = /\b(should|could|must|needs? to) (take|stop|start|increase|decrease|double|skip|halve)\b|\b\d+\s*(mg|tablets?|pills?|capsules?)\b/i;

  it("no long dashes, no dosing, no diagnosis; no 911 below level 3, 911 now only at 4 and up", () => {
    const samples = callCopySamples();
    expect(samples.length).toBeGreaterThan(20);
    for (const { level, text } of samples) {
      expect(DASHES.test(text), text).toBe(false);
      expect(DOSING.test(text), text).toBe(false);
      expect(/\bdiagnos(e|ed|es|is|ing)\b/i.test(text), text).toBe(false);
      if (level < 3) expect(/\b911\b|emergency|ambulance/i.test(text), text).toBe(false);
      if (level === 3 && /\b911\b/.test(text)) expect(text, text).toMatch(/if it gets much worse, call 911/i);
      if (level < 4) expect(/911 (now|right away)|call 911 now|please call 911\./i.test(text), text).toBe(false);
    }
    const at = (level: number) => samples.filter((s) => s.level === level).map((s) => s.text).join(" ");
    expect(at(4)).toMatch(/call 911 right away|please call 911/i);
    expect(at(5)).toMatch(/988/);
  });
});
