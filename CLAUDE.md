# CLAUDE.md

MHacks 2026: a daily check-in companion for seniors built on FinchNode (records), Relay Messenger (chat, calls, photos), ElevenLabs (voice) and Presage (camera vitals).

- Spec and run protocol: `CLAUDE_CODE_BRIEF.md`. Follow it every session.
- What and why: `docs/BRIEF.md`. How: `docs/DESIGN.md`.
- State between runs: `RUN_LOG.md` (yours) and `FEEDBACK.md` (the team's).
- "Relay" means Relay Messenger (relayapp.im, docs at https://docs.relayapp.im/llms.txt), not Relay.app or Twilio ConversationRelay.
- Synthetic data only. Secrets only in `.env`. Rules decide medical flags; the LLM only words them.
- Server code lives in `apps/server`. Run tests with `npm test` there.
