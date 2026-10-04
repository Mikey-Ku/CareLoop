import { describe, expect, it } from "vitest";
import { createRelayVideoFrameAdapter, mapRelayPixelFormat } from "../src/vitals/relay-frame-adapter.ts";

describe("Relay video frame adapter", () => {
  it("maps supported formats and rejects I420 until conversion exists", () => {
    expect(mapRelayPixelFormat("RGBA")).toBe(2);
    expect(mapRelayPixelFormat("bgra")).toBe(3);
    expect(mapRelayPixelFormat("I420")).toBeUndefined();
  });

  it("preserves dimensions and stride and supplies increasing timestamps", () => {
    const sent: unknown[][] = [];
    const adapter = createRelayVideoFrameAdapter(
      {
        sendFrame(...args) {
          sent.push(args);
          return true;
        },
      },
      { nowUs: () => 100 },
    );
    const frame = { buffer: Buffer.alloc(16), width: 2, height: 2, stride: 8, pixelFormat: "RGBA" } as const;
    expect(adapter.send(frame)).toEqual({ accepted: true, timestampUs: 100 });
    expect(adapter.send(frame)).toEqual({ accepted: true, timestampUs: 101 });
    expect(sent[0]).toEqual([frame.buffer, 2, 2, 8, 2, 100]);
    expect(sent[1]?.[5]).toBe(101);
  });

  it("reports invalid and SDK-rejected frames", () => {
    const adapter = createRelayVideoFrameAdapter({ sendFrame: () => false }, { nowUs: () => 100 });
    expect(adapter.send({ buffer: Buffer.alloc(1), width: 2, height: 2, stride: 8, pixelFormat: "RGBA" })).toMatchObject({
      accepted: false,
      reason: "invalid_frame",
    });
    expect(adapter.send({ buffer: Buffer.alloc(16), width: 2, height: 2, stride: 8, pixelFormat: "I420" })).toMatchObject({
      accepted: false,
      reason: "unsupported_pixel_format",
    });
    expect(adapter.send({ buffer: Buffer.alloc(16), width: 2, height: 2, stride: 8, pixelFormat: "RGBA" })).toMatchObject({
      accepted: false,
      reason: "sdk_rejected",
    });
  });
});
