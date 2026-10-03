# FEEDBACK

Team notes between Claude Code runs. Claude Code reads this at the start of every run.

## For Claude Code

(Add items here. Claude Code marks them `[done]` when addressed.)

## Questions for the team

(Claude Code writes questions here when it hits real ambiguity.)

Answered by Michael on 2026-10-03 (built in run 2c):

- [x] [done] R5 refill grace period: 7 days.
- [x] [done] AFib and camera heart rate: for patients with atrial fibrillation, report the reading as an estimate and skip the usual-range comparison.
- [x] [done] Red-flag questions: asked periodically, based on her conditions and whether a check is needed (every other day by default, daily for a few days after a worrying answer), not by plain rotation.
- [x] [done] R4 above the range: keep flagging it.
- [x] [done] Records dated after the check-in date: ignored, so the app behaves as if it really is that day.
- [x] [done] Flags when record consent ends: deleted along with the record copy.
- [x] [done] Family message values (`to_senior`/`to_family`, `voice`/`text`/`photo`): keep.
- [x] [done] Red-flag advice: keep the 911 line, but lead with telling her family; family alerts ask them to call her today.
- [x] [done] Stale button taps: a tap on an old message re-prompts instead of answering (checked against the message it replies to).
- [x] [done] "Later" on a flag she has heard: told, for record and paper flags alike.
- [x] [done] Family welcome: a family member gets a short welcome the first time they message the agent.
- [x] [done] Sharing changes: chat flow built in run 2b.
- [x] [done] R6 results enter the flag lifecycle after Harriet confirms the read-back (run 2b).
- [x] [done] Branches: merged to `main` through PR #1 (run 2b).

Open:

- [ ] Content eval on a held-out set: someone who hasn't seen `fixtures/content/messages.json` or the classifier prompt writes 50 new messages, so the accuracy numbers aren't flattered by tuning.

- [ ] Safety phrase lists (`apps/server/src/safety/screen.ts`, crisis and urgent symptom): a demo starting point. Someone review them against `docs/content-eval.md` before the demo.

- [ ] Red-flag cadence numbers: `redFlagEveryDays = 2` and `followUpDays = 3` in `apps/server/src/context/questions.ts`. Product values, not clinical cutoffs; change them if they feel wrong in rehearsal.

## Lane 3: Presage video spike (2026-10-03)

- Implemented a file-based SmartSpectra runner with `@smartspectra/node-sdk` 3.4.0. It requests pulse and breathing metrics, decodes the SDK protobuf messages, emits normalized JSON, records validation and SDK errors, and exits nonzero when either required reading is missing.
- Added `--metrics pulse-breathing|all`; the default remains the full breathing + cardio bundle, while the smaller profile isolates pulse/breathing model access during diagnostics.
- Fixed the runner lifecycle: SmartSpectra emits an initial idle status before file playback starts, so completion now waits for a real starting/running state and uses `stopAsync()` before destroy. Relative file timestamps are anchored to the run start instead of being reported as dates in 1970, and repeated validation messages are coalesced.
- Added a Relay `VideoStream` frame adapter design. It maps RGB, BGR, RGBA, BGRA, NV12, NV21 and YUYV, preserves dimensions and stride, supplies strictly increasing monotonic timestamps, and rejects I420 until a tested conversion path exists.
- Video characteristics: the supplied Photo Booth clip is 1620 x 1080 H.264/AAC, 53.38 seconds long. Real video must stay local and out of Git.
- Readings produced: after the lifecycle fix, the full `all` profile initialized without model/auth errors and produced breathing rate 25.17/min with confidence 79.29. Pulse remained unavailable because the clip repeatedly reported `Place more of the chest in view` and did not produce a pulse sample. The pulse/breathing diagnostic similarly produced breathing 21.86/min with confidence 64.09 and no SDK errors.
- Model access result: the earlier `phasic-bp-inference` cancellation was caused by our premature destroy on the SDK's initial idle event, not exhausted credits or a missing Presage model entitlement. The corrected runner reaches normal validation and metrics processing.
- Limitations: the clip's framing is not suitable for a reliable pulse reading; record one centered face with the upper chest visible, stable camera, even lighting, and no talking. Relay's actual `VideoStream` payload shape still needs confirmation on a live call. Harriet's AFib reading remains an estimate and must not be compared with her usual range.

## Team tasks (humans only, not for Claude Code)

Relay setup (WebSocket, so no public URL and no webhook secret):

- [ ] On the laptop that runs the agent: `npx relaymessenger@latest login`, then create the agent in Relay Console (or the CLI) and put its Agent Token in `.env` as `RELAY_AGENT_TOKEN`. Don't create a webhook subscription: WebSocket needs zero.
- [ ] Two phones with the Relay app: one plays Harriet, one plays Sarah. Put their handles in `.env` as `PATIENT_RELAY_HANDLE` and `FAMILY_RELAY_HANDLES`.
- [ ] From EACH phone, send the agent a first message ("hi"). The agent can't message someone who hasn't written to it. Turn on Allow Calls on Harriet's phone.
- [ ] Run `npm run relay:check` in `apps/server`; every line should be green. Then `npm run agent -- --checkin-now` and answer on Harriet's phone.

Voice, vitals, vision:

- [ ] ElevenLabs: create an Agent with a warm stock voice. Its prompt says it is an AI, keeps calls short, never gives medical or dosing advice, and ends by suggesting a real person. Put `ELEVENLABS_API_KEY` and `ELEVENLABS_AGENT_ID` in `.env`. (Relay-SDK `cookbook/elevenlabs-agents-call` is the reference.)
- [ ] Presage: sign up for the free tier (https://www.mlh.com/partners/presage) and put `PRESAGE_API_KEY` in `.env`.
- [ ] Presage spike, the riskiest unknown: try `@smartspectra/node-sdk` (npm, 3.4.0, has a darwin-arm64 build) with raw RGBA frames first. If it accepts frames from Relay's `VideoStream`, it replaces the C++ sidecar. Compare its heart rate with Presage's own app on the same person in the same minute. Write the result here.
- [ ] Anthropic: put `ANTHROPIC_API_KEY` in `.env` (reads paper photos in step 6).

Demo:

- [ ] Demo-day LLM backup: the free Gemini tier returned 503 "high demand" several times on 2026-10-03. Get a paid Gemini key or Claude API credits before the demo; switching is `LLM_PROVIDER` and a key in `.env`.

- [x] Synthetic discharge sheet: `fixtures/papers/harriet-discharge.html` (aspirin stopped). Print it on letter paper.
- [ ] Confirm the wording of rules R3 (bleeding combination) and R4 (potassium) against a drug interaction reference.
- [ ] Check MHacks prize tracks (FinchNode, ElevenLabs, Presage through MLH, Relay) and note them here.
- [ ] Assign owners: records and rules, Relay agent, voice, vitals, demo and pitch.
