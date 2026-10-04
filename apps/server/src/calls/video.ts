import { monitorEventLoopDelay } from "node:perf_hooks";
import { VideoBufferType, VideoStream, type RelayAudioFrame, type RelayCallTransport, type RemoteVideoTrack, type VideoFrameEvent } from "@relaymessenger/sdk/calls";
import { MetricType, ProcessingStatus, SmartSpectraSDK } from "@smartspectra/node-sdk";
import { decodeMetrics } from "@smartspectra/node-sdk/messages";
import { MAX_FRAME_GAP_LIMIT_MS } from "../config.ts";
import { createFrameTimestampAnchor } from "../vitals/frame-clock.ts";
import { createRelayVideoFrameAdapter, type FrameSendResult } from "../vitals/relay-frame-adapter.ts";
import { mergeMetricSnapshots, normalizePresageMetrics, resultFromSnapshot, type MetricSnapshot } from "../vitals/normalize.ts";
import type { PresageSession } from "../vitals/presage-file.ts";
import type { ValidationEvent, VitalsError, VitalsResult } from "../vitals/types.ts";
import { PULSE_WARM_UP_MS, QuietMeasurement } from "./quiet-measurement.ts";

export type RelayVideoLogger = (event: string, fields?: Record<string, unknown>) => void;

export type RelayPresageBridgeOptions = {
  apiKey: string;
  quietDurationMs?: number;
  /** VITALS_MIN_CONFIDENCE (0 to 100). */
  minConfidence?: number;
  /** VITALS_MAX_FRAME_GAP_MS: a longer pause in the video restarts the reading inside the same window (default and most 1900, under SmartSpectra's own 2000). */
  maxFrameGapMs?: number;
  sessionFactory?: (options: { apiKey: string; requestedMetrics: number[] }) => PresageCustomSession;
  now?: () => number;
  log?: RelayVideoLogger;
};

type PresageCustomSession = PresageSession & {
  useCustomInput(): PresageCustomSession;
  on(event: "frameSentThrough", callback: (sent: boolean, timestampUs: number) => void): PresageCustomSession;
  sendFrame(buffer: Uint8Array | Buffer, width: number, height: number, stride: number, pixelFormat: number, timestampUs: number): boolean;
};

/**
 * Pulse rate and breathing rate only: what Presage's clearance covers (docs/BRIEF.md constraints). Never
 * blood pressure or HRV, so neither can be shown or said.
 */
export const REQUESTED_METRICS: readonly number[] = Object.freeze([MetricType.PULSE_RATE, MetricType.BREATHING_RATE]);

/** A pause in the video restarts the reading this many times inside one window; the next one ends the window. */
const MAX_WINDOW_RESTARTS = 3;
/** A window that has taken no frame this long after it began (or after a restart) is over: the camera is not delivering. */
const FIRST_FRAME_DEADLINE_MS = 3_000;
/** A camera silent this long ends the window. Shorter than the gap limit would pre-empt the restart that a 2 s pause is given. */
const VIDEO_STALL_MS = 4_000;

/** Relay VideoStream to SmartSpectra. It computes speech activity from samples but never stores audio. */
export class RelayPresageBridge {
  readonly quiet: QuietMeasurement;
  readonly #transport: RelayCallTransport;
  readonly #options: RelayVideoBridgeOptions;
  readonly #session: PresageCustomSession;
  readonly #log: RelayVideoLogger;
  readonly #now: () => number;
  readonly #validation: ValidationEvent[] = [];
  readonly #errors: VitalsError[] = [];
  #snapshot: MetricSnapshot = {};
  #streamTask: Promise<void> | undefined;
  #reader: ReadableStreamDefaultReader<VideoFrameEvent> | undefined;
  #measurementStartUs: number | undefined;
  #measurementEndUs: number | undefined;
  #timestampOriginMs: number | undefined;
  readonly #adapter: ReturnType<typeof createRelayVideoFrameAdapter>;
  #started = false;
  #stopTask: Promise<VitalsResult> | undefined;
  #lastFrameWallMs: number | undefined;
  readonly #maxFrameGapMs: number;
  /** How long this process went without running timers (a GC pause or a blocking call would show here), since the window began. */
  readonly #loopDelay = monitorEventLoopDelay({ resolution: 20 });
  #restartTask: Promise<void> | undefined;
  #inputStarted = false;
  /** The frame size this SmartSpectra session has been fed. A different size inside one session aborts the whole process in its tracker (OpenCV), so the session is restarted first. */
  #sessionSize: string | undefined;
  #stopped = false;
  #speechActive = false;
  /** Telemetry for the quiet window, logged every few seconds and when it is cut short: counts and average colour, never pixels. */
  #telemetry: FrameTelemetry | undefined;
  #metricsPackets = 0;
  #lastValidation: string | undefined;
  #validationLogged = 0;
  /** This window: when it began, how often the reading was restarted inside it, whether its closing line is still owed. */
  #beganMs = 0;
  #restarts = 0;
  #windowOpen = false;
  #firstFrameTimer: ReturnType<typeof setTimeout> | undefined;
  /** SDK errors thrown by sendFrame: logged once per code per window, the rest only counted. */
  readonly #rejectedCodes = new Set<string>();
  #rejected = 0;
  #sentThrough = 0;
  #droppedByPresage = 0;

  constructor(transport: RelayCallTransport, options: RelayVideoBridgeOptions) {
    this.#transport = transport;
    this.#options = options;
    this.#log = options.log ?? (() => {});
    this.#now = options.now ?? (() => Date.now());
    this.#maxFrameGapMs = Math.min(options.maxFrameGapMs ?? MAX_FRAME_GAP_LIMIT_MS, MAX_FRAME_GAP_LIMIT_MS);
    this.quiet = new QuietMeasurement(options.quietDurationMs ?? 30_000);
    this.#session = (options.sessionFactory ?? ((input) => new SmartSpectraSDK(input)))({ apiKey: options.apiKey, requestedMetrics: [...REQUESTED_METRICS] });
    this.#adapter = createRelayVideoFrameAdapter(this.#session);
    this.#session.on("metrics", (buffer, timestampUs) => {
      this.#metricsPackets += 1;
      if (this.#measurementStartUs === undefined || timestampUs < this.#measurementStartUs) return;
      try {
        const next = normalizePresageMetrics(decodeMetrics(buffer), timestampUs);
        const startUs = this.#measurementStartUs;
        const inWindow = (timestamp: number | undefined, warmUpMs: number) => timestamp !== undefined
          && timestamp >= startUs + warmUpMs * 1000
          && (this.#measurementEndUs === undefined || timestamp <= this.#measurementEndUs);
        this.#snapshot = mergeMetricSnapshots(this.#snapshot, {
          ...(inWindow(next.heartRateTimestampUs, PULSE_WARM_UP_MS) ? {
            heartRate: next.heartRate, heartRateConfidence: next.heartRateConfidence,
            heartRateStable: next.heartRateStable === true, heartRateTimestampUs: next.heartRateTimestampUs,
          } : {}),
          ...(inWindow(next.breathingRateTimestampUs, 30_000) ? {
            breathingRate: next.breathingRate, breathingRateConfidence: next.breathingRateConfidence,
            breathingRateStable: next.breathingRateStable === true, breathingRateTimestampUs: next.breathingRateTimestampUs,
          } : {}),
        });
      } catch (error) {
        this.#errors.push({ code: "metrics_decode", message: error instanceof Error ? error.message : String(error) });
      }
    });
    this.#session.on("validationStatus", (code, timestampUs, hint) => {
      const key = `${code}:${hint}`;
      if (key !== this.#lastValidation && this.#validationLogged < 30) {
        this.#lastValidation = key;
        this.#validationLogged += 1;
        this.#log("call_presage_validation", { code, hint });
      }
      if (!this.#validation.some((event) => event.code === code && event.hint === hint)) this.#validation.push({ code, timestampUs, hint });
    });
    this.#session.on("error", (code, message, retryable) => {
      this.#errors.push({ code, message, retryable });
      this.#log("call_presage_error", { code, message, retryable });
    });
    this.#session.on("frameSentThrough", (sent) => {
      if (sent) this.#sentThrough += 1;
      else this.#droppedByPresage += 1;
    });
    this.#session.on("processingStatus", (status) => {
      this.#log("call_presage_status", { status });
      if (status === ProcessingStatus.kError) this.#errors.push({ code: "processing_status_error", message: "SmartSpectra ended in an error state" });
    });
  }

  start(): void {
    if (this.#started || this.#stopped) return;
    this.#started = true;
    this.#loopDelay.enable();
    this.#session.useCustomInput();
    this.#session.start();
    this.#transport.on("audio", (frame) => this.#updateSpeech(frame));
    this.#transport.on("trackSubscribed", (track) => this.#subscribe(track));
    this.#transport.on("trackUnsubscribed", () => {
      this.#log("call_video_unsubscribed");
      this.#interruptMeasurement("track_unsubscribed");
      void this.#disconnectVideo();
    });
    this.#transport.on("remoteVideo", (enabled) => this.#log("call_remote_video", { enabled }));
    const existing = this.#transport.remoteVideoTrack;
    if (existing) this.#subscribe(existing);
  }

  beginQuietMeasurement(permissionGranted: boolean): void {
    this.#loopDelay.reset();
    this.#snapshot = {};
    this.#measurementStartUs = undefined;
    this.#measurementEndUs = undefined;
    this.#lastFrameWallMs = undefined;
    this.#telemetry = undefined;
    this.#metricsPackets = 0;
    this.#lastValidation = undefined;
    this.#validationLogged = 0;
    this.#rejectedCodes.clear();
    this.#rejected = 0;
    this.#sentThrough = 0;
    this.#droppedByPresage = 0;
    this.#restarts = 0;
    this.#beganMs = this.#now();
    clearTimeout(this.#firstFrameTimer);
    this.quiet.requestPermission(permissionGranted);
    this.#windowOpen = permissionGranted;
    if (!permissionGranted) return;
    // Her video track arrives once per call; a reader that has ended would leave this window without frames.
    const track = this.#transport.remoteVideoTrack;
    if (!this.#reader && track && this.#started && !this.#stopped) this.#subscribe(track);
    if (this.#inputStarted) this.#restartProcessing();
    this.#armFirstFrameDeadline();
    this.#log("call_quiet_measurement_started", { duration_ms: this.quiet.durationMs });
  }

  result(): VitalsResult {
    if (!this.#stopped) this.#interruptIfStalled();
    if (this.quiet.status === "complete") this.#logFinished("complete");
    const raw = resultFromSnapshot("relay_video", this.#snapshot, this.#validation, this.#errors, { timestampOriginMs: this.#timestampOriginMs });
    return this.quiet.finish(raw, this.#options.minConfidence);
  }

  stop(): Promise<VitalsResult> {
    this.#stopTask ??= this.#stop();
    return this.#stopTask;
  }

  async #stop(): Promise<VitalsResult> {
    this.#interruptIfStalled();
    this.#stopped = true;
    clearTimeout(this.#firstFrameTimer);
    this.#loopDelay.disable();
    await this.#disconnectVideo();
    await this.#restartTask;
    try {
      await this.#session.stopAsync();
    } catch (error) {
      this.#errors.push({ code: "presage_destroy", message: error instanceof Error ? error.message : String(error) });
    }
    try {
      await this.#session.destroy();
    } catch (error) {
      this.#errors.push({ code: "presage_destroy", message: error instanceof Error ? error.message : String(error) });
    }
    const result = this.result();
    this.#logFinished(this.quiet.status === "measuring" ? "stopped" : this.quiet.status);
    return result;
  }

  /** stopAsync then start clears SmartSpectra's last-frame time, the only thing that does. Logs how long each took (start blocks the loop). */
  #restartProcessing(): void {
    const previous = this.#restartTask ?? Promise.resolve();
    const task = previous.then(async () => {
      const t0 = performance.now();
      await this.#session.stopAsync();
      const stopMs = Math.round(performance.now() - t0);
      if (this.#stopped) return;
      const t1 = performance.now();
      this.#session.start();
      this.#log("call_presage_restarted", { stop_ms: stopMs, start_ms: Math.round(performance.now() - t1) });
      this.#inputStarted = false;
      this.#sessionSize = undefined;
    }).catch((error) => {
      this.#errors.push({ code: "presage_restart", message: error instanceof Error ? error.message : String(error) });
      this.#interruptMeasurement("presage_restart");
    });
    this.#restartTask = task;
    void task.then(() => { if (this.#restartTask === task) this.#restartTask = undefined; });
  }

  /** True while the quiet window can still give a reading: a camera that has gone quiet ends it (checked here, as well as when a frame arrives). */
  measuring(): boolean {
    if (!this.#stopped) this.#interruptIfStalled();
    return this.quiet.status !== "interrupted";
  }

  #interruptIfStalled(): void {
    if (this.#lastFrameWallMs !== undefined && this.quiet.status === "measuring" && this.#now() - this.#lastFrameWallMs > VIDEO_STALL_MS) {
      this.#interruptMeasurement("video_stalled", { gap_ms: this.#now() - this.#lastFrameWallMs });
    }
  }

  #interruptMeasurement(reason: string, fields: Record<string, unknown> = {}): void {
    if (this.quiet.status !== "measuring") return;
    clearTimeout(this.#firstFrameTimer);
    this.#log("call_quiet_measurement_interrupted", { reason, ...fields, ...this.#telemetrySummary(this.#now()) });
    this.#logFinished(reason);
    this.quiet.interrupt();
    this.#snapshot = {};
    this.#measurementStartUs = undefined;
    this.#measurementEndUs = undefined;
    this.#lastFrameWallMs = undefined;
  }

  /**
   * The video paused for longer than SmartSpectra tolerates, or sendFrame threw: it refuses every frame until
   * it is restarted. Restart it and re-base the pulse warm-up; the window stays open and counting.
   */
  #recover(reason: "video_gap" | "sdk_error" | "frame_size_changed", fields: Record<string, unknown>, nowMs: number): void {
    if (this.quiet.status !== "measuring") return;
    if (this.#restarts >= MAX_WINDOW_RESTARTS) {
      this.#interruptMeasurement("video_gap_repeated", { trigger: reason, ...fields });
      return;
    }
    this.#restarts += 1;
    this.#log("call_quiet_measurement_restarted", { reason, ...fields, restarts: this.#restarts, elapsed_ms: nowMs - this.#beganMs, remaining_ms: this.quiet.remainingMs(nowMs), ...this.#telemetrySummary(nowMs) });
    this.#snapshot = {};
    this.#measurementStartUs = undefined;
    this.#measurementEndUs = undefined;
    this.#lastFrameWallMs = undefined;
    this.#restartProcessing();
    this.#armFirstFrameDeadline();
  }

  /** No frame taken within FIRST_FRAME_DEADLINE_MS ends the window now, not after 30 s of counting down over nothing. */
  #armFirstFrameDeadline(): void {
    clearTimeout(this.#firstFrameTimer);
    const timer = setTimeout(() => {
      try {
        if (this.#lastFrameWallMs === undefined) this.#interruptMeasurement("no_frames", { waited_ms: this.#now() - this.#beganMs });
      } catch {
        // a timer must never end the agent; the orchestrator's own timer still ends the window
      }
    }, FIRST_FRAME_DEADLINE_MS);
    timer.unref?.();
    this.#firstFrameTimer = timer;
  }

  /** One line when a window ends, however it ends: what Presage reported (before our gates), so the gates can be judged on live data. */
  #logFinished(reason: string): void {
    if (!this.#windowOpen) return;
    this.#windowOpen = false;
    const s = this.#snapshot;
    const frames = this.#telemetry?.frames ?? 0;
    this.#log("call_quiet_measurement_finished", {
      reason,
      frames,
      elapsed_ms: this.#now() - this.#beganMs,
      restarts: this.#restarts,
      talking_share: frames === 0 ? 0 : Math.round((this.quiet.talkingFrames / frames) * 100) / 100,
      hr: s.heartRate ?? null,
      hr_confidence: s.heartRateConfidence ?? null,
      hr_stable: s.heartRateStable ?? null,
      br: s.breathingRate ?? null,
      br_confidence: s.breathingRateConfidence ?? null,
      br_stable: s.breathingRateStable ?? null,
      metrics_packets: this.#metricsPackets,
      frames_rejected: this.#rejected,
    });
  }

  #subscribe(track: RemoteVideoTrack): void {
    if (this.#stopped) return;
    if (this.#reader) {
      this.#interruptMeasurement("track_replaced");
      void this.#reader.cancel().catch(() => {});
    }
    this.#log("call_video_subscribed", { width: "unknown", format: "RGBA" });
    const stream = new VideoStream(track, { capacity: 2, format: VideoBufferType.RGBA });
    // sendFrame throws on a bad frame; caught now, since an unhandled rejection would end the agent.
    const reader = stream.getReader();
    this.#reader = reader;
    this.#streamTask = this.#pump(reader).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      if (this.#reader === reader) this.#interruptMeasurement("stream_error", { error: message });
      this.#errors.push({ code: "video_stream", message });
    }).finally(async () => {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
      if (this.#reader === reader) {
        if (!this.#stopped) this.#interruptMeasurement("stream_ended");
        this.#reader = undefined;
      }
    });
  }

  async #disconnectVideo(): Promise<void> {
    const reader = this.#reader;
    const task = this.#streamTask;
    this.#reader = undefined;
    await reader?.cancel().catch(() => {});
    await task;
  }

  async #pump(reader: ReadableStreamDefaultReader<VideoFrameEvent>): Promise<void> {
    const clock = createFrameTimestampAnchor();
    while (!this.#stopped) {
      const next = await reader.read();
      if (next.done || this.#stopped || this.#reader !== reader) break;
      const event = next.value;
      if (this.quiet.status !== "measuring" || this.#restartTask) continue;
      const nowMs = this.#now();
      const timestampUs = clock.next(event.timestampUs, nowMs);
      // A stalled camera must not count as a continuous quiet capture window.
      const gapMs = this.#lastFrameWallMs === undefined ? 0 : nowMs - this.#lastFrameWallMs;
      const mediaGapMs = this.#measurementEndUs === undefined ? 0 : Math.round((timestampUs - this.#measurementEndUs) / 1000);
      if (this.#lastFrameWallMs !== undefined && (gapMs > this.#maxFrameGapMs || mediaGapMs > this.#maxFrameGapMs)) {
        this.#recover("video_gap", { gap_ms: gapMs, media_gap_ms: mediaGapMs }, nowMs);
        continue;
      }
      if (gapMs > 1_000 || mediaGapMs > 1_000) this.#log("call_video_pause", { gap_ms: gapMs, media_gap_ms: mediaGapMs, ...this.#telemetrySummary(nowMs) });
      const frame = event.frame;
      if (frame.type !== VideoBufferType.RGBA) {
        this.#log("call_video_frame_rejected", { reason: "unsupported_format", format: frame.type });
        continue;
      }
      const size = `${frame.width}x${frame.height}`;
      if (this.#sessionSize !== undefined && size !== this.#sessionSize) {
        // The phone changed resolution mid-window (it often starts at 720p and steps up). Never hand that to the same session.
        this.#recover("frame_size_changed", { from: this.#sessionSize, to: size }, nowMs);
        continue;
      }
      let result: FrameSendResult;
      try {
        result = this.#adapter.send({
          buffer: frame.data,
          width: frame.width,
          height: frame.height,
          stride: frame.width * 4,
          pixelFormat: "RGBA",
          timestampUs,
        });
      } catch (error) {
        // sendFrame throws (code 11 after a pause, 10 out of order) and refuses every frame after until restarted. The pump outlives it.
        const code = (error as { code?: unknown } | null)?.code;
        const message = error instanceof Error ? error.message : String(error);
        this.#rejected += 1;
        if (!this.#rejectedCodes.has(String(code))) {
          this.#rejectedCodes.add(String(code));
          this.#log("call_video_frame_rejected", { reason: "sdk_error", code, message });
        }
        this.#recover("sdk_error", { code, gap_ms: gapMs, media_gap_ms: mediaGapMs }, nowMs);
        continue;
      }
      if (!result.accepted) {
        this.#log("call_video_frame_rejected", { reason: result.reason, detail: result.detail });
        continue;
      }
      this.#inputStarted = true;
      this.#sessionSize = size;
      if (this.#lastFrameWallMs === undefined) {
        clearTimeout(this.#firstFrameTimer);
        if (this.#restarts === 0) this.#log("call_video_first_frame", { begin_to_first_frame_ms: nowMs - this.#beganMs });
      }
      this.#noteFrame(nowMs, frame, this.#now() - nowMs);
      this.#lastFrameWallMs = nowMs;
      this.#timestampOriginMs ??= nowMs - result.timestampUs / 1000;
      this.#measurementStartUs ??= result.timestampUs;
      this.quiet.recordFrame(result.timestampUs, this.#speechActive, nowMs);
      this.#measurementEndUs = result.timestampUs;
    }
  }

  /** Counts the frame and logs the window's cadence every 3 s: frames per second, the longest gap, size, average colour. */
  #noteFrame(nowMs: number, frame: { data: Uint8Array; width: number; height: number }, sendMs: number): void {
    const t = (this.#telemetry ??= { startedMs: nowMs, lastLogMs: nowMs, prevMs: undefined, frames: 0, windowFrames: 0, maxGapMs: 0, maxSendMs: 0, width: frame.width, height: frame.height, color: [0, 0, 0, 0] });
    if (t.prevMs !== undefined) t.maxGapMs = Math.max(t.maxGapMs, nowMs - t.prevMs);
    t.prevMs = nowMs;
    t.maxSendMs = Math.max(t.maxSendMs, sendMs);
    t.frames += 1;
    t.windowFrames += 1;
    t.width = frame.width;
    t.height = frame.height;
    t.color = sampleAverageColor(frame.data, frame.width, frame.height);
    if (nowMs - t.lastLogMs >= 3_000) {
      this.#log("call_video_cadence", { ...this.#telemetrySummary(nowMs), fps: Math.round((t.windowFrames * 10_000) / (nowMs - t.lastLogMs)) / 10, presage_sent: this.#sentThrough, presage_dropped: this.#droppedByPresage });
      t.lastLogMs = nowMs;
      t.windowFrames = 0;
    }
  }

  /** Her video's counters from the transport (frames dropped, keyframes asked for): what a pause in the picture was. */
  #receiverStats(): Record<string, unknown> {
    const loop_lag_ms = Math.round(this.#loopDelay.max / 1e6);
    try {
      const rx = typeof this.#transport.videoStats === "function" ? this.#transport.videoStats().inbound : undefined;
      return { loop_lag_ms, ...(rx ? { rx_dropped: rx.framesDropped, rx_decode_errors: rx.decodeErrors, rx_keyframe_requests: rx.keyframeRequests, rx_recent_frames: rx.recentFrames, rx_codec: rx.codec } : {}) };
    } catch {
      return { loop_lag_ms };
    }
  }

  #telemetrySummary(nowMs: number): Record<string, unknown> {
    const t = this.#telemetry;
    if (!t) return { frames: 0, metrics_packets: this.#metricsPackets, ...this.#receiverStats() };
    return {
      ...this.#receiverStats(),
      since_start_ms: nowMs - t.startedMs,
      frames: t.frames,
      max_gap_ms: t.maxGapMs,
      max_send_ms: t.maxSendMs, // time inside sendFrame: a stall we caused, not the camera
      width: t.width,
      height: t.height,
      mean_rgba: t.color,
      metrics_packets: this.#metricsPackets,
    };
  }

  #updateSpeech(frame: RelayAudioFrame): void {
    let energy = 0;
    const sampleCount = Math.min(frame.samples.length, frame.sampleRate / 20);
    for (let i = 0; i < sampleCount; i += 1) energy += Math.abs(frame.samples[i] ?? 0);
    this.#speechActive = sampleCount > 0 && energy / sampleCount > 500;
  }
}

export type RelayVideoBridgeOptions = RelayPresageBridgeOptions;

type FrameTelemetry = {
  startedMs: number;
  lastLogMs: number;
  prevMs: number | undefined;
  frames: number;
  windowFrames: number;
  maxGapMs: number;
  maxSendMs: number;
  width: number;
  height: number;
  color: [number, number, number, number];
};

/** Average red, green, blue and alpha of 144 sampled pixels of an RGBA frame: enough to tell a black, blank or odd frame apart. */
export function sampleAverageColor(data: Uint8Array, width: number, height: number): [number, number, number, number] {
  const sum = [0, 0, 0, 0];
  let n = 0;
  for (let gy = 0; gy < 12; gy += 1) {
    for (let gx = 0; gx < 12; gx += 1) {
      const i = (Math.floor(((gy + 0.5) * height) / 12) * width + Math.floor(((gx + 0.5) * width) / 12)) * 4;
      if (i < 0 || i + 3 >= data.length) continue;
      sum[0]! += data[i]!;
      sum[1]! += data[i + 1]!;
      sum[2]! += data[i + 2]!;
      sum[3]! += data[i + 3]!;
      n += 1;
    }
  }
  return n === 0 ? [0, 0, 0, 0] : [Math.round(sum[0]! / n), Math.round(sum[1]! / n), Math.round(sum[2]! / n), Math.round(sum[3]! / n)];
}
