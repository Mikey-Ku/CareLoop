import { describe, expect, it, vi } from "vitest";
import { VideoBufferType } from "@relaymessenger/sdk/calls";
import { RelayPresageBridge, sampleAverageColor } from "../src/calls/video.ts";

vi.mock("@smartspectra/node-sdk/messages", () => ({ decodeMetrics: (bytes: Uint8Array) => JSON.parse(Buffer.from(bytes).toString()) }));

// What the quiet window logs so a bad reading can be told apart: a black or odd frame, a frozen feed, no face.
function fixture() {
  const handlers = new Map<string, (...args: any[]) => void>();
  const sessionHandlers = new Map<string, (...args: any[]) => void>();
  const logs: { event: string; fields: Record<string, unknown> | undefined }[] = [];
  let now = 1_791_094_000_000;
  const session = {
    on: (name: string, fn: (...args: any[]) => void) => sessionHandlers.set(name, fn),
    useCustomInput: () => session,
    start: vi.fn(), stopAsync: vi.fn(async () => {}), destroy: vi.fn(async () => {}),
    sendFrame: () => true,
  };
  const bridge = new RelayPresageBridge({ on: (name: string, fn: (...args: any[]) => void) => handlers.set(name, fn) } as never, {
    apiKey: "test", now: () => now, sessionFactory: () => session as never, log: (event, fields) => logs.push({ event, fields }),
  });
  let consumer!: { push: (event: unknown) => void; end: () => void };
  const track = { _subscribe: (value: typeof consumer) => { consumer = value; return vi.fn(); } };
  bridge.start();
  handlers.get("trackSubscribed")!(track);
  bridge.beginQuietMeasurement(true);
  const frame = (t: number, wall: number, rgba: [number, number, number, number] = [10, 120, 200, 255]) => {
    now = 1_791_094_000_000 + wall;
    const data = new Uint8Array(4 * 4 * 4);
    for (let i = 0; i < data.length; i += 4) data.set(rgba, i);
    consumer.push({ frame: { type: VideoBufferType.RGBA, data, width: 4, height: 4 }, timestampUs: t });
  };
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  const eventsOf = (name: string) => logs.filter((l) => l.event === name).map((l) => l.fields!);
  return { bridge, frame, flush, logs, eventsOf, sessionHandlers };
}

describe("sampleAverageColor", () => {
  it("averages a solid frame, tells a black frame from a normal one, and survives short data", () => {
    const solid = new Uint8Array(4 * 4 * 4);
    for (let i = 0; i < solid.length; i += 4) solid.set([10, 120, 200, 255], i);
    expect(sampleAverageColor(solid, 4, 4)).toEqual([10, 120, 200, 255]);
    expect(sampleAverageColor(new Uint8Array(64), 4, 4)).toEqual([0, 0, 0, 0]);
    expect(sampleAverageColor(new Uint8Array(3), 4, 4)).toEqual([0, 0, 0, 0]);
  });
});

describe("the quiet window's telemetry", () => {
  it("logs cadence every 3 s: frames per second, longest gap, size and average colour, no pixels", async () => {
    const f = fixture();
    for (let i = 0; i <= 10; i += 1) { f.frame(1_000_000 + i * 330_000, i * 330); await f.flush(); }
    const cadence = f.eventsOf("call_video_cadence");
    expect(cadence.length).toBeGreaterThanOrEqual(1);
    expect(cadence[0]).toMatchObject({ width: 4, height: 4, mean_rgba: [10, 120, 200, 255], max_gap_ms: 330 });
    expect(cadence[0]!.fps).toBeCloseTo(3, 0);
    for (const fields of cadence) for (const value of Object.values(fields)) expect(typeof value === "number" || Array.isArray(value)).toBe(true);
    await f.bridge.stop();
  });

  it("says how big the gap was, and what the window had seen, when a stall cuts it short", async () => {
    const f = fixture();
    f.frame(1_000_000, 0); await f.flush();
    f.frame(1_100_000, 100); await f.flush();
    f.frame(2_600_000, 1_600); await f.flush(); // 1.5 s without a frame
    expect(f.bridge.quiet.status).toBe("interrupted");
    expect(f.eventsOf("call_quiet_measurement_interrupted")).toEqual([
      expect.objectContaining({ reason: "video_gap", gap_ms: 1_500, frames: 2, max_gap_ms: 100, width: 4, height: 4, mean_rgba: [10, 120, 200, 255] }),
    ]);
    await f.bridge.stop();
  });

  it("logs each change of what Presage says about the picture once (no face, hold still), not every frame", async () => {
    const f = fixture();
    const validation = f.sessionHandlers.get("validationStatus")!;
    validation(0, 1, "Hold still and record.");
    validation(0, 2, "Hold still and record.");
    validation(1, 3, "No face found.");
    validation(1, 4, "No face found.");
    validation(0, 5, "Hold still and record.");
    expect(f.eventsOf("call_presage_validation")).toEqual([
      { code: 0, hint: "Hold still and record." },
      { code: 1, hint: "No face found." },
      { code: 0, hint: "Hold still and record." },
    ]);
    await f.bridge.stop();
  });

  it("counts the metrics packets Presage sends, so 'no reading' can be told from 'nothing came back'", async () => {
    const f = fixture();
    f.frame(1_000_000, 0); await f.flush();
    f.sessionHandlers.get("metrics")!(Buffer.from(JSON.stringify({})), 1_000_000);
    f.sessionHandlers.get("metrics")!(Buffer.from(JSON.stringify({})), 1_200_000);
    f.frame(2_600_000, 2_600); await f.flush();
    expect(f.eventsOf("call_quiet_measurement_interrupted")[0]).toMatchObject({ metrics_packets: 2 });
    await f.bridge.stop();
  });
});
