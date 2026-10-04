# CLAUDE.md

MHacks 2026: a daily check-in companion for seniors built on FinchNode (records), Relay Messenger (chat, calls, photos), ElevenLabs (voice) and Presage (camera vitals).

- What and why: `docs/BRIEF.md`. How: `docs/DESIGN.md`. Glossary: `CONTEXT.md`. Run it: `README.md`. Test it on phones: `docs/QA.md`. When it's finished: `docs/DEFINITION_OF_DONE.md` (quote the evidence in your PR). Team questions and tasks: `FEEDBACK.md`.
- "Relay" means Relay Messenger (relayapp.im, docs at https://docs.relayapp.im/llms.txt), not Relay.app or Twilio ConversationRelay.
- Server code lives in `apps/server`. Run `npm run lint && npm test` there.

Rules:
- Work on a branch and open a pull request into `main`. Never push to `main`, never force-push.
- Synthetic data only (FinchNode's demo API or a `ck_test_` key). Secrets only in `.env`.
- Rules decide medical flags; the LLM only words them. No dosing advice, no diagnosis, no em dashes in anything a person reads.
- No new dependencies outside the stack in `docs/DESIGN.md` without asking.
- Shared files: `src/db/schema.ts` only gets new migrations at the end; `src/checkin/copy.ts` holds every word a person reads (add exports, don't change signatures); keep `src/checkin/engine.ts` changes small.
- A product or medical question you can't settle: write it in `FEEDBACK.md` instead of guessing.
