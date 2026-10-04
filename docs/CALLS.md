# Relay video symptom-screening calls

The phone call stays inside Relay. The backend joins its WebRTC room, sends incoming audio to ElevenLabs realtime speech-to-text, sends committed transcript turns and a bounded FinchNode context packet to Gemini, then streams Gemini-approved text through ElevenLabs text-to-speech back into the Relay call. Gemini never receives raw audio or video. Presage receives video frames only; raw media is not persisted.

## Responsibilities and boundaries

- Relay owns call signaling, WebRTC, remote audio/video tracks, and call termination.
- ElevenLabs provides realtime transcription and voice synthesis. There is no ElevenLabs conversational agent, dashboard prompt, webhook tool, or public callback URL.
- Gemini is the only model used for adaptive interview turns and evidence-contextualized wording. Deterministic emergency phrase rules run first and take precedence. Gemini cannot diagnose, prescribe, or recommend medication changes.
- FinchNode is read-only. The backend passes a bounded structured projection of relevant conditions, medications, labs, and vitals to Gemini; lookup failure is represented as unavailable and must be reflected as uncertainty. The record is read once per call and reused for every turn (a failed read is tried again on the next turn).
- Presage receives supported Relay video frames only and returns structured pulse and breathing estimates. Speech activity is measured from the incoming audio stream in memory to qualify the quiet window.
- SQLite stores call metadata, transcript text, structured vitals, and the existing call screening record. It does not store raw audio or video.

## Configure the server

Copy `.env.example` to `.env` and set these values on the trusted backend computer:

```text
RELAY_AGENT_TOKEN=
PATIENT_RELAY_HANDLE=
ELEVENLABS_API_KEY=
ELEVENLABS_VOICE_ID=
ELEVENLABS_STT_MODEL=scribe_v2_realtime
ELEVENLABS_STT_LANGUAGE=en
ELEVENLABS_STT_VAD_SILENCE_SECS=0.7
ELEVENLABS_TTS_MODEL=eleven_flash_v2_5
ELEVENLABS_TTS_OUTPUT_FORMAT=pcm_48000
ELEVENLABS_TTS_GAIN=1.6
GEMINI_API_KEY=
PRESAGE_API_KEY=
CALL_QUIET_MEASUREMENT_MS=30000
CALL_MAX_MINUTES=4
VITALS_MIN_CONFIDENCE=1
```

Keep every key on the server. The phones need only the Relay app and the relevant call permissions; they do not receive API credentials. The server makes outbound HTTPS/WebSocket connections to Relay, ElevenLabs, Gemini, FinchNode, and Presage. The call flow does not require a website, HTTPS tunnel, or publicly exposed HTTP endpoint. `/health` is only a local operational check.

`ELEVENLABS_VOICE_ID` identifies the TTS voice. The STT model must support realtime PCM 16 kHz input; the TTS output format is currently PCM 48 kHz mono, which is the format sent to Relay. `ELEVENLABS_STT_LANGUAGE` is the language of her speech as an ISO code; empty means ElevenLabs detects it, which on a real call took English for Chinese. `ELEVENLABS_STT_VAD_SILENCE_SECS` is how long she must pause (0.3 to 3 seconds) before her turn is taken as finished: every reply waits at least that long, so lower is quicker but may cut her off mid-sentence. `ELEVENLABS_TTS_GAIN` is a soft limiter on the voice before it is sent (1 to 4): 1 leaves it untouched, and the default 1.6 lifts a quiet voice about 4 dB without clipping. `CALL_QUIET_MEASUREMENT_MS` is constrained to 30–45 seconds. Never put real keys, patient records, or media in Git.

## Runtime sequence

1. The durable Relay inbox inserts `call.created` by `event_id`, acknowledges it after insertion, and dispatches call handling in the background.
2. The caller handle is matched to the configured patient. Other callers receive a generic decline without reading a patient record. If her chat is not linked yet (she called before she ever typed), the call's chat is linked the way her first message would link it, so the post-call message and her family's alerts can reach her.
3. Relay's call transport and ElevenLabs realtime STT are connected within Relay's 32-second answer deadline. The server opens ElevenLabs STT at `wss://api.elevenlabs.io/v1/speech-to-text/realtime` using `scribe_v2_realtime`, PCM 16 kHz, and voice-activity commits. Partial text can interrupt TTS; only committed transcripts become audit turns or Gemini input.
4. The server speaks a fixed AI disclosure and opening question, after waiting up to 2 seconds for her audio to arrive and playing 300 ms of silence ahead of it (a greeting spoken the instant the call was answered came out rough). Gemini then handles the patient's latest information conversationally, selecting at most one relevant follow-up at a time from transcript evidence and bounded context. It may ask about onset, change, severity, or associated symptoms when relevant, and should stop once sufficient information has been collected.
5. A deterministic emergency screen runs before Gemini for each committed turn. A detected crisis or urgent red flag immediately uses fixed safety wording and existing caregiver-alert behavior; it does not wait for Gemini.
6. When a camera measurement would add useful information, Gemini may request permission. Gemini does not always ask, so when it would end the call and the reading is possible (Presage is configured, she has not said no, no reading was taken yet) the server offers it itself, once, in fixed words, before the goodbye. A no or a finished reading goes on to the goodbye. The server never starts it without an explicit affirmative. It explains the reason, asks the patient to show face and upper chest, then keeps a 30–45 second quiet window. Presage receives the video frames; frames retain dimensions, stride, pixel format, and monotonic timestamps. Frames rejected by the adapter are logged without media contents. Speech during the window is reflected in measurement validity; low/zero-confidence readings remain unusable.
7. The server reads a usable pulse/breathing estimate back with uncertainty, then continues the screening turn with structured vitals and FinchNode evidence. Missing vitals or unavailable FinchNode data must remain missing/uncertain, never be guessed.
8. Gemini's wording for an ordinary turn (an acknowledgment and one question) is streamed through ElevenLabs TTS into Relay. The goodbye and the words for an emergency are fixed copy, never Gemini's: when Gemini completes or ends the call the server speaks `callClosing`, and when it declares an emergency, the text check-in's urgent or crisis reply (911, 988). TTS is cancelled on interruption. The patient can end the call at any point; call end stops and destroys Presage, closes STT/TTS and Relay resources, and persists only permitted structured/text data.

The existing check-in engine continues to own deterministic safety escalation, call transcript audit, and its established post-call check-in/memory behavior. The model's adaptive wording does not replace the severity ladder or write directly to FinchNode.

## Local verification

From `apps/server`:

```bash
npm run lint
npm test
npm run relay:check
npm run agent
```

For a real-device test, keep the server process running on a trusted computer with `.env` configured. Make sure the agent is connected to Relay and the patient account allows calls, microphone, and camera access. Place the call from the Relay app. Verify the first sentence identifies the assistant as AI, ordinary turns are transcribed and spoken back naturally, one relevant follow-up is asked at a time, consent is requested before measurement, and the call ends cleanly. Test urgent phrases only with the synthetic/test patient and confirm fixed emergency wording takes precedence. Do not use a real patient's record or media for a hackathon smoke test.

## Package versions and known limitations

| Package | Version / source |
| --- | --- |
| `@relaymessenger/sdk` | `0.5.1` |
| `@smartspectra/node-sdk` | `3.4.0` |
| `node-webcodecs` | `1.3.0` |
| `ws` | `8.22.0` |
| ElevenLabs STT/TTS | HTTPS/WebSocket API; no agent SDK package |

Presage output over Relay-call video is an estimate, not a clinical measurement. It may return no usable reading because of framing, lighting, motion, speaking, AFib, frame support, or insufficient confidence. No blood pressure, HRV, diagnosis, or medication advice is generated. Before any real patient use, validate device compatibility, consent, retention policy, clinical review, and the safety copy with the project owner and qualified clinical stakeholders.
