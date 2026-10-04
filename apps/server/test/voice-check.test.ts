import { describe, expect, it, vi } from "vitest";
import { ElevenLabsTts } from "../src/calls/audio.ts";
import { loadConfig } from "../src/config.ts";
import { main } from "../src/cli/voice-check.ts";
import { checkVoice } from "../src/demo/voice-check.ts";

const KEY = "synthetic-voice-secret";
const configured = { ELEVENLABS_API_KEY: KEY, ELEVENLABS_VOICE_ID: "synthetic voice/id" };
const config = (env: Record<string, string> = {}) => loadConfig({ ...configured, ...env });

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const pcm = (...samples: number[]) => new Uint8Array(Int16Array.from(samples).buffer);
const audio = (...chunks: Uint8Array[]) => new Response(new ReadableStream({ start(c) { for (const chunk of chunks) c.enqueue(chunk); c.close(); } }));
const LOUD = pcm(...Array<number>(480).fill(16_384)); // half of full scale: -6.0 dBFS
const good = {
  user: () => json({ subscription: { tier: "starter", character_count: 1200, character_limit: 30_000, secret: KEY } }),
  voice: () => json({ name: "Rachel", category: "premade", voice_id: "synthetic voice/id" }),
  speech: () => audio(LOUD),
};
/** Answers each ElevenLabs endpoint from `routes` and remembers the requests. */
function fakeFetch(routes: Partial<typeof good> = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  const answer = { ...good, ...routes };
  const impl = async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    return url.includes("/text-to-speech/") ? answer.speech() : url.includes("/voices/") ? answer.voice() : answer.user();
  };
  return { fetch: impl as typeof fetch, calls };
}

class FakeSocket {
  static all: FakeSocket[] = [];
  readyState = 0;
  closed: unknown[] | undefined;
  #listeners = new Map<string, ((...args: any[]) => void)[]>();
  readonly url: string;
  readonly options: { headers: Record<string, string> };
  constructor(url: string, options: { headers: Record<string, string> }) { this.url = url; this.options = options; FakeSocket.all.push(this); }
  on(event: string, fn: (...args: any[]) => void): void { this.#listeners.set(event, [...(this.#listeners.get(event) ?? []), fn]); }
  emit(event: string, ...args: unknown[]): void { for (const fn of this.#listeners.get(event) ?? []) fn(...args); }
  send(): void {}
  close(...args: unknown[]): void { this.closed = args; this.emit("close", 1000); }
}
/** A socket class that does `behave` once it is created: start the session, never start it, fail... */
const sockets = (behave: (socket: FakeSocket) => void) => class extends FakeSocket { constructor(url: string, options: { headers: Record<string, string> }) { super(url, options); queueMicrotask(() => behave(this)); } };
const starts = (socket: FakeSocket) => socket.emit("message", Buffer.from(JSON.stringify({ message_type: "session_started" })));
const webSocket = sockets(starts) as never;
/** Each reading of the clock is 50 ms after the last. */
const ticking = () => { let t = 0; return () => (t += 50); };
const run = (routes: Partial<typeof good> = {}, env: Record<string, string> = {}, deps: Parameters<typeof checkVoice>[1] = {}) => {
  const f = fakeFetch(routes);
  return checkVoice(config(env), { fetch: f.fetch, webSocket, now: ticking(), ...deps }).then((r) => ({ ...r, text: r.lines.join("\n"), calls: f.calls }));
};

describe("voice:check", () => {
  it("passes every step, one line each, and says what it spends", async () => {
    const r = await run();
    expect(r.exitCode).toBe(0);
    expect(r.lines).toEqual([
      "This check spends about 6 characters of speech.",
      "[ok] key: accepted, plan starter, 1200 of 30000 characters used",
      "[ok] voice: Rachel (premade)",
      "[ok] speech: first audio in 50 ms; loudness -6.0 dBFS raw, -2.8 dBFS after the soft limiter (gain 1.6)",
      "[ok] listening: realtime speech to text started in 50 ms (scribe_v2_realtime, en)",
    ]);
  });

  it("never prints the key, a response body or a header", async () => {
    const r = await run({ speech: () => json({ detail: `body-with-${KEY}` }, 500) });
    expect(r.exitCode).toBe(1);
    expect(r.text).not.toContain(KEY);
    expect(r.text).not.toContain("body-with");
    expect(r.text).not.toContain("synthetic voice");
  });

  it("sends the key as a header and encodes the voice id", async () => {
    const r = await run();
    expect(r.calls.map((c) => c.url.replace("https://api.elevenlabs.io/v1", ""))).toEqual(["/user", "/voices/synthetic%20voice%2Fid", "/text-to-speech/synthetic%20voice%2Fid/stream?output_format=pcm_48000"]);
    for (const c of r.calls) expect((c.init.headers as Record<string, string>)["xi-api-key"]).toBe(KEY);
  });

  it("asks for speech exactly as a call does", async () => {
    const spoken = fakeFetch();
    const relay = { writeAudio: async () => {}, clearAudio: () => {}, waitForPlayout: async () => {} };
    await new ElevenLabsTts(relay as never, { apiKey: KEY, voiceId: "synthetic voice/id", modelId: "eleven_flash_v2_5", outputFormat: "pcm_48000", fetch: spoken.fetch }).speak("Hello.");
    const checked = await run();
    const request = (calls: { url: string; init: RequestInit }[]) => { const c = calls.find((x) => x.url.includes("/text-to-speech/"))!; return { url: c.url, method: c.init.method, headers: c.init.headers, body: c.init.body }; };
    expect(request(checked.calls)).toEqual(request(spoken.calls));
  });

  it("measures loudness on what a call plays: raw, then after the soft limiter at the configured gain", async () => {
    expect((await run({}, { ELEVENLABS_TTS_GAIN: "1" })).text).toContain("loudness -6.0 dBFS raw, -6.0 dBFS after the soft limiter (gain 1)");
    expect((await run({}, { ELEVENLABS_TTS_GAIN: "3" })).text).toContain("-6.0 dBFS raw, -0.8 dBFS after");
    expect((await run({ speech: () => audio(pcm(0, 0)) })).text).toContain("silent raw, silent after");
  });

  it("times first audio at the first chunk, not the last", async () => {
    const times = [1000, 1400, 9000]; // started, first chunk, listening start...
    const now = () => times.shift() ?? 9999;
    const r = await run({ speech: () => audio(LOUD, LOUD) }, {}, { now });
    expect(r.text).toContain("first audio in 400 ms");
  });

  it("sets nothing up without the key or the voice id, and sends nothing", async () => {
    for (const [env, names] of [[{}, "ELEVENLABS_API_KEY and ELEVENLABS_VOICE_ID"], [{ ELEVENLABS_API_KEY: KEY }, "ELEVENLABS_VOICE_ID"], [{ ELEVENLABS_VOICE_ID: "v" }, "ELEVENLABS_API_KEY"]] as const) {
      const f = fakeFetch();
      FakeSocket.all = [];
      const r = await checkVoice(loadConfig(env), { fetch: f.fetch, webSocket });
      expect(r).toEqual({ lines: [`[fail] key: set ${names} in the repo-root .env; no request was sent`], exitCode: 1 });
      expect(f.calls).toHaveLength(0);
      expect(FakeSocket.all).toHaveLength(0);
    }
  });

  it("stops at a rejected key", async () => {
    const r = await run({ user: () => json({ detail: { status: "invalid_api_key" } }, 401) });
    expect(r.exitCode).toBe(1);
    expect(r.lines.at(-1)).toContain("[fail] key: ElevenLabs rejected ELEVENLABS_API_KEY (HTTP 401)");
    expect(r.calls).toHaveLength(1);
  });

  it("accepts a key limited to some features and carries on", async () => {
    const limited = () => json({ detail: { status: "missing_permissions" } }, 401);
    const r = await run({ user: limited, voice: limited });
    expect(r.exitCode).toBe(0);
    expect(r.text).toContain("[ok] key: accepted, but it is limited to some features");
    expect(r.text).toContain("[ok] voice: not checked");
    expect((await run({ speech: limited })).text).toContain("[fail] speech: the key is not allowed to use text to speech");
  });

  it("says when the voice id is wrong, and still tries the rest", async () => {
    const r = await run({ voice: () => json({}, 404) });
    expect(r.exitCode).toBe(1);
    expect(r.text).toContain("[fail] voice: no voice has that ELEVENLABS_VOICE_ID");
    expect(r.text).toContain("[ok] speech");
    expect(r.text).toContain("[ok] listening");
  });

  it.each([402, 403])("explains HTTP %i on speech: a paid plan, and a premade voice would work", async (status) => {
    const r = await run({ speech: () => json({}, status) });
    expect(r.exitCode).toBe(1);
    expect(r.text).toContain("[fail] speech: this voice or output format (pcm_48000) needs a paid ElevenLabs plan; a premade voice would work");
  });

  it("reports other HTTP statuses on speech, and a 200 that carries no audio", async () => {
    expect((await run({ speech: () => json({}, 429) })).text).toContain("[fail] speech: rate limited (HTTP 429)");
    expect((await run({ speech: () => json({}, 422) })).text).toContain("[fail] speech: ElevenLabs refused the request (HTTP 422); check ELEVENLABS_TTS_MODEL (eleven_flash_v2_5)");
    expect((await run({ speech: () => json({}, 503) })).text).toContain("[fail] speech: ElevenLabs answered HTTP 503");
    expect((await run({ speech: () => new Response(null) })).text).toContain("[fail] speech: HTTP 200 but no audio arrived");
    expect((await run({ speech: () => audio() })).text).toContain("[fail] speech: HTTP 200 but no audio arrived");
    expect((await run({ speech: () => audio(new Uint8Array(1)) })).text).toContain("[fail] speech: HTTP 200 but no audio arrived");
  });

  it("reports an unreachable network by its code and never by the error's own text", async () => {
    const refused = (): Response => { throw Object.assign(new TypeError(`bad header value ${KEY}`), { cause: { code: "ENOTFOUND" } }); };
    const r = await run({ user: refused });
    expect(r.lines.at(-1)).toBe("[fail] key: could not reach ElevenLabs (ENOTFOUND)");
    expect(r.text).not.toContain(KEY);
  });

  it("gives up on a request that never answers", async () => {
    const f = { fetch: ((_: string, init: RequestInit) => new Promise((_, reject) => init.signal!.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))))) as unknown as typeof fetch };
    const r = await checkVoice(config(), { ...f, requestMs: 20 });
    expect(r.lines.at(-1)).toBe("[fail] key: no answer in time");
  });

  it("opens the listening session the way a call does, then closes it cleanly", async () => {
    FakeSocket.all = [];
    await run();
    const [socket] = FakeSocket.all;
    const url = new URL(socket!.url);
    expect(`${url.origin}${url.pathname}`).toBe("wss://api.elevenlabs.io/v1/speech-to-text/realtime");
    expect(Object.fromEntries(url.searchParams)).toEqual({ model_id: "scribe_v2_realtime", audio_format: "pcm_48000", commit_strategy: "vad", vad_silence_threshold_secs: "0.7", language_code: "en" });
    expect(socket!.options.headers["xi-api-key"]).toBe(KEY);
    expect(socket!.closed?.[0]).toBe(1000);
    FakeSocket.all = [];
    await run({}, { ELEVENLABS_STT_LANGUAGE: "", ELEVENLABS_STT_VAD_SILENCE_SECS: "1.2", ELEVENLABS_STT_MODEL: "scribe_other" });
    const other = new URL(FakeSocket.all[0]!.url).searchParams;
    expect(other.has("language_code")).toBe(false);
    expect([other.get("vad_silence_threshold_secs"), other.get("model_id")]).toEqual(["1.2", "scribe_other"]);
  });

  it("fails listening when the session does not start in time, and closes the socket", async () => {
    FakeSocket.all = [];
    const r = await run({}, {}, { webSocket: sockets(() => {}) as never, listenMs: 20 });
    expect(r.exitCode).toBe(1);
    expect(r.lines.at(-1)).toBe("[fail] listening: no session started within 0.02 s");
    expect(FakeSocket.all[0]!.closed?.[0]).toBe(1000);
  });

  it("explains a refused handshake and a fatal Scribe event without repeating what the socket said", async () => {
    const refuse = (socket: FakeSocket) => socket.emit("error", new Error(`Unexpected server response: 401 for ${KEY}`));
    const r = await run({}, {}, { webSocket: sockets(refuse) as never });
    expect(r.lines.at(-1)).toBe("[fail] listening: ElevenLabs refused the connection (HTTP 401); the key may not be allowed speech to text");
    const fatal = (socket: FakeSocket) => socket.emit("message", Buffer.from(JSON.stringify({ message_type: "quota_exceeded", error: KEY })));
    const f = await run({}, {}, { webSocket: sockets(fatal) as never });
    expect(f.lines.at(-1)).toBe("[fail] listening: reported quota_exceeded");
    const weird = await run({}, {}, { webSocket: sockets((s) => s.emit("error", new Error(`boom ${KEY}`))) as never });
    expect(weird.lines.at(-1)).toBe("[fail] listening: could not open the realtime connection");
    expect(`${r.text}${f.text}${weird.text}`).not.toContain(KEY);
  });

  it("the command prints the lines and returns the exit code, and refuses a bad configuration", async () => {
    const f = fakeFetch();
    const out: string[] = [];
    expect(await main({ ...configured }, (l) => out.push(l), { fetch: f.fetch, webSocket })).toBe(0);
    expect(out[0]).toBe("Voice check (ElevenLabs, live):");
    expect(out.filter((l) => l.startsWith("[ok]"))).toHaveLength(4);
    const bad: string[] = [];
    expect(await main({ ...configured, ELEVENLABS_TTS_GAIN: "9" }, (l) => bad.push(l), { fetch: vi.fn() as never })).toBe(1);
    expect(bad.join("\n")).toContain("ELEVENLABS_TTS_GAIN");
  });
});
