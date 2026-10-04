import { describe, expect, it, vi } from "vitest";
import { ElevenLabsRealtimeStt, ElevenLabsTts, relayAudioToStt } from "../src/calls/audio.ts";

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
