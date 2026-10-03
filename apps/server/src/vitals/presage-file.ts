import { breathingMetrics, cardioMetrics, ProcessingStatus, SmartSpectraSDK } from "@smartspectra/node-sdk";
import { decodeMetrics } from "@smartspectra/node-sdk/messages";
import { mergeMetricSnapshots, normalizePresageMetrics, resultFromSnapshot } from "./normalize.ts";
import { emptyVitalsResult, type VitalsError, type VitalsResult, type ValidationEvent } from "./types.ts";

export type PresageSession = {
  useFile(videoPath: string): PresageSession;
  start(): void;
  destroy(): Promise<void>;
  on(event: "processingStatus", callback: (status: number) => void): PresageSession;
  on(event: "validationStatus", callback: (code: number, timestampUs: number, hint: string) => void): PresageSession;
  on(event: "metrics", callback: (buffer: Buffer, timestampUs: number) => void): PresageSession;
  on(event: "error", callback: (code: number, message: string, retryable: boolean) => void): PresageSession;
};

export type PresageSdkFactory = (options: { apiKey: string; requestedMetrics: number[] }) => PresageSession;

const defaultSdkFactory: PresageSdkFactory = (options) => new SmartSpectraSDK(options);

export type PresageFileOptions = {
  videoPath: string;
  apiKey: string | undefined;
  timeoutMs?: number;
  sdkFactory?: PresageSdkFactory;
};

export async function runPresageVideo(options: PresageFileOptions): Promise<VitalsResult> {
  const apiKey = options.apiKey?.trim();
  if (!apiKey) return emptyVitalsResult("video_file", [{ code: "missing_api_key", message: "PRESAGE_API_KEY is required" }]);

  const validation: ValidationEvent[] = [];
  const errors: VitalsError[] = [];
  let snapshot = {};
  let session: PresageSession | undefined;
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let settle: (() => void) | undefined;
  const complete = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const finish = () => {
    if (settled) return;
    settled = true;
    settle?.();
  };

  try {
    session = (options.sdkFactory ?? defaultSdkFactory)({
      apiKey,
      requestedMetrics: [...breathingMetrics, ...cardioMetrics],
    });
    session.on("metrics", (buffer, timestampUs) => {
      try {
        snapshot = mergeMetricSnapshots(snapshot, normalizePresageMetrics(decodeMetrics(buffer), timestampUs));
      } catch (error) {
        errors.push({ code: "metrics_decode", message: error instanceof Error ? error.message : String(error) });
      }
    });
    session.on("validationStatus", (code, timestampUs, hint) => {
      validation.push({ code, timestampUs, hint });
    });
    session.on("error", (code, message, retryable) => {
      errors.push({ code, message, retryable });
      finish();
    });
    session.on("processingStatus", (status) => {
      if (status === ProcessingStatus.kError) {
        errors.push({ code: "processing_status_error", message: "SmartSpectra ended in an error state" });
        finish();
      } else if (status === ProcessingStatus.kIdle) {
        finish();
      }
    });

    session.useFile(options.videoPath);
    session.start();
    const timeoutMs = options.timeoutMs ?? 120_000;
    timer = setTimeout(() => {
      errors.push({ code: "timeout", message: `SmartSpectra did not finish within ${timeoutMs} ms` });
      finish();
    }, timeoutMs);
    await complete;
  } catch (error) {
    errors.push({ code: "startup", message: error instanceof Error ? error.message : String(error) });
    finish();
  } finally {
    if (timer) clearTimeout(timer);
    if (session) {
      try {
        await session.destroy();
      } catch (error) {
        errors.push({ code: "destroy", message: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  return resultFromSnapshot("video_file", snapshot, validation, errors);
}

export function hasUsableVitals(result: VitalsResult): boolean {
  return result.heartRate !== null && result.breathingRate !== null;
}
