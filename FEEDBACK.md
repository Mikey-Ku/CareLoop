# FEEDBACK

Team notes between Claude Code runs. Claude Code reads this at the start of every run.

## For Claude Code

(Add items here. Claude Code marks them `[done]` when addressed.)

## Questions for the team

(Claude Code writes questions here when it hits real ambiguity.)

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
