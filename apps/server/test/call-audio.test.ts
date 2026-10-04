import { afterEach, describe, expect, it, vi } from "vitest";
import { ElevenLabsRealtimeStt, ElevenLabsTts, TTS_FRAME_SAMPLES, isBargeIn, relayAudioToStt, softLimit } from "../src/calls/audio.ts";

class FakeWebSocket {
  static latest: FakeWebSocket | undefined;
  /** Like Scribe: the socket opens, then the session starts. A test sets this false to hold the session back. */
  static sessionStarts = true;
  readonly url: string;
  readonly options: unknown;
  readyState = 0;
  sent: string[] = [];
  listeners = new Map<string, ((...args: any[]) => void)[]>();
  constructor(url: string, options?: unknown) {
    this.url = url;
    this.options = options;
    FakeWebSocket.latest = this;
    queueMicrotask(() => {
      this.readyState = 1;
      this.emit("open");
      if (FakeWebSocket.sessionStarts) this.emit("message", Buffer.from(JSON.stringify({ message_type: "session_started" })));
    });
  }
  on(event: string, fn: (...args: any[]) => void): void { this.listeners.set(event, [...(this.listeners.get(event) ?? []), fn]); }
  send(data: string): void { this.sent.push(data); }
  close(...args: unknown[]): void { this.readyState = 3; this.emit("close", ...args); }
  emit(event: string, ...args: any[]): void { for (const fn of this.listeners.get(event) ?? []) fn(...args); }
}

describe("call audio adapters", () => {
  it("downmixes stereo to mono and passes Relay's 48 kHz through untouched", () => {
    expect([...relayAudioToStt({ samples: new Int16Array([100, 300, -100, 100]), sampleRate: 48_000, channelCount: 2 })]).toEqual([200, 0]);
    const mono = Int16Array.from([5, -7, 32767, -32768, 0]);
    expect([...relayAudioToStt({ samples: mono, sampleRate: 48_000, channelCount: 1 })]).toEqual([...mono]); // no resampling, no filtering
  });

  it("brings a frame at another rate up to 48 kHz by linear interpolation (a fallback: Relay delivers 48 kHz)", () => {
    expect([...relayAudioToStt({ samples: new Int16Array([0, 100, 200]), sampleRate: 24_000, channelCount: 1 })]).toEqual([0, 50, 100, 150, 200, 200]);
    expect(relayAudioToStt({ samples: new Int16Array(160), sampleRate: 16_000, channelCount: 1 })).toHaveLength(480);
  });

  it("rejects invalid sample rates and unsupported channel counts", () => {
    expect(() => relayAudioToStt({ samples: new Int16Array([1]), sampleRate: 0, channelCount: 1 })).toThrow(/sample rate/);
    expect(() => relayAudioToStt({ samples: new Int16Array([1]), sampleRate: 16_000, channelCount: 3 })).toThrow(/channel count/);
  });

  it("sends audio chunks to realtime STT but only emits committed transcript turns", async () => {
    const stt = new ElevenLabsRealtimeStt({ apiKey: "test", webSocket: FakeWebSocket as never });
    const partial = vi.fn();
    const committed = vi.fn();
    stt.onPartial(partial).onCommitted(committed);
    await stt.connect();
    stt.send(new Int16Array([1, -1]));
    const frame = JSON.parse(FakeWebSocket.latest!.sent[0]!);
    expect(frame.message_type).toBe("input_audio_chunk");
    FakeWebSocket.latest!.emit("message", Buffer.from(JSON.stringify({ message_type: "partial_transcript", text: "hello" })));
    FakeWebSocket.latest!.emit("message", Buffer.from(JSON.stringify({ message_type: "committed_transcript", text: " Hello there " })));
    await vi.waitFor(() => expect(committed).toHaveBeenCalledWith("Hello there"));
    expect(partial).toHaveBeenCalledWith("hello");
    stt.close();
  });

  it("asks for 48 kHz audio and a 0.7 s speech wait unless told otherwise, and for her language only when it is set", async () => {
    const query = async (options: { vadSilenceSecs?: number; languageCode?: string } = {}) => {
      const stt = new ElevenLabsRealtimeStt({ apiKey: "test", webSocket: FakeWebSocket as never, ...options });
      await stt.connect();
      stt.close();
      return new URL(FakeWebSocket.latest!.url).searchParams;
    };
    expect((await query()).get("vad_silence_threshold_secs")).toBe("0.7");
    expect((await query({ vadSilenceSecs: 1.2 })).get("vad_silence_threshold_secs")).toBe("1.2");
    expect((await query()).get("commit_strategy")).toBe("vad");
    expect((await query()).get("audio_format")).toBe("pcm_48000"); // what relayAudioToStt produces
    expect((await query({ languageCode: "en" })).get("language_code")).toBe("en");
    expect((await query()).has("language_code")).toBe(false); // left out: ElevenLabs detects the language
  });

  it("streams generated mono PCM into Relay and clears speaking state on HTTP failure", async () => {
    const audio = new Int16Array([100, -100]);
    const bytes = new Uint8Array(audio.buffer.slice(0));
    const relay = {
      writeAudio: vi.fn(async () => {}),
      clearAudio: vi.fn(),
      waitForPlayout: vi.fn(async () => {}),
    };
    const tts = new ElevenLabsTts(relay as never, {
      apiKey: "test",
      voiceId: "voice-id",
      fetch: vi.fn(async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }))),
    });
    await tts.speak("A careful response.");
    expect(relay.writeAudio).toHaveBeenCalledWith({ samples: expect.any(Int16Array), sampleRate: 48_000, channelCount: 1 });
    expect(relay.waitForPlayout).toHaveBeenCalledOnce();
    expect(tts.isSpeaking).toBe(false);

    const failed = new ElevenLabsTts(relay as never, { apiKey: "test", voiceId: "voice-id", fetch: vi.fn(async () => new Response(null, { status: 401 })) });
    await expect(failed.speak("hello")).rejects.toThrow(/HTTP 401/);
    expect(failed.isSpeaking).toBe(false);
  });

  it("hands the transport whole 20 ms frames, because it pads every write to whole 10 ms slices with silence", async () => {
    // ElevenLabs delivered a greeting as about 370 pieces of 4 to 14 ms. Written one by one, each piece gained a gap of
    // silence; re-framed, only the final write may be partial.
    const written: Int16Array[] = [];
    const relay = { writeAudio: vi.fn(async (frame: { samples: Int16Array }) => { written.push(Int16Array.from(frame.samples)); }), clearAudio: vi.fn(), waitForPlayout: vi.fn(async () => {}) };
    const pieceSizes = [215, 672, 672, 1, 480, 479, 700, 33, 960, 960, 1500, 7]; // in samples, none a whole frame
    const all = Int16Array.from({ length: pieceSizes.reduce((a, b) => a + b, 0) }, (_, i) => (i % 2000) - 1000);
    let offset = 0;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const size of pieceSizes) {
          controller.enqueue(new Uint8Array(all.slice(offset, offset + size).buffer));
          offset += size;
        }
        controller.close();
      },
    });
    const tts = new ElevenLabsTts(relay as never, { apiKey: "test", voiceId: "voice-id", fetch: vi.fn(async () => new Response(body)) });
    await tts.speak("A fixed greeting.");
    expect(written.length).toBeGreaterThan(1);
    for (const frame of written.slice(0, -1)) expect(frame.length % TTS_FRAME_SAMPLES).toBe(0);
    expect(written.slice(0, -1).every((frame) => frame.length >= TTS_FRAME_SAMPLES)).toBe(true);
    const last = written.at(-1)!;
    expect(last.length).toBeLessThan(TTS_FRAME_SAMPLES * 2); // only the tail is partial
    expect(Int16Array.from(written.flatMap((frame) => [...frame]))).toEqual(all); // every sample, in order, none added
    expect(relay.waitForPlayout).toHaveBeenCalledOnce();
  });

  it("does not write the partial tail of an utterance that was cancelled", async () => {
    const relay = { writeAudio: vi.fn(async (_frame: { samples: Int16Array }) => {}), clearAudio: vi.fn(), waitForPlayout: vi.fn(async () => {}) };
    let release!: () => void;
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(new Uint8Array(new Int16Array(500).buffer)); // less than one frame: held back
        await new Promise<void>((resolve) => { release = resolve; });
        controller.close();
      },
    });
    const tts = new ElevenLabsTts(relay as never, { apiKey: "test", voiceId: "voice-id", fetch: vi.fn(async () => new Response(body)) });
    const speaking = tts.speak("This is interrupted.");
    await new Promise((resolve) => setTimeout(resolve, 10));
    tts.cancel();
    release();
    await speaking;
    expect(relay.writeAudio).not.toHaveBeenCalled();
    expect(relay.waitForPlayout).not.toHaveBeenCalled();
  });

  it("writes nothing after it was cancelled, even for a chunk whose read was still pending", async () => {
    const relay = { writeAudio: vi.fn(async (_frame: { samples: Int16Array }) => {}), clearAudio: vi.fn(), waitForPlayout: vi.fn(async () => {}) };
    type Read = { done: boolean; value?: Uint8Array };
    let deliver!: (result: Read) => void;
    const reader = {
      read: vi.fn(() => new Promise<Read>((resolve) => { deliver = resolve; })),
      cancel: vi.fn(async () => {}), // like a stream that does not release a read already under way
      releaseLock: vi.fn(),
    };
    const response = { ok: true, status: 200, body: { getReader: () => reader, cancel: vi.fn(async () => {}) } } as unknown as Response;
    const tts = new ElevenLabsTts(relay as never, { apiKey: "test", voiceId: "voice-id", fetch: vi.fn(async () => response) });
    const speaking = tts.speak("This response is interrupted.");
    await vi.waitFor(() => expect(reader.read).toHaveBeenCalledOnce()); // read() is pending
    tts.cancel(); // she interrupts
    deliver({ done: false, value: new Uint8Array(Int16Array.from([1000, -1000]).buffer.slice(0)) }); // and then the chunk arrives
    await expect(speaking).resolves.toBeUndefined();
    expect(relay.writeAudio).not.toHaveBeenCalled();
    expect(relay.waitForPlayout).not.toHaveBeenCalled();
    expect(reader.releaseLock).toHaveBeenCalled();
    expect(tts.isSpeaking).toBe(false);
  });

  it("treats a barge-in cancellation as a normal interruption", async () => {
    const relay = { writeAudio: vi.fn(async () => {}), clearAudio: vi.fn(), waitForPlayout: vi.fn(async () => {}) };
    const tts = new ElevenLabsTts(relay as never, {
      apiKey: "test",
      voiceId: "voice-id",
      fetch: vi.fn(async () => new Response(new ReadableStream({ pull() {} }))),
    });
    const speaking = tts.speak("This response should be interrupted.");
    await vi.waitFor(() => expect(tts.isSpeaking).toBe(true));
    tts.cancel();
    await expect(speaking).resolves.toBeUndefined();
    expect(relay.clearAudio).toHaveBeenCalled();
    expect(tts.isSpeaking).toBe(false);
  });
});

describe("voice gain (soft limiter)", () => {
  const EDGES = Int16Array.from([-32768, -32767, -20000, -1000, -1, 0, 1, 1000, 20000, 32766, 32767]); // ascending
  const rmsDb = (samples: Int16Array) => 10 * Math.log10(samples.reduce((sum, x) => sum + (x / 32768) ** 2, 0) / samples.length);

  it("gain 1 leaves the samples untouched", () => {
    expect([...softLimit(EDGES, 1)]).toEqual([...EDGES]);
  });

  it("never leaves the int16 range: the loudest samples stay at the edges instead of wrapping around", () => {
    for (const gain of [1.1, 1.6, 2.5, 4]) {
      const out = softLimit(EDGES, gain);
      expect(out[0]).toBe(-32768);
      expect(out.at(-1)).toBe(32767); // rounding to 32768 would wrap to -32768
      for (let i = 0; i < EDGES.length; i += 1) {
        expect(Math.sign(out[i]!)).toBe(Math.sign(EDGES[i]!)); // a wrap flips the sign
        if (i > 0) expect(out[i]!).toBeGreaterThanOrEqual(out[i - 1]!); // and a louder input is never quieter
      }
    }
  });

  it("boosts quiet samples and rounds the peaks, the same for both signs", () => {
    const out = softLimit(Int16Array.from([1000, -1000, 3000, 30000]), 1.6);
    expect(out[0]).toBeGreaterThan(1000 * 1.6);
    expect(out[0]).toBeLessThan(1000 * 1.9);
    expect(out[1]).toBe(-out[0]!);
    expect(out[2]).toBeGreaterThan(3000);
    expect(out[3]! / 30000).toBeLessThan(out[0]! / 1000); // a much smaller lift, relatively, near full scale
    expect(out[3]).toBeLessThanOrEqual(32767);
  });

  it("lifts a voice sitting around -20 dBFS by about 4 dB", () => {
    const voice = Int16Array.from({ length: 4800 }, (_, i) => Math.round(0.1 * 32768 * Math.sin((2 * Math.PI * 440 * i) / 48_000)));
    const lift = rmsDb(softLimit(voice, 1.6)) - rmsDb(voice);
    expect(lift).toBeGreaterThan(3.5);
    expect(lift).toBeLessThan(5.5);
  });

  it("keeps silence silent", () => {
    expect([...softLimit(new Int16Array(480), 1.6)]).toEqual(new Array(480).fill(0));
    expect(softLimit(new Int16Array(0), 1.6)).toHaveLength(0);
  });

  it("is applied to the voice just before it goes into Relay, and not at all at gain 1", async () => {
    const speakWith = async (gain?: number) => {
      const relay = { writeAudio: vi.fn(async (_frame: { samples: Int16Array }) => {}), clearAudio: vi.fn(), waitForPlayout: vi.fn(async () => {}) };
      const bytes = new Uint8Array(Int16Array.from([1000, -1000]).buffer.slice(0));
      const tts = new ElevenLabsTts(relay as never, {
        apiKey: "test",
        voiceId: "voice-id",
        ...(gain === undefined ? {} : { gain }),
        fetch: vi.fn(async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }))),
      });
      await tts.speak("A careful response.");
      return [...relay.writeAudio.mock.calls[0]![0].samples];
    };
    expect(await speakWith()).toEqual([1000, -1000]);
    expect(await speakWith(1)).toEqual([1000, -1000]);
    const boosted = await speakWith(1.6);
    expect(boosted[0]).toBeGreaterThan(1600);
    expect(boosted[1]).toBe(-boosted[0]!);
  });
});

describe("her talking over the assistant", () => {
  it("needs two real words: a cough, noise, a lone hello or punctuation does not count", () => {
    for (const noise of ["", "   ", "hello", "Hello?", "yes.", "(coughs)", "[noise]", "(coughs) hello", "[laughter] yes", "(laughs softly", "...", "- -"]) expect(isBargeIn(noise), noise).toBe(false);
    for (const speech of ["wait a moment", "no thanks", "Hello, can you hear me", "(coughs) wait a moment", "[noise] yes please", "ok then", "I do not"]) expect(isBargeIn(speech), speech).toBe(true);
  });
});

describe("realtime STT session", () => {
  const event = (messageType: string, extra: Record<string, unknown> = {}) => Buffer.from(JSON.stringify({ message_type: messageType, ...extra }));
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  const connected = async (options: { log?: (event: string, fields?: Record<string, unknown>) => void } = {}) => {
    const stt = new ElevenLabsRealtimeStt({ apiKey: "test", webSocket: FakeWebSocket as never, ...options });
    const onClose = vi.fn();
    stt.onClose(onClose);
    await stt.connect();
    return { stt, onClose, socket: FakeWebSocket.latest! };
  };
  afterEach(() => {
    FakeWebSocket.sessionStarts = true;
    vi.useRealTimers();
  });

  it("is ready only once Scribe sends session_started, not when the socket opens, and takes no audio before", async () => {
    FakeWebSocket.sessionStarts = false;
    const stt = new ElevenLabsRealtimeStt({ apiKey: "test", webSocket: FakeWebSocket as never });
    let ready = false;
    const connecting = stt.connect().then(() => { ready = true; });
    await tick();
    expect(FakeWebSocket.latest!.readyState).toBe(1); // the socket is open
    expect(ready).toBe(false);
    stt.send(new Int16Array([1, -1]));
    expect(FakeWebSocket.latest!.sent).toEqual([]);
    FakeWebSocket.latest!.emit("message", event("session_started", { session_id: "s1" }));
    await connecting;
    expect(ready).toBe(true);
    stt.send(new Int16Array([1, -1]));
    expect(FakeWebSocket.latest!.sent).toHaveLength(1);
    stt.close();
  });

  it("gives up after 10 seconds if the session never starts", async () => {
    vi.useFakeTimers();
    FakeWebSocket.sessionStarts = false;
    const stt = new ElevenLabsRealtimeStt({ apiKey: "test", webSocket: FakeWebSocket as never });
    const failure = expect(stt.connect()).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(9_999);
    await vi.advanceTimersByTimeAsync(2);
    await failure;
  });

  it("a closure after it connected calls onClose once, and the dead session is sent nothing; our own close() does not call it", async () => {
    const lost = await connected();
    lost.socket.emit("close", 1006);
    lost.socket.emit("close", 1006); // a repeat changes nothing
    expect(lost.onClose).toHaveBeenCalledOnce();
    expect(lost.onClose).toHaveBeenCalledWith("closed");
    lost.stt.send(new Int16Array([1, -1]));
    expect(lost.socket.sent).toEqual([]);

    const ours = await connected();
    ours.stt.close(); // the socket reports its close, as ws does
    expect(ours.onClose).not.toHaveBeenCalled();
    await tick();
    expect(ours.onClose).not.toHaveBeenCalled();
  });

  it("a fatal event calls onClose once with its type only, and what it says is never logged", async () => {
    for (const type of ["error", "auth_error", "quota_exceeded", "rate_limited", "unaccepted_terms", "commit_throttled", "queue_overflow", "session_time_limit_exceeded", "input_error", "chunk_size_exceeded", "transcriber_error"]) {
      const log = vi.fn();
      const { onClose, socket } = await connected({ log });
      socket.emit("message", event(type, { message: "secret detail about the account", error: "secret detail about the account" }));
      expect(onClose, type).toHaveBeenCalledOnce();
      expect(onClose, type).toHaveBeenCalledWith(type);
      expect(log, type).toHaveBeenCalledWith("elevenlabs_stt_error", { message_type: type });
      expect(JSON.stringify(log.mock.calls), type).not.toContain("secret detail");
    }
  });

  it("transcripts, warnings and a repeated session_started are not fatal", async () => {
    const { onClose, socket } = await connected();
    for (const type of ["partial_transcript", "committed_transcript", "warning", "session_started", "insufficient_audio_activity"]) socket.emit("message", event(type, { text: "hello" }));
    await tick();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("a fatal event before the session started fails connect at once and names only its type; onClose is for live sessions", async () => {
    FakeWebSocket.sessionStarts = false;
    const stt = new ElevenLabsRealtimeStt({ apiKey: "test", webSocket: FakeWebSocket as never });
    const onClose = vi.fn();
    stt.onClose(onClose);
    const failure = expect(stt.connect()).rejects.toThrow("ElevenLabs STT reported auth_error");
    await tick();
    FakeWebSocket.latest!.emit("message", event("auth_error", { message: "bad key sk-secret" }));
    await failure;
    expect(onClose).not.toHaveBeenCalled();
  });

  it("a socket that closes before the session started still fails connect, as before", async () => {
    FakeWebSocket.sessionStarts = false;
    const stt = new ElevenLabsRealtimeStt({ apiKey: "test", webSocket: FakeWebSocket as never });
    const failure = expect(stt.connect()).rejects.toThrow(/closed before it was ready/);
    await tick();
    FakeWebSocket.latest!.emit("close", 1006);
    await failure;
  });
});
