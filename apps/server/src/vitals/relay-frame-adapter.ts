import { PixelFormat } from "@smartspectra/node-sdk";

export type RelayVideoPixelFormat = "RGB" | "BGR" | "RGBA" | "BGRA" | "NV12" | "NV21" | "YUYV" | "I420";

export type RelayVideoFrame = {
  buffer: Uint8Array | Buffer;
  width: number;
  height: number;
  stride: number;
  pixelFormat: RelayVideoPixelFormat | string;
};

export type FrameSink = {
  sendFrame(buffer: Uint8Array | Buffer, width: number, height: number, stride: number, pixelFormat: number, timestampUs: number): boolean;
};

export type FrameSendResult =
  | { accepted: true; timestampUs: number }
  | { accepted: false; reason: "unsupported_pixel_format" | "invalid_frame" | "sdk_rejected"; detail: string };

/**
 * Relay's VideoStream can expose formats that SmartSpectra cannot consume directly.
 * I420 is deliberately rejected until a tested conversion path is added.
 */
export function mapRelayPixelFormat(format: string): number | undefined {
  switch (format.trim().toUpperCase().replace(/[^A-Z0-9]/g, "")) {
    case "RGB":
      return PixelFormat.kRGB;
    case "BGR":
      return PixelFormat.kBGR;
    case "RGBA":
      return PixelFormat.kRGBA;
    case "BGRA":
      return PixelFormat.kBGRA;
    case "NV12":
      return PixelFormat.kNV12;
    case "NV21":
      return PixelFormat.kNV21;
    case "YUYV":
      return PixelFormat.kYUYV;
    default:
      return undefined;
  }
}

export function createRelayVideoFrameAdapter(
  sink: FrameSink,
  options: { nowUs?: () => number } = {},
): { send(frame: RelayVideoFrame): FrameSendResult } {
  const nowUs = options.nowUs ?? (() => Number(process.hrtime.bigint() / 1000n));
  let lastTimestampUs = 0;

  return {
    send(frame) {
      const pixelFormat = mapRelayPixelFormat(frame.pixelFormat);
      if (pixelFormat === undefined) {
        return { accepted: false, reason: "unsupported_pixel_format", detail: `Unsupported Relay pixel format: ${frame.pixelFormat}` };
      }
      if (frame.width <= 0 || frame.height <= 0 || frame.stride <= 0 || frame.buffer.byteLength < frame.stride * frame.height) {
        return { accepted: false, reason: "invalid_frame", detail: "Frame dimensions, stride, or buffer length are invalid" };
      }

      const timestampUs = Math.max(lastTimestampUs + 1, nowUs());
      lastTimestampUs = timestampUs;
      const accepted = sink.sendFrame(frame.buffer, frame.width, frame.height, frame.stride, pixelFormat, timestampUs);
      return accepted
        ? { accepted: true, timestampUs }
        : { accepted: false, reason: "sdk_rejected", detail: "SmartSpectra rejected the frame" };
    },
  };
}
