import { describe, expect, it, vi } from "vitest";
import { VideoBufferType } from "@relaymessenger/sdk/calls";
import { RelayPresageBridge, sampleAverageColor } from "../src/calls/video.ts";

vi.mock("@smartspectra/node-sdk/messages", () => ({ decodeMetrics: (bytes: Uint8Array) => JSON.parse(Buffer.from(bytes).toString()) }));

// What the quiet window logs so a bad reading can be told apart: a black or odd frame, a frozen feed, no face.
function fixture(options: { maxFrameGapMs?: number } = {}, transportExtra: Record<string, unknown> = {}) {
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
  const transport: Record<string, unknown> = { on: (name: string, fn: (...args: any[]) => void) => handlers.set(name, fn), ...transportExtra };
  const bridge = new RelayPresageBridge(transport as never, {
    apiKey: "test", now: () => now, sessionFactory: () => session as never, log: (event, fields) => logs.push({ event, fields }), ...options,
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
  return { bridge, session, transport, end: () => consumer.end(), frame, flush, logs, eventsOf, sessionHandlers, handlers, setNow: (wall: number) => { now = 1_791_094_000_000 + wall; } };
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

  it("says how long the camera was silent, and what the window had seen, when a stall cuts it short", async () => {
    const f = fixture();
    f.frame(1_000_000, 0); await f.flush();
    f.frame(1_100_000, 100); await f.flush();
    f.setNow(5_100); // 5 s without a frame
    expect(f.bridge.measuring()).toBe(false);
    expect(f.eventsOf("call_quiet_measurement_interrupted")).toEqual([
      expect.objectContaining({ reason: "video_stalled", gap_ms: 5_000, frames: 2, max_gap_ms: 100, width: 4, height: 4, mean_rgba: [10, 120, 200, 255] }),
    ]);
    await f.bridge.stop();
  });

  it("restarts the reading inside the window after a pause SmartSpectra would refuse (the 2.1 s pause seen live), without ending the window", async () => {
    const f = fixture();
    for (let i = 0; i < 6; i += 1) { f.frame(1_000_000 + i * 15_000, i * 15); await f.flush(); }
    f.setNow(2_050);
    expect(f.bridge.measuring()).toBe(true); // asked during the pause (the orchestrator does, each second): the pause is not yet the end
    f.frame(3_134_000, 2_134); await f.flush(); // the pause seen live, frame 64 after the burst
    expect(f.bridge.quiet.status).toBe("measuring");
    expect(f.bridge.measuring()).toBe(true);
    expect(f.eventsOf("call_quiet_measurement_interrupted")).toEqual([]);
    expect(f.eventsOf("call_quiet_measurement_restarted")).toEqual([
      expect.objectContaining({ reason: "video_gap", restarts: 1, elapsed_ms: 2_134, remaining_ms: expect.any(Number), media_gap_ms: expect.any(Number), gap_ms: 2_134 - 75 }),
    ]);
    expect(f.session.stopAsync).toHaveBeenCalledOnce();
    expect(f.session.start).toHaveBeenCalledTimes(2);
    expect(f.eventsOf("call_presage_restarted")).toEqual([{ stop_ms: expect.any(Number), start_ms: expect.any(Number) }]);
    const sent: number[] = [];
    f.session.sendFrame = (...args: unknown[]) => { sent.push(args[5] as number); return true; };
    f.frame(3_167_000, 2_167); await f.flush(); // the first frames after the restart are taken again
    f.frame(3_200_000, 2_200); await f.flush();
    expect(sent).toHaveLength(2);
    expect(f.bridge.quiet.status).toBe("measuring");
    await f.bridge.stop();
  });

  it("rides out a short pause with no restart and logs it, and never lets the limit rise above SmartSpectra's own 2 s", async () => {
    const f = fixture({ maxFrameGapMs: 10_000 }); // asked for 10 s: clamped to 1900
    f.frame(1_000_000, 0); await f.flush();
    f.frame(2_500_000, 1_500); await f.flush(); // 1.5 s: SmartSpectra takes it
    f.frame(2_600_000, 1_600); await f.flush();
    expect(f.eventsOf("call_quiet_measurement_restarted")).toEqual([]);
    expect(f.eventsOf("call_video_pause")).toEqual([expect.objectContaining({ gap_ms: 1_500, media_gap_ms: 1_500 })]);
    f.frame(4_600_000, 3_600); await f.flush(); // 2 s: over the clamp
    expect(f.eventsOf("call_quiet_measurement_restarted")).toHaveLength(1);
    await f.bridge.stop();
  });

  it("logs a restart with her video's own counters (frames dropped, keyframes asked for) and how long this process stalled", async () => {
    const videoStats = () => ({ inbound: { framesDropped: 64, decodeErrors: 0, keyframeRequests: 2, recentFrames: 27, codec: "h264" } });
    const f = fixture({}, { videoStats });
    f.frame(1_000_000, 0); await f.flush();
    f.frame(3_134_000, 2_134); await f.flush();
    expect(f.eventsOf("call_quiet_measurement_restarted")).toEqual([
      expect.objectContaining({ gap_ms: 2_134, media_gap_ms: 2_134, rx_dropped: 64, rx_keyframe_requests: 2, rx_decode_errors: 0, rx_recent_frames: 27, rx_codec: "h264", loop_lag_ms: expect.any(Number) }),
    ]);
    await f.bridge.stop();
  });

  it("takes her video track again for a new window when its reader has ended", async () => {
    const f = fixture();
    f.frame(1_000_000, 0); await f.flush();
    f.end(); await f.flush();
    expect(f.eventsOf("call_quiet_measurement_interrupted")).toEqual([expect.objectContaining({ reason: "stream_ended" })]);
    let consumer!: { push: (event: unknown) => void; end: () => void };
    const track = { _subscribe: vi.fn((value: typeof consumer) => { consumer = value; return vi.fn(); }) };
    f.transport.remoteVideoTrack = track;
    f.bridge.beginQuietMeasurement(true);
    expect(track._subscribe).toHaveBeenCalledOnce();
    await f.flush(); // the session restarts for the new window first
    const sent: number[] = [];
    f.session.sendFrame = (...args: unknown[]) => { sent.push(args[5] as number); return true; };
    consumer.push({ frame: { type: VideoBufferType.RGBA, data: new Uint8Array(64), width: 4, height: 4 }, timestampUs: 5_000_000 });
    await f.flush();
    expect(sent).toHaveLength(1);
    await f.bridge.stop();
  });

  it("restarts when sendFrame throws code 11, and logs the rejection once per code, not once per frame", async () => {
    const f = fixture();
    let thrown = 0;
    f.session.sendFrame = () => { thrown += 1; throw Object.assign(new Error("SmartSpectra detected a gap between camera frame timestamps."), { code: 11 }); };
    f.frame(1_000_000, 0); await f.flush();
    f.frame(1_033_000, 33); await f.flush();
    f.frame(1_066_000, 66); await f.flush();
    expect(thrown).toBe(3);
    expect(f.eventsOf("call_video_frame_rejected")).toEqual([{ reason: "sdk_error", code: 11, message: "SmartSpectra detected a gap between camera frame timestamps." }]);
    expect(f.eventsOf("call_quiet_measurement_restarted")).toEqual([
      expect.objectContaining({ reason: "sdk_error", code: 11, restarts: 1 }),
      expect.objectContaining({ reason: "sdk_error", code: 11, restarts: 2 }),
      expect.objectContaining({ reason: "sdk_error", code: 11, restarts: 3 }),
    ]);
    expect(f.bridge.quiet.status).toBe("measuring");
    await f.bridge.stop();
  });

  it("ends the window on the fourth pause, with its own reason", async () => {
    const f = fixture();
    f.frame(1_000_000, 0); await f.flush();
    for (let i = 1; i <= 3; i += 1) {
      f.frame(1_000_000 + i * 2_100_000, i * 2_100); await f.flush(); // pause: restart i
      expect(f.bridge.quiet.status).toBe("measuring");
      f.frame(1_000_000 + i * 2_100_000 + 33_000, i * 2_100 + 33); await f.flush(); // the first frame after it
    }
    expect(f.eventsOf("call_quiet_measurement_restarted")).toHaveLength(3);
    f.frame(1_000_000 + 4 * 2_100_000, 4 * 2_100); await f.flush();
    expect(f.bridge.quiet.status).toBe("interrupted");
    expect(f.eventsOf("call_quiet_measurement_interrupted")).toEqual([expect.objectContaining({ reason: "video_gap_repeated", trigger: "video_gap" })]);
    await f.bridge.stop();
  });

  it("ends a window that took no frame within 3 s of beginning, and says when the first frame came otherwise", async () => {
    vi.useFakeTimers();
    try {
      const empty = fixture();
      await vi.advanceTimersByTimeAsync(2_900);
      expect(empty.bridge.quiet.status).toBe("measuring");
      await vi.advanceTimersByTimeAsync(200);
      expect(empty.bridge.quiet.status).toBe("interrupted");
      expect(empty.bridge.measuring()).toBe(false);
      expect(empty.eventsOf("call_quiet_measurement_interrupted")).toEqual([expect.objectContaining({ reason: "no_frames", frames: 0 })]);
      expect(empty.eventsOf("call_quiet_measurement_finished")).toEqual([expect.objectContaining({ reason: "no_frames", frames: 0 })]);

      const fed = fixture();
      await vi.advanceTimersByTimeAsync(500);
      fed.frame(1_000_000, 500); await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(fed.bridge.quiet.status).toBe("measuring");
      expect(fed.eventsOf("call_video_first_frame")).toEqual([{ begin_to_first_frame_ms: 500 }]);
      await Promise.all([fed.bridge.stop(), empty.bridge.stop()]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("writes one finished line per window, whatever ends it, with what Presage reported", async () => {
    const f = fixture();
    const epochUs = (wallMs: number) => (1_791_094_000_000 + wallMs) * 1000;
    for (let i = 0; i <= 30; i += 1) {
      f.frame(1_000_000 + i * 1_000_000, i * 1_000); await f.flush();
      if (i === 14) f.sessionHandlers.get("metrics")!(Buffer.from(JSON.stringify({ cardio: { pulseRate: [{ value: 71, confidence: 13, stable: false, timestamp: epochUs(14_000) }] } })), epochUs(14_000));
    }
    expect(f.bridge.quiet.status).toBe("complete");
    f.bridge.result();
    f.bridge.result();
    expect(f.eventsOf("call_quiet_measurement_finished")).toEqual([
      expect.objectContaining({ reason: "complete", frames: 31, elapsed_ms: 30_000, restarts: 0, talking_share: 0, hr: 71, hr_confidence: 13, hr_stable: false, br: null, br_confidence: null, br_stable: null, metrics_packets: 1 }),
    ]);
    f.bridge.beginQuietMeasurement(true); await f.flush(); // the restart of the session settles
    f.frame(40_000_000, 31_000); await f.flush();
    await f.bridge.stop();
    expect(f.eventsOf("call_quiet_measurement_finished")).toHaveLength(2);
    expect(f.eventsOf("call_quiet_measurement_finished")[1]).toMatchObject({ reason: "stopped", frames: 1 });
  });

  it("logs what Presage says about itself at once: errors, status changes, and per window the frames it dropped", async () => {
    const f = fixture();
    f.sessionHandlers.get("error")!(5, "network", true);
    f.sessionHandlers.get("processingStatus")!(3);
    expect(f.eventsOf("call_presage_error")).toEqual([{ code: 5, message: "network", retryable: true }]);
    expect(f.eventsOf("call_presage_status")).toEqual([{ status: 3 }]);
    for (let i = 0; i <= 10; i += 1) {
      f.sessionHandlers.get("frameSentThrough")!(i % 5 !== 0, 1);
      f.frame(1_000_000 + i * 330_000, i * 330); await f.flush();
    }
    expect(f.eventsOf("call_video_cadence")[0]).toMatchObject({ presage_sent: expect.any(Number), presage_dropped: expect.any(Number) });
    await f.bridge.stop();
  });

  it("says why a reading ended, every time: a stream that ended, a track taken away, a camera that went quiet", async () => {
    const f = fixture({ maxFrameGapMs: 3_000 });
    f.frame(1_000_000, 0); await f.flush();
    f.setNow(5_000); // no frame for 5 s: noticed when asked, not only when the next frame comes
    expect(f.bridge.measuring()).toBe(false);
    expect(f.eventsOf("call_quiet_measurement_interrupted")).toEqual([expect.objectContaining({ reason: "video_stalled", gap_ms: 5_000 })]);
    f.bridge.beginQuietMeasurement(true);
    f.frame(9_000_000, 9_000); await f.flush();
    f.handlers.get("trackUnsubscribed")!();
    expect(f.eventsOf("call_quiet_measurement_interrupted").at(-1)).toMatchObject({ reason: "track_unsubscribed" });
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

  it("starts the validation log afresh in every window", async () => {
    const f = fixture();
    const validation = f.sessionHandlers.get("validationStatus")!;
    for (let i = 0; i < 40; i += 1) validation(i, i, `hint ${i}`);
    expect(f.eventsOf("call_presage_validation")).toHaveLength(30);
    f.bridge.beginQuietMeasurement(true);
    validation(1, 99, "No face found.");
    expect(f.eventsOf("call_presage_validation")).toHaveLength(31);
    await f.bridge.stop();
  });

  it("counts the metrics packets Presage sends, so 'no reading' can be told from 'nothing came back'", async () => {
    const f = fixture();
    f.frame(1_000_000, 0); await f.flush();
    f.sessionHandlers.get("metrics")!(Buffer.from(JSON.stringify({})), 1_000_000);
    f.sessionHandlers.get("metrics")!(Buffer.from(JSON.stringify({})), 1_200_000);
    f.setNow(5_000);
    expect(f.bridge.measuring()).toBe(false);
    expect(f.eventsOf("call_quiet_measurement_interrupted")[0]).toMatchObject({ metrics_packets: 2 });
    await f.bridge.stop();
  });
});
