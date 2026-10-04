import { VideoBufferType, VideoStream, type RelayAudioFrame, type RelayCallTransport, type RemoteVideoTrack } from "@relaymessenger/sdk/calls";
import { MetricType, ProcessingStatus, SmartSpectraSDK } from "@smartspectra/node-sdk";
import { decodeMetrics } from "@smartspectra/node-sdk/messages";
import { createRelayVideoFrameAdapter, type FrameSink } from "../vitals/relay-frame-adapter.ts";
import { mergeMetricSnapshots, normalizePresageMetrics, resultFromSnapshot, type MetricSnapshot } from "../vitals/normalize.ts";
import type { PresageSession } from "../vitals/presage-file.ts";
import type { ValidationEvent, VitalsError, VitalsResult } from "../vitals/types.ts";
import { QuietMeasurement } from "./quiet-measurement.ts";

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
  #stopped = false;
  #speechActive = false;

  constructor(transport: RelayCallTransport, options: RelayVideoBridgeOptions) {
    this.#transport = transport;
    this.#options = options;
    this.#log = options.log ?? (() => {});
    this.#now = options.now ?? (() => Date.now());
    this.quiet = new QuietMeasurement(options.quietDurationMs ?? 30_000);
    this.#session = (options.sessionFactory ?? ((input) => new SmartSpectraSDK(input)))({ apiKey: options.apiKey, requestedMetrics: [...REQUESTED_METRICS] });
    this.#session.on("metrics", (buffer, timestampUs) => {
      try {
        this.#snapshot = mergeMetricSnapshots(this.#snapshot, normalizePresageMetrics(decodeMetrics(buffer), timestampUs));
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
    this.#session.useCustomInput();
    this.#session.start();
    this.#transport.on("audio", (frame) => this.#updateSpeech(frame));
    this.#transport.on("trackSubscribed", (track) => this.#subscribe(track));
    this.#transport.on("trackUnsubscribed", () => this.#log("call_video_unsubscribed"));
    this.#transport.on("remoteVideo", (enabled) => this.#log("call_remote_video", { enabled }));
    const existing = this.#transport.remoteVideoTrack;
    if (existing) this.#subscribe(existing);
  }

  beginQuietMeasurement(permissionGranted: boolean): void {
    this.quiet.requestPermission(permissionGranted);
    if (permissionGranted) this.#log("call_quiet_measurement_started", { duration_ms: this.quiet.durationMs });
  }

  result(): VitalsResult {
    const raw = resultFromSnapshot("relay_video", this.#snapshot, this.#validation, this.#errors, { timestampOriginMs: this.#now() });
    return this.quiet.finish(raw, this.#options.minConfidence);
  }

  async stop(): Promise<VitalsResult> {
    this.#stopped = true;
    await this.#streamTask;
    try {
      await this.#session.stopAsync();
      await this.#session.destroy();
    } catch (error) {
      this.#errors.push({ code: "presage_destroy", message: error instanceof Error ? error.message : String(error) });
    }
    return this.result();
  }

  #subscribe(track: RemoteVideoTrack): void {
    if (this.#streamTask) return;
    this.#log("call_video_subscribed", { width: "unknown", format: "RGBA" });
    const stream = new VideoStream(track, { capacity: 2, format: VideoBufferType.RGBA });
    // sendFrame throws on a bad frame; caught now, since an unhandled rejection would end the agent.
    this.#streamTask = this.#pump(stream).catch((error) => {
      this.#errors.push({ code: "video_stream", message: error instanceof Error ? error.message : String(error) });
    });
  }

  async #pump(stream: VideoStream): Promise<void> {
    const sink: FrameSink = this.#session;
    const adapter = createRelayVideoFrameAdapter(sink);
    for await (const event of stream) {
      if (this.#stopped) break;
      const frame = event.frame;
      if (frame.type !== VideoBufferType.RGBA) {
        this.#log("call_video_frame_rejected", { reason: "unsupported_format", format: frame.type });
        continue;
      }
      const result = adapter.send({
        buffer: frame.data,
        width: frame.width,
        height: frame.height,
        stride: frame.width * 4,
        pixelFormat: "RGBA",
        timestampUs: event.timestampUs,
      });
      if (!result.accepted) {
        this.#log("call_video_frame_rejected", { reason: result.reason, detail: result.detail });
        continue;
      }
      this.quiet.recordFrame(result.timestampUs, this.#speechActive, this.#now());
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
