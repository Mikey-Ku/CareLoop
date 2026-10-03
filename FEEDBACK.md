# FEEDBACK

Team notes between Claude Code runs. Claude Code reads this at the start of every run.

## For Claude Code

(Add items here. Claude Code marks them `[done]` when addressed.)

## Questions for the team

(Claude Code writes questions here when it hits real ambiguity.)

- [ ] R5 refill grace period: DESIGN.md says "days supply plus a grace period" but gives no number. Run 1 uses `refillGraceDays: 7` in `apps/server/src/rules/config.ts` as a placeholder. R5 is skipped for Harriet anyway (one fill per drug). Pick a value.
- [ ] Atrial fibrillation and camera heart rate: Harriet has AFib, the rhythm where camera heart-rate estimates are least reliable. Should the vitals call say so, or skip the usual-range comparison for patients with AFib? Default for now: no special handling.
- [ ] Red-flag questions in rotation: "trouble breathing lying flat" and "unusual bleeding" rotate like every other question, so Harriet is asked each only some days. Should red-flag questions be asked daily (using up 2 of the 3 slots)? Default for now: rotate.
- [ ] R4 above the range: a potassium above the top of its reference range (say 5.5 with range to 5.1) flags today, since the check is "at or above the start of the top quarter". Safer reading of DESIGN.md, but confirm.
- [ ] Records dated after the check-in date: rules don't ignore labs or fills dated later than the pinned demo date. Harriet has none. Should they be excluded?
- [ ] Flags when record consent ends: snapshots are deleted on a 410, but stored flags are kept. Delete them too?
- [ ] Family messages: run 1 picked `direction` to_senior/to_family and `kind` voice/text/photo in the schema. Check against how the Relay agent stores messages in run 2.
- [ ] Red-flag advice adds "If it gets worse or feels like an emergency, call 911." Beyond the spec; keep or drop?
- [ ] Stale button taps: a tap on an old message counts as the answer to whatever is pending now. Fine for the demo; tighten with `replyTo` in run 2?
- [ ] "Later" on a flag she has heard: a record flag becomes told (not offered again), a paper (R6) flag stays new (offered again). Make them match? Suggested: both told.
- [ ] Family members get no reply when they first message the agent, so they can't tell they're set up. Send a short welcome ("You'll get Harriet's daily updates here")? Suggested: yes, next run.
- [x] [done] Sharing changes: chat flow built in run 2b.
- [x] [done] R6 results enter the flag lifecycle after Harriet confirms the read-back (run 2b).
- [x] [done] Branches: merged to `main` through a pull request (run 2b).

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
