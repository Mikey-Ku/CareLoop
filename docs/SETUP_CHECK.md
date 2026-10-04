# Demo setup check

From `apps/server`, run `npm run demo:check`. It loads the repo-root `.env`, parses application config, and checks the Node engine declared in `package.json`, full voice-demo settings, and synthetic fixture assets. It never contacts providers, creates a database, sends messages, or starts calls. Secret values, handles, endpoints, and records are not printed.

Exit codes: `0` locally configured; `2` optional capabilities missing; `1` required setup missing or invalid. **Locally configured does not prove credentials authenticate or the live demo works.** Placeholder credentials also pass presence checks.

The voice demo requires `RELAY_AGENT_TOKEN`, `PATIENT_RELAY_HANDLE`, `GEMINI_API_KEY`, `ELEVENLABS_API_KEY`, and `ELEVENLABS_VOICE_ID`. `PRESAGE_API_KEY` enables camera estimation. `FAMILY_RELAY_HANDLES` enables family delivery. Recorded synthetic fixtures need no FinchNode key; an authenticated endpoint needs `FINCHNODE_API_KEY`. Follow `.env.example` and README. Never commit `.env`.

Run provider verification separately from `apps/server`:

- `npm run relay:check`: provider authentication, webhook and existing chat reads. May migrate an existing local database and print configured handles. Sends no messages or calls.
- `npm run llm:check`: submits synthetic text and medicine-label fixtures to Gemini; consumes quota.
- `npm run content:eval`: synthetic conversation evaluation; consumes quota and overwrites `docs/content-eval.md`.

No `--live` flag is supported; use the explicit commands above. Verify ElevenLabs recognition, pronunciation, interruptions, camera framing, readings and recovery with a synthetic patient on the authorized demo phone. Verify family participants have messaged the agent and receive the intended synthetic summary during rehearsal. Avoid actual patient information for hackathon rehearsal.
