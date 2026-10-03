# RUN_LOG

## Run 1: 2026-10-03 15:00

**Goal of this run:** Build order steps 1 and 2: scaffold, FinchNode client with fixtures and tests, context packet, question picker, rules R1 to R5 with the answer key.

**What was built:**
- `apps/server` scaffold: TypeScript 7 strict, Node 22.18+ running `.ts` directly (no build step), vitest, `npm run lint` = `tsc --noEmit`.
- FinchNode client on the normalized `/users/{subject}/records` route: 429 retry with Retry-After, typed errors for 410/403/404/429, connect sessions with demo and sandbox spellings.
- Normalization: string values and ranges parsed, lb to kg, glucose mmol/L to mg/dL, a zero low bound treated as no bound, unusable records marked with a reason, same-code records merged across sources with provenance. RxNav lookups use exact normalized-name match only, cached in `fixtures/rxnav-cache.json`.
- `scripts/record-fixtures.ts`: every demo subject, the 403/410/429 responses and the connect sessions, saved to `fixtures/finchnode/`.
- Rules R1 to R5 with evidence and fingerprints; every number in `src/rules/config.ts`. `fixtures/answer-key.json` for Harriet matches: R1 flag, R2 checked, R3 flag, R4 flag, R5 skipped.
- Context packet builder and `npm run packet -- <subject> [--live]`. Harriet: age 78, checkinDate and dataAsOf 2026-09-01, usual heart-rate range 65 to 91 from 10 readings, open flags R1, R3, R4.
- Question bank with rotation (max 3 a day), skipping questions whose categories she didn't share.
- SQLite schema with migrations, flag lifecycle (new, told, noted, cleared), snapshots and their deletion when record consent ends.
- Express app: `/health`, raw-body placeholder at `/webhooks/relay` (501 until run 2), JSON errors without stack traces.
- 203 tests passing, offline.

**What was skipped or changed from spec:**
- Planning session before the build (with Michael) changed the spec: normalized FinchNode route, check-in date vs data as-of, heart-rate-only usual range, flag lifecycle, sharing levels. Docs and `CONTEXT.md` (new glossary) updated to match.
- Runtime raised from Node 20+ to 22.18+ (Node 20 is end of life; better-sqlite3 13 needs 22; lets Node run `.ts` without tsx).
- No ESLint: lint is a typecheck, to avoid a dependency outside the stack.
- "Not today" lives on the check-in message, not on each question (run 3 builds that message).
- Packet `age` and `dataAsOf` can be null (consent-partial shares no demographics).
- Built on branch `claude/workflow-review-deep-dive-3eaa2f`, not `main`.
- Work was split across five parallel agents (client tests, rules, packet, database, server) and integrated here.

**Files touched:**
- `apps/server/src/finchnode/*`: client, wire types, normalize and merge, RxNav cache, fixture loader.
- `apps/server/src/rules/*`: R1 to R5, config values, drug classes.
- `apps/server/src/context/*`: question bank and picker, context packet.
- `apps/server/src/db/*`: schema, migrations, flags, snapshots.
- `apps/server/src/{app,server,config}.ts`, `src/cli/packet.ts`: server, config, packet CLI.
- `apps/server/test/*`: 8 test files.
- `fixtures/finchnode/**`, `fixtures/rxnav-cache.json`, `fixtures/answer-key.json`.
- `scripts/record-fixtures.ts`, `scripts/package.json`.
- `docs/DESIGN.md`, `docs/BRIEF.md`, `CLAUDE_CODE_BRIEF.md`, `README.md`, `CONTEXT.md`, `.env.example`, `FEEDBACK.md`.

**Commits:**
- `docs: settle record route, dates, usual range, flags and sharing`: planning decisions and glossary.
- `build: run 1: scaffold, finchnode client, rules r1-r5, context packet`: this run.

**Recommended next step:**
Run 2 (build order step 3): Relay agent. Webhook signature check on the raw body, morning check-in with buttons and "Not today", answers saved to `checkins`, red-flag rules on answers, one new flag offered per day via `nextFlagToOffer`/`markOffered`, family group creation, missed check-in job. Needs `RELAY_AGENT_TOKEN` and `RELAY_WEBHOOK_SECRET` in `.env`.

**Open questions:** see `FEEDBACK.md` "Questions for the team" (R5 grace days, AFib, red-flag question rotation, R4 above range, records after the check-in date, flags on consent end, family message values, branches).
