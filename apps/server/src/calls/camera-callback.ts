import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { Db } from "../db/index.ts";
import { addVitalsReading } from "../db/vitals.ts";
import { REPO_ROOT } from "../finchnode/fixtures.ts";
import { runPresageVideo } from "../vitals/presage-file.ts";
import type { VitalsResult } from "../vitals/types.ts";
import { CAMERA_CHECK_END, CAMERA_CHECK_MISSED, CAMERA_CHECK_NOTICE, CAMERA_CHECK_NO_VIDEO, CAMERA_CHECK_START, heartRateReadback, noReadingReadback } from "./copy.ts";

// The camera check call-back: a short second call that only records her camera, then reads the recording.
// On live calls the Relay TypeScript receiver drops frames every few seconds, so Presage never gets the 12 s of
// continuous video a pulse needs. The Relay Python SDK (aiortc) repairs the loss: the recorder in
// apps/camera-check places the call, records about 35 s as constant 30 fps H.264, and Presage reads that file here.
// The result goes to her chat; it is a real reading or the no-reading words, never a stand-in.

export const CAMERA_CHECK_DIR = join(REPO_ROOT, "apps", "camera-check");

/** One JSON line from the recorder. The last one is `recorded` (with `path`) or `failed` (with `reason`). */
export type RecorderEvent = { event: string; [field: string]: unknown };

export type Recorder = (args: string[]) => { events: AsyncIterable<RecorderEvent>; exit: Promise<number>; kill(): void };

export type CameraCallbackPatient = { id: string; chatId: string; handle: string };

export type CameraCallbackDeps = {
  db: Db;
  /** A text message in her chat; `key` makes a retry safe. */
  send(chatId: string, text: string, key: string): Promise<void>;
  /** Presage's file reader. */
  readVideo?: (path: string) => Promise<VitalsResult>;
  /** The Python recorder; replaced in tests. */
  record?: Recorder;
  minConfidence: number;
  presageApiKey: string;
  now: () => string;
  log: (event: string, fields?: Record<string, unknown>) => void;
  /** How long the whole call-back may take before the recorder is stopped. */
  timeoutMs?: number;
  /** The wait before the one more try (CAMERA_CHECK_RETRY_MS). */
  retryDelayMs?: number;
};

export type CameraCallbackOutcome = "reading" | "no_reading" | "not_recorded";

/**
 * Relay sometimes ends a call-back within 2 s as no-answer, before her phone rang (twice on 2026-10-04; one placed
 * between them was answered in 3 s), or can't place it while her last call is still open. Those are tried once more
 * after this long. A call she let ring out (not_answered) is not.
 */
export const CAMERA_CHECK_RETRY_MS = 10_000;
const RETRIED = new Set(["call_ended", "call_not_placed"]);

/** The recorder as a child process: `uv run` in apps/camera-check, or CAMERA_CHECK_PYTHON when set. Keys pass through the environment. */
export const pythonRecorder: Recorder = (args) => {
  const python = process.env.CAMERA_CHECK_PYTHON?.trim();
  const [command, prefix] = python ? [python, []] : ["uv", ["run", "--quiet", "--project", CAMERA_CHECK_DIR, "python"]];
  const child = spawn(command, [...prefix, join(CAMERA_CHECK_DIR, "camera_check.py"), ...args], { stdio: ["ignore", "pipe", "pipe"], env: process.env });
  child.stderr.resume(); // aiortc's own logging; never parsed, never logged (it can name hosts)
  const exit = new Promise<number>((resolve) => {
    child.on("error", () => resolve(127));
    child.on("close", (code) => resolve(code ?? 1));
  });
  async function* events(): AsyncIterable<RecorderEvent> {
    for await (const line of createInterface({ input: child.stdout })) {
      try {
        const parsed = JSON.parse(line) as RecorderEvent;
        if (parsed && typeof parsed.event === "string") yield parsed;
      } catch {
        // not one of ours
      }
    }
  }
  return { events: events(), exit, kill: () => child.kill("SIGTERM") };
};

/**
 * The heart rate and breathing rate Presage is sure of, as on a call (QuietMeasurement.finish): stable and at least
 * minConfidence, else null. Presage gave 183 bpm at confidence 0 on a 60 fps phone clip; that must never be said.
 */
export function usableReading(vitals: VitalsResult, minConfidence: number): { heartRate: number | null; breathingRate: number | null } {
  const sure = (value: number | null, confidence: number | null, stable: boolean | null | undefined) =>
    value !== null && Number.isFinite(value) && stable === true && confidence !== null && confidence >= minConfidence && confidence <= 100 ? value : null;
  const heartRate = sure(vitals.heartRate, vitals.heartRateConfidence, vitals.heartRateStable);
  return {
    heartRate: heartRate !== null && heartRate >= 30 && heartRate <= 220 ? heartRate : null,
    breathingRate: sure(vitals.breathingRate, vitals.breathingRateConfidence, vitals.breathingRateStable),
  };
}

/** Calls her back for the camera check and texts her the result. Never throws; the recording is always deleted. */
export async function runCameraCallback(deps: CameraCallbackDeps, patient: CameraCallbackPatient): Promise<CameraCallbackOutcome> {
  const startedAt = deps.now();
  const key = (part: string) => `camera-check:${patient.id}:${startedAt}:${part}`;
  const text = async (body: string, part: string) => {
    try {
      await deps.send(patient.chatId, body, key(part));
    } catch (error) {
      deps.log("camera_check_message_failed", { part, error: error instanceof Error ? error.message : String(error) });
    }
  };
  const dir = await mkdtemp(join(tmpdir(), "camera-check-"));
  const out = join(dir, "check.mp4");
  const callOnce = async (): Promise<{ recorded?: RecorderEvent; failure: string }> => {
    const recorder = (deps.record ?? pythonRecorder)(["--chat-id", patient.chatId, "--to", patient.handle, "--out", out, "--say-start", CAMERA_CHECK_START, "--say-end", CAMERA_CHECK_END, "--say-camera", CAMERA_CHECK_NO_VIDEO]);
    const timer = setTimeout(() => recorder.kill(), deps.timeoutMs ?? 4 * 60_000);
    timer.unref?.();
    let recorded: RecorderEvent | undefined;
    let failure = "no_result";
    try {
      for await (const event of recorder.events) {
        deps.log("camera_check_step", { step: event.event, ...pick(event, ["reason", "detail", "frames", "seconds", "received", "longest_gap_ms", "width", "height", "camera_flag", "has_track", "readers", "frames_decoded", "frames_dropped", "decode_errors", "codec"]) });
        if (event.event === "recorded") recorded = event;
        if (event.event === "failed") failure = String(event.reason ?? "failed");
      }
      await recorder.exit;
    } finally {
      clearTimeout(timer);
    }
    return recorded ? { recorded, failure } : { failure };
  };
  try {
    await text(CAMERA_CHECK_NOTICE, "notice");
    let call = await callOnce();
    if (!call.recorded && RETRIED.has(call.failure)) {
      deps.log("camera_check_retry", { reason: call.failure });
      await new Promise((resolve) => setTimeout(resolve, deps.retryDelayMs ?? CAMERA_CHECK_RETRY_MS));
      call = await callOnce();
    }
    const { recorded, failure } = call;
    if (!recorded) {
      deps.log("camera_check_not_recorded", { reason: failure });
      await text(CAMERA_CHECK_MISSED, "result");
      return "not_recorded";
    }
    const vitals = await (deps.readVideo ?? ((path) => runPresageVideo({ videoPath: path, apiKey: deps.presageApiKey, timeoutMs: 180_000 })))(out);
    const reading = usableReading(vitals, deps.minConfidence);
    deps.log("camera_check_read", {
      hr: vitals.heartRate, hr_confidence: vitals.heartRateConfidence, hr_stable: vitals.heartRateStable,
      br: vitals.breathingRate, br_confidence: vitals.breathingRateConfidence, br_stable: vitals.breathingRateStable,
      kept_hr: reading.heartRate, kept_br: reading.breathingRate,
    });
    if (reading.heartRate === null && reading.breathingRate === null) {
      await text(noReadingReadback(), "result");
      return "no_reading";
    }
    addVitalsReading(deps.db, {
      patientId: patient.id,
      takenAt: deps.now(), // the agent's clock (a pinned demo day); Presage's file time is the real clock
      heartRate: reading.heartRate,
      breathingRate: reading.breathingRate,
      method: "relay_call", // the call-back is a Relay video call
      confidence: reading.heartRate !== null ? vitals.heartRateConfidence : vitals.breathingRateConfidence,
    });
    await text(heartRateReadback(reading, null), "result");
    return "reading";
  } catch (error) {
    deps.log("camera_check_failed", { error: error instanceof Error ? error.message : String(error) });
    await text(CAMERA_CHECK_MISSED, "result");
    return "not_recorded";
  } finally {
    await rm(dir, { recursive: true, force: true }); // her video is never kept
  }
}

function pick(source: Record<string, unknown>, names: string[]): Record<string, unknown> {
  return Object.fromEntries(names.filter((name) => source[name] !== undefined).map((name) => [name, source[name]]));
}
