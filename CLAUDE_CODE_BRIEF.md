# Claude Code Brief: Senior Check-in Companion (MHacks 2026)

## For Claude Code: read this first

You are building this project across multiple sessions. Three files in this folder are your state:

- `CLAUDE_CODE_BRIEF.md` (this file): the spec. Don't modify it.
- `RUN_LOG.md`: your memory across runs. Read it at the start, append to it at the end.
- `FEEDBACK.md`: the team's notes between runs. Read it at the start, mark items `[done]` as you address them.

Full spec: `docs/BRIEF.md` (what and why) and `docs/DESIGN.md` (how). Read both before the first run; after that, rely on `RUN_LOG.md` instead of re-reading the whole codebase.

This folder is a git repo with a GitHub remote (`Mikey-Ku/Mhacks_2026`). The team pulls on other machines, so push at the end of every run.

**At the start of EVERY run:**
1. Read this file.
2. `git pull --rebase`.
3. Read `RUN_LOG.md` if it exists.
4. Read `FEEDBACK.md`. Unresolved items under "For Claude Code" take priority over the build order. Items under "Team tasks" are for humans; don't attempt them.
5. State your plan for this run in 3 to 5 bullets before starting.

**During the run:**
- Commit regularly with conventional commit messages (`feat:`, `fix:`, `refactor:`, `docs:`, `chore:`, `test:`).
- If you hit real ambiguity, STOP. Write a clear question in `FEEDBACK.md` under "## Questions for the team". Commit, push, end the run cleanly.

**At the end of EVERY run:**
1. Append a section to `RUN_LOG.md` (format at the bottom of this file).
2. Mark addressed FEEDBACK items with `[done]`.
3. `git add -A`
4. `git commit -m "build: run <N>: <one-line summary>"`
5. `git push`
6. Confirm in the terminal that the push succeeded.

**Things you must NOT do:**
- Don't force-push or rewrite history.
- Don't add dependencies outside the tech stack in `docs/DESIGN.md` without asking (write the question to FEEDBACK.md).
- Don't refactor working code unless feedback asks for it.
- Don't rename or move files without asking.
- Don't delete files.
- Don't change repo visibility or settings.
- Don't run destructive shell commands.
- Don't use or fetch real patient data. Only FinchNode's demo API (`https://api.finchnode.com/demo/v1`) or a sandbox key starting with `ck_test_`.
- Don't put secrets in code, tests, fixtures, logs or commits. Secrets live in `.env` only.
- Don't let the LLM decide what is medically risky. Rules decide; the LLM only words the message.
- Don't write medical thresholds that aren't in `docs/DESIGN.md`. Make them config values and ask.
- Don't write to any `docs/learning_log/` folder.

---

## What we're building

A daily check-in companion for older adults who live alone with several chronic conditions.

Each morning a Relay agent sends a short, friendly chat with buttons and at most 3 questions picked from the senior's FinchNode record. She can then choose a voice call to talk (ElevenLabs) or a video call to check her vitals (Presage heart rate compared with her usual range from the record; breathing rate recorded). Photos of hospital papers are read back and checked against her medication list, voice messages go to and from her family group, and the family gets a heads-up if she doesn't check in by noon.

## Architecture

See `docs/DESIGN.md` sections "Architecture", "FinchNode", "Rules engine", "Context packet", "Database". Short version: Relay carries every chat, call and photo; our backend builds each reply from FinchNode's record plus our own SQLite notes, hands call audio to ElevenLabs, and sends call video frames to Presage.

## Tech stack

Node 20+ and TypeScript (strict), Express, SQLite via `better-sqlite3`, `zod`, `vitest`, `@relaymessenger/sdk`, `@relaymessenger/elevenlabs`, `@anthropic-ai/sdk`, NLM RxNav REST API, Presage SmartSpectra SDK (later run). Full table in `docs/DESIGN.md`. Use npm.

## Build order for THIS run

**Run 1: scaffold. Build order steps 1 and 2.** Both run without API keys.

Step 1. Scaffold the repo (TypeScript server in `apps/server`, lint, vitest, SQLite schema). FinchNode client for the demo API with typed models, scenario handling, normalization, source merge. Record fixtures. Tests.

Step 2. Context packet builder, question picker, rules R1 to R5, answer key test.

Details:

- `scripts/record-fixtures.ts`: fetch every demo patient and every behavior scenario from the demo API and save raw JSON to `fixtures/finchnode/`. Read `/scenarios` and `/scenarios/{id}` to learn how behavior scenarios are requested. If that is unclear, ask in FEEDBACK.md and build the rest from the record patients.
- Tests run against fixtures only, never the live API.
- Normalization: RxNorm codes kept; free-text drug names looked up through RxNav (cache results to a fixture so tests stay offline); weight in lb converted to kg; glucose in mmol/L converted to mg/dL; resources with no value or no date kept but marked unusable.
- Merge: same code from two sources becomes one item with both sources in its provenance; unit differences converted.
- Rules R1 to R5 exactly as specified in `docs/DESIGN.md`, each returning evidence (resource id, source, date, value).
- `fixtures/answer-key.json` for Harriet (`patient-demo-polypharmacy`) as written in `docs/DESIGN.md`, and a test that the rules match it.
- `npm run packet -- patient-demo-polypharmacy` prints Harriet's context packet as JSON.

Definition of done for this run:
- `npm install && npm test` passes in `apps/server`.
- Client tests cover all scenario behaviors in the `docs/DESIGN.md` table that the fixtures include.
- Rules output for Harriet matches `fixtures/answer-key.json`.
- `npm run packet -- patient-demo-polypharmacy` prints a sensible packet with `checkinDate` and `dataAsOf` both 2026-09-01 (demo clock, see `docs/DESIGN.md` "Dates").
- `README.md` has setup and test commands.
- RUN_LOG.md updated and pushed to origin.

## Full build order (context only; do NOT attempt all of it in one run)

1. **[THIS RUN]** Scaffold, FinchNode client, fixtures, tests.
2. **[THIS RUN]** Context packet, question picker, rules R1 to R5, answer key test.
3. Relay agent: webhook server with signature check, morning check-in with buttons, answers saved, family group, missed check-in job.
4. Chat call: ElevenLabs bridge on `call.created`, context packet as initiation data, memories saved, voice memo to family.
5. Vitals call: Relay video frames into Presage (team spike decides C++ sidecar vs fallback scan screen).
6. Hospital paper check: photo to Claude vision, read-back and confirm buttons, rule R6.
7. Family voice messages both ways, sharing levels, consent revocation flow.
8. Stretch and polish: visit-prep PDF, weekly summary, demo helpers.

Steps 3 to 7 need API keys and phones. Don't start them until FEEDBACK.md says the keys are in `.env`.

## Constraints

From `docs/BRIEF.md`: synthetic data only; FinchNode is read-only; no diagnosis or dosing advice; Presage readings from call video are a wellness estimate and blood pressure/HRV are never shown; at most 3 questions a day; "Not today" never gets a guilt message; the voice says it is an AI; no voice cloning; secrets only in `.env`.

## Repo conventions

- Layout as in `docs/DESIGN.md` "Repo layout".
- Commits: imperative mood, lowercase, no trailing period, conventional prefix. Body explains why.
- Work on `main`.
- README: name and one-line pitch, status, what it does, setup, usage, how it works (link to docs/DESIGN.md), license (MIT).
- `.gitignore` must cover `.env`, `.env.local`, `node_modules/`, `*.db`, `.DS_Store`, `.idea/`, `.vscode/`, build output.
- No em dashes in docs or user-facing copy.

## End-of-run protocol

Append to `RUN_LOG.md`:

```
## Run <N>: <YYYY-MM-DD HH:MM>

**Goal of this run:** <one line>

**What was built:**
- <bullet>

**What was skipped or changed from spec:**
- <bullet, or "none">

**Files touched:**
- <path>: <one-line summary>

**Commits:**
- <sha or message>: <description>

**Recommended next step:**
<what the next run should tackle>

**Open questions:** <link to FEEDBACK.md or "none">
```

Keep each entry under 200 lines. Then:

```bash
git add -A
git commit -m "build: run <N>: <one-line summary>"
git push
```
