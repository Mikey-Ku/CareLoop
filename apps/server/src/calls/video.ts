import { VideoBufferType, VideoStream, type RelayAudioFrame, type RelayCallTransport, type RemoteVideoTrack, type VideoFrameEvent } from "@relaymessenger/sdk/calls";
import { MetricType, ProcessingStatus, SmartSpectraSDK } from "@smartspectra/node-sdk";
import { decodeMetrics } from "@smartspectra/node-sdk/messages";
import { createFrameTimestampAnchor } from "../vitals/frame-clock.ts";
import { createRelayVideoFrameAdapter } from "../vitals/relay-frame-adapter.ts";
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
  sessionFactory?: (options: { apiKey: string; requestedMetrics: number[] }) => PresageCustomSession;
  now?: () => number;
  log?: RelayVideoLogger;
};

type PresageCustomSession = PresageSession & {
  useCustomInput(): PresageCustomSession;
  sendFrame(buffer: Uint8Array | Buffer, width: number, height: number, stride: number, pixelFormat: number, timestampUs: number): boolean;
};

/**
 * Pulse rate and breathing rate only: what Presage's clearance covers (docs/BRIEF.md constraints). Never
 * blood pressure or HRV, so neither can be shown or said.
 */
export const REQUESTED_METRICS: readonly number[] = Object.freeze([MetricType.PULSE_RATE, MetricType.BREATHING_RATE]);

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
  #restartTask: Promise<void> | undefined;
  #inputStarted = false;
  #stopped = false;
  #speechActive = false;

  constructor(transport: RelayCallTransport, options: RelayVideoBridgeOptions) {
    this.#transport = transport;
    this.#options = options;
    this.#log = options.log ?? (() => {});
    this.#now = options.now ?? (() => Date.now());
    this.quiet = new QuietMeasurement(options.quietDurationMs ?? 30_000);
    this.#session = (options.sessionFactory ?? ((input) => new SmartSpectraSDK(input)))({ apiKey: options.apiKey, requestedMetrics: [...REQUESTED_METRICS] });
    this.#adapter = createRelayVideoFrameAdapter(this.#session);
    this.#session.on("metrics", (buffer, timestampUs) => {
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
      if (!this.#validation.some((event) => event.code === code && event.hint === hint)) this.#validation.push({ code, timestampUs, hint });
    });
    this.#session.on("error", (code, message, retryable) => this.#errors.push({ code, message, retryable }));
    this.#session.on("processingStatus", (status) => {
      if (status === ProcessingStatus.kError) this.#errors.push({ code: "processing_status_error", message: "SmartSpectra ended in an error state" });
    });
  }

  start(): void {
    if (this.#started || this.#stopped) return;
    this.#started = true;
    this.#session.useCustomInput();
    this.#session.start();
    this.#transport.on("audio", (frame) => this.#updateSpeech(frame));
    this.#transport.on("trackSubscribed", (track) => this.#subscribe(track));
    this.#transport.on("trackUnsubscribed", () => {
      this.#log("call_video_unsubscribed");
      this.#interruptMeasurement();
      void this.#disconnectVideo();
    });
    this.#transport.on("remoteVideo", (enabled) => this.#log("call_remote_video", { enabled }));
    const existing = this.#transport.remoteVideoTrack;
    if (existing) this.#subscribe(existing);
  }

  beginQuietMeasurement(permissionGranted: boolean): void {
    this.#snapshot = {};
    this.#measurementStartUs = undefined;
    this.#measurementEndUs = undefined;
    this.#lastFrameWallMs = undefined;
    this.quiet.requestPermission(permissionGranted);
    if (permissionGranted && this.#inputStarted) this.#restartProcessing();
    if (permissionGranted) this.#log("call_quiet_measurement_started", { duration_ms: this.quiet.durationMs });
  }

  result(): VitalsResult {
    if (!this.#stopped) this.#interruptIfStalled();
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
    return this.result();
  }

  #restartProcessing(): void {
    const previous = this.#restartTask ?? Promise.resolve();
    const task = previous.then(async () => {
      await this.#session.stopAsync();
      if (this.#stopped) return;
      this.#session.start();
      this.#inputStarted = false;
    }).catch((error) => {
      this.#errors.push({ code: "presage_restart", message: error instanceof Error ? error.message : String(error) });
      this.#interruptMeasurement();
    });
    this.#restartTask = task;
    void task.then(() => { if (this.#restartTask === task) this.#restartTask = undefined; });
  }

  #interruptIfStalled(): void {
    if (this.#lastFrameWallMs !== undefined && this.quiet.status === "measuring" && this.#now() - this.#lastFrameWallMs > 1_000) this.#interruptMeasurement();
  }

  #interruptMeasurement(): void {
    if (this.quiet.status !== "measuring") return;
    this.quiet.interrupt();
    this.#snapshot = {};
    this.#measurementStartUs = undefined;
    this.#measurementEndUs = undefined;
    this.#lastFrameWallMs = undefined;
  }

  #subscribe(track: RemoteVideoTrack): void {
    if (this.#stopped) return;
    if (this.#reader) {
      this.#interruptMeasurement();
      void this.#reader.cancel().catch(() => {});
    }
    this.#log("call_video_subscribed", { width: "unknown", format: "RGBA" });
    const stream = new VideoStream(track, { capacity: 2, format: VideoBufferType.RGBA });
    // sendFrame throws on a bad frame; caught now, since an unhandled rejection would end the agent.
    const reader = stream.getReader();
    this.#reader = reader;
    this.#streamTask = this.#pump(reader).catch((error) => {
      if (this.#reader === reader) this.#interruptMeasurement();
      this.#errors.push({ code: "video_stream", message: error instanceof Error ? error.message : String(error) });
    }).finally(async () => {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
      if (this.#reader === reader) {
        if (!this.#stopped) this.#interruptMeasurement();
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
      if (this.#lastFrameWallMs !== undefined && (nowMs - this.#lastFrameWallMs > 1_000
        || (this.#measurementEndUs !== undefined && timestampUs - this.#measurementEndUs > 1_000_000))) {
        this.#interruptMeasurement();
        this.#log("call_quiet_measurement_interrupted", { reason: "video_gap" });
        continue;
      }
      const frame = event.frame;
      if (frame.type !== VideoBufferType.RGBA) {
        this.#log("call_video_frame_rejected", { reason: "unsupported_format", format: frame.type });
        continue;
      }
      const result = this.#adapter.send({
        buffer: frame.data,
        width: frame.width,
        height: frame.height,
        stride: frame.width * 4,
        pixelFormat: "RGBA",
        timestampUs,
      });
      if (!result.accepted) {
        this.#log("call_video_frame_rejected", { reason: result.reason, detail: result.detail });
        continue;
      }
      this.#inputStarted = true;
      this.#lastFrameWallMs = nowMs;
      this.#timestampOriginMs ??= nowMs - result.timestampUs / 1000;
      this.#measurementStartUs ??= result.timestampUs;
      this.quiet.recordFrame(result.timestampUs, this.#speechActive, nowMs);
      this.#measurementEndUs = result.timestampUs;
    }
  }

  #updateSpeech(frame: RelayAudioFrame): void {
    let energy = 0;
    const sampleCount = Math.min(frame.samples.length, frame.sampleRate / 20);
    for (let i = 0; i < sampleCount; i += 1) energy += Math.abs(frame.samples[i] ?? 0);
    this.#speechActive = sampleCount > 0 && energy / sampleCount > 500;
  }
}

export type RelayVideoBridgeOptions = RelayPresageBridgeOptions;
