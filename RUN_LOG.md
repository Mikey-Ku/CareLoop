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

## Run 2a: 2026-10-03 16:30

**Goal of this run:** Run the whole daily check-in end to end in a terminal, without Relay keys or phones, so run 2 only swaps the transport.

**What was built:**
- `Messenger` interface (`src/relay/messenger.ts`) and `FakeMessenger` (dedupes by idempotency key, validates Relay button limits).
- Check-in engine (`src/checkin/engine.ts`): `startDay` (snapshot, rules, flag sync, greeting), `handleInbound` (start, answers, "Not today", red flags, one flag offer per day with Tell me more / Later / I'll ask my doctor, family daily status), `runMissedCheckin`. Inbound message ids are recorded so webhook retries can't double-answer.
- Red-flag evaluator: answers in a question's red-flag list tell her to call her doctor and alert the family at every sharing level.
- Message copy (`src/checkin/copy.ts`) for an older reader: plain flag messages, family messages by sharing level, record-link-ended and sharing wording. Tests ban em dashes, guilt words, diagnosis language.
- R6 paper diff and read-back, a printable synthetic discharge sheet (`fixtures/papers/harriet-discharge.html`, aspirin stopped) and its extracted JSON and answer key.
- `npm run simulate`: Harriet's phone and the family group in one terminal; `/next`, `/noon`, `/day`, `/paper`, `/flags`, `/sharing`, `/db`; scripted runs in `scripts/demo/`.
- 313 tests passing (was 203); all five demo scripts exit 0.

**What was skipped or changed from spec:**
- R1 to R5 flag messages rewritten in plain words; R2 no longer names a dose to the senior (no dosing advice), the expected dose stays in `details`.
- Migration 2: checkins state columns and an `inbound_messages` table.
- Not yet: sharing-change chat flow, storing R6 as a flag, memories from free text.
- Work split across four parallel agents (engine, copy, paper check, simulator) against contracts written first.

**Files touched:**
- `apps/server/src/relay/{messenger,fake-messenger}.ts`, `src/checkin/{engine,engine-types,copy,red-flags,paper-check}.ts`, `src/rules/paper-diff.ts`, `src/db/{checkins,schema}.ts`, `src/cli/{simulate,simulator,sim-render}.ts`.
- `src/rules/index.ts` (plain messages, R6 id), `src/context/questions.ts` (one question reworded).
- Tests: engine, red-flags, db-checkins, copy, paper-diff, simulator; `db.test.ts` table list.
- `fixtures/papers/*`, `scripts/demo/*.txt`, `README.md` (Simulator), `docs/DESIGN.md`, `FEEDBACK.md`.

**Commits:**
- `feat: run 2a: check-in engine and terminal simulator`

**Recommended next step:**
Run 2 (Relay): a `RelayMessenger` implementing `Messenger` with `@relaymessenger/sdk`, the webhook route verifying the Standard Webhooks signature on the raw body and calling `engine.handleInbound`, family group creation, and a scheduler for `startDay` (CHECKIN_TIME) and `runMissedCheckin` (MISSED_CHECKIN_TIME). Needs Relay keys in `.env`.

**Open questions:** see `FEEDBACK.md` (911 line, stale taps, sharing flow, R6 as a flag, plus run 1 items).
