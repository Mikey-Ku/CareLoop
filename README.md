# Check-in Companion

An AI caregiving companion for older adults who live alone: an easy daily check-in by chat or video call, and a summary that gives their doctor the context behind the numbers. Built for MHacks 2026 on FinchNode, Relay Messenger, Gemini, ElevenLabs and Presage. **All data is synthetic.** The demo patient is Harriet, 78 (atrial fibrillation, heart failure, kidney disease, 14 medicines), read from FinchNode's synthetic record.

## What it does

1. **Video check-in call.** Harriet calls the agent in Relay. It says it is an AI, asks how she is and the questions she has not answered, then offers a quiet 30-second camera reading of pulse and breathing (Presage), said back as an estimate. ElevenLabs hears and speaks; Gemini words the questions, with her FinchNode record as context; fixed rules decide anything medical.
2. **Text check-in.** Each morning, at most three questions picked from her FinchNode record, answered by tap or in her own words. A severity ladder sets the reaction, in fixed words: her doctor, her family, 911 or 988. Never dosing advice or a diagnosis.
3. **Medication helper.** Reminders read from her FinchNode record; a photo of a label is checked against her list (a mismatch sends her to her pharmacist, never "take this instead"); refill reminders.
4. **Doctor report.** One week as a two-page clinical summary: symptoms in her words, flags with their FinchNode evidence, medicines, labs.
5. **Family updates.** Each family member follows along in their own Relay chat, within her sharing settings. Urgent alerts go out at once, and their replies reach her.

## How FinchNode is used

FinchNode is the health record everything else reads, live and read-only (its open demo API, synthetic patients, no key). Harriet's record has 10 conditions, 14 medicines with RxNorm codes, labs and vitals.

- **Questions:** today's questions are chosen from her conditions and drug classes (heart failure: breathing and ankles; a blood thinner: bleeding).
- **Rules R1 to R6:** fixed rules read the labs and medicines for flags with their evidence: a falling kidney test on metformin, apixaban with aspirin and sertraline, potassium with lisinopril, a hospital paper that differs from the record.
- **Context:** the chat and the call get her record as reference facts, so the model has nothing to invent.
- **Report and updates:** the doctor report and the family updates cite it (record ID, data as of, sources).
- **Consent:** if FinchNode says her consent ended, the agent tells her in plain words and reads nothing more.

See it live: `npm run packet -- patient-demo-polypharmacy --live`.

**Safety by design.** Rules decide every medical flag; the model only words things. Emergencies and self-harm get fixed replies (911, 988) from a phrase screen that runs before any model. Whatever the model writes for the voice is checked first, and it never gives dosing advice, a diagnosis or reassurance. A person is always pointed to.

## Setup

Node 24 LTS is what the demo was rehearsed on (Node 22.22.3 or newer also works; Node 25 runs but Vitest warns). The server runs its `.ts` files directly through Node's type stripping, with no build step.

```sh
cd apps/server
npm ci
cp ../../.env.example ../../.env    # the .env lives at the repo root
```

| Tool | What it does here | You need | Check |
| --- | --- | --- | --- |
| FinchNode | Harriet's synthetic health record, read live and read-only | nothing: the demo API is open (`FINCHNODE_API_KEY` only for an authenticated endpoint) | `npm run packet -- patient-demo-polypharmacy --live` |
| Relay Messenger | Chat, video call and photos with the agent | `RELAY_AGENT_TOKEN`, `PATIENT_RELAY_HANDLE`, and `FAMILY_RELAY_HANDLES` for family | `npm run relay:check` |
| Gemini | Understands typed and spoken words, words the questions | `GEMINI_API_KEY` (without it, buttons only) | `npm run llm:check` |
| ElevenLabs | Hears and speaks on the call | `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID` | `npm run demo:check`, then a call |
| Presage | Pulse and breathing estimate from the call's video | `PRESAGE_API_KEY` (optional) | a video call with the camera on |
| Photon (optional) | Texts care summaries to the doctor and emergency contact over iMessage | `SPECTRUM_PROJECT_ID`, `SPECTRUM_PROJECT_SECRET` | `npm run care:send -- --dry-run` |

`npm run demo:check` reads the config and the synthetic fixtures without any network request and never prints a key. Exit `0` means configured, `2` means an optional part is missing, `1` means something required is. It shows presence, not that a key works: `relay:check` and `llm:check` call the providers (`llm:check` uses a little quota). `content:eval` runs 145 messages through Gemini and overwrites `docs/content-eval.md`. Phone calls, the camera and family delivery need a live rehearsal with a synthetic patient on a phone.

**No keys? Run the recorded demo:** `npm run simulate -- --reset --day 2026-07-28 --sharing all --family sarah --script ../../scripts/demo/hackathon-demo.txt` (from `apps/server`). It needs no `.env`. See [the three-minute demo](docs/DEMO.md) and [QA gates](docs/QA.md) before presenting.

For the Relay agent, each person messages the agent once from their own Relay app so it can reach them: the senior (`PATIENT_RELAY_HANDLE`) and each family member (`FAMILY_RELAY_HANDLES`). A Relay chat holds one person, so there is no family group: each family member gets updates in their own chat with the agent. `npm run relay:check` shows who has.

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
   The check-in arrives on your phone. Type naturally ("ankles a bit puffy, slept ok") or tap. `CLOCK_DATE` only pins the demo day's data stamping; a fresh database on the same date no longer collides with Relay's memory of earlier messages. `FOLLOW_UP_DELAY_MINUTES=2` makes the same-day follow-up arrive in 2 minutes instead of 3 hours. Stop with Ctrl-C.

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
| `npm run dev` | Starts the server on `PORT` (default 3000): `GET /health`, and the doctor report at `GET /report/<patientId>[?day=YYYY-MM-DD]` from `DATABASE_PATH`. |
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
