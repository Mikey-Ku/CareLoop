import { ElevenLabsRealtimeStt, softLimit, type RealtimeSttOptions } from "../calls/audio.ts";
import type { CallsConfig, Config } from "../config.ts";

// `npm run voice:check`: does ElevenLabs work end to end with this .env? The key, the voice, a spoken sample
// and the realtime listening, one line each, [ok] or [fail]. It never prints a key, a response body or a
// header, and it spends about as many characters of speech as SAMPLE has.

export type VoiceCheckDeps = {
  fetch?: typeof fetch;
  webSocket?: RealtimeSttOptions["webSocket"];
  /** Milliseconds; tests replace the clock. */
  now?: () => number;
  /** The time one HTTP exchange may take, and the wait for the realtime session to start. */
  requestMs?: number;
  listenMs?: number;
};
export type VoiceCheckResult = { lines: string[]; exitCode: number };
type Step = { ok: boolean; text: string };
type Run = { apiKey: string; voiceId: string; calls: CallsConfig; fetch: typeof fetch; now: () => number; requestMs: number };

const API = "https://api.elevenlabs.io/v1";
const SAMPLE = "Hello.";
const TIMED_OUT = new Error("timed out");

/** Run every step. Never throws; a failure becomes a line. A key that fails stops the rest, which could not pass either. */
export async function checkVoice(config: Config, deps: VoiceCheckDeps = {}): Promise<VoiceCheckResult> {
  const { elevenLabsApiKey: apiKey, elevenLabsVoiceId: voiceId } = config.calls;
  const lines: string[] = [];
  let failed = false;
  const add = (step: Step) => {
    lines.push(`${step.ok ? "[ok]" : "[fail]"} ${step.text}`);
    failed ||= !step.ok;
    return step.ok;
  };
  const result = () => ({ lines, exitCode: failed ? 1 : 0 });

  if (!apiKey || !voiceId) {
    const unset = [apiKey ? "" : "ELEVENLABS_API_KEY", voiceId ? "" : "ELEVENLABS_VOICE_ID"].filter(Boolean);
    add({ ok: false, text: `key: set ${unset.join(" and ")} in the repo-root .env; no request was sent` });
    return result();
  }
  lines.push(`This check spends about ${SAMPLE.length} characters of speech.`);
  const run: Run = { apiKey, voiceId, calls: config.calls, fetch: deps.fetch ?? fetch, now: deps.now ?? (() => performance.now()), requestMs: deps.requestMs ?? 15_000 };
  if (!add(await checkKey(run))) return result();
  add(await checkVoiceId(run));
  add(await checkSpeech(run));
  add(await checkListening(run, deps.webSocket, deps.listenMs ?? 8_000));
  return result();
}

async function checkKey(run: Run): Promise<Step> {
  try {
    const { ok, status, data } = await get(run, "/user");
    if (ok) {
      const { tier, character_count: used, character_limit: limit } = record(data.subscription);
      const plan = tidy(tier);
      return { ok: true, text: `key: accepted${plan ? `, plan ${plan}` : ""}${Number.isFinite(used) && Number.isFinite(limit) ? `, ${used} of ${limit} characters used` : ""}` };
    }
    if (status !== 401) return { ok: false, text: `key: ElevenLabs answered HTTP ${status}` };
    return limited(data)
      ? { ok: true, text: "key: accepted, but it is limited to some features, so the plan is not shown" }
      : { ok: false, text: "key: ElevenLabs rejected ELEVENLABS_API_KEY (HTTP 401); copy the key into the repo-root .env again" };
  } catch (error) {
    return { ok: false, text: `key: ${trouble(error)}` };
  }
}

async function checkVoiceId(run: Run): Promise<Step> {
  try {
    const { ok, status, data } = await get(run, `/voices/${encodeURIComponent(run.voiceId)}`);
    if (ok) {
      const category = tidy(data.category);
      return { ok: true, text: `voice: ${tidy(data.name) || "found"}${category ? ` (${category})` : ""}` };
    }
    if (status === 404) return { ok: false, text: "voice: no voice has that ELEVENLABS_VOICE_ID; copy the id from the voice library again" };
    if (status === 401 && limited(data)) return { ok: true, text: "voice: not checked, the key may not read voices; the speech step below tries it" };
    return { ok: false, text: `voice: ElevenLabs answered HTTP ${status}` };
  } catch (error) {
    return { ok: false, text: `voice: ${trouble(error)}` };
  }
}

/** The same request a call makes (ElevenLabsTts.speak), for the sample instead of her reply. */
async function checkSpeech(run: Run): Promise<Step> {
  const { elevenLabsTtsModel: model, elevenLabsTtsOutputFormat: format, elevenLabsTtsGain: gain } = run.calls;
  try {
    return await within(run.requestMs, async (signal) => {
      const started = run.now();
      const response = await run.fetch(`${API}/text-to-speech/${encodeURIComponent(run.voiceId)}/stream?output_format=${encodeURIComponent(format)}`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "audio/pcm", "xi-api-key": run.apiKey },
        body: JSON.stringify({ text: SAMPLE, model_id: model }),
        signal,
      });
      if (!response.ok) return { ok: false, text: speechProblem(response.status, limited(await read(response)), model, format) };
      if (!response.body) return { ok: false, text: "speech: HTTP 200 but no audio arrived" };
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let firstMs: number | undefined;
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        if (next.value.byteLength === 0) continue;
        firstMs ??= run.now() - started;
        chunks.push(next.value);
      }
      const bytes = new Uint8Array(Buffer.concat(chunks)); // a copy, so the samples start at an even offset
      const pcm = new Int16Array(bytes.buffer, 0, Math.floor(bytes.byteLength / 2));
      if (firstMs === undefined || pcm.length === 0) return { ok: false, text: "speech: HTTP 200 but no audio arrived" };
      return { ok: true, text: `speech: first audio in ${Math.round(firstMs)} ms; loudness ${dbfs(pcm)} raw, ${dbfs(softLimit(pcm, gain))} after the soft limiter (gain ${gain})` };
    });
  } catch (error) {
    return { ok: false, text: `speech: ${trouble(error)}` };
  }
}

function speechProblem(status: number, limitedKey: boolean, model: string, format: string): string {
  if (status === 402 || status === 403) return `speech: this voice or output format (${format}) needs a paid ElevenLabs plan; a premade voice would work, so set ELEVENLABS_VOICE_ID to one`;
  if (status === 401) return limitedKey ? "speech: the key is not allowed to use text to speech; allow it in the key's settings" : "speech: ElevenLabs rejected the key (HTTP 401)";
  if (status === 404) return "speech: no voice has that ELEVENLABS_VOICE_ID";
  if (status === 400 || status === 422) return `speech: ElevenLabs refused the request (HTTP ${status}); check ELEVENLABS_TTS_MODEL (${model})`;
  if (status === 429) return "speech: rate limited (HTTP 429); wait a minute and run it again";
  return `speech: ElevenLabs answered HTTP ${status}`;
}

/** Opens the realtime speech-to-text session the way a call does (ElevenLabsRealtimeStt) and closes it again. */
async function checkListening(run: Run, webSocket: VoiceCheckDeps["webSocket"], listenMs: number): Promise<Step> {
  const { elevenLabsSttModel: model, elevenLabsSttLanguage: language, elevenLabsSttVadSilenceSecs: vadSilenceSecs } = run.calls;
  const stt = new ElevenLabsRealtimeStt({ apiKey: run.apiKey, modelId: model, ...(language ? { languageCode: language } : {}), vadSilenceSecs, ...(webSocket ? { webSocket } : {}) });
  const started = run.now();
  const connected = stt.connect();
  connected.catch(() => {}); // after the wait below gives up, a late failure is not news
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([connected, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(TIMED_OUT), listenMs); })]);
    return { ok: true, text: `listening: realtime speech to text started in ${Math.round(run.now() - started)} ms (${model}, ${language ?? "language auto-detect"})` };
  } catch (error) {
    return { ok: false, text: `listening: ${listenProblem(error, listenMs)}` };
  } finally {
    clearTimeout(timer);
    stt.close();
  }
}

function listenProblem(error: unknown, listenMs: number): string {
  if (error === TIMED_OUT) return `no session started within ${listenMs / 1000} s`;
  const message = error instanceof Error ? error.message : "";
  const status = /Unexpected server response: (\d{3})/.exec(message)?.[1];
  if (status === "401" || status === "403") return `ElevenLabs refused the connection (HTTP ${status}); the key may not be allowed speech to text`;
  if (status) return `ElevenLabs answered HTTP ${status}`;
  // Our own messages (ElevenLabsRealtimeStt) only; whatever else the socket says could carry anything.
  return /^ElevenLabs STT [\w ]{1,80}$/.test(message) ? message.replace("ElevenLabs STT ", "") : "could not open the realtime connection";
}

/** One JSON GET with the whole exchange under the time limit. */
function get(run: Run, path: string): Promise<{ ok: boolean; status: number; data: Record<string, unknown> }> {
  return within(run.requestMs, async (signal) => {
    const response = await run.fetch(`${API}${path}`, { headers: { "xi-api-key": run.apiKey }, signal });
    return { ok: response.ok, status: response.status, data: await read(response) };
  });
}

async function within<T>(ms: number, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await work(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

async function read(response: Response): Promise<Record<string, unknown>> {
  try {
    return record(await response.json());
  } catch {
    return {};
  }
}

const record = (value: unknown): Record<string, unknown> => (typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {});

/** A key limited to some features gets 401 "missing_permissions" for the others: the key is good, just not allowed there. */
const limited = (data: Record<string, unknown>): boolean => record(data.detail).status === "missing_permissions";

/** A name, plan or category from a response, cut down to plain words before it is printed. */
const tidy = (value: unknown): string => (typeof value === "string" ? value.replace(/[^\p{L}\p{N} ._&()'-]/gu, "").trim().slice(0, 60) : "");

/** Why a request failed, without the error's own text: a bad header value can carry the key. */
function trouble(error: unknown): string {
  if ((error as { name?: unknown } | null)?.name === "AbortError") return "no answer in time";
  const code = (error as { cause?: { code?: unknown } } | null)?.cause?.code;
  return `could not reach ElevenLabs${typeof code === "string" && /^[A-Z0-9_]{3,30}$/.test(code) ? ` (${code})` : ""}`;
}

/** Loudness as RMS in dBFS (0 is full scale). */
function dbfs(samples: Int16Array): string {
  let squares = 0;
  for (const sample of samples) squares += sample * sample;
  const rms = Math.sqrt(squares / samples.length) / 32_768;
  return rms > 0 ? `${(20 * Math.log10(rms)).toFixed(1)} dBFS` : "silent";
}
