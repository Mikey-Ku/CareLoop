# Team plan

How we split the rest of the build so five people (and their Claude Code sessions) can work at once without stepping on each other. Pick a lane, put your name in the Owner column (edit this file in a small PR, or tell the team chat), and read your lane's section.

**If you are an AI coding agent:** read `CLAUDE_CODE_BRIEF.md` (run protocol), `CONTEXT.md` (glossary), then only your lane's section below and the "How we work" rules. Stay inside your lane's files; the shared files table says how to touch anything else. Work on a lane branch and finish with a pull request, never a push to `main`. If the person didn't say which lane is theirs, ask.

## Where we are

Done and on `main` (run 1 to run 2c, see `RUN_LOG.md`):

- FinchNode client, rules R1 to R6, flags, context packet.
- Check-in engine: questions (red-flag questions on a cadence: every other day, daily for 3 days after a worrying answer), red flags that tell her who was alerted and always reach the family, one flag offer a day, sharing changes, paper check, missed check-in, stale button taps re-prompt.
- Team decisions from 2026-10-03 are built: records after the check-in date ignored, AFib readings are estimates with no usual-range comparison, flags deleted when record access ends, a one-time welcome for each family member.
- Relay agent over WebSocket, scheduler, `npm run agent`, `npm run relay:check`. Tested with a fake Relay only.
- Terminal simulator (`npm run simulate`) and scripted demos in `scripts/demo/`.
- CI: typecheck and tests on every push and pull request.

Not built: voice calls, vitals, reading paper photos, family voice messages, the doctor's visit-prep sheet.

## Lanes

| Lane | Owner | Builds | Needs | Blocked by |
| --- | --- | --- | --- | --- |
| 1. Relay live | | Real phones end to end; platform fixes | Relay token, 2 phones | Nothing. Start here |
| 2. Voice calls | | "Call me to chat" (build step 4) | ElevenLabs key and agent | Lane 1 to test on phones |
| 3. Vitals | | "Check my vitals" video call (build step 5) | Presage key | The Presage spike |
| 4. Papers and doctor sheet | | Paper photo reading (step 6), visit-prep sheet (step 8) | Anthropic key | Nothing to start |
| 5. Family and demo | | Family voice messages (step 7), demo script and pitch | Nothing to start | Lane 1 to test on phones |

Fewer than five people: merge 2 and 3 (both are Relay calls), then 4 and 5.

Every lane can start now against mocks and the simulator. Keys only matter for the last mile.

### 1. Relay live

Goal: the morning check-in runs on two real phones.

- Create the agent (`npx relaymessenger@latest login`, then Relay Console). No webhook subscription.
- Fill `.env`: `RELAY_AGENT_TOKEN`, `PATIENT_RELAY_HANDLE`, `FAMILY_RELAY_HANDLES`. Each phone sends the agent "hi" first.
- `npm run relay:check`, then `npm run agent -- --checkin-now`. Fix whatever the real SDK disagrees with (unverified: `contact.added` order, full-sync paging, webhook-conflict behaviour).
- Then run a whole day for real: check-in, a red flag reaching the family chat, the noon missed alert, a sharing change.
- Files: `src/relay/*`, `src/agent.ts`, `src/scheduler.ts`, `src/cli/relay-check.ts`, `src/config.ts`.
- Done when: every scenario in `scripts/demo/` also works on the phones.

### 2. Voice calls

Goal: Harriet taps "Call me to chat" and talks to a warm ElevenLabs voice that knows her context packet, says it is an AI, keeps it short and ends by pointing her to family.

- Create the ElevenLabs agent in its dashboard (prompt rules in `FEEDBACK.md`). `.env`: `ELEVENLABS_API_KEY`, `ELEVENLABS_AGENT_ID`.
- Answer Relay's `call.created` within 32 seconds with `@relaymessenger/elevenlabs`; pass the context packet as initiation data. Reference: Relay-SDK `cookbook/elevenlabs-agents-call`.
- After the call, save what she shared to `memories` (the packet already reads them).
- Files: new `src/calls/*`. Adds the "Call me to chat" button: a small PR to `engine.ts` and `copy.ts`.
- Done when: a real call from Harriet's phone works and a memory shows up in the next day's packet.

### 3. Vitals

Goal: Harriet taps "Check my vitals", sits still for a minute on a video call, and hears her heart rate and breathing rate.

- First, the spike: try `@smartspectra/node-sdk` (npm, has a Mac build) with raw frames from Relay's `VideoStream`. Compare with Presage's own app, same person, same minute. Write the result in `FEEDBACK.md`. If frames don't work, fall back to the scan screen.
- Save readings to `vitals_readings`. Harriet has AFib, so her reading is reported as an estimate with no "in or outside your usual range" (`usualRange.compareHeartRate` in the packet). Never show blood pressure or HRV.
- Family sees it at sharing level "status_vitals" or "all" (`familyDailyStatus` already takes `vitals`).
- Files: new `src/vitals/*` (or `services/presage-bridge/` if it must be a sidecar). Small PR to `engine.ts` for the button.
- Done when: a real reading is spoken back and lands in the family update.

### 4. Papers and doctor sheet

Goal: a photo of discharge papers becomes the paper check that already works in the simulator; and the doctor gets a one-page visit-prep sheet.

- Claude vision turns a photo into `ExtractedPaper` (`src/rules/paper-diff.ts`), validated with zod, then `engine.startPaperCheck`. Test with a photo of the printed `fixtures/papers/harriet-discharge.html`. `.env`: `ANTHROPIC_API_KEY`.
- Relay delivers photos as a media part with a signed URL valid 60 minutes; the inbox currently skips media (TODO in `src/relay/inbox.ts`). Coordinate that hook with lane 1.
- Visit-prep sheet: printable HTML for her doctor with noted flags and their evidence, her questions, heart-rate readings. This is the clinician-facing piece FinchNode's prompt asks for.
- Files: new `src/llm/*`, `src/report/*`.
- Done when: the printed sheet, photographed on a phone, ends with the aspirin flag on Harriet's "ask my doctor" list, and the visit-prep sheet shows it.

### 5. Family and demo

Goal: voice messages between Harriet and her family, and a demo that lands.

- Voice memos: Harriet sends one, the agent forwards it to each family chat, and back the other way (Relay chats hold one person, see `docs/adr/0001`). The `Messenger` contract needs attachments: small PR to `src/relay/messenger.ts`, coordinated with lane 1.
- Demo: write `docs/DEMO.md` (a 3-minute script built on R1: her kidney numbers falling while on metformin, from flag to "I'll ask my doctor" to the visit-prep sheet). Rehearse in `npm run simulate`. Print the discharge sheet. Check the MHacks prize tracks and name each sponsor's part in the pitch. Confirm the R3 and R4 wording against a drug interaction reference.
- Files: new `src/family/*`, `docs/DEMO.md`, `scripts/demo/*`.
- Done when: a voice memo goes both ways on real phones, and the demo runs start to finish twice in a row.

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

- One branch per piece of work: `lane2/call-handler`, `lane4/vision`. Never push to `main` directly.
- Open a pull request into `main`. CI must be green. Someone from another lane skims it, then merge it with a merge commit.
- `git pull --rebase origin main` often, and always right before merging.

### Claude Code

Open Claude Code in your clone and say:

> Read CLAUDE_CODE_BRIEF.md and docs/TEAM_PLAN.md. I own lane N (name). Start the next run for my lane.

Your session works on your lane's branch, appends to `RUN_LOG.md` with your lane in the heading, and opens a pull request at the end instead of pushing to `main`.

### Shared files (the only places we can collide)

| File | Rule |
| --- | --- |
| `src/checkin/engine.ts` | Small PRs only; say in the team chat before you start; rebase right before merging |
| `src/checkin/copy.ts` | Every word Harriet or her family reads lives here. Add exports freely; never change an existing signature |
| `src/relay/messenger.ts`, `src/checkin/engine-types.ts` | Contracts. Add, don't change; tell lane 1 |
| `src/db/schema.ts` | Append a migration, never edit a merged one. If someone merged a migration before you, move yours after theirs when you rebase |
| `RUN_LOG.md`, `FEEDBACK.md` | Append only; merge conflicts here are fine to resolve by keeping both |

### Questions

- Product or medical questions: `FEEDBACK.md` "Questions for the team".
- "Who is touching X": the team chat.
- Rules that never bend: synthetic data only, secrets only in `.env`, rules decide what is risky and the LLM only words it, no dosing advice, no em dashes in anything a person reads.

## Milestones (in order)

1. A real morning check-in on Harriet's phone, with the family update on Sarah's (lane 1).
2. A real voice call (lane 2).
3. A real vitals reading (lane 3).
4. A photographed discharge sheet raising the aspirin flag (lane 4).
5. A voice memo both ways, then two clean demo run-throughs (lane 5, everyone).
