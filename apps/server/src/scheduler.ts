import { DAY_MS, addDays } from "./days.ts";
import { errorSummary } from "./errors.ts";

// Daily jobs in the senior's time zone (docs/DESIGN.md "Dates", "Build order" 3).
// Each job fires once per local day at its HH:MM wall-clock time, across DST
// changes. The check-in date it gets is CLOCK_DATE when the demo clock is pinned,
// else the local date in her time zone; the job still fires at the real time.
// Written with setTimeout and Intl only (no cron dependency).

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
/** Longest single wait. Waking up at least this often keeps the schedule right after sleep or clock changes. */
export const MAX_WAIT_MS = 5 * 60_000;

export type SchedulerJob = {
  name: string;
  /** Local wall-clock time, HH:MM (24 hour). */
  time: string;
  run(day: string): unknown;
};

export type CancelTimer = () => void;

export type DailySchedulerOptions = {
  /** IANA time zone the times are in. */
  timezone: string;
  jobs: SchedulerJob[];
  /** CLOCK_DATE: pins the check-in date handed to jobs. Firing times stay real. */
  clockDate?: string | undefined;
  /** Current time. Defaults to the system clock. */
  clock?: () => Date;
  /** Starts a timer and returns its cancel function. Defaults to setTimeout. */
  setTimer?: (fn: () => void, ms: number) => CancelTimer;
  log?: (line: string) => void;
};

export type ScheduledRun = { name: string; day: string; at: Date };

export type DailyScheduler = {
  start(): void;
  stop(): void;
  /** Run one job now with today's check-in date (for demos). Errors are logged, not thrown. */
  runNow(name: string): Promise<void>;
  /** When each job fires next and for which local day. Empty when stopped. */
  upcoming(): ScheduledRun[];
};

type JobState = { job: SchedulerJob; localDay: string; at: number };

export function createDailyScheduler(options: DailySchedulerOptions): DailyScheduler {
  const { timezone, jobs, clockDate } = options;
  const clock = options.clock ?? (() => new Date());
  const setTimer =
    options.setTimer ??
    ((fn: () => void, ms: number): CancelTimer => {
      const t = setTimeout(fn, ms);
      return () => clearTimeout(t);
    });
  const log = options.log ?? ((line: string) => console.log(line));

  const names = new Set<string>();
  for (const job of jobs) {
    if (!TIME.test(job.time)) throw new Error(`Job "${job.name}": time must be HH:MM, got "${job.time}"`);
    if (names.has(job.name)) throw new Error(`Two jobs are named "${job.name}"`);
    names.add(job.name);
  }
  localDate(new Date(0), timezone); // throws early on an unknown time zone

  let states: JobState[] = [];
  let cancel: CancelTimer | undefined;
  let running = false;

  /** The first firing for this job at or after `now`, starting with today's local date. */
  function firstFiring(job: SchedulerJob, now: number): JobState {
    let day = localDate(new Date(now), timezone);
    let at = zonedInstant(day, job.time, timezone);
    if (at < now) {
      day = addDays(day, 1);
      at = zonedInstant(day, job.time, timezone);
    }
    return { job, localDay: day, at };
  }

  function checkinDay(localDay: string): string {
    return clockDate ?? localDay;
  }

  async function execute(job: SchedulerJob, day: string, why: string): Promise<void> {
    log(`[scheduler] ${job.name}: running for ${day} (${why})`);
    try {
      await job.run(day);
    } catch (error) {
      log(`[scheduler] ${job.name}: failed for ${day}: ${errorSummary(error)}`);
    }
  }

  function arm(): void {
    cancel?.();
    cancel = undefined;
    if (!running || states.length === 0) return;
    const now = clock().getTime();
    const next = Math.min(...states.map((s) => s.at));
    const wait = Math.max(0, Math.min(next - now, MAX_WAIT_MS));
    cancel = setTimer(tick, wait);
  }

  function tick(): void {
    if (!running) return;
    const now = clock().getTime();
    const today = localDate(new Date(now), timezone);
    for (const state of states) {
      while (now >= state.at) {
        // Fire late only on the same local day (say after the laptop slept); a day that already passed is skipped.
        if (state.localDay === today) void execute(state.job, checkinDay(state.localDay), `scheduled ${state.job.time} ${timezone}`);
        else log(`[scheduler] ${state.job.name}: skipped ${state.localDay}, the process was not running at ${state.job.time}`);
        state.localDay = addDays(state.localDay, 1);
        state.at = zonedInstant(state.localDay, state.job.time, timezone);
      }
    }
    arm();
  }

  return {
    start() {
      if (running) return;
      running = true;
      const now = clock().getTime();
      states = jobs.map((job) => firstFiring(job, now));
      for (const s of states) log(`[scheduler] ${s.job.name}: next at ${s.job.time} ${timezone} on ${s.localDay}`);
      arm();
    },
    stop() {
      running = false;
      cancel?.();
      cancel = undefined;
      states = [];
    },
    async runNow(name) {
      const job = jobs.find((j) => j.name === name);
      if (!job) throw new Error(`No scheduled job named "${name}"`);
      await execute(job, checkinDay(localDate(clock(), timezone)), "run now");
    },
    upcoming() {
      return states.map((s) => ({ name: s.job.name, day: s.localDay, at: new Date(s.at) }));
    },
  };
}

// ---- time zone arithmetic with Intl ----

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timezone: string): Intl.DateTimeFormat {
  let f = formatters.get(timezone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(timezone, f);
  }
  return f;
}

/** Wall-clock fields of an instant in a time zone. */
function wallClock(instant: number, timezone: string): { y: number; mo: number; d: number; h: number; mi: number; s: number } {
  const parts: Record<string, number> = {};
  for (const p of formatter(timezone).formatToParts(new Date(instant))) if (p.type !== "literal") parts[p.type] = Number(p.value);
  return { y: parts.year!, mo: parts.month!, d: parts.day!, h: parts.hour!, mi: parts.minute!, s: parts.second! };
}

/** Local date (YYYY-MM-DD) of an instant in a time zone. */
export function localDate(date: Date, timezone: string): string {
  const { y, mo, d } = wallClock(date.getTime(), timezone);
  return `${String(y).padStart(4, "0")}-${pad(mo)}-${pad(d)}`;
}

/** Offset of the zone from UTC at an instant, in ms (Detroit in winter: -5 h). */
function offsetAt(instant: number, timezone: string): number {
  const w = wallClock(instant, timezone);
  const asUtc = Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s);
  return asUtc - Math.floor(instant / 1000) * 1000;
}

/**
 * The instant a local date and HH:MM happen in a time zone. A time skipped by a
 * spring-forward change maps to the same distance past the gap (02:30 becomes 03:30);
 * a time that happens twice in the fall maps to the first one.
 */
export function zonedInstant(day: string, time: string, timezone: string): number {
  const [y, mo, d] = day.split("-").map(Number) as [number, number, number];
  const [h, mi] = time.split(":").map(Number) as [number, number];
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  const before = offsetAt(wall - DAY_MS / 2, timezone);
  const after = offsetAt(wall + DAY_MS / 2, timezone);
  const valid = [...new Set([before, after])].map((o) => wall - o).filter((t) => wall - offsetAt(t, timezone) === t);
  if (valid.length > 0) return Math.min(...valid);
  return wall - before;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}
