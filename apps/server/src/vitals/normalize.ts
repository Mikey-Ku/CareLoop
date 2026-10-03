import type { VitalsResult, VitalsError, ValidationEvent, VitalsSource } from "./types.ts";

type Measurement = {
  value?: number;
  confidence?: number;
  stable?: boolean;
  timestampUs?: number;
};

export type MetricSnapshot = {
  heartRate?: number;
  breathingRate?: number;
  heartRateConfidence?: number;
  breathingRateConfidence?: number;
  heartRateTimestampUs?: number;
  breathingRateTimestampUs?: number;
};

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function timestampUs(value: unknown): number | undefined {
  if (record(value) && typeof value.toString === "function") return finiteNumber(value.toString());
  return finiteNumber(value);
}

function measurement(value: unknown): Measurement | undefined {
  if (!record(value)) return undefined;
  const numericValue = finiteNumber(value.value);
  if (numericValue === undefined) return undefined;
  const confidence = finiteNumber(value.confidence);
  const timestamp = timestampUs(value.timestamp);
  return {
    value: numericValue,
    ...(confidence === undefined ? {} : { confidence }),
    ...(typeof value.stable === "boolean" ? { stable: value.stable } : {}),
    ...(timestamp === undefined ? {} : { timestampUs: timestamp }),
  };
}

function latestMeasurement(value: unknown): Measurement | undefined {
  if (!Array.isArray(value)) return undefined;
  let latest: Measurement | undefined;
  for (const candidate of value) {
    const current = measurement(candidate);
    if (!current) continue;
    if (!latest || (current.timestampUs ?? 0) >= (latest.timestampUs ?? 0)) latest = current;
  }
  return latest;
}

/** Decode the useful pulse and breathing fields from one SmartSpectra metrics packet. */
export function normalizePresageMetrics(metrics: unknown, fallbackTimestampUs?: number): MetricSnapshot {
  if (!record(metrics)) return {};
  const cardio = record(metrics.cardio) ? metrics.cardio : undefined;
  const breathing = record(metrics.breathing) ? metrics.breathing : undefined;
  const pulse = latestMeasurement(cardio?.pulseRate);
  const respiration = latestMeasurement(breathing?.rate);
  const pulseTimestamp = pulse?.timestampUs ?? fallbackTimestampUs;
  const breathingTimestamp = respiration?.timestampUs ?? fallbackTimestampUs;

  return {
    ...(pulse?.value === undefined ? {} : { heartRate: pulse.value }),
    ...(respiration?.value === undefined ? {} : { breathingRate: respiration.value }),
    ...(pulse?.confidence === undefined ? {} : { heartRateConfidence: pulse.confidence }),
    ...(respiration?.confidence === undefined ? {} : { breathingRateConfidence: respiration.confidence }),
    ...(pulseTimestamp === undefined ? {} : { heartRateTimestampUs: pulseTimestamp }),
    ...(breathingTimestamp === undefined ? {} : { breathingRateTimestampUs: breathingTimestamp }),
  };
}

function latestValue(previous: number | undefined, previousAt: number | undefined, next: number | undefined, nextAt: number | undefined): number | undefined {
  if (next === undefined) return previous;
  if (previous === undefined || nextAt === undefined || previousAt === undefined || nextAt >= previousAt) return next;
  return previous;
}

/** Merge successive packets without allowing an older packet to replace a newer value. */
export function mergeMetricSnapshots(previous: MetricSnapshot, next: MetricSnapshot): MetricSnapshot {
  const heartRateTimestampUs = next.heartRateTimestampUs ?? previous.heartRateTimestampUs;
  const breathingRateTimestampUs = next.breathingRateTimestampUs ?? previous.breathingRateTimestampUs;
  const useNextHeartRate = next.heartRate !== undefined &&
    (previous.heartRate === undefined || next.heartRateTimestampUs === undefined || previous.heartRateTimestampUs === undefined || next.heartRateTimestampUs >= previous.heartRateTimestampUs);
  const useNextBreathingRate = next.breathingRate !== undefined &&
    (previous.breathingRate === undefined || next.breathingRateTimestampUs === undefined || previous.breathingRateTimestampUs === undefined || next.breathingRateTimestampUs >= previous.breathingRateTimestampUs);
  const heartRate = latestValue(previous.heartRate, previous.heartRateTimestampUs, next.heartRate, next.heartRateTimestampUs);
  const breathingRate = latestValue(previous.breathingRate, previous.breathingRateTimestampUs, next.breathingRate, next.breathingRateTimestampUs);
  const heartRateConfidence = useNextHeartRate ? next.heartRateConfidence : previous.heartRateConfidence;
  const breathingRateConfidence = useNextBreathingRate ? next.breathingRateConfidence : previous.breathingRateConfidence;
  return {
    ...(heartRate === undefined ? {} : { heartRate }),
    ...(breathingRate === undefined ? {} : { breathingRate }),
    ...(heartRateConfidence === undefined ? {} : { heartRateConfidence }),
    ...(breathingRateConfidence === undefined ? {} : { breathingRateConfidence }),
    ...(heartRateTimestampUs === undefined ? {} : { heartRateTimestampUs }),
    ...(breathingRateTimestampUs === undefined ? {} : { breathingRateTimestampUs }),
  };
}

function timestampToIso(timestamp: number | undefined, timestampOriginMs?: number): string | undefined {
  if (timestamp === undefined || !Number.isFinite(timestamp) || timestamp <= 0) return undefined;
  // File playback and Relay frames commonly use a relative microsecond clock;
  // protobuf packets from other sources may contain epoch microseconds.
  const epochMs = timestamp >= 1_000_000_000_000
    ? timestamp / 1000
    : (timestampOriginMs ?? Date.now()) + timestamp / 1000;
  const date = new Date(epochMs);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

export function resultFromSnapshot(
  source: VitalsSource,
  snapshot: MetricSnapshot,
  validation: ValidationEvent[] = [],
  errors: VitalsError[] = [],
  options: { timestampOriginMs?: number } = {},
): VitalsResult {
  const confidences = [snapshot.heartRateConfidence, snapshot.breathingRateConfidence].filter(
    (value): value is number => value !== undefined && Number.isFinite(value),
  );
  const timestamps = [snapshot.heartRateTimestampUs, snapshot.breathingRateTimestampUs].filter(
    (value): value is number => value !== undefined && Number.isFinite(value),
  );
  return {
    heartRate: snapshot.heartRate ?? null,
    breathingRate: snapshot.breathingRate ?? null,
    confidence: confidences.length > 0 ? Math.min(...confidences) : null,
    measuredAt: timestampToIso(timestamps.length > 0 ? Math.max(...timestamps) : undefined, options.timestampOriginMs) ?? null,
    source,
    validation: [...validation],
    errors: [...errors],
  };
}
