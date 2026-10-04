# Mhacks_2026

A daily check-in companion for older adults living alone with several chronic conditions, built on FinchNode, Relay Messenger, Gemini, ElevenLabs speech APIs, and Presage.

**Status:** in progress (MHacks 2026)

## What it does

Each morning a Relay agent starts a short, friendly chat with at most three questions picked from the senior's FinchNode health record. She can choose a video call to describe symptoms conversationally: Relay carries the call, ElevenLabs transcribes and speaks, Gemini contextualizes the committed transcript with structured FinchNode records, and Presage can provide consented pulse and breathing estimates from video. Photos of hospital papers are checked against her medication list, and each family member follows along in their own Relay chat with the agent.

All data in this project is synthetic.

## Setup

Requires Node 22.18 or newer: the server runs its `.ts` files directly through Node's built-in type stripping, with no build step.

```sh
cd apps/server
npm install
cp ../../.env.example ../../.env   # optional for run 1
```

The `.env` file lives at the repo root. Run 1 needs no keys: the FinchNode demo API is open and every other value has a default.

For the Relay agent, set `PATIENT_RELAY_HANDLE` and `FAMILY_RELAY_HANDLES` in `.env`, then have the senior and each family member send the agent a message from their own Relay app. A Relay chat holds at most one person, so there is no family group: each family member gets updates in their own chat with the agent, starting once they have messaged it. `npm run relay:check` shows who has.

## Try it on your phone (about 10 minutes)

Each person runs their own agent: two programs on the same agent token take each other's messages.

1. Install the Relay app on your phone and sign up.
2. On your laptop: `npx relaymessenger@latest login`, then create your agent (pick your own handle, 3 to 32 lowercase letters, digits or underscores):
   ```sh
   npx relaymessenger agents create --handle yourname_checkin --name "Check-in Companion" --subtitle "Daily check-in assistant (AI)"
   ```
   It prints a `Profile:` name and your agent's link. Don't create a webhook subscription; the agent uses WebSocket.
3. Put the token in `.env` without showing it (repo root; replace `yourname_checkin` with your profile):
   ```sh
   cp .env.example .env && TOKEN="$(npx relaymessenger auth token --profile yourname_checkin)" && sed -i '' "s|^RELAY_AGENT_TOKEN=.*|RELAY_AGENT_TOKEN=$TOKEN|" .env && unset TOKEN
   ```
4. Get a Gemini API key at https://aistudio.google.com (free tier is fine to try; synthetic data only) and add it the same way:
   ```sh
   read -rs 'KEY?Gemini API key: ' && echo && sed -i '' "s|^GEMINI_API_KEY=.*|GEMINI_API_KEY=$KEY|" .env && unset KEY
   ```
   Without a key everything still works with buttons only.
5. In `.env`, set `PATIENT_RELAY_HANDLE` to your own Relay handle (you play Harriet). `FAMILY_RELAY_HANDLES` is optional (a second phone plays Sarah).
6. Open your agent's link on your phone and send it "hi". Relay won't let the agent message you until you've written first.
7. In `apps/server`: `npm run relay:check` (every line `[ok]`), then:
   ```sh
   CLOCK_DATE=2026-09-01 FOLLOW_UP_DELAY_MINUTES=2 npm run agent -- --checkin-now
   ```
   The check-in arrives on your phone. Type naturally ("ankles a bit puffy, slept ok") or tap. `CLOCK_DATE` pins the demo day (use a new date for each fresh check-in); `FOLLOW_UP_DELAY_MINUTES=2` makes the same-day follow-up arrive in 2 minutes instead of 3 hours. Stop with Ctrl-C.

The commands above are for macOS (`sed -i ''`, zsh `read`). Your conversation is stored in `apps/server/data/app.db` (not in git).

### Optional: care summaries over Photon

Off by default and not part of the MVP. After each check-in the doctor and the emergency contact can get a text over [Photon](https://photon.codes/docs/spectrum-ts/getting-started) (iMessage). To try it: copy `care-contacts.example.json` to `care-contacts.json` with their numbers, set `SPECTRUM_PROJECT_ID` and `SPECTRUM_PROJECT_SECRET` in `.env`, have both contacts text the Photon line once, then run the agent. Preview with `npm run care:send -- --day 2026-09-01 --dry-run`.

## Usage

All commands run in `apps/server`.

| Command | What it does |
| --- | --- |
| `npm test` | Runs the test suite (vitest). |
| `npm run lint` | Typechecks the project (`tsc --noEmit`). |
| `npm run packet -- patient-demo-polypharmacy` | Prints Harriet's context packet built from the recorded fixtures. Add `--live` to read the FinchNode demo API instead. |
| `npm run care:send -- [--day YYYY-MM-DD] [--dry-run] [--templates]` | Texts a day's care summaries to the doctor and the emergency contact over Photon (once per day; `--dry-run` only prints them; `--templates` skips Gemini). |
| `npm run record-fixtures` | Re-records the fixtures in `fixtures/` from the FinchNode demo API. |
| `npm run dev` | Starts the server on `PORT` (default 3000): `GET /health`, and the doctor report at `GET /report/<patientId>[?day=YYYY-MM-DD]` from `DATABASE_PATH`. `/webhooks/relay` answers 501. |
| `npm run report -- [--day YYYY-MM-DD] [--db path] [--out file.html]` | Writes the doctor report for the 7 days ending on `--day` (default her latest check-in) and prints its path (default `data/report-<day>.html`). See "Doctor report". |
| `npm run relay:check` | Checks your Relay setup: token, no webhook subscriptions, who has messaged the agent. |
| `npm run agent` | Runs the Relay agent (WebSocket, daily scheduler, free text through Gemini). `--checkin-now` sends today's check-in right away. |
| `npm run llm:check` | One live call of each Gemini job, with timings. |
| `npm run content:eval` | Runs 145 realistic messages (history questions and answers that need the context digest included) through the safety screen and Gemini; writes `docs/content-eval.md`. |

### Simulator

`npm run simulate` runs Harriet's morning check-in in the terminal, with no phones: her chat ("Harriet's phone") and each family member's own chat with the agent ("Sarah's phone (family)") print as separate panes, and you type her replies. Family members start already linked, as if they had messaged the agent; `--family sarah,tom` sets who they are (default `sarah`). A number taps that button on her latest message; any other text is sent as her message. Synthetic data, offline by default (recorded fixtures; `--live` reads the FinchNode demo API).

```
npm run simulate -- [subject] [--day YYYY-MM-DD] [--db path] [--reset] [--live] [--script file] [--sharing status|status_vitals|all] [--family sarah,tom]
```

- Days carry over in `data/simulator.db`; `--reset` deletes that file first. `--day` defaults to `CLOCK_DATE`, else her data as-of date (2026-09-01).
- Commands: `/next` (next day), `/day YYYY-MM-DD`, `/noon` (missed check-in job), `/flags`, `/sharing <level>`, `/paper` (discharge paper read-back and R6 check), `/db`, `/help`, `/quit`.
- Photon, faked with the example contacts:
  - `/summary` texts the day's care summaries.
  - `/doctor <text>` and `/family <text>` text back as the doctor or the emergency contact.
  - With `--photon`, the summaries also go out on their own when a day ends, as in the agent.
  - Demo: `npm run simulate -- --reset --photon --script ../../scripts/demo/harriet-care-summary.txt`.
- `--script file` runs one input per line (`#` comments) and exits, non-zero if any input failed. Demo backups live in `scripts/demo/`, for example `npm run simulate -- --reset --script ../../scripts/demo/harriet-day1.txt`.

### Doctor report

A printable summary of one week for her doctor (US letter, two pages), laid out like a clinical summary for a visit: her identifiers and active problems, the week at a glance, what she reported by severity level with dates and her own words (Subjective), camera wellness estimates and labs from her record (Objective), her medications as a reconciliation table with this week's label photos, refills and hospital-paper differences, items for clinician review (rule flags R1 to R6 with their evidence), and her questions for the visit. Fixed wording from the data only: no diagnosis, no dosing advice. Example: [docs/examples/doctor-report-example.html](docs/examples/doctor-report-example.html) (synthetic).

From a simulated week (`scripts/demo/harriet-week.txt`, Aug 26 to Sep 1, 2026):

```
npm run simulate -- --reset --day 2026-08-26 --script ../../scripts/demo/harriet-week.txt
npm run report -- --db ../../data/simulator.db
# -> data/report-2026-09-01.html; open it and print (Background graphics on)
```

The shareable link, served locally from the same database:

```
DATABASE_PATH=../../data/simulator.db npm run dev
# -> http://localhost:3000/report/harriet (or ?day=2026-08-30 for another week)
```

`--patient <id>` picks a patient when the database has several (default: the first). The report reads the database and her stored record copy only; nothing is sent anywhere.

## How it works

- What and why: [docs/BRIEF.md](docs/BRIEF.md)
- How: [docs/DESIGN.md](docs/DESIGN.md)
- Glossary of domain terms: [CONTEXT.md](CONTEXT.md)

## Working on it

- One branch per piece of work, a pull request into `main`, CI green, then a merge commit. `CLAUDE.md` has the rules Claude Code follows in your clone.
- Test with [docs/QA.md](docs/QA.md). "Done" is [docs/DEFINITION_OF_DONE.md](docs/DEFINITION_OF_DONE.md). Product and medical questions go in [FEEDBACK.md](FEEDBACK.md).
- If you ran the `photon/care-summaries` or `lane3/presage-spike` branch, delete `data/*.db` and `apps/server/data/*.db` once: the database migrations were renumbered when those branches merged.

## License

MIT
