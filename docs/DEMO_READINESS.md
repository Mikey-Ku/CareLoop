# Demo readiness evidence

As of October 4, 2026. This checklist records evidence requirements; it does not certify live readiness. Use [DEMO.md](DEMO.md) for the presentation and [QA.md](QA.md) / [DEFINITION_OF_DONE.md](DEFINITION_OF_DONE.md) for full acceptance criteria.

## Verified in the demo-kit branch

Two consecutive offline rehearsals used separately created temporary synthetic databases and exited 0, followed by report generation exiting 0 for each. Local evidence directory: `/tmp/mhacks-ready-demo.rjYJLB` (temporary, not a durable team artifact). Each transcript includes a completed calm check-in, morning prescription read-back and memory check, two label comparisons, refill help sent to Sarah, Sarah's reply delivered to Harriet, an urgent breathing escalation to Sarah, and its follow-up. Each database has 2 check-ins, 2 label checks, 1 refill, 1 family message, 1 follow-up and 1 injected wellness reading. Each has 0 call sessions. Reports were generated for the week ending July 30.

No model API, Relay phone delivery, ElevenLabs audio, Presage camera measurement, print layout or fresh-clone setup is proven by these runs. The fallback reads recorded FinchNode fixtures and scripts photo extraction. Its historical July date is intentionally earlier than the September fixture snapshot to reach a refill window.

## Required live evidence before saying demo-ready

Record pass/fail, branch/commit, local timestamp, scenario and evidence location for each row. Keep tokens, secret values and personal contact identifiers out of saved evidence.

| Gate | Concrete evidence needed | Current evidence in this kit |
| --- | --- | --- |
| Provider setup | Teammate follows README from fresh clone in under 10 minutes; readiness output covers configured tools without printing keys. Paid Gemini fallback credential configured privately and checked. | Not verified |
| Actual FinchNode integration | Fetch synthetic `patient-demo-polypharmacy`; record age, medicine count and selected rule flags matching fixture answer key. | Offline fixture only |
| Text reliability | Natural one-message calm answer closes correctly; ambiguous reply clarifies; Not today works; buttons remain usable when Gemini unavailable. Timed 10 replies meet QA targets. | Button engine exercised offline |
| Video/voice | Three live calls answered within 10 seconds. Recording shows AI disclosure, relevant questions, consent, patient interruption, closing and post-call persisted symptom severity. | Not verified |
| Camera quality and recovery | Same-minute comparison with Presage app for 3 attempts, recorded as an engineering benchmark, not clinical validation. Also test decline, poor light, motion, disconnect and reconnect; unavailable stays unavailable and stale readings do not appear. | Injected estimate only |
| Medication photo | Three printed synthetic labels read correctly on a phone. Strength mismatch asks pharmacist; blur or missing strength asks for another view. Reminder matches record directions verbatim. | Record matching exercised; image model not verified |
| Report | Render simulated seven-day report, print exactly two pages, spot-check 5 dates/numbers against DB and record. Open served report link on a phone. | HTML generated for short scenario only |
| Family | Second phone receives status and urgent alert; every configured family chat receives it. Time urgent delivery under 5 seconds; reply returns to Harriet. Verify lower sharing levels reduce medical detail. | Separate simulator panes only |
| Safety practices | Rehearse emergency, self-harm and dose-change questions using QA synthetic scenarios. Appropriate fixed routing, no diagnosis or dose changes. Complete applicable safety tests and held-out content evaluation. | Breathing escalation exercised offline |
| Clean integration | Claude and Codex agree on final commit and owned changes; final integrated typecheck/test/CI passes. Confirm startup and recovery on that exact revision. | Requires root integration evidence |
| Backup media | Save a labelled recording of one good live run, report HTML/PDF and offline transcripts in a team-accessible location. | Temporary offline transcripts only |
| Pitch | Check every statement against actual gate evidence and sponsor eligibility. Name FinchNode, Relay, ElevenLabs, Presage and Gemini accurately; disclose fallback footage. | Script provided; eligibility not verified |

## Hard limits for the presenter

Use synthetic records only. Read-only FinchNode integration; no write-back, diagnosis or dose adjustment. Server camera readings are wellness estimates and are not covered by a claim of FDA clearance. Do not display blood pressure or HRV. Harriet's AFib reading is not compared with a usual range. A missing measurement remains missing. No claims of reduced admissions or proven health outcomes. Tell judges when footage, model extraction or camera values are simulated.

A live failure does not invalidate a clearly labelled offline demonstration. It does mean the corresponding live readiness gate remains open.
