import { Metrics } from "@smartspectra/node-sdk/messages";
import { describe, expect, it } from "vitest";
import { hasUsableVitals, runPresageVideo, type PresageSession } from "../src/vitals/presage-file.ts";

type EventName = "processingStatus" | "validationStatus" | "metrics" | "error";

class FakeSession implements PresageSession {
  private readonly handlers = new Map<EventName, (...args: never[]) => void>();
  private readonly mode: "metrics" | "empty" | "error";

  constructor(mode: "metrics" | "empty" | "error" = "metrics") {
    this.mode = mode;
  }

  on(event: EventName, callback: (...args: never[]) => void): PresageSession {
    this.handlers.set(event, callback);
    return this;
  }

  useFile(_videoPath?: string, _options?: { interframeDelayMs?: number }): PresageSession {
    this.emit("processingStatus", 1);
    return this;
  }

  start(): void {
    if (this.mode === "error") {
      this.emitError();
      return;
    }
    this.emit("processingStatus", 3);
    if (this.mode === "empty") {
      this.emit("processingStatus", 1);
      return;
    }
    const metrics = Metrics.encode({
      cardio: { pulseRate: [{ value: 73, confidence: 84, timestamp: 1_760_000_000_000_000 }] },
      breathing: { rate: [{ value: 15, confidence: 76, timestamp: 1_760_000_000_000_000 }] },
    }).finish();
    this.emit("metrics", Buffer.from(metrics), 1_760_000_000_000_000);
    this.emit("processingStatus", 1);
  }

  async destroy(): Promise<void> {}

  async stopAsync(): Promise<void> {}

  emitError(): void {
    this.emit("error", 2, "authentication failed", false);
  }

  protected emit(event: "processingStatus", status: number): void;
  protected emit(event: "metrics", buffer: Buffer, timestampUs: number): void;
  protected emit(event: "error", code: number, message: string, retryable: boolean): void;
  protected emit(event: EventName, ...args: never[]): void {
    this.handlers.get(event)?.(...args);
  }
}

describe("Presage file runner", () => {
  it("can request only pulse and breathing for model-access diagnostics", async () => {
    let requestedMetrics: number[] | undefined;
    const result = await runPresageVideo({
      videoPath: "face.mp4",
      apiKey: "test-key",
      metricProfile: "pulse-breathing",
      sdkFactory: (options) => {
        requestedMetrics = options.requestedMetrics;
        return new FakeSession();
      },
    });
    expect(requestedMetrics).toEqual([2, 15]);
    expect(hasUsableVitals(result)).toBe(true);
  });

  it("returns normalized readings after the file settles", async () => {
    const result = await runPresageVideo({ videoPath: "face.mp4", apiKey: "test-key", sdkFactory: () => new FakeSession() });
    expect(hasUsableVitals(result)).toBe(true);
    expect(result).toMatchObject({ heartRate: 73, breathingRate: 15, confidence: 76, source: "video_file" });
    expect(result.errors).toEqual([]);
  });

  it("returns a non-usable result when no metrics are emitted", async () => {
    const result = await runPresageVideo({ videoPath: "face.mp4", apiKey: "test-key", sdkFactory: () => new FakeSession("empty") });
    expect(hasUsableVitals(result)).toBe(false);
    expect(result.heartRate).toBeNull();
    expect(result.breathingRate).toBeNull();
  });

  it("captures SDK errors without exposing the API key", async () => {
    const result = await runPresageVideo({ videoPath: "face.mp4", apiKey: "secret-key", sdkFactory: () => new FakeSession("error") });
    expect(result.errors).toEqual([{ code: 2, message: "authentication failed", retryable: false }]);
    expect(JSON.stringify(result)).not.toContain("secret-key");
  });
});
