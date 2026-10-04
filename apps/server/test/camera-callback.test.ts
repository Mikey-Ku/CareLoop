import { existsSync, writeFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { runCameraCallback, usableReading, type RecorderEvent } from "../src/calls/camera-callback.ts";
import { CAMERA_CHECK_MISSED, CAMERA_CHECK_NOTICE, noReadingReadback } from "../src/calls/copy.ts";
import { openDatabase, upsertPatient } from "../src/db/index.ts";
import { emptyVitalsResult, type VitalsResult } from "../src/vitals/types.ts";

const PATIENT = { id: "harriet", chatId: "chat-harriet", handle: "harriet" };

function vitals(fields: Partial<VitalsResult>): VitalsResult {
  return { ...emptyVitalsResult("video_file", []), measuredAt: "2026-09-02T14:00:00.000Z", ...fields };
}

function setup(events: RecorderEvent[], read: VitalsResult = vitals({})) {
  const db = openDatabase(":memory:");
  upsertPatient(db, { id: PATIENT.id, finchnodePatientId: "patient-demo-polypharmacy", preferredName: "Harriet", relayHandle: PATIENT.handle, relayChatId: PATIENT.chatId });
  const sent: { text: string; key: string }[] = [];
  let out = "";
  const readVideo = vi.fn(async (path: string) => {
    expect(existsSync(path)).toBe(true); // Presage reads the file the recorder wrote
    return read;
  });
  const record = vi.fn((args: string[]) => {
    out = args[args.indexOf("--out") + 1]!;
    if (events.some((e) => e.event === "recorded")) writeFileSync(out, "mp4");
    return { events: (async function* () { yield* events; })(), exit: Promise.resolve(0), kill: vi.fn() };
  });
  const deps = {
    db,
    send: vi.fn(async (_chatId: string, text: string, key: string) => { sent.push({ text, key }); }),
    readVideo,
    record,
    minConfidence: 1,
    presageApiKey: "test",
    now: () => "2026-09-02T14:00:00.000Z",
    log: vi.fn(),
  };
  return { db, deps, sent, readVideo, record, out: () => out };
}

const recorded: RecorderEvent[] = [{ event: "calling" }, { event: "answered" }, { event: "video", width: 720, height: 1280 }, { event: "recording" }, { event: "recorded", frames: 1050, seconds: 35 }];
const readings = (db: ReturnType<typeof openDatabase>) => db.prepare("SELECT heart_rate AS hr, breathing_rate AS br, method FROM vitals_readings").all();

describe("usableReading: only what Presage is sure of", () => {
  it("keeps a stable, confident heart rate and drops a confidence-0 one (183 at confidence 0 on a 60 fps phone clip)", () => {
    expect(usableReading(vitals({ heartRate: 82.5, heartRateConfidence: 70, heartRateStable: true }), 1)).toEqual({ heartRate: 82.5, breathingRate: null });
    expect(usableReading(vitals({ heartRate: 182.9, heartRateConfidence: 0, heartRateStable: false }), 1)).toEqual({ heartRate: null, breathingRate: null });
    expect(usableReading(vitals({ heartRate: 82.5, heartRateConfidence: 70, heartRateStable: false }), 1).heartRate).toBeNull();
    expect(usableReading(vitals({ breathingRate: 14.8, breathingRateConfidence: 83, breathingRateStable: true }), 1)).toEqual({ heartRate: null, breathingRate: 14.8 });
    expect(usableReading(vitals({ heartRate: 250, heartRateConfidence: 90, heartRateStable: true }), 1).heartRate).toBeNull();
  });
});

describe("runCameraCallback", () => {
  it("texts her first, records, reads the file, saves the reading and texts it back; her video is deleted", async () => {
    // Presage stamps the file's reading on the real clock; the agent's clock (here the pinned demo day) wins.
    const f = setup(recorded, vitals({ heartRate: 82.5, heartRateConfidence: 70, heartRateStable: true, measuredAt: "2026-10-04T13:44:06.259Z" }));
    expect(await runCameraCallback(f.deps, PATIENT)).toBe("reading");
    expect(f.db.prepare("SELECT taken_at AS takenAt FROM vitals_readings").get()).toEqual({ takenAt: "2026-09-02T14:00:00.000Z" });
    expect(f.sent.map((m) => m.text)).toEqual([CAMERA_CHECK_NOTICE, "Your heart rate is about 83 beats a minute. This is a camera estimate, not a medical test."]);
    expect(new Set(f.sent.map((m) => m.key)).size).toBe(2); // each message has its own retry-safe key
    expect(readings(f.db)).toEqual([{ hr: 82.5, br: null, method: "relay_call" }]);
    expect(existsSync(f.out())).toBe(false);
  });

  it("an estimate Presage is not sure of is not said: the no-reading words, and nothing is saved", async () => {
    const f = setup(recorded, vitals({ heartRate: 182.9, heartRateConfidence: 0, heartRateStable: false }));
    expect(await runCameraCallback(f.deps, PATIENT)).toBe("no_reading");
    expect(f.sent.at(-1)!.text).toBe(noReadingReadback());
    expect(readings(f.db)).toEqual([]);
  });

  it("no recording (not answered, camera off): she is told kindly, and Presage is not run", async () => {
    const f = setup([{ event: "calling" }, { event: "failed", reason: "no_video" }]);
    expect(await runCameraCallback(f.deps, PATIENT)).toBe("not_recorded");
    expect(f.sent.map((m) => m.text)).toEqual([CAMERA_CHECK_NOTICE, CAMERA_CHECK_MISSED]);
    expect(f.readVideo).not.toHaveBeenCalled();
  });

  it("never throws: a Presage failure ends with the missed-check words", async () => {
    const f = setup(recorded);
    f.deps.readVideo = vi.fn(async () => { throw new Error("SmartSpectra failed"); });
    expect(await runCameraCallback(f.deps, PATIENT)).toBe("not_recorded");
    expect(f.sent.at(-1)!.text).toBe(CAMERA_CHECK_MISSED);
    expect(existsSync(f.out())).toBe(false);
  });
});
