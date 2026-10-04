# Three-minute hackathon demo

Use only Harriet's synthetic FinchNode record. The five features are video check-in, text check-in, medication helper, doctor report, and family updates. Use the acceptance gates in [QA.md](QA.md) and [DEFINITION_OF_DONE.md](DEFINITION_OF_DONE.md); this script does not prove live readiness.

## Before the timer

Follow the README setup and QA guide. Link Harriet and Sarah on separate Relay phones; confirm sharing permissions. Open a report populated by the synthetic week rehearsal. Stage both synthetic apixaban labels and a successfully rehearsed call recording. Check provider readiness without exposing keys. Tell everyone the numbers and records are synthetic. Do not run the simulator against the live agent database.

The full patient call may take about three minutes itself. To fit five features into the presentation, show a disclosed excerpt from a successful rehearsal, or begin the live call before the presentation timer. Do not speed through consent or interrupt a safety response for the timer.

| Time | Action | Presenter words |
| --- | --- | --- |
| 0:00-0:20 | Show Harriet's record-backed greeting in Relay (optionally `npm run packet -- patient-demo-polypharmacy --live` beside it: the same record straight from FinchNode's API). | "Harriet has several conditions and medicines across her records. FinchNode provides this synthetic record; our companion brings it into a short daily check-in." |
| 0:20-0:45 | Show a natural text answer or the rehearsed button path. Show only remaining questions and completion. | "She can type or tap. Fixed rules handle severity and escalation; the model helps understand her words. Not today remains available." |
| 0:45-1:25 | Show the live video excerpt: AI disclosure, voice check-in, consented reading, and closing. | "Relay carries the call. ElevenLabs listens and speaks; Gemini supports the conversation. Presage supplies a camera wellness estimate when capture quality permits. With Harriet's atrial fibrillation we do not compare it with a usual range." |
| 1:25-2:00 | Show morning medicines, then the synthetic apixaban 2.5 mg label against the 5 mg record. | "Instructions are read back from the record. A mismatching label leads to a pharmacist check, never a recommendation to change a dose. Refill help prepares a request; it does not order medicine." |
| 2:00-2:30 | Show Sarah's separate Relay chat, a daily update and her reply reaching Harriet. Optionally show the rehearsed urgent alert. | "Family receives updates within Harriet's sharing settings. Urgent safety alerts still go out with limited detail where appropriate. Sarah can reply in her own chat." |
| 2:30-3:00 | Show both report pages, dwelling on page one. | "A clinician gets the week's reported symptoms, dates, questions, record flags and wellness estimates, with medicines and labs on page two. This supports review; it does not diagnose or write back to the health record." |

## Offline fallback and two rehearsals

Say: "This fallback uses recorded synthetic data and scripted image readings. The engine, medication comparison, family routing and report generation run locally. The camera number is injected; this is not a live call or a model-quality demonstration."

From `apps/server`, after installing the repository dependencies:

```sh
DEMO_DIR=$(mktemp -d "${TMPDIR:-/tmp}/mhacks-demo.XXXXXX")
for RUN in 1 2; do
  npm run simulate -- --db "$DEMO_DIR/demo-$RUN.db" --day 2026-07-28 --sharing all --family sarah --script ../../scripts/demo/hackathon-demo.txt > "$DEMO_DIR/transcript-$RUN.txt" || break
  npm run report -- --db "$DEMO_DIR/demo-$RUN.db" --day 2026-07-30 --out "$DEMO_DIR/report-$RUN.html" || break
done
printf '%s\n' "$DEMO_DIR"
```

Inspect both transcripts for check-in completion, prescription read-back, matching and mismatching labels, refill notice to Sarah, Sarah's reply, urgent alert and follow-up. Check report contents against each database. Both runs must exit successfully; a failed command requires investigation, not a claimed rehearsal pass.

The July date deliberately reaches the fixture's apixaban refill window. The fixture snapshot is dated September 1, so this is a historical synthetic scenario, not a claim about live record freshness. The fallback supplies `/reading 72` and creates zero call sessions. Show a separately labelled recording for the video feature; if none exists, state that the live video demonstration remains unavailable.

For a full seven-day report rehearsal use a third fresh database with `harriet-week.txt`, starting `--day 2026-08-26`, then generate the report ending `2026-09-01`. Use browser print preview with background graphics enabled and verify two pages.

If a provider fails live, use the matching fallback segment and disclose it. Do not present a saved reading as a current measurement. If urgent symptoms are entered during a rehearsal, let the safety flow finish before resuming the pitch.
