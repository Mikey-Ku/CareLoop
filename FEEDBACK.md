# FEEDBACK

Open items for the team. Product or medical questions you can't settle go here.

- [ ] Relay video call: set `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID` and `GEMINI_API_KEY` (and `PRESAGE_API_KEY` for the camera reading) in `.env`; see `docs/CALLS.md`. Then check real-device setup, transcription quality, voice playback and interruption, the consented quiet reading and cleanup, three timed calls, and Presage within 5 bpm of its own app.
- [ ] Content eval on a held-out set: someone who hasn't seen `fixtures/content/messages.json` or the classifier prompt writes 50 new messages, so the accuracy numbers aren't flattered by tuning.
- [ ] Review the safety phrase lists (`apps/server/src/safety/screen.ts`) against `docs/content-eval.md` before the demo.
- [ ] Red-flag cadence (`redFlagEveryDays = 2`, `followUpDays = 3` in `apps/server/src/context/questions.ts`) are product values, not clinical cutoffs; change them if they feel wrong in rehearsal.
- [ ] Confirm the wording of rules R3 (bleeding combination) and R4 (potassium) against a drug interaction reference.
- [ ] Check MHacks prize tracks (FinchNode, ElevenLabs, Presage through MLH, Relay) and note each sponsor's part here.
- [ ] Family words are now stored (`family_messages.text`, migration 14, capped at 500 characters) so Harriet can ask "what did Sarah say?" and the context digest can quote them to Gemini as reference facts. Until 2026-10-04 only who and when were kept, and DESIGN.md said their words are never read by a model. Keep it, or drop the column and answer only "Sarah sent you a message on Sep 1"? Their words reach the digest as quoted strings with instruction-like text left out; real use needs their consent as well as hers.

Presage spike (2026-10-03): `@smartspectra/node-sdk` 3.4.0 gave heart rate 71.4/min and breathing 11.9/min on a 56 s clip (heart-rate confidence 13, so a low-confidence estimate). Needs one centered face, upper chest visible, steady camera, even light, no talking. Relay's real `VideoStream` frame shape is confirmed only on a live call; Harriet's AFib reading stays an estimate with no usual-range comparison.
