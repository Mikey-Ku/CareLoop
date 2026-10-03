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

- [ ] Red-flag cadence numbers: `redFlagEveryDays = 2` and `followUpDays = 3` in `apps/server/src/context/questions.ts`. Product values, not clinical cutoffs; change them if they feel wrong in rehearsal.

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

- [x] Synthetic discharge sheet: `fixtures/papers/harriet-discharge.html` (aspirin stopped). Print it on letter paper.
- [ ] Confirm the wording of rules R3 (bleeding combination) and R4 (potassium) against a drug interaction reference.
- [ ] Check MHacks prize tracks (FinchNode, ElevenLabs, Presage through MLH, Relay) and note them here.
- [ ] Assign owners: records and rules, Relay agent, voice, vitals, demo and pitch.

Photon care summaries (branch photon/care-summaries):

- [ ] Create a Photon project (https://photon.codes) and put `SPECTRUM_PROJECT_ID` and `SPECTRUM_PROJECT_SECRET` in `.env`.
- [ ] Copy `care-contacts.example.json` to `care-contacts.json` and put in the doctor's and the emergency contact's real numbers (synthetic patient, real test phones).
- [ ] From each of those two phones, text the Photon line once before the first summary (Apple marks cold messages as junk).
- [ ] Check the summaries with `npm run care:send -- --day 2026-09-01 --dry-run`, then run the agent.
- [ ] Decide whether the doctor's summary should also go out after a voice call (lanes 2 and 3) as a second trigger, or stay one per day.
