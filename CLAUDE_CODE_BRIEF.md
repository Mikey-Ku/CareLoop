# Claude Code Brief: Senior Check-in Companion (MHacks 2026)

## For Claude Code: read this first

You are building this project across multiple sessions. Three files in this folder are your state:

- `CLAUDE_CODE_BRIEF.md` (this file): the spec. Don't modify it.
- `RUN_LOG.md`: your memory across runs. Read it at the start, append to it at the end.
- `FEEDBACK.md`: the team's notes between runs. Read it at the start, mark items `[done]` as you address them.

Full spec: `docs/BRIEF.md` (what and why) and `docs/DESIGN.md` (how). Glossary: `CONTEXT.md`. Who builds what: `docs/TEAM_PLAN.md` (lanes). Read them before your first run; after that, rely on `RUN_LOG.md` instead of re-reading the whole codebase.

This folder is a git repo with a GitHub remote (`Mikey-Ku/Mhacks_2026`). Several teammates run Claude Code at once, each on their own lane (`docs/TEAM_PLAN.md`). Work on your lane's branch and open a pull request; never push to `main` directly.

**At the start of EVERY run:**
1. Read this file and `docs/TEAM_PLAN.md`. Ask which lane you are working on if the person didn't say.
2. `git fetch origin`, then create or update your lane branch from `origin/main` (for example `git switch -c lane2/call-handler origin/main`, or `git pull --rebase origin main` on an existing lane branch).
3. Read `RUN_LOG.md` if it exists.
4. Read `FEEDBACK.md`. Unresolved items under "For Claude Code" take priority over the build order. Items under "Team tasks" are for humans; don't attempt them.
5. State your plan for this run in 3 to 5 bullets before starting.

**During the run:**
- Commit regularly with conventional commit messages (`feat:`, `fix:`, `refactor:`, `docs:`, `chore:`, `test:`).
- If you hit real ambiguity, STOP. Write a clear question in `FEEDBACK.md` under "## Questions for the team". Commit, push, end the run cleanly.

**At the end of EVERY run:**
1. Append a section to `RUN_LOG.md` (format at the bottom of this file, with your lane in the heading).
2. Mark addressed FEEDBACK items with `[done]`.
3. `git add -A`
4. `git commit -m "build: <lane>: <one-line summary>"`
5. `git pull --rebase origin main`, run `npm run lint && npm test` in `apps/server` again, then `git push -u origin <your branch>`.
6. Open a pull request into `main` (`gh pr create`) and confirm it was created. Merging happens after CI is green and a teammate has looked.

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

Each morning a Relay agent sends a short, friendly chat with buttons and at most 3 questions picked from the senior's FinchNode record. She can then choose a voice call to talk (ElevenLabs) or a video call to check her vitals (Presage heart rate compared with her usual range from the record; breathing rate recorded). Photos of hospital papers are read back and checked against her medication list, voice messages are passed between her chat and her family's chats, and the family gets a heads-up if she doesn't check in by noon.

## Architecture

See `docs/DESIGN.md` sections "Architecture", "FinchNode", "Rules engine", "Context packet", "Database". Short version: Relay carries every chat, call and photo; our backend builds each reply from FinchNode's record plus our own SQLite notes, hands call audio to ElevenLabs, and sends call video frames to Presage.

## Tech stack

Node 22.18+ and TypeScript (strict, `.ts` run directly), Express, SQLite via `better-sqlite3`, `zod`, `vitest`, `@relaymessenger/sdk`, `@relaymessenger/elevenlabs`, `@anthropic-ai/sdk`, NLM RxNav REST API, Presage SmartSpectra SDK (later run). Full table in `docs/DESIGN.md`. Use npm.

## What to build

Runs 1 to 2c are done (see `RUN_LOG.md`). The remaining work is split into lanes in `docs/TEAM_PLAN.md`: 1 Relay live, 2 Voice calls, 3 Vitals, 4 Papers and doctor sheet, 5 Family and demo. Each lane lists its goal, files, keys and definition of done. Stay inside your lane's files; the shared files table in `docs/TEAM_PLAN.md` says how to touch `engine.ts`, `copy.ts`, the contracts and migrations.

Build against mocks and the simulator first (`npm run simulate`); keys in `.env` are only needed for the last step of each lane. Tests stay offline.

## Full build order (context only)

1. Done. Scaffold, FinchNode client, fixtures, tests.
2. Done. Context packet, question picker, rules R1 to R5, answer key test.
2a to 2c. Done. Check-in engine, simulator, Relay WebSocket agent, scheduler, family chats, CI.
3. Lane 1: Relay agent live on phones.
4. Lane 2: chat call, ElevenLabs bridge on `call.created`, context packet as initiation data, memories saved.
5. Lane 3: vitals call, Relay video frames into Presage.
6. Lane 4: hospital paper check from a photo (Claude vision into the existing paper check).
7. Lane 5: family voice messages both ways.
8. Lanes 4 and 5: visit-prep sheet, weekly summary, demo helpers.

## Constraints

From `docs/BRIEF.md`: synthetic data only; FinchNode is read-only; no diagnosis or dosing advice; Presage readings from call video are a wellness estimate and blood pressure/HRV are never shown; at most 3 questions a day; "Not today" never gets a guilt message; the voice says it is an AI; no voice cloning; secrets only in `.env`.

## Repo conventions

- Layout as in `docs/DESIGN.md` "Repo layout".
- Commits: imperative mood, lowercase, no trailing period, conventional prefix. Body explains why.
- Work on a lane branch and merge through pull requests (`docs/TEAM_PLAN.md`).
- README: name and one-line pitch, status, what it does, setup, usage, how it works (link to docs/DESIGN.md), license (MIT).
- `.gitignore` must cover `.env`, `.env.local`, `node_modules/`, `*.db`, `.DS_Store`, `.idea/`, `.vscode/`, build output.
- No em dashes in docs or user-facing copy.

## End-of-run protocol

Append to `RUN_LOG.md`:

```
## <Lane name>: <YYYY-MM-DD HH:MM>

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
git commit -m "build: <lane>: <one-line summary>"
git pull --rebase origin main
git push -u origin <your branch>
gh pr create --base main
```
