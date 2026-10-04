import { describe, expect, it, vi } from "vitest";
import { ElevenLabsRealtimeStt, ElevenLabsTts, relayAudioToStt, softLimit } from "../src/calls/audio.ts";

class FakeWebSocket {
  static latest: FakeWebSocket | undefined;
  readonly url: string;
  readonly options: unknown;
  readyState = 0;
  sent: string[] = [];
  listeners = new Map<string, ((...args: any[]) => void)[]>();
  constructor(url: string, options?: unknown) {
    this.url = url;
    this.options = options;
    FakeWebSocket.latest = this;
    queueMicrotask(() => { this.readyState = 1; this.emit("open"); });
  }
  on(event: string, fn: (...args: any[]) => void): void { this.listeners.set(event, [...(this.listeners.get(event) ?? []), fn]); }
  send(data: string): void { this.sent.push(data); }
  close(...args: unknown[]): void { this.emit("close", ...args); }
  emit(event: string, ...args: any[]): void { for (const fn of this.listeners.get(event) ?? []) fn(...args); }
}

describe("call audio adapters", () => {
  it("downmixes stereo and converts Relay PCM to 16 kHz", () => {
    const downmixed = relayAudioToStt({ samples: new Int16Array([100, 300, -100, 100]), sampleRate: 16_000, channelCount: 2 });
    expect([...downmixed]).toEqual([200, 0]);
    expect([...relayAudioToStt({ samples: new Int16Array([100, 200, 300, 400]), sampleRate: 32_000, channelCount: 1 })]).toEqual([100, 300]);
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

  it("waits 0.7 s of her silence before a turn is committed, or as long as the setting says", async () => {
    const query = async (options: { vadSilenceSecs?: number } = {}) => {
      const stt = new ElevenLabsRealtimeStt({ apiKey: "test", webSocket: FakeWebSocket as never, ...options });
      await stt.connect();
      stt.close();
      return new URL(FakeWebSocket.latest!.url).searchParams;
    };
    expect((await query()).get("vad_silence_threshold_secs")).toBe("0.7");
    expect((await query({ vadSilenceSecs: 1.2 })).get("vad_silence_threshold_secs")).toBe("1.2");
    expect((await query()).get("commit_strategy")).toBe("vad");
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
