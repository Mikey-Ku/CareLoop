import type { RelayCallTransport } from "@relaymessenger/sdk/calls";
import { createRequire } from "node:module";

type WsLike = {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(type: string, listener: (...args: unknown[]) => void): void;
};
type WsConstructor = new (url: string, options?: { headers?: Record<string, string> }) => WsLike;
const require = createRequire(import.meta.url);

export type AudioLogger = (event: string, fields?: Record<string, unknown>) => void;

/** Converts Relay's interleaved PCM16 frame to mono 16 kHz for Scribe realtime. */
export function relayAudioToStt(frame: { samples: Int16Array; sampleRate: number; channelCount: number }): Int16Array {
  if (!Number.isInteger(frame.sampleRate) || frame.sampleRate <= 0) throw new Error("invalid Relay audio sample rate");
  if (!Number.isInteger(frame.channelCount) || frame.channelCount < 1 || frame.channelCount > 2) throw new Error("unsupported Relay audio channel count");
  if (frame.samples.length === 0) return new Int16Array(0);
  const channels = frame.channelCount;
  const monoLength = Math.ceil(frame.samples.length / channels);
  const mono = new Float32Array(monoLength);
  for (let i = 0; i < monoLength; i += 1) {
    let total = 0;
    let count = 0;
    for (let channel = 0; channel < channels; channel += 1) {
      const sample = frame.samples[i * channels + channel];
      if (sample !== undefined) {
        total += sample;
        count += 1;
      }
    }
    mono[i] = count === 0 ? 0 : total / count;
  }
  if (frame.sampleRate === 16_000) return floatToPcm16(mono);
  const outputLength = Math.max(1, Math.round(mono.length * 16_000 / frame.sampleRate));
  const output = new Float32Array(outputLength);
  const ratio = frame.sampleRate / 16_000;
  for (let i = 0; i < outputLength; i += 1) {
    const source = i * ratio;
    const left = Math.floor(source);
    const right = Math.min(mono.length - 1, left + 1);
    const weight = source - left;
    output[i] = (mono[left] ?? 0) * (1 - weight) + (mono[right] ?? 0) * weight;
  }
  return floatToPcm16(output);
}

function floatToPcm16(values: Float32Array): Int16Array {
  const output = new Int16Array(values.length);
  for (let i = 0; i < values.length; i += 1) output[i] = Math.max(-32768, Math.min(32767, Math.round(values[i] ?? 0)));
  return output;
}

export type RealtimeSttOptions = {
  apiKey: string;
  modelId?: string;
  languageCode?: string;
  /** ELEVENLABS_STT_VAD_SILENCE_SECS: how long she must pause before her turn is committed. Default 0.7. */
  vadSilenceSecs?: number;
  log?: AudioLogger;
  webSocket?: WsConstructor;
};

export type SttTranscriptHandler = (text: string) => void | Promise<void>;

/** ElevenLabs realtime STT adapter. Audio and transcripts stay in memory. */
export class ElevenLabsRealtimeStt {
  readonly #options: RealtimeSttOptions;
  readonly #log: AudioLogger;
  #socket: WsLike | undefined;
  #closed = false;
  #connected: Promise<void> | undefined;
  #onPartial: SttTranscriptHandler | undefined;
  #onCommitted: SttTranscriptHandler | undefined;
  #lastCommittedEventId: string | number | undefined;

  constructor(options: RealtimeSttOptions) {
    this.#options = options;
    this.#log = options.log ?? (() => {});
  }

  onPartial(handler: SttTranscriptHandler): this {
    this.#onPartial = handler;
    return this;
  }

  onCommitted(handler: SttTranscriptHandler): this {
    this.#onCommitted = handler;
    return this;
  }

  connect(): Promise<void> {
    this.#connected ??= this.#open();
    return this.#connected;
  }

  async #open(): Promise<void> {
    const WebSocketImpl = this.#options.webSocket ?? (require("ws") as WsConstructor);
    const query = new URLSearchParams({
      model_id: this.#options.modelId ?? "scribe_v2_realtime",
      audio_format: "pcm_16000",
      commit_strategy: "vad",
      vad_silence_threshold_secs: String(this.#options.vadSilenceSecs ?? 0.7),
      ...(this.#options.languageCode ? { language_code: this.#options.languageCode } : {}),
    });
    const socket = new WebSocketImpl(`wss://api.elevenlabs.io/v1/speech-to-text/realtime?${query.toString()}`, { headers: { "xi-api-key": this.#options.apiKey } });
    this.#socket = socket;
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => finish(new Error("ElevenLabs STT connection timed out")), 10_000);
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      };
      socket.on("open", () => finish());
      socket.on("error", (error) => finish(error instanceof Error ? error : new Error("ElevenLabs STT WebSocket error")));
      socket.on("close", () => finish(new Error("ElevenLabs STT WebSocket closed before connecting")));
    });
    socket.on("message", (data) => void this.#message(data));
    socket.on("close", (code) => this.#log("elevenlabs_stt_closed", { code: typeof code === "number" ? code : undefined }));
  }

  send(samples: Int16Array): void {
    if (this.#closed || !this.#socket || this.#socket.readyState !== 1 || samples.byteLength === 0) return;
    const audio = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength).toString("base64");
    this.#socket.send(JSON.stringify({ message_type: "input_audio_chunk", audio_base_64: audio }));
  }

  close(): void {
    this.#closed = true;
    this.#socket?.close(1000, "call ended");
    this.#socket = undefined;
  }

  async #message(data: unknown): Promise<void> {
    const text = typeof data === "string" ? data : data instanceof ArrayBuffer ? new TextDecoder().decode(data) : Buffer.isBuffer(data) ? data.toString("utf8") : data instanceof Uint8Array ? Buffer.from(data).toString("utf8") : "";
    if (!text) return;
    let event: { message_type?: unknown; text?: unknown; event_id?: unknown };
    try {
      event = JSON.parse(text) as { message_type?: unknown; text?: unknown; event_id?: unknown };
    } catch {
      this.#log("elevenlabs_stt_invalid_event");
      return;
    }
    if (event.message_type === "partial_transcript" && typeof event.text === "string") {
      await this.#onPartial?.(event.text);
      return;
    }
    if (event.message_type === "committed_transcript" && typeof event.text === "string") {
      const committed = event.text.trim();
      if (!committed) return;
      if ((typeof event.event_id === "string" || typeof event.event_id === "number") && event.event_id === this.#lastCommittedEventId) return;
      if (typeof event.event_id === "string" || typeof event.event_id === "number") this.#lastCommittedEventId = event.event_id;
      await this.#onCommitted?.(committed);
      return;
    }
    if (event.message_type === "rate_limited" || event.message_type === "error") this.#log("elevenlabs_stt_error", { message_type: event.message_type });
  }
}

/**
 * A soft limiter for the voice: y = tanh(g * x) / tanh(g) on samples scaled to [-1, 1]. Quiet speech is
 * raised (about 4.7 dB at g = 1.6) and loud peaks are rounded off instead of clipped, so the result never
 * leaves the int16 range. A gain of 1 (or less) returns the samples untouched.
 */
export function softLimit(samples: Int16Array, gain: number): Int16Array {
  if (!(gain > 1)) return samples;
  const scale = 32_768 / Math.tanh(gain);
  const output = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) output[i] = Math.max(-32_768, Math.min(32_767, Math.round(Math.tanh((gain * (samples[i] ?? 0)) / 32_768) * scale)));
  return output;
}

export type ElevenLabsTtsOptions = {
  apiKey: string;
  voiceId: string;
  modelId?: string;
  outputFormat?: string;
  /** ELEVENLABS_TTS_GAIN: the soft limiter's gain on the voice (softLimit). Absent or 1: untouched. */
  gain?: number;
  log?: AudioLogger;
  fetch?: typeof fetch;
};

/** Streams ElevenLabs PCM audio into RelayCallTransport without persisting audio. */
export class ElevenLabsTts {
  readonly #transport: RelayCallTransport;
  readonly #options: ElevenLabsTtsOptions;
  readonly #log: AudioLogger;
  #abort: AbortController | undefined;
  #speaking = false;

  constructor(transport: RelayCallTransport, options: ElevenLabsTtsOptions) {
    this.#transport = transport;
    this.#options = options;
    this.#log = options.log ?? (() => {});
  }

  get isSpeaking(): boolean {
    return this.#speaking;
  }

  cancel(): void {
    const active = this.#abort;
    this.#abort = undefined;
    if (active) {
      this.#speaking = false;
      active.abort();
    }
    this.#transport.clearAudio();
  }

  async speak(text: string): Promise<void> {
    const spoken = text.replace(/\s+/g, " ").trim().slice(0, 1200);
    if (!spoken) return;
    this.cancel();
    this.#speaking = true;
    const controller = new AbortController();
    this.#abort = controller;
    const fetchImpl = this.#options.fetch ?? fetch;
    const format = this.#options.outputFormat ?? "pcm_48000";
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(this.#options.voiceId)}/stream?output_format=${encodeURIComponent(format)}`;
    try {
      const response = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "audio/pcm", "xi-api-key": this.#options.apiKey },
        body: JSON.stringify({ text: spoken, model_id: this.#options.modelId ?? "eleven_flash_v2_5" }),
        signal: controller.signal,
      });
      if (!response.ok || !response.body) {
        await response.body?.cancel().catch(() => {});
        throw new Error(`ElevenLabs TTS returned HTTP ${response.status}`);
      }
      const reader = response.body.getReader();
      const cancelReader = () => void reader.cancel().catch(() => {});
      controller.signal.addEventListener("abort", cancelReader, { once: true });
      let remainder = new Uint8Array(0);
      try {
        while (!controller.signal.aborted) {
          const next = await reader.read();
          if (next.done) break;
          const bytes = concatBytes(remainder, next.value);
          const usableLength = bytes.byteLength - (bytes.byteLength % 2);
          remainder = bytes.slice(usableLength);
          if (usableLength === 0) continue;
          const samples = new Int16Array(bytes.buffer, bytes.byteOffset, usableLength / 2);
          await this.#transport.writeAudio({ samples: softLimit(samples, this.#options.gain ?? 1), sampleRate: 48_000, channelCount: 1 });
        }
        if (!controller.signal.aborted) await this.#transport.waitForPlayout();
      } finally {
        controller.signal.removeEventListener("abort", cancelReader);
        reader.releaseLock();
      }
    } catch (error) {
      if (!controller.signal.aborted) throw error;
    } finally {
      if (this.#abort === controller) {
        this.#speaking = false;
        this.#abort = undefined;
      }
    }
  }

  close(): void {
    this.cancel();
    this.#speaking = false;
    this.#log("elevenlabs_tts_closed");
  }
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.byteLength + b.byteLength);
  out.set(a, 0);
  out.set(b, a.byteLength);
  return out;
}
