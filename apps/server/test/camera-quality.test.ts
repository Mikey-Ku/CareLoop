import { describe, expect, it, vi } from "vitest";
import { VideoBufferType } from "@relaymessenger/sdk/calls";
import { RelayPresageBridge } from "../src/calls/video.ts";
import { QuietMeasurement } from "../src/calls/quiet-measurement.ts";
import { emptyVitalsResult } from "../src/vitals/types.ts";

vi.mock("@smartspectra/node-sdk/messages", () => ({ decodeMetrics: (bytes: Uint8Array) => JSON.parse(Buffer.from(bytes).toString()) }));
const good = { ...emptyVitalsResult("relay_video"), heartRate: 72, breathingRate: 15, heartRateConfidence: 90, breathingRateConfidence: 90, heartRateStable: true, breathingRateStable: true };

function window(duration = 30_000) {
  const quiet = new QuietMeasurement(duration);
  quiet.requestPermission(true);
  quiet.recordFrame(1, false, 0);
  return quiet;
}

describe("camera reading qualification", () => {
  it("waits for pulse warm-up and gates stability independently for each metric", () => {
    const quiet = window();
    expect(quiet.finish(good).heartRate).toBeNull();
    quiet.recordFrame(2, false, 12_000);
    expect(quiet.finish(good).heartRate).toBe(72);
    expect(quiet.finish(good).breathingRate).toBeNull();
    quiet.recordFrame(3, false, 30_000);
    expect(quiet.finish({ ...good, heartRateStable: false }).heartRate).toBeNull();
    expect(quiet.finish({ ...good, heartRateStable: false }).breathingRate).toBe(15);
    expect(quiet.finish({ ...good, breathingRateStable: false }).breathingRate).toBeNull();
    expect(quiet.finish({ ...good, heartRateStable: null }).heartRate).toBeNull();
  });

  it("revocation invalidates readings and another permission starts a fresh window", () => {
    const quiet = window();
    quiet.recordFrame(2, false, 30_000);
    expect(quiet.finish(good).breathingRate).toBe(15);
    quiet.requestPermission(false);
    expect(quiet.finish(good).heartRate).toBeNull();
    quiet.requestPermission(true);
    expect(quiet.remainingMs(31_000)).toBe(30_000);
    expect(quiet.finish(good).breathingRate).toBeNull();
    quiet.recordFrame(3, false, 31_000);
    expect(quiet.finish(good).heartRate).toBeNull();
  });
});

function fixture(quietDurationMs = 30_000) {
  const handlers = new Map<string, (...args: any[]) => void>();
  const metricHandlers = new Map<string, (...args: any[]) => void>();
  const epochMs = 1_791_094_000_000;
  let now = 0;
  const captureEpoch = new Map<number, number>();
  const sent: number[] = [];
  const stopAsync = vi.fn(async () => {});
  const destroy = vi.fn(async () => {});
  const session = {
    on: (name: string, fn: (...args: any[]) => void) => metricHandlers.set(name, fn),
    useCustomInput: () => session,
    start: vi.fn(), stopAsync, destroy,
    sendFrame: (_b: unknown, _w: unknown, _h: unknown, _s: unknown, _f: unknown, t: number) => { sent.push(t); return true; },
  };
  const bridge = new RelayPresageBridge({ on: (name: string, fn: (...args: any[]) => void) => handlers.set(name, fn) } as never, { apiKey: "test", quietDurationMs, now: () => epochMs + now, sessionFactory: () => session as never });
  function track() {
    let consumer: { push: (event: unknown) => void; end: () => void };
    const unsubscribe = vi.fn();
    const result = { _subscribe: (value: typeof consumer) => { consumer = value; return unsubscribe; } };
    return {
      result, unsubscribe,
      frame(t: number, wall: number) {
        now = wall;
        captureEpoch.set(t, (epochMs + wall) * 1000);
        consumer.push({ frame: { type: VideoBufferType.RGBA, data: new Uint8Array(16), width: 2, height: 2 }, timestampUs: t });
      },
      end() { consumer.end(); },
    };
  }
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  const metrics = (t: number, sampleTime = t, stable: boolean | null = true) => metricHandlers.get("metrics")!(Buffer.from(JSON.stringify({ cardio: { pulseRate: [{ value: 72, confidence: 90, stable, timestamp: captureEpoch.get(sampleTime) ?? sampleTime }] }, breathing: { rate: [{ value: 15, confidence: 90, stable, timestamp: captureEpoch.get(sampleTime) ?? sampleTime }] } })), captureEpoch.get(t) ?? t);
  bridge.start();
  return { bridge, handlers, track, flush, sent, metrics, stopAsync, destroy, session, epoch: (t: number) => captureEpoch.get(t), setNow: (value: number) => { now = value; } };
}

describe("camera transport lifecycle", () => {
  it("pauses frames while restarting a previous processing run", async () => {
    const f = fixture(); const track = f.track();
    f.handlers.get("trackSubscribed")!(track.result);
    f.bridge.beginQuietMeasurement(true);
    track.frame(10_000_000, 0); await f.flush();
    let drain!: () => void;
    f.stopAsync.mockImplementationOnce(() => new Promise<void>((resolve) => { drain = resolve; }));
    f.bridge.beginQuietMeasurement(true);
    track.frame(11_000_000, 1_000); await f.flush();
    expect(f.sent).toEqual([f.epoch(10_000_000)]);
    drain(); await f.flush();
    expect(f.session.start).toHaveBeenCalledTimes(2);
    track.frame(12_000_000, 2_000); await f.flush();
    expect(f.sent).toEqual([f.epoch(10_000_000), f.epoch(12_000_000)]);
    await f.bridge.stop();
  });

  it("does not restart processing after shutdown during a retry drain", async () => {
    const f = fixture(); const track = f.track();
    f.handlers.get("trackSubscribed")!(track.result);
    f.bridge.beginQuietMeasurement(true);
    track.frame(10_000_000, 0); await f.flush();
    let drain!: () => void;
    f.stopAsync.mockImplementationOnce(() => new Promise<void>((resolve) => { drain = resolve; }));
    f.bridge.beginQuietMeasurement(true); await f.flush();
    const stopped = f.bridge.stop();
    drain(); await stopped;
    expect(f.session.start).toHaveBeenCalledOnce();
    expect(f.destroy).toHaveBeenCalledOnce();
  });

  it("qualifies breathing warmed at 30 seconds in a longer quiet window", async () => {
    const f = fixture(45_000); const track = f.track();
    f.handlers.get("trackSubscribed")!(track.result);
    f.bridge.beginQuietMeasurement(true);
    for (let i = 0; i <= 45; i += 1) {
      track.frame(10_000_000 + i * 1_000_000, i * 1_000); await f.flush();
      if (i === 35) f.metrics(45_000_000);
    }
    expect(f.bridge.result().breathingRate).toBe(15);
    await f.bridge.stop();
  });

  it("rejects stale samples inside a current packet and clears missing stability", async () => {
    const f = fixture(); const track = f.track();
    f.handlers.get("trackSubscribed")!(track.result);
    f.bridge.beginQuietMeasurement(true);
    for (let i = 0; i <= 13; i += 1) { track.frame(10_000_000 + i * 1_000_000, i * 1_000); await f.flush(); }
    f.metrics(23_000_000, 1);
    expect(f.bridge.result().heartRate).toBeNull();
    f.metrics(22_000_000);
    expect(f.bridge.result().heartRate).toBe(72);
    f.metrics(23_000_000, 23_000_000, null);
    expect(f.bridge.result().heartRate).toBeNull();
    await f.bridge.stop();
  });

  it("keeps final metrics from accepted frames during SDK drain and stops only once", async () => {
    const f = fixture(); const track = f.track();
    f.handlers.get("trackSubscribed")!(track.result);
    f.bridge.beginQuietMeasurement(true);
    for (let i = 0; i <= 12; i += 1) { track.frame(10_000_000 + i * 1_000_000, i * 1_000); await f.flush(); }
    f.stopAsync.mockImplementation(async () => { f.setNow(15_000); f.metrics(22_000_000); });
    const results = await Promise.all([f.bridge.stop(), f.bridge.stop()]);
    expect(results[0].heartRate).toBe(72);
    expect(f.stopAsync).toHaveBeenCalledOnce();
    expect(f.destroy).toHaveBeenCalledOnce();
  });

  it("invalidates a measurement if the camera stalls", async () => {
    const f = fixture(); const track = f.track();
    f.handlers.get("trackSubscribed")!(track.result);
    f.bridge.beginQuietMeasurement(true);
    track.frame(1, 0); await f.flush();
    track.frame(30_000_001, 30_000); await f.flush();
    expect(f.bridge.quiet.status).toBe("interrupted");
    expect(f.bridge.result().heartRate).toBeNull();
    expect(f.sent).toEqual([f.epoch(1)]);
    await f.bridge.stop();
  });

  it("releases the producer on a frame processing failure and destroys after a stop failure", async () => {
    const f = fixture(); const track = f.track();
    f.handlers.get("trackSubscribed")!(track.result);
    f.bridge.beginQuietMeasurement(true);
    f.session.sendFrame = () => { throw new Error("bad frame"); };
    track.frame(1, 0); await f.flush();
    expect(track.unsubscribe).toHaveBeenCalledOnce();
    expect(f.bridge.quiet.status).toBe("interrupted");
    f.stopAsync.mockRejectedValue(new Error("failed drain"));
    await f.bridge.stop();
    expect(f.destroy).toHaveBeenCalledOnce();
  });

  it("sends no frames before consent and ignores old metric packets", async () => {
    const f = fixture(); const track = f.track();
    f.handlers.get("trackSubscribed")!(track.result);
    track.frame(1, 0); await f.flush();
    expect(f.sent).toEqual([]);
    f.metrics(1);
    f.bridge.beginQuietMeasurement(true);
    track.frame(10_000_000, 1_000); await f.flush();
    for (let i = 1; i <= 12; i += 1) { track.frame(10_000_000 + i * 1_000_000, 1_000 + i * 1_000); await f.flush(); }
    f.metrics(1);
    expect(f.bridge.result().heartRate).toBeNull();
    f.metrics(22_000_000);
    expect(f.bridge.result().heartRate).toBe(72);
    f.bridge.beginQuietMeasurement(true);
    expect(f.bridge.result().heartRate).toBeNull();
    await f.bridge.stop();
  });

  it("stops promptly while no frames are arriving and releases SDK resources", async () => {
    const f = fixture(); const track = f.track();
    f.handlers.get("trackSubscribed")!(track.result);
    await f.bridge.stop();
    expect(track.unsubscribe).toHaveBeenCalledOnce();
    expect(f.stopAsync).toHaveBeenCalledOnce();
    expect(f.destroy).toHaveBeenCalledOnce();
    const late = f.track();
    f.handlers.get("trackSubscribed")!(late.result);
    expect(late.unsubscribe).not.toHaveBeenCalled();
  });

  it("does not process a queued old-track frame in a replacement measurement", async () => {
    const f = fixture(); const first = f.track();
    f.handlers.get("trackSubscribed")!(first.result);
    f.bridge.beginQuietMeasurement(true);
    first.frame(1, 0);
    const next = f.track();
    f.handlers.get("trackSubscribed")!(next.result);
    f.bridge.beginQuietMeasurement(true);
    await f.flush();
    next.frame(2, 10); await f.flush();
    expect(f.sent).toEqual([f.epoch(2)]);
    await f.bridge.stop();
  });

  it("can receive frames again when the video track is replaced", async () => {
    const f = fixture(); const first = f.track();
    f.handlers.get("trackSubscribed")!(first.result);
    f.bridge.beginQuietMeasurement(true);
    first.frame(1, 0); await f.flush();
    f.handlers.get("trackUnsubscribed")!();
    const next = f.track();
    f.handlers.get("trackSubscribed")!(next.result);
    expect(f.bridge.quiet.status).toBe("interrupted");
    f.bridge.beginQuietMeasurement(true);
    await f.flush();
    next.frame(2, 10); await f.flush();
    expect(first.unsubscribe).toHaveBeenCalledOnce();
    expect(f.sent).toEqual([f.epoch(1), f.epoch(2)]);
    await f.bridge.stop();
    expect(next.unsubscribe).toHaveBeenCalledOnce();
  });
});
