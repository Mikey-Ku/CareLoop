import type { VitalsResult } from "../vitals/types.ts";

export type QuietMeasurementStatus = "waiting_for_permission" | "measuring" | "complete" | "unusable" | "interrupted";

export class QuietMeasurement {
  readonly durationMs: number;
  #status: QuietMeasurementStatus = "waiting_for_permission";
  #startedAtMs: number | undefined;
  #lastTimestampUs = 0;
  #talkingFrames = 0;
  #frames = 0;

  constructor(durationMs = 30_000) {
    if (!Number.isInteger(durationMs) || durationMs < 30_000 || durationMs > 45_000) throw new Error("quiet measurement must be 30 to 45 seconds");
    this.durationMs = durationMs;
  }

  get status(): QuietMeasurementStatus {
    return this.#status;
  }

  get talkingFrames(): number {
    return this.#talkingFrames;
  }

  requestPermission(granted: boolean): void {
    if (!granted) {
      this.#status = "interrupted";
      return;
    }
    this.#status = "measuring";
    this.#startedAtMs = undefined;
  }

  recordFrame(timestampUs: number | bigint, talking: boolean, nowMs: number): boolean {
    if (this.#status !== "measuring") return false;
    const timestamp = typeof timestampUs === "bigint" ? Number(timestampUs) : timestampUs;
    if (!Number.isFinite(timestamp) || timestamp <= this.#lastTimestampUs) return false;
    this.#lastTimestampUs = timestamp;
    this.#startedAtMs ??= nowMs;
    this.#frames += 1;
    if (talking) this.#talkingFrames += 1;
    if (nowMs - this.#startedAtMs >= this.durationMs) this.#status = "complete";
    return true;
  }

  finish(vitals: VitalsResult): VitalsResult {
    const usable = vitals.heartRate !== null && vitals.breathingRate !== null && (vitals.confidence ?? 0) > 0 && this.#talkingFrames === 0;
    if (!usable) this.#status = "unusable";
    return usable ? vitals : { ...vitals, heartRate: null, breathingRate: null, confidence: null, measuredAt: null, errors: [...vitals.errors, { code: "quiet_window_unusable", message: this.#talkingFrames > 0 ? "Patient spoke during the quiet measurement" : "No usable nonzero-confidence reading was obtained" }] };
  }

  interrupt(): void {
    this.#status = "interrupted";
  }
}
