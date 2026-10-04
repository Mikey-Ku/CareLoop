# Definition of done

What "finished" means for the MVP (the five features in `docs/BRIEF.md`), and the benchmark that proves each part. A feature is done when every benchmark in its section passes, checked the way the "How we check" column says. Tick boxes in a pull request when a benchmark passes, with the evidence (a command's output, a log line, a photo or a short note) in the PR description.

**If you are an AI coding agent:** before you call your lane done, run every automated check in your section and quote the results in your pull request. Don't tick a box you didn't verify. Keep new tests to the safety-critical paths (safety screen, severity levels, red flags, dosing never advised); the team chose speed over exhaustive flow tests.

## Scoreboard

| # | MVP feature | Lane | Status |
| --- | --- | --- | --- |
| 0 | Foundation: records, rules, engine, simulator, CI | done | Done |
| 1 | Video check-in call (ElevenLabs voice, Presage heart rate) | B | Not started (Presage spike first) |
| 2 | Text check-in | A | Live on a phone; polishing |
| 3 | Medication helper (reminders, label photo, refills) | A | Not started |
| 4 | Doctor report | C | Not started |
| 5 | Family updates | C | Status and alerts work in Relay family chats; replies not built |
| 6 | Demo ready | everyone | Not started |

Order: 2 is nearly done; 1 and 3 run in parallel; 4 can start now from simulated data; 6 starts when 1 to 5 are done or cut (see "Cut list").

## Benchmarks

### Always (every pull request)

| Benchmark | How we check |
| --- | --- |
| [ ] CI green: typecheck and every test pass | GitHub Actions on the PR |
| [ ] No secrets in the diff | `git diff --cached` scan for `AIza`, `rel_`, `rly_`, `sk-ant` before committing |
| [ ] No em dashes and no dosing advice in anything a person reads | `test/copy.test.ts` |
| [ ] Synthetic data only | Only FinchNode demo subjects and `fixtures/` |

### Foundation: records and rules (done)

| Benchmark | How we check |
| --- | --- |
| [x] R1 to R5 match Harriet's answer key exactly | `test/rules.test.ts` against `fixtures/answer-key.json` |
| [x] R6 catches the planted aspirin change | `test/paper-diff.test.ts` against `fixtures/papers/answer-key.json` |
| [x] Every FinchNode behavior scenario handled (rate limit, revoked, partial, source down, merge, messy, sparse) | `test/finchnode-client.test.ts`, `test/normalize.test.ts` |
| [x] Packet for Harriet: age 78, usual range 65 to 91 kept but not compared (AFib), open flags R1, R3, R4 | `npm run packet -- patient-demo-polypharmacy` |
| [x] All scripted demos run offline | every `scripts/demo/*.txt` exits 0 |

### 1. Video check-in call (lane B)

| Benchmark | How we check |
| --- | --- |
| [ ] Presage spike result written in `FEEDBACK.md` (Node SDK on Relay frames, or the fallback scan screen) | The file |
| [ ] Call answered within 10 seconds of tapping "Call me" (Relay's hard limit is 32) | Live, 3 tries |
| [ ] First sentence says it's an AI assistant; never gives medical or dosing advice ("should I stop my aspirin?" gets "ask your doctor") | Live |
| [ ] Covers today's check-in questions in conversation and mentions something from her day (a memory or yesterday's check-in) | Live, 3 tries |
| [ ] Guides her through a reading and says the heart rate back as an estimate; for AFib no usual-range comparison; never blood pressure or HRV | Live |
| [ ] Heart rate within 5 bpm of Presage's own app, same person, same minute, 3 of 3 tries | Side by side, numbers written down |
| [ ] After the call, her answers are recorded through the same extraction and severity ladder as text (a spoken "ankles a bit puffy" becomes a level-1 ankle answer) | `checkins`, `symptom_observations` rows after a live call |
| [ ] Ends within about 3 minutes by pointing her to a real person | Live |

### 2. Text check-in (lane A)

| Benchmark | How we check |
| --- | --- |
| [x] Agent connects over WebSocket, links the senior on first message | `npm run relay:check` all `[ok]`; agent log "is linked" |
| [x] A full check-in on a real phone: greeting, 3 questions, one flag offer, done | Live, 2026-10-03 |
| [ ] Family update reaches every linked family chat | Live with a second phone; log shows one send per family chat |
| [ ] Red flag reaches the family chat in under 5 seconds | Live: tap Yes on breathing, time the family message |
| [ ] Noon missed check-in alert fires | Live with `CLOCK_DATE` and a check-in left unanswered past `MISSED_CHECKIN_TIME` |
| [ ] Sharing change: family told it changed, check-in resumes | Live |
| [ ] Zero processing errors over a full demo day | `relay_events` rows with `error` = 0 |
| [ ] Button replies answer in under 2 seconds; typed replies in under 5 seconds for 9 of 10 | Agent log timings (`[llm]` lines) over 10 typed replies |
| [x] Content handling: every crisis and urgent case in the catalogue is caught by the phrase screen or the model; none by neither | `npm run content:eval`, 2026-10-03: 37 of 37 (screen 29, model 37). Re-run on a held-out set before the demo |
| [x] No idiom or negation trips the safety screen ("dying to see the grandkids", "no chest pain") | `test/content-catalogue.test.ts`: 0 of 11 |
| [x] Message kind accuracy at least 85% | `docs/content-eval.md`: 98% (2026-10-03, second run; optimistic, see DESIGN) |
| [ ] Answer mapping at least 90% (model alone) | Second run after the graded labels: 84% (27 of 32). All 5 misses end safely in the app (3 red-flag readings go back to her for a one-tap confirm, 2 hedges get the buttons again), but the model itself is below target: tune the hedge and "slept in my recliner" cases |
| [x] Gemini down: typed replies fall back to buttons with honest wording | `test/free-text.test.ts` (`typedReplyUnavailable`) |
| [ ] Today's breathing conversation replays correctly (her "more info" saved, typed "Yes" counted, no flag offer after, follow-up later) | `scripts/demo/harriet-red-flag-typed.txt` and live |
| [ ] A natural one-message check-in on a good day ("feeling fine, ankles ok, slept well") closes with no extra questions it already answered | Live |
| [ ] Bundled replies understood: answers and extra symptoms recorded under the right topics, with the "Got it" line | Live, the Oct 7 cases |

### 3. Medication helper (lane A)

| Benchmark | How we check |
| --- | --- |
| [ ] Morning reminder lists exactly the medicines her record says she takes in the morning, with the label instructions read back unchanged | Compare with `npm run packet` medications |
| [ ] "Do you remember how many?" confirms or gently corrects by reading the instructions back; never a new instruction | Live and a copy test |
| [ ] Photo of a bottle or label: medicine and strength read correctly and matched against her record, 3 of 3 photos | Live with a printed synthetic label |
| [ ] Mismatch between photo and record: "please check with your pharmacist", never "take this instead" | Live and a test |
| [ ] Refill reminder a few days before a fill runs out (fill date plus days supply), with a ready-to-read request and an offer to tell her family | Simulator with `CLOCK_DATE` near a run-out date |
| [ ] No dosing advice anywhere: no "take more", "skip", "double", "stop" in any reply | Copy scan test |

### 4. Doctor report (lane C)

| Benchmark | How we check |
| --- | --- |
| [ ] Two printed pages, page 1 standing alone (flags, symptoms, her questions; labs and medicines on page 2): patient and conditions, the week's symptoms by severity level with dates and her words, vitals, her visit questions, flags with evidence, medicines and refill status | Print it from a simulated week |
| [ ] Every number and date in it matches the database and her FinchNode record | Spot-check 5 items |
| [ ] Shareable link served locally | Open it on a phone |
| [ ] Never prints dosing advice or a diagnosis | Read it; copy test |

### 5. Family updates (lane C)

| Benchmark | How we check |
| --- | --- |
| [ ] Daily status and alerts reach every linked family chat on a second phone | Live |
| [ ] Red flag reaches the family chat in under 5 seconds | Live |
| [ ] A family member's reply is passed on to Harriet ("Sarah says: ...") | Live |
| [ ] "Tell Sarah I love her" is passed on | Live |

### 6. Demo ready (everyone)

| Benchmark | How we check |
| --- | --- |
| [ ] `docs/DEMO.md`: a 3-minute script across the five features | The file |
| [ ] The script runs start to finish twice in a row with no manual fixes | Rehearsal |
| [ ] Backups: a simulator script of the demo, a screen recording of a good run, a paid LLM key | All three exist |
| [ ] A teammate sets up from a fresh clone with the README in under 10 minutes | Someone who didn't build it |
| [ ] Every claim in the pitch is backed by a benchmark above; nothing from "Claims we will not make" in `docs/BRIEF.md` | Read the slides against this file |
| [ ] Prize tracks checked and each sponsor's part named in the pitch (FinchNode, Relay, ElevenLabs, Presage, Gemini if there's a track) | `FEEDBACK.md` |

## Cut list

If time runs short, cut in this order and say so in the pitch rather than faking it:

1. SMS or iMessage for family (not in the MVP anyway).
2. Weekly family summary and family replies.
3. FHIR export of the doctor report.
4. Heart rate on the Relay call: use the fallback scan screen.
5. "Do you remember how many?" (keep the reminder and the photo check).
6. Refill reminders.

Never cut: the text check-in with the safety screen, the voice part of the video call, the morning medication reminder, the doctor report. Those carry the story.
