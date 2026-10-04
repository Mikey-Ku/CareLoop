import type { VitalsResult } from "../vitals/types.ts";

export type QuietMeasurementStatus = "waiting_for_permission" | "measuring" | "complete" | "interrupted";

/** VITALS_MIN_CONFIDENCE's default: SmartSpectra confidence is 0 to 100 and starts at 0 while it warms up. */
export const DEFAULT_VITALS_MIN_CONFIDENCE = 1;
export const PULSE_WARM_UP_MS = 12_000;

/**
 * Share of the quiet window's video frames she may be talking over before the reading is void. One loud
 * audio frame (a cough, a door) doesn't void it; talking through the window does.
 */
export const MAX_TALKING_SHARE = 0.2;

/**
 * The quiet window for a Presage reading. Readings come only from a window she agreed to. Heart rate
 * needs 12 seconds of capture and explicit stability and confidence (missing breathing never drops it); breathing also needs the
 * full window. Talking through much of the window voids both.
 */
export class QuietMeasurement {
  readonly durationMs: number;
  #status: QuietMeasurementStatus = "waiting_for_permission";
  #startedAtMs: number | undefined;
  #lastTimestampUs = 0;
  #talkingFrames = 0;
  #frames = 0;
  #windowComplete = false;
  #elapsedMs = 0;

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

  /** Milliseconds left in the window (0 once complete, the full window before it starts). */
  remainingMs(nowMs: number): number {
    if (this.#windowComplete) return 0;
    if (this.#startedAtMs === undefined) return this.durationMs;
    return Math.max(0, this.durationMs - (nowMs - this.#startedAtMs));
  }

  requestPermission(granted: boolean): void {
    if (!granted) {
      this.#status = "interrupted";
      return;
    }
    this.#status = "measuring";
    this.#startedAtMs = undefined;
    this.#lastTimestampUs = 0;
    this.#talkingFrames = 0;
    this.#frames = 0;
    this.#windowComplete = false;
    this.#elapsedMs = 0;
  }

  recordFrame(timestampUs: number | bigint, talking: boolean, nowMs: number): boolean {
    if (this.#status !== "measuring") return false;
    const timestamp = typeof timestampUs === "bigint" ? Number(timestampUs) : timestampUs;
    if (!Number.isFinite(timestamp) || timestamp <= this.#lastTimestampUs) return false;
    this.#lastTimestampUs = timestamp;
    this.#startedAtMs ??= nowMs;
    this.#elapsedMs = nowMs - this.#startedAtMs;
    this.#frames += 1;
    if (talking) this.#talkingFrames += 1;
    if (nowMs - this.#startedAtMs >= this.durationMs) {
      this.#status = "complete";
      this.#windowComplete = true;
    }
    return true;
  }

  /** The usable part of a reading. Pure: it can be asked mid-call and again at the end. */
  finish(vitals: VitalsResult, minConfidence = DEFAULT_VITALS_MIN_CONFIDENCE): VitalsResult {
    const talking = this.#frames > 0 && this.#talkingFrames / this.#frames > MAX_TALKING_SHARE;
    const confident = (value: number | null) => value !== null && Number.isFinite(value) && value > 0 && value <= 100 && value >= minConfidence;
    const started = this.#frames > 0 && this.#status !== "interrupted";
    const heartRate = started && this.#elapsedMs >= PULSE_WARM_UP_MS && !talking && vitals.heartRateStable === true && vitals.heartRate !== null && confident(vitals.heartRateConfidence) ? vitals.heartRate : null;
    const breathingRate =
      started && !talking && vitals.breathingRateStable === true && this.#windowComplete && vitals.breathingRate !== null && confident(vitals.breathingRateConfidence) ? vitals.breathingRate : null;
    if (heartRate !== null && breathingRate !== null) return vitals;
    const reason = !started
      ? "No quiet measurement was taken"
      : talking
        ? "Patient spoke during the quiet measurement"
        : "No usable reading with enough confidence was obtained";
    return {
      ...vitals,
      heartRate,
      breathingRate,
      heartRateConfidence: heartRate === null ? null : vitals.heartRateConfidence,
      breathingRateConfidence: breathingRate === null ? null : vitals.breathingRateConfidence,
      confidence: heartRate !== null ? vitals.heartRateConfidence : breathingRate !== null ? vitals.breathingRateConfidence : null,
      measuredAt: heartRate === null && breathingRate === null ? null : vitals.measuredAt,
      errors: [...vitals.errors, { code: "quiet_window_unusable", message: reason }],
    };
  }

  interrupt(): void {
    this.#status = "interrupted";
  }
}
