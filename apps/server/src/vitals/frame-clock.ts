/** Match SmartSpectra's renderer: preserve capture deltas on an epoch-microsecond timeline. */
export function createFrameTimestampAnchor(): { next(rawTimestampUs: number | bigint | undefined, nowMs: number): number } {
  let offsetUs: number | undefined;
  let lastUs = 0;
  return {
    next(rawTimestampUs, nowMs) {
      const rawUs = rawTimestampUs === undefined ? undefined : Number(rawTimestampUs);
      const epochUs = Math.floor(nowMs * 1000);
      if (!Number.isSafeInteger(epochUs)) throw new Error("invalid frame wall clock");
      if (rawUs !== undefined && !Number.isSafeInteger(rawUs)) throw new Error("invalid frame capture timestamp");
      if (rawUs !== undefined) offsetUs ??= epochUs - rawUs;
      const timestampUs = Math.max(lastUs + 1, rawUs === undefined ? epochUs : rawUs + offsetUs!);
      lastUs = timestampUs;
      return timestampUs;
    },
  };
}
