import { Metrics, decodeMetrics } from "@smartspectra/node-sdk/messages";
import { describe, expect, it } from "vitest";
import { mergeMetricSnapshots, normalizePresageMetrics, resultFromSnapshot } from "../src/vitals/normalize.ts";

describe("Presage metric normalization", () => {
  it("normalizes pulse, breathing, confidence and epoch timestamps", () => {
    const encoded = Metrics.encode({
      cardio: { pulseRate: [{ value: 72, confidence: 88, stable: true, timestamp: 1_760_000_000_000_000 }] },
      breathing: { rate: [{ value: 16, confidence: 80, stable: true, timestamp: 1_760_000_000_100_000 }] },
    }).finish();
    const snapshot = normalizePresageMetrics(decodeMetrics(encoded));
    const result = resultFromSnapshot("video_file", snapshot);

    expect(result).toMatchObject({
      heartRate: 72,
      breathingRate: 16,
      heartRateConfidence: 88,
      breathingRateConfidence: 80,
      heartRateStable: true,
      breathingRateStable: true,
      confidence: 80,
      measuredAt: "2025-10-09T08:53:20.100Z",
      source: "video_file",
    });
  });

  it("keeps the newest value for each metric when packets arrive out of order", () => {
    const older = normalizePresageMetrics({ cardio: { pulseRate: [{ value: 70, confidence: 60, timestamp: 100 }] } });
    const newer = normalizePresageMetrics({ cardio: { pulseRate: [{ value: 74, confidence: 90, timestamp: 200 }] } });
    const merged = mergeMetricSnapshots(newer, older);
    expect(merged.heartRate).toBe(74);
    expect(merged.heartRateConfidence).toBe(90);
  });

  it("allows partial packets while the file is still measuring", () => {
    expect(normalizePresageMetrics({ breathing: { rate: [{ value: 17, confidence: 51 }] } })).toEqual({
      breathingRate: 17,
      breathingRateConfidence: 51,
    });
  });

  it("anchors relative file timestamps to the run start", () => {
    const snapshot = normalizePresageMetrics({ breathing: { rate: [{ value: 18, timestamp: 50_000_000 }] } });
    const result = resultFromSnapshot("video_file", snapshot, [], [], { timestampOriginMs: 1_700_000_000_000 });
    expect(result.measuredAt).toBe(new Date(1_700_000_000_000 + 50_000).toISOString());
  });
});
