import { z } from "zod";

// App configuration from the environment. Secrets live only in .env.

const DAY = /^\d{4}-\d{2}-\d{2}$/;

const ConfigSchema = z.object({
  FINCHNODE_BASE_URL: z.string().url().default("https://api.finchnode.com/demo/v1"),
  FINCHNODE_API_KEY: z.string().optional(),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_PATH: z.string().default("./data/app.db"),
  CHECKIN_TIME: z.string().default("09:00"),
  MISSED_CHECKIN_TIME: z.string().default("12:00"),
  /** Demo clock (docs/DESIGN.md "Dates"). Empty means use the snapshot's data as-of date. */
  CLOCK_DATE: z
    .string()
    .optional()
    .transform((v) => (v ? v : undefined))
    .refine((v) => v === undefined || DAY.test(v), "CLOCK_DATE must be YYYY-MM-DD"),
});

export type Config = {
  finchnode: { baseUrl: string; apiKey: string | undefined };
  port: number;
  databasePath: string;
  checkinTime: string;
  missedCheckinTime: string;
  clockDate: string | undefined;
};

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const c = ConfigSchema.parse(Object.fromEntries(Object.entries(env).map(([k, v]) => [k, v === "" ? undefined : v])));
  return {
    finchnode: { baseUrl: c.FINCHNODE_BASE_URL, apiKey: c.FINCHNODE_API_KEY },
    port: c.PORT,
    databasePath: c.DATABASE_PATH,
    checkinTime: c.CHECKIN_TIME,
    missedCheckinTime: c.MISSED_CHECKIN_TIME,
    clockDate: c.CLOCK_DATE,
  };
}

/**
 * The check-in date rules reason about: the demo clock if set, else the snapshot's
 * data as-of date, else today. Nothing else should read the system clock for rules.
 */
export function resolveCheckinDate(clockDate: string | undefined, dataAsOf: string | undefined, now = new Date()): string {
  return clockDate ?? dataAsOf ?? now.toISOString().slice(0, 10);
}
