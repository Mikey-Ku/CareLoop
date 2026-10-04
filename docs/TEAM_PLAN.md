# Team plan

How we split the rest of the build so everyone (and their Claude Code sessions) can work at once without stepping on each other. The goal is the five MVP features in `docs/BRIEF.md`. Pick a lane, put your name in the Owner column (edit this file in a small PR, or tell the team chat), and read your lane's section.

**If you are an AI coding agent:** read `CLAUDE_CODE_BRIEF.md` (run protocol), `CONTEXT.md` (glossary), then only your lane's section below and the "How we work" rules. Stay inside your lane's files; the shared files table says how to touch anything else. Work on a lane branch and finish with a pull request, never a push to `main`. If the person didn't say which lane is theirs, ask.

## Where we are

Done and on `main` (see `RUN_LOG.md`):

- FinchNode client, rules R1 to R6, flags, context packet; everything stored locally in SQLite and tied to her FinchNode record.
- **Text check-in, live on a real phone through Relay:** open question first ("How are you feeling today?"), buttons as a fallback, typed replies read by Gemini (cheap lite models), the severity ladder 0 to 5 (no alarm for small things), a fixed safety screen (988, 911), notes for the doctor, same-day follow-ups, family chats, sharing levels.
- Paper photo check logic (rule R6) and a printable synthetic discharge sheet.
- Terminal simulator, scripted demos, content eval (119 messages), CI.

Not built: the video call (ElevenLabs and Presage), the medication helper, the doctor report, family replies.

## Done means done

`docs/DEFINITION_OF_DONE.md` lists the benchmarks for every feature. A lane is finished when its benchmarks pass, with the evidence in the pull request.

## Lanes (three, one per group of MVP features)

| Lane | Owner | MVP features | Needs | Waits on |
| --- | --- | --- | --- | --- |
| A. Check-in and medicines | Michael | 2 Text check-in (polish), 3 Medication helper | Relay token, Gemini key | Nothing |
| B. Video call | | 1 Video check-in call | ElevenLabs key and agent, Presage key | The Presage spike (`lane3/presage-spike`) |
| C. Doctor and family | | 4 Doctor report, 5 Family updates, the demo | Gemini key for the report's wording (optional) | Nothing: a week of data comes from the simulator |

Old lane names map like this: lanes 1 and part of 4 became A, lanes 2 and 3 became B, lanes 4 (report) and 5 became C. Existing branches keep their names.

Every lane can start now against mocks and the simulator. Keys only matter for the last mile.

### A. Check-in and medicines

Goal: the text check-in feels natural and never breaks, and Harriet gets help with her medicines every morning.

- **Text check-in polish:** answer mapping at least 90% in the content eval (84% now), the "Got it" line and suggested confirms reading well on the phone, family update on a second phone, noon alert and a sharing change tested live.
- **Morning medication reminder:** from her FinchNode medications, the ones taken in the morning (from each prescription's instructions), read back in plain words ("Your morning medicines: apixaban 5 mg, 1 tablet; metoprolol 50 mg, 1 tablet; ..."), then "Have you taken them?". A missed answer joins the daily status.
- **"Do you remember how many?":** for one medicine a day, ask her; confirm or gently correct by reading the label instructions back. Never a new instruction.
- **Photo of a bottle or label:** Gemini reads it (medicine, strength, instructions); the agent checks it against her record and says whether it matches. Mismatch: "These don't match. Please check with your pharmacist." Reuse the paper-check flow (`src/checkin/paper-flow.ts`, `src/rules/paper-diff.ts`).
- **Refill reminders:** from fill dates and days supply (rule R5's data); a few days before running out: a reminder, a ready-to-read refill request, and "Want me to let Sarah know?".
- Files: `src/checkin/*`, new `src/meds/*`, `src/llm/*` (photo reading).
- Done when: the benchmarks for features 2 and 3 pass.

### B. Video call

Goal: Harriet calls the agent from its Relay chat, has a short warm voice conversation that does her check-in, and hears her heart rate.

- **Presage spike first** (`lane3/presage-spike`): `@smartspectra/node-sdk` with raw frames from Relay's `VideoStream`; compare with Presage's own app, same person, same minute. If frames don't work, use the fallback scan screen. Write the result in `FEEDBACK.md`.
- **The call:** answer Relay's `call.created` within 32 seconds with `@relaymessenger/elevenlabs`; pass the context packet (her questions for today, memories, usual range) as initiation data. The ElevenLabs agent's prompt: says it is an AI, keeps it short, covers today's questions conversationally, never gives medical or dosing advice, ends by pointing to her family. Reference: Relay-SDK `cookbook/elevenlabs-agents-call`.
- **Vitals during the call:** the voice guides her ("look at the camera and hold still for about a minute"), the frames go to Presage, and the voice says the heart rate back as an estimate (no usual-range comparison for AFib). Save it in `vitals_readings`. Never blood pressure or HRV.
- **After the call:** run the transcript through `extractCheckin` and the severity ladder (`src/checkin/severity.ts`) so spoken answers are recorded exactly like typed ones; safety screen first.
- Files: new `src/calls/*`, new `src/vitals/*` (or `services/presage-bridge/`), one small PR to `engine.ts` (as built: she calls the agent herself; there is no "Call me" button).
- Done when: the benchmarks for feature 1 pass.

### C. Doctor and family

Goal: her doctor gets a clear weekly picture, her family stays informed, and the demo lands.

- **Doctor report:** one printable page from the local database and her FinchNode record: who she is and her conditions; the week's symptoms by severity level with dates and her own words (`symptom_observations`, `checkin_notes`); vitals (`vitals_readings`); her questions for the visit (`visit_questions`); flags with their evidence (record and date); medicines and refill status. A shareable link (`npm run dev` can serve it). Optional: a FHIR bundle export.
- **Family updates:** today the agent sends status and alerts to each family chat. Add: family replies passed to Harriet ("Sarah says: ..."), and a short weekly family summary if time allows. SMS or iMessage only after everything else.
- **Demo:** `docs/DEMO.md`, a 3-minute script across the five features (suggested arc: a natural text check-in, a video call with a heart-rate reading, a photographed pill bottle, then the doctor report showing it all). Rehearse with the simulator; record a backup.
- Files: new `src/report/*`, `src/family/*`, `docs/DEMO.md`.
- Done when: the benchmarks for features 4 and 5 and the demo pass.

## How we work

### Setup (everyone, 5 minutes)

```bash
git clone https://github.com/Mikey-Ku/Mhacks_2026.git
cd Mhacks_2026/apps/server
npm install
npm test
npm run simulate -- --reset
```

Copy `.env.example` to `.env` at the repo root. Keys are shared privately (a DM or a password manager), never in the repo or a public channel. You only need your lane's keys.

### Git

- One branch per piece of work: `laneA/med-reminders`, `laneB/call-handler`, `laneC/doctor-report`. Never push to `main` directly.
- Open a pull request into `main`. CI must be green. Someone from another lane skims it, then merge it with a merge commit.
- `git pull --rebase origin main` often, and always right before merging.

### Claude Code

Open Claude Code in your clone and say:

> Read CLAUDE_CODE_BRIEF.md, docs/BRIEF.md and docs/TEAM_PLAN.md. I own lane A, B or C (name). Start the next run for my lane.

Your session works on your lane's branch, appends to `RUN_LOG.md` with your lane in the heading, and opens a pull request at the end instead of pushing to `main`.

### Shared files (the only places we can collide)

| File | Rule |
| --- | --- |
| `src/checkin/engine.ts` | Small PRs only; say in the team chat before you start; rebase right before merging |
| `src/checkin/copy.ts` | Every word Harriet or her family reads lives here. Add exports freely; never change an existing signature |
| `src/relay/messenger.ts`, `src/checkin/engine-types.ts`, `src/llm/types.ts` | Contracts. Add, don't change; tell lane A |
| `src/db/schema.ts` | Append a migration, never edit a merged one. If someone merged a migration before you, move yours after theirs when you rebase |
| `RUN_LOG.md`, `FEEDBACK.md` | Append only; merge conflicts here are fine to resolve by keeping both |

### Questions

- Product or medical questions: `FEEDBACK.md` "Questions for the team".
- "Who is touching X": the team chat.
- Rules that never bend: synthetic data only, secrets only in `.env`, rules decide what is risky and the LLM only words it, no dosing advice, no em dashes in anything a person reads.

## Milestones (in order)

1. Text check-in smooth on the phone, family update on a second phone (lane A).
2. Presage spike result written down (lane B).
3. Morning medication reminder live (lane A).
4. A real video call with a voice check-in (lane B).
5. Doctor report from a simulated week (lane C).
6. Heart rate read during the call (lane B).
7. Photographed pill bottle checked against her record (lane A).
8. Two clean demo run-throughs (everyone).
