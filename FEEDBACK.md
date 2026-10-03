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
- [ ] Branches: run 1 was built on branch `claude/workflow-review-deep-dive-3eaa2f`, not `main`. Also, local `main` has commit d7a795a (docs) that was never pushed to origin. Merge or fast-forward when ready.

## Team tasks (humans only, not for Claude Code)

- [ ] Relay: create an agent in Relay Console and save its Agent Token; create a webhook subscription secret. Put `RELAY_AGENT_TOKEN` and `RELAY_WEBHOOK_SECRET` in `.env`.
- [ ] Relay: install the Relay iOS app on two iPhones (one plays Harriet, one plays Sarah). Add the agent on both and turn on Allow Calls on Harriet's phone.
- [ ] ElevenLabs: create an Agent with a warm stock voice. Its prompt says it is an AI, keeps calls short, never gives medical or dosing advice, and ends by suggesting a real person. Put `ELEVENLABS_API_KEY` and `ELEVENLABS_AGENT_ID` in `.env`.
- [ ] Presage: sign up for the free tier (https://www.mlh.com/partners/presage) and put `PRESAGE_API_KEY` in `.env`.
- [ ] Anthropic: put `ANTHROPIC_API_KEY` in `.env`.
- [ ] Day-one spike: run one Relay video call with the ElevenLabs bridge and video frame reading at the same time. Compare heart rate with Presage's own app on the same person in the same minute. Write the result here; it decides build step 5 (C++ sidecar or fallback scan screen).
- [ ] Confirm the wording of rules R3 (bleeding combination) and R4 (potassium) against a drug interaction reference.
- [ ] Print the synthetic discharge sheet for Harriet from "Northstar Health System" with one planted change (aspirin stopped). Label it clearly as synthetic.
- [ ] Check MHacks prize tracks (FinchNode, ElevenLabs, Presage through MLH) and note them here.
- [ ] Assign owners: records and rules, Relay agent, voice, vitals, demo and pitch.
