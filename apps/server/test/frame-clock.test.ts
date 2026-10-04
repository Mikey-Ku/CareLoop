import { describe, expect, it } from "vitest";
import { createFrameTimestampAnchor } from "../src/vitals/frame-clock.ts";

describe("SmartSpectra epoch frame clock", () => {
  const wallMs = 1_791_094_000_000;
  it("anchors a relative capture clock to epoch and preserves capture deltas despite wall clock changes", () => {
    const clock = createFrameTimestampAnchor();
    expect(clock.next(10_000_000n, wallMs)).toBe(wallMs * 1000);
    expect(clock.next(10_033_333n, wallMs - 500)).toBe(wallMs * 1000 + 33_333);
    expect(clock.next(22_000_000n, wallMs + 12_005)).toBe(wallMs * 1000 + 12_000_000);
  });
  it("keeps timestamps increasing on capture reset or missing capture metadata", () => {
    const clock = createFrameTimestampAnchor();
    expect(clock.next(10, wallMs)).toBe(wallMs * 1000);
    expect(clock.next(9, wallMs)).toBe(wallMs * 1000 + 1);
    expect(clock.next(undefined, wallMs - 5)).toBe(wallMs * 1000 + 2);
  });
  it("rejects invalid clocks rather than sending invalid SDK timestamps", () => {
    expect(() => createFrameTimestampAnchor().next(NaN, wallMs)).toThrow();
    expect(() => createFrameTimestampAnchor().next(undefined, Infinity)).toThrow();
  });
});
