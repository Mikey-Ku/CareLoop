# Definition of done

What "finished" means for this project, and the benchmark that proves each part. A lane is done when every benchmark in its section passes, checked the way the "How we check" column says. Tick boxes in a pull request when a benchmark passes, with the evidence (a command's output, a log line, a photo or a short note) in the PR description.

**If you are an AI coding agent:** before you call your lane done, run every automated check in your section and quote the results in your pull request. Don't tick a box you didn't verify.

## Scoreboard

The six MVP features from `docs/BRIEF.md`, plus what the demo needs.

| # | Milestone | Lane | Status |
| --- | --- | --- | --- |
| M0 | Records, rules, check-in engine, simulator, CI | done | Done (runs 1 to 2c) |
| M1 | Morning check-in live on phones, typed replies, content handling | 1 | In progress |
| M2 | "Call me to chat" voice call | 2 | Not started |
| M3 | "Check my vitals" video call | 3 | Not started (spike first) |
| M4 | Paper photo check and the doctor's visit-prep sheet | 4 | Not started |
| M5 | Family voice messages both ways | 5 | Not started |
| M6 | Demo ready | everyone | Not started |

Order: M1 unblocks real-phone testing for M2 and M5. M3 and M4 can run in parallel from the start against mocks. M6 starts when M2 to M5 are done or cut (see "Cut list").

## Benchmarks

### Always (every pull request)

| Benchmark | How we check |
| --- | --- |
| [ ] CI green: typecheck and every test pass | GitHub Actions on the PR |
| [ ] No secrets in the diff | `git diff --cached` scan for `AIza`, `rel_`, `rly_`, `sk-ant` before committing |
| [ ] No em dashes and no dosing advice in anything a person reads | `test/copy.test.ts` |
| [ ] Synthetic data only | Only FinchNode demo subjects and `fixtures/` |

### M0: Records and rules (done)

| Benchmark | How we check |
| --- | --- |
| [x] R1 to R5 match Harriet's answer key exactly | `test/rules.test.ts` against `fixtures/answer-key.json` |
| [x] R6 catches the planted aspirin change | `test/paper-diff.test.ts` against `fixtures/papers/answer-key.json` |
| [x] Every FinchNode behavior scenario handled (rate limit, revoked, partial, source down, merge, messy, sparse) | `test/finchnode-client.test.ts`, `test/normalize.test.ts` |
| [x] Packet for Harriet: age 78, usual range 65 to 91 kept but not compared (AFib), open flags R1, R3, R4 | `npm run packet -- patient-demo-polypharmacy` |
| [x] All scripted demos run offline | every `scripts/demo/*.txt` exits 0 |

### M1: Check-in live on phones (lane 1)

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
| [x] Message kind accuracy at least 85%, answer mapping at least 90% | `docs/content-eval.md`: 97% and 94% (optimistic, see DESIGN) |
| [x] Gemini down: typed replies fall back to buttons with honest wording | `test/free-text.test.ts` (`typedReplyUnavailable`) |
| [ ] Today's breathing conversation replays correctly (her "more info" saved, typed "Yes" counted, no flag offer after, follow-up later) | `scripts/demo/harriet-red-flag-typed.txt` and live |

### M2: Voice call (lane 2)

| Benchmark | How we check |
| --- | --- |
| [ ] Call answered within 10 seconds of tapping "Call me to chat" (Relay's hard limit is 32) | Live, 3 tries |
| [ ] First sentence says it's an AI assistant | Live recording or transcript |
| [ ] Mentions at least one thing from her day (a memory or today's check-in) | Live, 3 tries |
| [ ] Never gives medical or dosing advice; a medicine question gets "ask your doctor" | Live: ask "should I stop my aspirin?" |
| [ ] Ends within about 3 minutes by pointing her to a real person | Live |
| [ ] What she shared is saved and shows in the next day's packet | `memories` table, `npm run packet` |

### M3: Vitals (lane 3)

| Benchmark | How we check |
| --- | --- |
| [ ] Spike result written in `FEEDBACK.md` (Node SDK on frames, or the fallback scan screen) | The file |
| [ ] Heart rate within 5 bpm of Presage's own app, same person, same minute, 3 of 3 tries | Side by side, written down with the numbers |
| [ ] Reading spoken back as an estimate, no "usual range" comparison for AFib | Live |
| [ ] Breathing rate recorded, never compared | `vitals_readings` row |
| [ ] Never shows blood pressure or HRV | Code search and live |
| [ ] Family sees it at "status_vitals" and "all" only | Live, two sharing levels |

### M4: Paper photo and visit-prep sheet (lane 4)

| Benchmark | How we check |
| --- | --- |
| [ ] Photo of the printed discharge sheet: at least 13 of 14 medicines read correctly | 3 photos, compared with `fixtures/papers/harriet-discharge.extracted.json` |
| [ ] Aspirin stop caught 3 of 3 times, after she confirms the read-back | Live |
| [ ] R6 flag goes new, told, noted | `flags` table |
| [ ] Visit-prep sheet: noted flags with evidence (record and date), her notes, her visit questions, heart-rate readings, on one printed page | Print it |
| [ ] Never prints a dosing instruction | Read the sheet; copy test |

### M5: Family voice messages (lane 5)

| Benchmark | How we check |
| --- | --- |
| [ ] Voice memo from Harriet reaches every family chat in under 10 seconds | Live |
| [ ] Voice memo from family reaches Harriet | Live |
| [ ] "Tell Sarah I love her" (typed) is passed on | Live |

### M6: Demo ready (everyone)

| Benchmark | How we check |
| --- | --- |
| [ ] `docs/DEMO.md`: a 3-minute script built on R1 (falling kidney numbers on metformin, flag, "I'll ask my doctor", visit-prep sheet) | The file |
| [ ] The script runs start to finish twice in a row with no manual fixes | Rehearsal |
| [ ] Backups: simulator script of the demo, a screen recording of a good run, a paid LLM key or Claude credits in `.env` | All three exist |
| [ ] A teammate sets up from a fresh clone with the README in under 10 minutes | Someone who didn't build it |
| [ ] Every claim in the pitch is backed by a benchmark above; nothing from "Claims we will not make" in `docs/BRIEF.md` | Read the slides against this file |
| [ ] Prize tracks checked and each sponsor's part named in the pitch | `FEEDBACK.md` |

## Cut list

If time runs short, cut in this order and say so in the pitch rather than faking it:

1. Weekly family summary (never started).
2. Family voice memos from family to Harriet (keep Harriet to family).
3. Vitals on the Relay call: use the fallback scan screen.
4. Breathing rate (keep heart rate).
5. Small talk (keep typed answers, safety and fixed replies).

Never cut: the check-in, red flags reaching the family, the safety screen, the paper check, the visit-prep sheet. Those carry the story.
