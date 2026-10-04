# FEEDBACK

Team notes between Claude Code runs. Claude Code reads this at the start of every run.

## For Claude Code

(Add items here. Claude Code marks them `[done]` when addressed.)

## Questions for the team

(Claude Code writes questions here when it hits real ambiguity.)

Open:

- [ ] Content eval on a held-out set: someone who hasn't seen `fixtures/content/messages.json` or the classifier prompt writes 50 new messages, so the accuracy numbers aren't flattered by tuning.

- [ ] Safety phrase lists (`apps/server/src/safety/screen.ts`, crisis and urgent symptom): a demo starting point. Someone review them against `docs/content-eval.md` before the demo.

- [ ] Red-flag cadence numbers: `redFlagEveryDays = 2` and `followUpDays = 3` in `apps/server/src/context/questions.ts`. Product values, not clinical cutoffs; change them if they feel wrong in rehearsal.

## Presage video spike (2026-10-03)

- Implemented a file-based SmartSpectra runner with `@smartspectra/node-sdk` 3.4.0. It requests pulse and breathing metrics, decodes the SDK protobuf messages, emits normalized JSON, records validation and SDK errors, and exits nonzero when either required reading is missing.
- Added `--metrics pulse-breathing|all`; the default remains the full breathing + cardio bundle, while the smaller profile isolates pulse/breathing model access during diagnostics.
- Fixed the runner lifecycle: SmartSpectra emits an initial idle status before file playback starts, so completion now waits for a real starting/running state and uses `stopAsync()` before destroy. Relative file timestamps are anchored to the run start instead of being reported as dates in 1970, and repeated validation messages are coalesced.
- Added a Relay `VideoStream` frame adapter design. It maps RGB, BGR, RGBA, BGRA, NV12, NV21 and YUYV, preserves dimensions and stride, supplies strictly increasing monotonic timestamps, and rejects I420 until a tested conversion path exists.
- Video characteristics: the successful Photo Booth clip is 1620 x 1080 H.264/AAC, 56.45 seconds long. The earlier 6.00 PM clip was deleted after this better run. Real video must stay local and out of Git.
- Readings produced: after the lifecycle fix, the full `all` profile initialized without model/auth errors and produced heart rate 71.44/min and breathing rate 11.88/min. Heart-rate confidence was 13.16; breathing confidence was 0; both stability flags were false, so the combined confidence remained 0. Validation briefly reported `Face the camera`, and the native SDK emitted repeated non-increasing timestamp warnings during playback. The updated runner exposes per-metric quality fields while preserving provisional readings for downstream interpretation.
- Model access result: the earlier `phasic-bp-inference` cancellation was caused by our premature destroy on the SDK's initial idle event, not exhausted credits or a missing Presage model entitlement. The corrected runner reaches normal validation and metrics processing.
- Limitations: record one centered face with the upper chest visible, stable camera, even lighting, and no talking to improve confidence. Relay's actual `VideoStream` payload shape still needs confirmation on a live call. Harriet's AFib reading remains an estimate and must not be compared with her usual range.

## Team tasks (humans only, not for Claude Code)

Relay setup (WebSocket, so no public URL and no webhook secret):

- [ ] On the laptop that runs the agent: `npx relaymessenger@latest login`, then create the agent in Relay Console (or the CLI) and put its Agent Token in `.env` as `RELAY_AGENT_TOKEN`. Don't create a webhook subscription: WebSocket needs zero.
- [ ] Two phones with the Relay app: one plays Harriet, one plays Sarah. Put their handles in `.env` as `PATIENT_RELAY_HANDLE` and `FAMILY_RELAY_HANDLES`.
- [ ] From EACH phone, send the agent a first message ("hi"). The agent can't message someone who hasn't written to it. Turn on Allow Calls on Harriet's phone.
- [ ] Run `npm run relay:check` in `apps/server`; every line should be green. Then `npm run agent -- --checkin-now` and answer on Harriet's phone.

Voice, vitals, vision:

- [ ] Relay video symptom-screening: use the backend's direct ElevenLabs realtime STT and streaming TTS APIs (not an ElevenLabs conversational Agent). Configure `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID`, `GEMINI_API_KEY`, and optionally `PRESAGE_API_KEY` in the server `.env`; see `docs/CALLS.md`. Validate real-device call setup, transcription quality, TTS playback/interruption, consented quiet measurement, and cleanup before a phone demo.
- [ ] Presage: sign up for the free tier (https://www.mlh.com/partners/presage) and put `PRESAGE_API_KEY` in `.env`.
- [ ] Presage spike, the riskiest unknown: try `@smartspectra/node-sdk` (npm, 3.4.0, has a darwin-arm64 build) with raw RGBA frames first. If it accepts frames from Relay's `VideoStream`, it replaces the C++ sidecar. Compare its heart rate with Presage's own app on the same person in the same minute. Write the result here.

Demo:

- [ ] Demo-day LLM backup: the free Gemini tier returned 503 "high demand" several times on 2026-10-03. Done: a paid Gemini key (lite models only). If Gemini is down, typed replies fall back to buttons with honest wording.

- [x] Synthetic discharge sheet: `fixtures/papers/harriet-discharge.html` (aspirin stopped). Print it on letter paper.
- [ ] Confirm the wording of rules R3 (bleeding combination) and R4 (potassium) against a drug interaction reference.
- [ ] Check MHacks prize tracks (FinchNode, ElevenLabs, Presage through MLH, Relay) and note them here.
- [ ] Assign owners: records and rules, Relay agent, voice, vitals, demo and pitch.

Photon care summaries (branch photon/care-summaries):

- [ ] Create a Photon project (https://photon.codes) and put `SPECTRUM_PROJECT_ID` and `SPECTRUM_PROJECT_SECRET` in `.env`.
- [ ] Copy `care-contacts.example.json` to `care-contacts.json` and put in the doctor's and the emergency contact's real numbers (synthetic patient, real test phones).
- [ ] From each of those two phones, text the Photon line once before the first summary (Apple marks cold messages as junk).
- [ ] Check the summaries with `npm run care:send -- --day 2026-09-01 --dry-run`, then run the agent.
- [ ] Decide whether the doctor's summary should also go out after a voice call (the video call) as a second trigger, or stay one per day.
