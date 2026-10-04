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
VITALS_MAX_FRAME_GAP_MS=1900
CAMERA_CALLBACK=off
```

Keep every key on the server. The phones need only the Relay app and the relevant call permissions; they do not receive API credentials. The server makes outbound HTTPS/WebSocket connections to Relay, ElevenLabs, Gemini, FinchNode, and Presage. The call flow does not require a website, HTTPS tunnel, or publicly exposed HTTP endpoint. `/health` is only a local operational check.

`ELEVENLABS_VOICE_ID` identifies the TTS voice. The STT model must support realtime PCM 48 kHz input (Relay's own rate: her speech is only downmixed to mono, never resampled, which heard quiet words better); the TTS output format is currently PCM 48 kHz mono, which is the format sent to Relay. `ELEVENLABS_STT_LANGUAGE` is the language of her speech as an ISO code; empty means ElevenLabs detects it, which on a real call took English for Chinese. `ELEVENLABS_STT_VAD_SILENCE_SECS` is how long she must pause (0.3 to 3 seconds) before her turn is taken as finished: every reply waits at least that long, so lower is quicker but may cut her off mid-sentence. `ELEVENLABS_TTS_GAIN` is a soft limiter on the voice before it is sent (1 to 4): 1 leaves it untouched, and the default 1.6 lifts a quiet voice about 4 dB without clipping. `CALL_QUIET_MEASUREMENT_MS` is constrained to 30–45 seconds. Never put real keys, patient records, or media in Git.

## Runtime sequence

1. The durable Relay inbox inserts `call.created` by `event_id`, acknowledges it after insertion, and dispatches call handling in the background.
2. The caller handle is matched to the configured patient. Other callers receive a generic decline without reading a patient record. If her chat is not linked yet (she called before she ever typed), the call's chat is linked the way her first message would link it, so the post-call message and her family's alerts can reach her.
3. Relay's call transport and ElevenLabs realtime STT are connected within Relay's 32-second answer deadline. The server opens ElevenLabs STT at `wss://api.elevenlabs.io/v1/speech-to-text/realtime` using `scribe_v2_realtime`, PCM 48 kHz, and voice-activity commits. The session counts as connected only when Scribe sends `session_started`, not when the socket opens. If it ends under a live call (the socket closes, or Scribe sends a fatal event such as `quota_exceeded` or `rate_limited`; only the event's type is ever logged), audio sent into it would be dropped and the call would go deaf, so the server reconnects once, and if that fails it says in fixed words that it cannot hear her and ends the call. Partial text of at least two real words (sound tags such as "(coughs)" are not words) can interrupt TTS, except during the greeting and a fixed safety reply, so a cough, noise or a first "hello?" does not cut the assistant off; only committed transcripts become audit turns or Gemini input.
4. The server speaks a fixed AI disclosure and opening question, after waiting up to 2 seconds for her audio to arrive and playing 300 ms of silence ahead of it (a greeting spoken the instant the call was answered came out rough). Gemini then handles the patient's latest information conversationally, selecting at most one relevant follow-up at a time from transcript evidence and bounded context. It may ask about onset, change, severity, or associated symptoms when relevant, and should stop once sufficient information has been collected. Gemini can finish on "I'm feeling great", so before the camera offer and the goodbye the server asks each of today's check-in questions not yet said on the call, in fixed words. None is asked twice: when Gemini asks one of them in its own words ("Did you take your morning medications today?"), the fixed question is said instead, and its rewording of one already asked is replaced by the next; its follow-ups on what she said ("Is the bleeding heavy?") are kept; when she has already answered the day's check-in (in the chat, or "Not today"), the call asks all of them again. Her "I have to go" and the emergency words still end the call at once.
5. A deterministic emergency screen runs before Gemini for each committed turn. A detected crisis or urgent red flag immediately uses fixed safety wording and existing caregiver-alert behavior; it does not wait for Gemini.
6. When a camera measurement would add useful information, Gemini may request permission. Gemini does not always ask, so when it has what it needs and the reading is possible (Presage is configured, her video is on, she has not said no, no reading was taken yet) the server offers it itself, once, in fixed words, before the goodbye. A caller who says she has to go gets the goodbye without the offer. Whether her video is on is read from the transport's own video events on every turn. When it is off, the reading is not offered; instead, once and before the goodbye, she is told in fixed words how to turn her camera on (the video button), and her "ready" is her yes (told once more if the camera is still off, then the call goes on without the reading, as it does on a no). A no, or a second answer that is neither yes nor no, or a finished reading goes on to the goodbye. The server never starts it without an explicit affirmative. It explains the reason, asks the patient to show face and upper chest, then keeps a 30–45 second quiet window and says how many seconds are left ("Twenty seconds left.", "Ten seconds left."); if the window is cut short, for example by a stalled camera, it ends at once instead of counting down to nothing. A longer pause in her video than `VITALS_MAX_FRAME_GAP_MS` (default and at most 1.9 s, because Presage refuses any frame more than 2 s after the last one and then every frame after it) restarts the reading inside the same window: Presage is stopped and started, the 12 s pulse warm-up begins again from the next frame, and the window and its countdown carry on (at most 3 restarts a window; a fourth ends it). A phone often sends its first frames in a burst and then pauses for about 2 s, so this is expected. A window that takes no frame within 3 s of beginning, or whose camera goes silent for 4 s, ends at once. When a reading comes to nothing usable (and her camera is still on), she is offered one more try in fixed words, and a yes or "try again" runs the window again after a short prompt ("Hold still and quiet again for 30 seconds once I stop talking. I will count down."); a second failure ends with the no-reading words and the goodbye. Answers that repeat within 3 s (the speech-to-text can commit one short answer twice) count once. To tell a bad reading from a bad picture the server logs `call_video_cadence` every 3 s of the window (frames a second, longest gap, size, average colour, how long the process stalled, and the transport's counters for dropped frames and keyframe requests), `call_video_pause` for any pause over a second that Presage takes, `call_quiet_measurement_restarted` for a restart (with its reason, `video_gap` or `sdk_error`), `call_video_frame_rejected` once per Presage error code a window, `call_presage_error` and `call_presage_status` as they happen, for every reading cut short `call_quiet_measurement_interrupted` with its reason (`no_frames`, `video_stalled`, `video_gap_repeated` and others), and one `call_quiet_measurement_finished` line per window with what Presage reported before our gates (heart rate, breathing rate, confidence, stable, packets, restarts); no pixels. Presage receives the video frames; frames retain dimensions, stride, pixel format, and monotonic timestamps. Frames rejected by the adapter are logged without media contents. Speech during the window is reflected in measurement validity; low/zero-confidence readings remain unusable. The log also says what it saw about her video: `call_video_changed` (her video went on or off, and which transport event said so), `call_video_state` (once, 5 seconds after the answer: video on, track present, Presage configured, the receive counters) and `call_camera_offer_skipped` (Presage is configured but her video was off at the goodbye).
7. The server reads a usable pulse/breathing estimate back with uncertainty, then continues the screening turn with structured vitals and FinchNode evidence. Missing vitals or unavailable FinchNode data must remain missing/uncertain, never be guessed.
8. Gemini's wording for an ordinary turn (an acknowledgment and one question) is streamed through ElevenLabs TTS into Relay, but only after the output guard (`guardSpoken`, the chat's small-talk guard family): no dosing, medical instructions, sending her to a clinician, diagnosis or what a symptom means, reassurance, or 911 and 988. A sentence that fails is replaced by a fixed one ("Thank you for telling me."; the next unanswered check-in question, or an open one). The goodbye and the words for an emergency are fixed copy, never Gemini's: when Gemini completes or ends the call the server speaks `callClosing`. Gemini declaring an emergency does not by itself make her hear 911 or 988: those replies are said only when the fixed screen over her words hits too (and then they claim no alert, since nobody has been told at that point); otherwise the call ends with the goodbye, and the ladder after the call, where the model's reading can raise the level, decides who is alerted. TTS is cancelled on interruption. A reply Gemini is still planning is dropped without a word when she adds to what she said (a newer committed transcript is queued, or a partial transcript with two real words shows she is talking again); her next committed transcript is then answered with everything she said. The patient can end the call at any point; call end stops and destroys Presage, closes STT/TTS and Relay resources, and persists only permitted structured/text data.

With `CAMERA_CALLBACK=on`, step 6's reading on the call is replaced by the camera check call-back below.

## Camera check call-back

The live call's video reaches the server through the Relay TypeScript SDK's receiver, which on a phone loses frames every few seconds (holes of about 2 s), so Presage rarely gets the 12 s of continuous video a pulse needs. The Relay Python SDK (aiortc) repairs lost packets: on the same phone it delivered every frame (1050 of 1050 in 35 s, longest gap 34 ms). So with `CAMERA_CALLBACK=on` the reading is taken on a short second call:

1. Before the goodbye (after the day's questions) the server offers it in fixed words, camera on or not: "would you like a quick camera check of your heart rate? I'll call you right back for it." Her yes is the goodbye, which starts "I'll call you right back for the camera check. When it rings, please answer and tap the video button." A yes earlier in the call gets "after we finish" and the call goes on. The check-in call opens no Presage session.
2. Once the call is recorded and her post-call message sent, the agent waits 10 s, texts her the notice, and runs the recorder (`apps/camera-check/camera_check.py`, through `uv run`, or `CAMERA_CHECK_PYTHON`). It places the call, waits for her to pick up, speaks the start prompt in the agent's ElevenLabs voice, and waits up to 45 s for her camera (reading the SDK's video track whether or not its "track subscribed" event came, starting another reader if one dies, and asking once more after 10 s: "I can't see your camera yet. Please tap the video button."). It records 35 s as constant 30 fps H.264 at one size into a temporary file and says goodbye. The agent ignores the call it placed. Relay sometimes ends a call-back within 2 s as no-answer before her phone rings, or can't place it while her last call is still open: that is tried once more, 10 s later; a call she let ring, hung up, or kept her camera off on is not.
3. Presage reads the file. A heart rate is kept only if it is stable, at least `VITALS_MIN_CONFIDENCE`, and 30 to 220 bpm (a 60 fps phone clip gave 183 bpm at confidence 0). The reading is saved as a camera reading on the agent's day and texted to her ("Your heart rate is about 94 beats a minute. This is a camera estimate, not a medical test."), or she gets the no-reading words. The recording is always deleted.

There is no call-back after the emergency words, after "I have to go", or when the reading after the call puts the call at the urgent or crisis level, and only one runs at a time. `npm run camera:check -- [--patient id] [--db path]` runs it on demand. Setup: install [uv](https://docs.astral.sh/uv/), then `uv sync --project apps/camera-check` once from the repo root (Python 3.10 or newer, `relaymessenger[calls]`). The log shows `call_back_started`, then `[camera-check] camera_check_step` for `calling`, `answered`, `video`, `recording` and `recorded` (frames written and received, longest gap, size) or `failed` with a reason (`no_token`, `call_not_placed`, `not_answered`, `call_ended`, `hung_up`, `no_video` with what the call knew about her video, `too_short`, `call_error`), `camera_reminder`, `video_error`, `camera_check_retry`, and `camera_check_read` with what Presage reported and what was kept.

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
