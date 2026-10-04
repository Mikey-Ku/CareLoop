import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addDays, dayNumber } from "../src/days.ts";
import { createDailyScheduler, localDate, onDay, zonedInstant, type SchedulerJob } from "../src/scheduler.ts";

const TZ = "America/Detroit";
const HOUR = 3_600_000;
const MINUTE = 60_000;

type Fired = { name: string; day: string; at: string };

function recorder(fired: Fired[], name: string, time: string, fail = false): SchedulerJob {
  return {
    name,
    time,
    run(day) {
      fired.push({ name, day, at: new Date().toISOString() });
      if (fail) throw new Error("boom");
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("time zone helpers", () => {
  it("gives the local date in the zone, not UTC", () => {
    // 2026-10-03 23:30 in Detroit (EDT, UTC-4) is already 10-04 in UTC.
    expect(localDate(new Date("2026-10-04T03:30:00Z"), TZ)).toBe("2026-10-03");
    expect(localDate(new Date("2026-10-04T04:30:00Z"), TZ)).toBe("2026-10-04");
  });

  it("maps a wall time to the right instant on both sides of DST", () => {
    expect(new Date(zonedInstant("2026-10-03", "09:00", TZ)).toISOString()).toBe("2026-10-03T13:00:00.000Z");
    expect(new Date(zonedInstant("2026-11-02", "09:00", TZ)).toISOString()).toBe("2026-11-02T14:00:00.000Z");
  });

  it("moves a time skipped by spring forward past the gap and picks the first of a repeated fall-back time", () => {
    // 2026-03-08 02:00 EST jumps to 03:00 EDT.
    expect(new Date(zonedInstant("2026-03-08", "02:30", TZ)).toISOString()).toBe("2026-03-08T07:30:00.000Z");
    // 2026-11-01 01:30 happens at 05:30Z (EDT) and again at 06:30Z (EST).
    expect(new Date(zonedInstant("2026-11-01", "01:30", TZ)).toISOString()).toBe("2026-11-01T05:30:00.000Z");
  });

  it("moves an instant to the same local time on another day (a pinned demo day), across DST and late evenings", () => {
    expect(onDay("2026-09-02", new Date("2026-10-04T13:44:06.259Z"), TZ).toISOString()).toBe("2026-09-02T13:44:06.259Z");
    // 09:44 EST in November is 09:44 EDT on the pinned day.
    expect(onDay("2026-09-02", new Date("2026-11-10T14:44:00.000Z"), TZ).toISOString()).toBe("2026-09-02T13:44:00.000Z");
    // 23:30 in Detroit is already the next day in UTC; it stays on the pinned local day.
    const late = onDay("2026-09-02", new Date("2026-10-05T03:30:00.000Z"), TZ);
    expect(late.toISOString()).toBe("2026-09-03T03:30:00.000Z");
    expect(localDate(late, TZ)).toBe("2026-09-02");
    expect(onDay("2026-10-04", new Date("2026-10-04T13:44:00.000Z"), TZ).toISOString()).toBe("2026-10-04T13:44:00.000Z");
  });

  it("adds calendar days across months and years", () => {
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(addDays("2026-09-01", -14)).toBe("2026-08-18");
    expect(dayNumber("2026-09-01") - dayNumber("2026-08-18")).toBe(14);
    expect(dayNumber("not a day")).toBeNaN();
  });
});

describe("createDailyScheduler", () => {
  it("fires each job once per local day at its time, across midnight", async () => {
    // 2026-10-03 08:00 EDT
    vi.setSystemTime(new Date("2026-10-03T12:00:00Z"));
    const fired: Fired[] = [];
    const scheduler = createDailyScheduler({
      timezone: TZ,
      jobs: [recorder(fired, "checkin", "09:00"), recorder(fired, "missed", "12:00"), recorder(fired, "late", "23:59")],
      log: () => {},
    });
    scheduler.start();

    await vi.advanceTimersByTimeAsync(59 * MINUTE);
    expect(fired).toEqual([]);
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(fired).toEqual([{ name: "checkin", day: "2026-10-03", at: "2026-10-03T13:00:00.000Z" }]);

    // Through midnight local time (04:00Z) and into the next morning.
    await vi.advanceTimersByTimeAsync(24 * HOUR);
    expect(fired.map((f) => `${f.name} ${f.day} ${f.at}`)).toEqual([
      "checkin 2026-10-03 2026-10-03T13:00:00.000Z",
      "missed 2026-10-03 2026-10-03T16:00:00.000Z",
      "late 2026-10-03 2026-10-04T03:59:00.000Z",
      "checkin 2026-10-04 2026-10-04T13:00:00.000Z",
    ]);
    scheduler.stop();
  });

  it("does not fire a job whose time already passed today when it starts", async () => {
    vi.setSystemTime(new Date("2026-10-03T14:00:00Z")); // 10:00 EDT
    const fired: Fired[] = [];
    const scheduler = createDailyScheduler({ timezone: TZ, jobs: [recorder(fired, "checkin", "09:00")], log: () => {} });
    scheduler.start();
    expect(scheduler.upcoming()).toEqual([{ name: "checkin", day: "2026-10-04", at: new Date("2026-10-04T13:00:00Z") }]);
    await vi.advanceTimersByTimeAsync(22 * HOUR);
    expect(fired).toEqual([]);
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(fired).toEqual([{ name: "checkin", day: "2026-10-04", at: "2026-10-04T13:00:00.000Z" }]);
    scheduler.stop();
  });

  it("keeps 09:00 local through the fall DST change", async () => {
    vi.setSystemTime(new Date("2026-10-31T14:00:00Z")); // 10:00 EDT on Saturday
    const fired: Fired[] = [];
    const scheduler = createDailyScheduler({ timezone: TZ, jobs: [recorder(fired, "checkin", "09:00")], log: () => {} });
    scheduler.start();
    await vi.advanceTimersByTimeAsync(3 * 24 * HOUR);
    expect(fired.map((f) => `${f.day} ${f.at}`)).toEqual([
      "2026-11-01 2026-11-01T14:00:00.000Z", // 09:00 EST, the day clocks fall back
      "2026-11-02 2026-11-02T14:00:00.000Z",
      "2026-11-03 2026-11-03T14:00:00.000Z",
    ]);
    scheduler.stop();
  });

  it("keeps 09:00 local through the spring DST change and fires a skipped time once", async () => {
    vi.setSystemTime(new Date("2026-03-07T15:00:00Z")); // 10:00 EST on Saturday
    const fired: Fired[] = [];
    const scheduler = createDailyScheduler({
      timezone: TZ,
      jobs: [recorder(fired, "checkin", "09:00"), recorder(fired, "night", "02:30")],
      log: () => {},
    });
    scheduler.start();
    await vi.advanceTimersByTimeAsync(2 * 24 * HOUR);
    expect(fired.map((f) => `${f.name} ${f.day} ${f.at}`)).toEqual([
      "night 2026-03-08 2026-03-08T07:30:00.000Z", // 02:30 does not exist that night; runs at 03:30 EDT
      "checkin 2026-03-08 2026-03-08T13:00:00.000Z", // 09:00 EDT
      "night 2026-03-09 2026-03-09T06:30:00.000Z",
      "checkin 2026-03-09 2026-03-09T13:00:00.000Z",
    ]);
    scheduler.stop();
  });

  it("hands jobs the pinned CLOCK_DATE but fires at real times", async () => {
    vi.setSystemTime(new Date("2026-10-03T12:00:00Z"));
    const fired: Fired[] = [];
    const scheduler = createDailyScheduler({
      timezone: TZ,
      clockDate: "2026-09-01",
      jobs: [recorder(fired, "checkin", "09:00")],
      log: () => {},
    });
    scheduler.start();
    await vi.advanceTimersByTimeAsync(25 * HOUR);
    expect(fired).toEqual([
      { name: "checkin", day: "2026-09-01", at: "2026-10-03T13:00:00.000Z" },
      { name: "checkin", day: "2026-09-01", at: "2026-10-04T13:00:00.000Z" },
    ]);
    scheduler.stop();
  });

  it("logs a failing job and keeps going", async () => {
    vi.setSystemTime(new Date("2026-10-03T12:00:00Z"));
    const fired: Fired[] = [];
    const lines: string[] = [];
    const scheduler = createDailyScheduler({
      timezone: TZ,
      jobs: [recorder(fired, "checkin", "09:00", true), recorder(fired, "missed", "12:00")],
      log: (l) => lines.push(l),
    });
    scheduler.start();
    await vi.advanceTimersByTimeAsync(25 * HOUR);
    expect(fired.map((f) => f.name)).toEqual(["checkin", "missed", "checkin"]);
    expect(lines.filter((l) => l.includes("failed"))).toEqual([
      "[scheduler] checkin: failed for 2026-10-03: Error: boom",
      "[scheduler] checkin: failed for 2026-10-04: Error: boom",
    ]);
    scheduler.stop();
  });

  it("logs an async job's rejection too", async () => {
    vi.setSystemTime(new Date("2026-10-03T12:59:00Z"));
    const lines: string[] = [];
    const scheduler = createDailyScheduler({
      timezone: TZ,
      jobs: [{ name: "checkin", time: "09:00", run: async () => Promise.reject(new TypeError("network down")) }],
      log: (l) => lines.push(l),
    });
    scheduler.start();
    await vi.advanceTimersByTimeAsync(2 * MINUTE);
    expect(lines).toContain("[scheduler] checkin: failed for 2026-10-03: TypeError: network down");
    scheduler.stop();
  });

  it("fires late on the same day after a long pause, and skips a day that already passed", async () => {
    vi.setSystemTime(new Date("2026-10-03T12:00:00Z"));
    const fired: Fired[] = [];
    const lines: string[] = [];
    // A timer that only fires when told to, like a laptop that slept.
    let pending: (() => void) | undefined;
    const scheduler = createDailyScheduler({
      timezone: TZ,
      jobs: [recorder(fired, "checkin", "09:00")],
      setTimer: (fn) => {
        pending = fn;
        return () => {
          pending = undefined;
        };
      },
      log: (l) => lines.push(l),
    });
    scheduler.start();

    // Wake at 2026-10-04 10:00 EDT: the 10-03 run is a passed day, 10-04 is late but today.
    vi.setSystemTime(new Date("2026-10-04T14:00:00Z"));
    pending?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(fired).toEqual([{ name: "checkin", day: "2026-10-04", at: "2026-10-04T14:00:00.000Z" }]);
    expect(lines).toContain("[scheduler] checkin: skipped 2026-10-03, the process was not running at 09:00");
    expect(scheduler.upcoming()).toEqual([{ name: "checkin", day: "2026-10-05", at: new Date("2026-10-05T13:00:00Z") }]);
    scheduler.stop();
  });

  it("never waits longer than a few minutes, so it notices clock jumps", () => {
    vi.setSystemTime(new Date("2026-10-03T12:00:00Z"));
    const waits: number[] = [];
    const scheduler = createDailyScheduler({
      timezone: TZ,
      jobs: [recorder([], "checkin", "09:00")],
      setTimer: (_fn, ms) => {
        waits.push(ms);
        return () => {};
      },
      log: () => {},
    });
    scheduler.start();
    expect(waits).toEqual([5 * MINUTE]);
    scheduler.stop();
  });

  it("stops firing after stop()", async () => {
    vi.setSystemTime(new Date("2026-10-03T12:00:00Z"));
    const fired: Fired[] = [];
    const scheduler = createDailyScheduler({ timezone: TZ, jobs: [recorder(fired, "checkin", "09:00")], log: () => {} });
    scheduler.start();
    scheduler.stop();
    await vi.advanceTimersByTimeAsync(48 * HOUR);
    expect(fired).toEqual([]);
    expect(scheduler.upcoming()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("runNow runs one job immediately with today's check-in date", async () => {
    vi.setSystemTime(new Date("2026-10-04T02:00:00Z")); // 22:00 EDT on 10-03
    const fired: Fired[] = [];
    const scheduler = createDailyScheduler({ timezone: TZ, jobs: [recorder(fired, "checkin", "09:00")], log: () => {} });
    await scheduler.runNow("checkin");
    expect(fired).toEqual([{ name: "checkin", day: "2026-10-03", at: "2026-10-04T02:00:00.000Z" }]);
    await expect(scheduler.runNow("nope")).rejects.toThrow('No scheduled job named "nope"');
  });

  it("rejects a bad time, a duplicate name and an unknown time zone", () => {
    expect(() => createDailyScheduler({ timezone: TZ, jobs: [recorder([], "a", "9:00")] })).toThrow("HH:MM");
    expect(() => createDailyScheduler({ timezone: TZ, jobs: [recorder([], "a", "09:00"), recorder([], "a", "10:00")] })).toThrow(
      "Two jobs",
    );
    expect(() => createDailyScheduler({ timezone: "Mars/Olympus", jobs: [] })).toThrow();
  });
});
