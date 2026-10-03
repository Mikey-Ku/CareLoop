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

## Run 2b: 2026-10-03 19:30

**Goal of this run:** Everything the real Relay agent needs that doesn't need a token: WebSocket transport, scheduler, `npm run agent`, `npm run relay:check`, CI, the sharing flow, paper-check flags, and family chats.

**What was built:**
- Relay over WebSocket (ADR 0002): `RelayMessenger` (text plus buttons in SDK 0.5.0 shape), a durable inbox that commits each event by `event_id` before the SDK ACKs, then turns `message.received` into `engine.handleInbound`, links Harriet and family members on `contact.added` (or their first message), and re-links chats on full sync. Refuses to start if any webhook subscription exists.
- Family chats, not a family group (ADR 0001): Relay chats hold at most one person, so each family member has their own chat with the agent and every family message goes to each linked one.
- Daily scheduler in the patient's timezone (DST-safe, CLOCK_DATE aware), late-start catch-up, `npm run agent` (`--checkin-now` for demos), `npm run relay:check` checklist.
- Sharing-change chat flow ("Sharing" any time, family told it changed, check-in resumes) and the paper check through the engine (read-back, confirm, R6 into the flag lifecycle).
- Config: relay and patient sections, token kept out of every error and printout.
- CI: GitHub Actions runs typecheck and tests on push and pull requests.
- Simulator: one pane per family member (`--family sarah,tom`), `/sharing` and `/paper` go through the engine; new demo `harriet-sharing.txt`.
- 453 tests passing (was 313); all six demo scripts exit 0.

**What was skipped or changed from spec:**
- Webhooks replaced by WebSocket; `RELAY_WEBHOOK_SECRET` no longer needed. New env: `PATIENT_RELAY_HANDLE`, `FAMILY_RELAY_HANDLES`, `PATIENT_FINCHNODE_SUBJECT`, `PATIENT_TIMEZONE`.
- Migrations 3 (`relay_events`, `relay_full_syncs`) and 4 (`family_members`); `patients.family_chat_id` unused.
- Nothing ran against real Relay (no token). Unverified until then: event order of `contact.added` vs first message, full-sync paging, SDK behaviour on a webhook conflict.
- Work split across four agents (transport; scheduler, agent and CI; sharing and paper; family chats) plus integration here.

**Files touched:**
- `apps/server/src/relay/{relay-client,relay-messenger,inbox}.ts`, `src/{agent,scheduler,patient-id,config}.ts`, `src/cli/relay-check.ts`, `src/checkin/{engine,engine-types,copy,paper-flow}.ts`, `src/db/{schema,family,paper-scans,checkins,index}.ts`, simulator files.
- Tests: relay-inbox, relay-transport, scheduler, config, agent, sharing, paper-flow, family, and updates to engine, copy, db, simulator.
- `.github/workflows/ci.yml`, `scripts/demo/*`, `README.md`, `docs/DESIGN.md`, `docs/BRIEF.md`, `docs/adr/0001`, `docs/adr/0002`, `CONTEXT.md`, `CLAUDE_CODE_BRIEF.md`, `.env.example`, `FEEDBACK.md`.

**Commits:**
- `feat: run 2b: relay websocket agent, scheduler, family chats, ci`

**Recommended next step:**
With a Relay token: `npm run relay:check`, then `npm run agent -- --checkin-now` on two phones, and fix whatever the real SDK disagrees with. Then build step 4 (ElevenLabs call on `call.created`, answered within 32 seconds; Relay-SDK `cookbook/elevenlabs-agents-call`).

**Open questions:** see `FEEDBACK.md` (flag "Later" consistency, family welcome message, plus earlier items).

## Run 2c: 2026-10-03 21:00

**Goal of this run:** Build the team's answers to the open questions, and write the team plan.

**What was built:**
- Red-flag questions on a cadence instead of rotation: due when never asked, every other day, and daily for 3 days after a worrying answer in the same group; at most 2 of the 3 slots (`QUESTION_CADENCE` in `questions.ts`, product values). Answer history from `answerHistory`; a not-today or missed day doesn't count as asked. The packet takes the same history.
- Red-flag advice names the family members who were told (display name, else handle), then "call your doctor today", then the 911 line; with no family linked it doesn't claim anyone was told. Family alerts ask them to call her today.
- `asOf`: records dated after the check-in date are ignored by rules, the packet, the paper diff and question picking.
- AFib: `usualRange.compareHeartRate` false with a plain note; family status shows the reading as an estimate with no in or out.
- R5 grace period confirmed at 7 days. "Later" after hearing a flag leaves it told for record and paper flags. Flags deleted with the record copy when record consent ends. One-time welcome to each family member on first link.
- Stale button taps: `checkin_prompts` (migration 5) records which sent message each step waits on; a tap on any other message re-sends the current prompt.
- `docs/TEAM_PLAN.md`: five lanes (Relay live, voice calls, vitals, papers and doctor sheet, family and demo), shared-file rules, branch-and-PR workflow. `CLAUDE_CODE_BRIEF.md` now has each session work on a lane branch and open a PR.
- 525 tests passing (was 453); all six demo scripts exit 0.

**What was skipped or changed from spec:**
- Run protocol changed: no more pushes to `main`; lane branches and pull requests.
- `apps/server/.vitest/` (a stale test report committed in run 1) untracked and ignored.
- Work split across two parallel agents (cadence, engine and stale taps; dates, AFib, copy, welcome) plus integration here.

**Files touched:**
- `apps/server/src/context/{questions,packet}.ts`, `src/checkin/{engine,engine-types,copy,paper-flow}.ts`, `src/db/{answer-history,checkins,flags,schema}.ts`, `src/finchnode/normalize.ts`, `src/rules/{index,paper-diff,config}.ts`, `src/relay/{inbox,relay-messenger}.ts`, `src/cli/simulator.ts`, tests, `scripts/demo/*`.
- `docs/TEAM_PLAN.md`, `docs/DESIGN.md`, `CLAUDE_CODE_BRIEF.md`, `CLAUDE.md`, `README.md`, `FEEDBACK.md`, `.gitignore`.

**Commits:**
- `feat: run 2c: red-flag cadence, family-first alerts, team plan`

**Recommended next step:**
Split by lanes in `docs/TEAM_PLAN.md`. Lane 1 (Relay live) first: token, two phones, `npm run relay:check`, `npm run agent -- --checkin-now`.

**Open questions:** `FEEDBACK.md` (red-flag cadence numbers).

## Run 2d: 2026-10-03 (branch photon/care-summaries)

**Goal of this run:** After the check-in (and, once lanes 2 and 3 land, the call), text a data summary to her doctor and a plain-language one to her emergency contact over Photon, and answer their replies in the right tone.

**What was built:**
- **Contacts:** `care-contacts.json` (copy of `care-contacts.example.json`, gitignored). It holds the doctor's and the emergency contact's names and numbers, normalized to E.164. It's validated without echoing values, and the example 555-01xx numbers leave the step off.
- **Facts and wording:**
  - `src/care/facts.ts` builds the day's `CareFacts` from the database.
  - `src/care/copy.ts` writes `doctorSummary` (data) and `familySummary` (plain words; only flags she has heard).
  - `src/care/copy.ts` also holds the fixed replies. The urgent family reply says to contact the doctor first, because an automated assistant lacks the medical knowledge to act on symptoms. It ends with the 911 line.
- **Service:** `src/care/service.ts` sends both summaries once per day. Each text is planned in `care_messages` before it's sent (migration 6 adds `care_summaries` and `care_messages`). A failure for one contact doesn't block the other.
- **Replies:** inbound texts are routed by phone number and deduped. Rules come first (acknowledgment, urgent family text, dose question, doctor asking it to act). Otherwise Claude (`src/care/claude-writer.ts`) words an answer from the frozen facts. `guardReply` checks it, and template answers are the fallback.
- **Transport:** `src/photon/` wraps the Spectrum SDK behind a small port, with a fake for tests and the simulator.
- **Engine and agent:**
  - The engine gets an optional `onDayFinished` hook. It is called after delivery, and its errors are swallowed.
  - The agent connects care when the contacts file and the Photon credentials are present. The noon job calls `ensureDaySummary`.
  - New `npm run care:send` CLI.
- **Simulator:** `/summary`, `/doctor <text>`, `/family <text>` and `--photon`. New demo script `scripts/demo/harriet-care-summary.txt`.
- 575 tests passing (was 525); lint clean.

**What was skipped or changed from spec:**
- Dependencies added, with approval: `@spectrum-ts/core`, `@spectrum-ts/imessage` and `@anthropic-ai/sdk`.
  - A top-level npm override pins Spectrum's TypeScript peer to the repo's TS 7.
  - The lockfile was generated with npm 10, because npm 11.5.1 drops the rolldown native bindings (npm/cli#4828).
- The emergency contact gets the full plain-language summary, whatever Harriet's Relay sharing level (team decision).
- In the simulator the automatic Photon send is opt-in (`--photon`), so existing simulator output is unchanged.
- Not tested against a live Photon line (no credentials). `connectPhoton` typechecks against the real Spectrum types.

**Files touched:**
- New: `apps/server/src/care/*`, `src/photon/*`, `src/db/care.ts`, `src/cli/care-send.ts`, `test/care.test.ts`, `test/care-contacts.test.ts`, `care-contacts.example.json`, `scripts/demo/harriet-care-summary.txt`.
- Additions only: `src/checkin/engine.ts` (hook), `src/agent.ts` (wiring), `src/db/schema.ts` (migration 6), `src/cli/{simulator,simulate,sim-render}.ts`, `test/db.test.ts` (table list), `package.json`, `package-lock.json`, `.env.example`, `.gitignore`, `README.md`, `docs/DESIGN.md`, `FEEDBACK.md`.

**Recommended next step:** Create the Photon project, fill in `care-contacts.json`, have both contacts text the line once, then `npm run care:send -- --dry-run` and `npm run agent -- --checkin-now`.

**Open questions:** `FEEDBACK.md` (Photon setup).
