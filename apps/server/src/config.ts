import { z } from "zod";
import { isCalendarDay } from "./days.ts";

// App configuration from the environment. Secrets live only in .env and never
// appear in an error message, a log line or a printed config.

/** SmartSpectra refuses a frame more than 2000 ms after the last one it took, then every frame after it until it is restarted. */
export const MAX_FRAME_GAP_LIMIT_MS = 1_900;

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

export const DEFAULT_RELAY_API_URL = "https://api.relayapp.im";
export const DEFAULT_FINCHNODE_SUBJECT = "patient-demo-polypharmacy";
/** FinchNode's open demo API: synthetic records, no key needed. */
export const DEFAULT_FINCHNODE_BASE_URL = "https://api.finchnode.com/demo/v1";
export const DEFAULT_TIMEZONE = "America/Detroit";
/**
 * Tried in order. gemini-3.6-flash first: measured 2026-10-04 with the context digest in the prompt (10 calls
 * each, thinkingLevel minimal), a classify call took p50 1.2 s, p95 1.4 s, against 0.8 s and 0.9 s for
 * gemini-flash-lite-latest, and it read her messages best in the content eval (docs/content-eval.md).
 * gemini-3.7-flash, gemini-3.8-flash and gemini-flash-latest answer 400 to thinkingLevel minimal, so they
 * can't be used until the client asks for another level.
 */
// The lite models after it, the cheapest tier, as fallbacks: load moves between models (on 2026-10-03 one
// returned 503 for minutes while others answered in under a second), and a busy model is skipped at once
// (src/llm/fallback.ts).
export const DEFAULT_GEMINI_MODELS = ["gemini-3.6-flash", "gemini-flash-lite-latest", "gemini-3.5-flash-lite", "gemini-3.1-flash-lite"];
/** Live calls plan a turn every few seconds, so they use the fast lite models (about 0.5 s faster per turn than the chat chain). */
export const DEFAULT_GEMINI_CALL_MODELS = ["gemini-flash-lite-latest", "gemini-3.5-flash-lite", "gemini-3.1-flash-lite"];
/** One try at one model; leaves budget for the next model when one hangs. */
export const DEFAULT_LLM_ATTEMPT_TIMEOUT_MS = 4_000;
export const DEFAULT_LLM_TIMEOUT_MS = 12_000;

const ConfigSchema = z.object({
  FINCHNODE_BASE_URL: z.string().url().default(DEFAULT_FINCHNODE_BASE_URL),
  FINCHNODE_API_KEY: z.string().optional(),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_PATH: z.string().default("./data/app.db"),
  CHECKIN_TIME: z.string().regex(TIME, "must be HH:MM (24 hour)").default("09:00"),
  MISSED_CHECKIN_TIME: z.string().regex(TIME, "must be HH:MM (24 hour)").default("12:00"),
  /** Medication helper (src/meds): the morning and evening reminders, the one re-reminder after "Not yet", the refill window. */
  MEDS_MORNING_TIME: z.string().regex(TIME, "must be HH:MM (24 hour)").default("08:00"),
  MEDS_EVENING_TIME: z.string().regex(TIME, "must be HH:MM (24 hour)").default("20:00"),
  MEDS_NUDGE_MINUTES: z.coerce.number().positive("must be a positive number of minutes").max(24 * 60).default(60),
  REFILL_REMIND_DAYS: z.coerce.number().int().min(1).max(30).default(5),
  /** Demo clock (docs/DESIGN.md "Dates"). Empty means use the snapshot's data as-of date. */
  CLOCK_DATE: z
    .string()
    .optional()
    .transform((v) => (v ? v : undefined))
    .refine((v) => v === undefined || isCalendarDay(v), "CLOCK_DATE must be a real date, YYYY-MM-DD"),
  RELAY_API_URL: z.string().default(DEFAULT_RELAY_API_URL),
  PATIENT_RELAY_HANDLE: z.string().optional(),
  FAMILY_RELAY_HANDLES: z.string().optional(),
  PATIENT_FINCHNODE_SUBJECT: z.string().default(DEFAULT_FINCHNODE_SUBJECT),
  PATIENT_TIMEZONE: z.string().default(DEFAULT_TIMEZONE),
  LLM_PROVIDER: z
    .string()
    .default("gemini")
    .transform((v) => v.trim().toLowerCase())
    .pipe(z.enum(["gemini"], "LLM_PROVIDER must be gemini (the only adapter)")),
  GEMINI_MODELS: z.string().optional(),
  GEMINI_CALL_MODELS: z.string().optional(),
  LLM_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120_000).default(DEFAULT_LLM_TIMEOUT_MS),
  LLM_ATTEMPT_TIMEOUT_MS: z.coerce.number().int().min(500).max(120_000).default(DEFAULT_LLM_ATTEMPT_TIMEOUT_MS),
  ELEVENLABS_API_KEY: z.string().optional(),
  ELEVENLABS_VOICE_ID: z.string().optional(),
  ELEVENLABS_STT_MODEL: z.string().default("scribe_v2_realtime"),
  /** How long she must pause before her turn is taken as finished. It is added to every reply's wait; it was 0.85 and a real call felt slow. */
  ELEVENLABS_STT_VAD_SILENCE_SECS: z.coerce.number().min(0.3, "must be 0.3 to 3 seconds").max(3, "must be 0.3 to 3 seconds").default(0.7),
  ELEVENLABS_TTS_MODEL: z.string().default("eleven_flash_v2_5"),
  ELEVENLABS_TTS_OUTPUT_FORMAT: z.string().default("pcm_48000").pipe(z.literal("pcm_48000")),
  /** Soft limiter on the voice (src/calls/audio.ts softLimit). 1 leaves it untouched; 1.6 lifts a quiet voice about 4.7 dB without clipping. */
  ELEVENLABS_TTS_GAIN: z.coerce.number().min(1, "must be 1 (untouched) or more").max(4, "must be 4 or less").default(1.6),
  CALL_QUIET_MEASUREMENT_MS: z.coerce.number().int().min(30_000).max(45_000).default(30_000),
  /** Longest call; the server ends the ElevenLabs session after it (Relay's 32 s is only the time to answer). */
  CALL_MAX_MINUTES: z.coerce.number().positive().max(30).default(4),
  /** Lowest SmartSpectra confidence (0 to 100) a camera reading needs to be used. 1 keeps out warm-up zeros; the team tunes it. */
  VITALS_MIN_CONFIDENCE: z.coerce.number().min(0).max(100).default(1),
  /**
   * Longest pause in her video (ms) before the reading restarts inside the same window. SmartSpectra refuses any frame
   * more than 2000 ms after the last one it took, so this is clamped to MAX_FRAME_GAP_LIMIT_MS (1900) whatever is set.
   */
  VITALS_MAX_FRAME_GAP_MS: z.coerce.number().int().min(1_000).max(10_000).default(MAX_FRAME_GAP_LIMIT_MS).transform((ms) => Math.min(ms, MAX_FRAME_GAP_LIMIT_MS)),
});

export type RelayConfig = {
  /** Origin only (https://api.relayapp.im). The SDK adds /v1 itself. */
  apiUrl: string;
  /** RELAY_AGENT_TOKEN. Non-enumerable, so it never shows up when the config is printed or serialized. */
  agentToken: string | undefined;
};

export type PatientConfig = {
  finchnodeSubject: string;
  /** Her Relay handle, lower case, without a leading "@". */
  relayHandle: string | undefined;
  /** Family members' Relay handles, normalized like relayHandle, in .env order, no duplicates. */
  familyHandles: string[];
  /** IANA time zone her day runs in. */
  timezone: string;
};

export type LlmProvider = "gemini";

export type LlmConfig = {
  /** LLM_PROVIDER. Only "gemini" has an adapter; LlmClient stays provider-neutral for another one. */
  provider: LlmProvider;
  /** GEMINI_API_KEY. Non-enumerable, so it never shows up when the config is printed or serialized. */
  geminiApiKey: string | undefined;
  /** GEMINI_MODELS, comma separated, tried in order. */
  geminiModels: string[];
  /** GEMINI_CALL_MODELS: the chain for live-call turns (fast models first). */
  geminiCallModels: string[];
  /** LLM_TIMEOUT_MS: the whole budget for one call, across retries and model fallbacks. */
  timeoutMs: number;
  /** LLM_ATTEMPT_TIMEOUT_MS: the cap on one try at one model. */
  attemptTimeoutMs: number;
};

export type CallsConfig = {
  /** ElevenLabs API key. Non-enumerable and never logged. */
  elevenLabsApiKey: string | undefined;
  /** ElevenLabs voice used by direct streaming TTS. */
  elevenLabsVoiceId: string | undefined;
  elevenLabsSttModel: string;
  /** ELEVENLABS_STT_LANGUAGE: the language code of her speech ("en" unless set); undefined means ElevenLabs detects it. */
  elevenLabsSttLanguage: string | undefined;
  /** ELEVENLABS_STT_VAD_SILENCE_SECS: her pause, in seconds, that ends a turn. */
  elevenLabsSttVadSilenceSecs: number;
  elevenLabsTtsModel: string;
  elevenLabsTtsOutputFormat: string;
  /** ELEVENLABS_TTS_GAIN: the voice's soft limiter gain, 1 to 4 (1 untouched). */
  elevenLabsTtsGain: number;
  /** SmartSpectra key. Non-enumerable and never logged. */
  presageApiKey: string | undefined;
  /** SmartSpectra's minimum quiet window for breathing. */
  quietMeasurementMs: number;
  /** CALL_MAX_MINUTES: the server ends the call after this long. */
  maxMinutes: number;
  /** VITALS_MIN_CONFIDENCE: lowest SmartSpectra confidence (0 to 100) a reading needs. */
  vitalsMinConfidence: number;
  /** VITALS_MAX_FRAME_GAP_MS: a longer pause in her video restarts the reading inside the same quiet window (at most 1900). */
  maxFrameGapMs: number;
};

export type Config = {
  finchnode: { baseUrl: string; apiKey: string | undefined };
  relay: RelayConfig;
  patient: PatientConfig;
  llm: LlmConfig;
  calls: CallsConfig;
  port: number;
  databasePath: string;
  checkinTime: string;
  missedCheckinTime: string;
  clockDate: string | undefined;
  /** Medication helper: MEDS_MORNING_TIME, MEDS_EVENING_TIME (HH:MM in her time zone), MEDS_NUDGE_MINUTES, REFILL_REMIND_DAYS. */
  meds: { morningTime: string; eveningTime: string; nudgeMinutes: number; refillRemindDays: number };
};

/** Thrown for a bad environment. The message names variables and problems, never values. */
export class ConfigError extends Error {
  override name = "ConfigError";
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  // Secrets are read here and nowhere near the schema, so a parse error can't echo them.
  const { RELAY_AGENT_TOKEN, GEMINI_API_KEY, ELEVENLABS_API_KEY, PRESAGE_API_KEY, ...rest } = env;
  const cleaned = Object.fromEntries(Object.entries(rest).map(([k, v]) => [k, v === "" ? undefined : v]));
  const parsed = ConfigSchema.safeParse(cleaned);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join(".") || "env"}: ${i.message}`);
    throw new ConfigError(`Invalid configuration: ${problems.join("; ")}`);
  }
  const c = parsed.data;
  const relay: RelayConfig = { apiUrl: relayOrigin(c.RELAY_API_URL), agentToken: undefined };
  const token = RELAY_AGENT_TOKEN?.trim();
  Object.defineProperty(relay, "agentToken", { value: token ? token : undefined, enumerable: false });
  const llm: LlmConfig = {
    provider: c.LLM_PROVIDER,
    geminiApiKey: undefined,
    geminiModels: parseList(c.GEMINI_MODELS) ?? [...DEFAULT_GEMINI_MODELS],
    geminiCallModels: parseList(c.GEMINI_CALL_MODELS) ?? [...DEFAULT_GEMINI_CALL_MODELS],
    timeoutMs: c.LLM_TIMEOUT_MS,
    attemptTimeoutMs: c.LLM_ATTEMPT_TIMEOUT_MS,
  };
  const geminiKey = GEMINI_API_KEY?.trim();
  Object.defineProperty(llm, "geminiApiKey", { value: geminiKey ? geminiKey : undefined, enumerable: false });

  const calls: CallsConfig = {
    elevenLabsApiKey: undefined,
    elevenLabsVoiceId: c.ELEVENLABS_VOICE_ID?.trim() || undefined,
    elevenLabsSttModel: c.ELEVENLABS_STT_MODEL.trim(),
    elevenLabsSttLanguage: sttLanguageCode(env.ELEVENLABS_STT_LANGUAGE),
    elevenLabsSttVadSilenceSecs: c.ELEVENLABS_STT_VAD_SILENCE_SECS,
    elevenLabsTtsModel: c.ELEVENLABS_TTS_MODEL.trim(),
    elevenLabsTtsOutputFormat: c.ELEVENLABS_TTS_OUTPUT_FORMAT.trim(),
    elevenLabsTtsGain: c.ELEVENLABS_TTS_GAIN,
    presageApiKey: undefined,
    quietMeasurementMs: c.CALL_QUIET_MEASUREMENT_MS,
    maxMinutes: c.CALL_MAX_MINUTES,
    vitalsMinConfidence: c.VITALS_MIN_CONFIDENCE,
    maxFrameGapMs: c.VITALS_MAX_FRAME_GAP_MS,
  };
  Object.defineProperty(calls, "elevenLabsApiKey", { value: ELEVENLABS_API_KEY?.trim() || undefined, enumerable: false });
  Object.defineProperty(calls, "presageApiKey", { value: PRESAGE_API_KEY?.trim() || undefined, enumerable: false });

  return {
    finchnode: { baseUrl: c.FINCHNODE_BASE_URL, apiKey: c.FINCHNODE_API_KEY },
    relay,
    patient: {
      finchnodeSubject: c.PATIENT_FINCHNODE_SUBJECT.trim(),
      relayHandle: c.PATIENT_RELAY_HANDLE ? normalizeHandle(c.PATIENT_RELAY_HANDLE) || undefined : undefined,
      familyHandles: parseHandles(c.FAMILY_RELAY_HANDLES),
      timezone: validTimezone(c.PATIENT_TIMEZONE.trim()),
    },
    llm,
    calls,
    port: c.PORT,
    databasePath: c.DATABASE_PATH,
    checkinTime: c.CHECKIN_TIME,
    missedCheckinTime: c.MISSED_CHECKIN_TIME,
    clockDate: c.CLOCK_DATE,
    meds: {
      morningTime: c.MEDS_MORNING_TIME,
      eveningTime: c.MEDS_EVENING_TIME,
      nudgeMinutes: c.MEDS_NUDGE_MINUTES,
      refillRemindDays: c.REFILL_REMIND_DAYS,
    },
  };
}

/**
 * A Relay handle as the API uses it: trimmed, without leading "@"s (the SDK
 * docs and payloads use bare handles such as `harriet`), lower case. The one
 * normalizer: config, the database, the inbox and the call service all use it,
 * and sameHandle in src/relay/relay-client.ts compares handles with it. A real
 * handle never starts with "@" or a space, so "@@harriet" and "@ harriet"
 * (typing slips) are still `harriet`.
 */
export function normalizeHandle(handle: string): string {
  return handle.trim().replace(/^@+/, "").trim().toLowerCase();
}

/** Comma separated handles: trimmed, "@" stripped, empty entries and repeats dropped. */
export function parseHandles(value: string | undefined): string[] {
  if (!value) return [];
  const seen = new Set<string>();
  for (const part of value.split(",")) {
    const handle = normalizeHandle(part);
    if (handle) seen.add(handle);
  }
  return [...seen];
}

/**
 * ELEVENLABS_STT_LANGUAGE: "en" when unset. Unlike the other settings an empty value means something,
 * no language code, so ElevenLabs detects the language itself (it once took English for Chinese), which is
 * why this is read from the raw environment, where an empty value is still empty.
 */
function sttLanguageCode(value: string | undefined): string | undefined {
  if (value === undefined) return "en";
  const code = value.trim().toLowerCase();
  if (code === "") return undefined;
  if (!/^[a-z]{2,3}$/.test(code)) throw new ConfigError("ELEVENLABS_STT_LANGUAGE: use an ISO language code such as en (empty means auto-detect)");
  return code;
}

/** Comma separated values, trimmed, blanks and repeats dropped; undefined when nothing is left. */
function parseList(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const items = [...new Set(value.split(",").map((part) => part.trim()).filter(Boolean))];
  return items.length > 0 ? items : undefined;
}

/** The IANA zone, or a ConfigError if Intl doesn't know it. */
export function validTimezone(timezone: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: timezone }).resolvedOptions().timeZone;
  } catch {
    throw new ConfigError(`PATIENT_TIMEZONE: "${timezone}" is not a time zone Intl knows (try America/Detroit)`);
  }
}

/**
 * RELAY_API_URL must be an origin; the SDK appends /v1 itself, so a path is a mistake. HTTPS, HTTP
 * only on localhost, no credentials (the Relay docs' rules). createRelayClient checks with this too.
 */
export function relayOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new ConfigError(`RELAY_API_URL: not a URL (expected an origin like ${DEFAULT_RELAY_API_URL})`);
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
    throw new ConfigError(`RELAY_API_URL: must use HTTPS (HTTP only on localhost), like ${DEFAULT_RELAY_API_URL}`);
  if (url.username || url.password) throw new ConfigError("RELAY_API_URL: must not contain credentials");
  if (url.pathname.replace(/\/+$/, "") !== "" || url.search || url.hash)
    throw new ConfigError(`RELAY_API_URL: use the origin only, like ${DEFAULT_RELAY_API_URL} (the SDK adds /v1)`);
  return url.origin;
}

/**
 * The check-in date rules reason about: the demo clock if set, else the snapshot's
 * data as-of date, else today. Nothing else should read the system clock for rules.
 */
export function resolveCheckinDate(clockDate: string | undefined, dataAsOf: string | undefined, now = new Date()): string {
  return clockDate ?? dataAsOf ?? now.toISOString().slice(0, 10);
}
