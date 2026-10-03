# DESIGN: Senior Check-in Companion

Plan doc with diagrams: https://claude.ai/code/artifact/3b6c7a92-f524-40dc-85cf-f28dbcbe5367

## Architecture

```
Harriet (Relay iOS app) --\                         /--> FinchNode demo API (record, read-only)
                           >-- Relay API -- our backend --> ElevenLabs Agent (voice, via Relay bridge)
Sarah (Relay group chat) --/   (webhooks,     |         \--> Presage SmartSpectra SDK (vitals from frames)
                                 calls)        |
                                               +--> Anthropic Claude (chat wording, reading paper photos)
                                               +--> SQLite (our database)
```

Backend parts:

| Part | Job |
| --- | --- |
| `finchnode` client | Pull records for a patient, handle every demo scenario behavior, normalize codes and units, merge sources |
| `context` builder | One "context packet" per reply or call: record + our notes |
| `rules` engine | Medication checks, red flags, paper discrepancies. Deterministic, unit tested |
| `db` | SQLite tables below |
| `relay` agent | Webhook server, check-in messages, buttons, family group, photos, voice memos, scheduled jobs |
| `calls` handler | Relay call events, ElevenLabs bridge, video frames to Presage |
| `llm` | Claude for friendly wording and reading paper photos. Never decides what is risky |

## Tech stack

| Layer | Choice | Why |
| --- | --- | --- |
| Runtime | Node 20+, TypeScript (strict) | Relay's SDK and its ElevenLabs bridge are TypeScript packages |
| Web server | Express | Webhook routes need the raw body for signature checks |
| Database | SQLite via `better-sqlite3` | One file, no setup |
| Validation | `zod` | Validate FinchNode and Relay payloads |
| Tests | `vitest` | Fast unit tests for the client and rules |
| Relay | `@relaymessenger/sdk`, `@relaymessenger/elevenlabs`, CLI `npx relaymessenger` | Chat, buttons, calls, media, voice memos |
| Voice | ElevenLabs Agent (configured in the ElevenLabs dashboard) | Warm voice; context passed at call start |
| LLM | Anthropic Claude via `@anthropic-ai/sdk` | Chat wording and vision for paper photos |
| Vitals | Presage SmartSpectra C++ SDK with custom frame input, as a sidecar in `services/presage-bridge/` | Takes raw frames from the Relay video call. Final choice after the spike |
| Drug names | NLM RxNav REST API (no key) | Map free-text medication names to RxNorm codes |
| Package manager | npm | Default with Node |

## Repo layout

```
Mhacks_2026/
├── CLAUDE.md                 # auto-loaded by Claude Code; points to the brief
├── CLAUDE_CODE_BRIEF.md      # spec for each Claude Code run
├── RUN_LOG.md                # written by Claude Code
├── FEEDBACK.md               # written by the team
├── README.md
├── .env.example
├── docs/BRIEF.md, docs/DESIGN.md
├── apps/server/
│   ├── src/finchnode/        # client, types, normalize, merge
│   ├── src/context/          # context packet builder, question picker
│   ├── src/rules/            # medication rules, red flags, paper diff
│   ├── src/db/               # schema, migrations, queries
│   ├── src/relay/            # webhook server, messages, jobs
│   ├── src/calls/            # ElevenLabs bridge, video frames
│   ├── src/llm/              # Claude prompts
│   └── test/
├── services/presage-bridge/  # vitals sidecar (after spike)
├── fixtures/                 # recorded FinchNode responses, answer key, synthetic papers
└── scripts/                  # spikes and dev helpers
```

## FinchNode

- Demo base URL: `https://api.finchnode.com/demo/v1` (no auth, synthetic only). Endpoints seen: `/patients`, `/patients/{id}`, `/patients/{id}/records`, `/scenarios`, `/scenarios/{id}`, `/providers`, `/connect/sessions`, `/fhir/metadata`, `/fhir/Bundle/{id}`. `/openapi` returned 404 when checked; read `/scenarios` for how behavior scenarios are reached.
- Read-only. Production uses Connect sessions, a stable `subject` per app, and signed webhooks (`consent.granted`, `sync.completed`). Sandbox keys start with `ck_test_`.
- Record patients: `patient-demo-001` (baseline-adult), `patient-demo-polypharmacy` (polypharmacy-senior, the demo patient), `patient-demo-pediatric-asthma`, `patient-demo-multi-source`, `patient-demo-sparse`, `patient-demo-messy-coding`.
- Behavior scenarios the client must handle:

| Scenario | Behavior | Expected handling |
| --- | --- | --- |
| rate-limited | 429 with `Retry-After` in even two-second slots | Retry after the header's delay, capped attempts |
| consent-revoked | 410 `consent_inactive` on every read | Stop, delete cached records for that patient, tell her and the family |
| consent-partial | Only medications and allergies shared; other categories 403 `consent_scope_exceeded` | Use what is shared; questions that need other categories are skipped |
| source-unavailable | Partial sync status, `source_unavailable` warning, older `lastSyncedAt` for one source | Use the data, show "last updated" per source |
| multi-source-overlap | Same items under two sources with different ids, dates, one unit difference | Merge by code, keep both sources in provenance, convert units |
| messy-coding | Free-text meds without RxNorm, observation with no value, code-only value, low bound zero, undated resource, weight in lb, glucose in mmol/L | Normalize; skip unusable values; never crash |
| sparse-record | Only demographics and one visit | Empty states; generic questions only |
| connect-cancelled / connect-failed | Session status cancelled or failed (`source_unavailable`) | Friendly retry message |

### Harriet's record (verified 2026-10-03)

- 14 active MedicationRequests with RxNorm codes: apixaban 5 mg (1364445), metoprolol succinate ER 50 mg (866436), furosemide 40 mg (313988), lisinopril 10 mg (314076), atorvastatin 40 mg (617311), metformin 500 mg (861007), levothyroxine 0.075 mg (966222), omeprazole 20 mg (198051), acetaminophen 500 mg (198440), sertraline 50 mg (312941), trazodone 50 mg (856377), potassium chloride 20 mEq (198116), cholecalciferol 0.025 mg (199362), aspirin 81 mg (243670).
- One MedicationDispense per drug, handed over 2026-07-01 to 2026-08-28, mostly 30-day supply (levothyroxine 90).
- eGFR (mL/min/1.73m2): 39 on 2025-01-14, 36 on 2025-07-15, 33 on 2026-01-20, 31 on 2026-07-14. Creatinine 1.4 to 1.7 mg/dL over the same dates.
- Potassium 4.9 mmol/L on 2026-07-14 (reference 3.5 to 5.1). Latest weight 70.5 kg on 2026-01-20. Born 1948-03-02.
- Conditions: CKD stage 3, atrial fibrillation, heart failure, hypertension, type 2 diabetes, hyperlipidemia, hypothyroidism, knee osteoarthritis, GERD, insomnia.
- Gotcha: against today's date every 30-day fill has run out. Use the record's latest date as the "as of" date for refill logic.

## Rules engine

Deterministic functions, each returning `{ ruleId, status: "flag" | "checked" | "skipped", severity, message, evidence: [{ resourceId, source, date, value }] }`.

| Rule | Logic | Source |
| --- | --- | --- |
| R1 metformin and kidneys | On metformin and latest eGFR < 45: flag "reassess"; < 30: flag "contraindicated" | FDA safety communication, https://www.fda.gov/Drugs/DrugSafety/ucm493244.htm |
| R2 apixaban dose | Count: age >= 80, weight <= 60 kg, creatinine >= 1.5. Two or more means 2.5 mg twice daily, else 5 mg. Flag a mismatch, otherwise "checked" | Eliquis label, https://packageinserts.bms.com/pi/pi_eliquis.pdf |
| R3 bleeding combination | Anticoagulant plus aspirin and/or an SSRI: flag "ask your doctor" | Team confirms wording against a drug interaction reference before the demo |
| R4 potassium | Latest potassium in the top quarter of its reference range, on an ACE inhibitor plus a potassium supplement, with eGFR falling: flag | Demo heuristic; team confirms |
| R5 refill timing | Needs two or more fills of the same drug; gap longer than days supply plus a grace period: flag. One fill only: skipped | Uses record "as of" date |
| R6 paper diff | Paper says stopped but record says active; new drug on paper not in record; dose differs: flag each | Hospital paper check |

Answer key for Harriet: R1 flag (reassess, eGFR 31 and falling), R2 checked (1 of 3 criteria, 5 mg is right), R3 flag (apixaban, aspirin, sertraline), R4 flag (potassium 4.9, lisinopril plus potassium chloride, eGFR falling), R5 skipped (one fill per drug). Write this as `fixtures/answer-key.json` and test against it.

## Daily questions and red flags

- Question bank keyed by condition or drug class: heart failure (ankle swelling; trouble breathing lying flat), anticoagulant (unusual bruising or bleeding), beta blocker or loop diuretic (dizziness on standing), everyone (morning medicines taken). Pick at most 3, rotate across days.
- Red flags are fixed rules, not LLM judgment: for example heart failure plus "trouble breathing" answer, or anticoagulant plus "bleeding" answer. Action: tell her to call her doctor and alert the family group (if sharing allows). Thresholds are config values the team sets; do not invent clinical cutoffs.
- Vitals baseline: from the record's vitals history, her own observed range for heart rate. A reading outside that range gets a gentle mention, not an alarm.

## Context packet

```ts
type ContextPacket = {
  patient: { preferredName: string; age: number };
  conditions: string[];
  medications: { name: string; rxnorm?: string; dose?: string; lastFill?: string; source: string }[];
  vitalsBaseline: { heartRate?: { low: number; high: number }; breathingRate?: { low: number; high: number } };
  recentLabs: { name: string; value: number; unit: string; date: string; refRange?: string }[];
  todaysQuestions: { id: string; text: string; buttons: string[] }[];
  openFlags: { ruleId: string; message: string }[];
  memories: string[];            // things she told us, newest first, capped
  pendingFamilyMessages: { id: string; from: string; kind: "voice" | "text" }[];
  sharing: "status" | "status_vitals" | "all";
  asOf: string;                  // record's latest date
};
```

For calls, the packet goes to ElevenLabs as dynamic variables through the bridge's `initiationData` (`conversation_initiation_client_data`).

## Database (SQLite)

| Table | Key columns |
| --- | --- |
| patients | id, finchnode_patient_id, preferred_name, relay_handle, relay_chat_id, family_chat_id, checkin_time, timezone, sharing |
| record_snapshots | patient_id, fetched_at, scenario, sync_status, raw_json |
| checkins | id, patient_id, date, status (sent, answered, skipped, missed), mood, answers_json |
| vitals_readings | id, patient_id, taken_at, heart_rate, breathing_rate, method (relay_call, scan_screen), confidence |
| memories | id, patient_id, text, created_at, deleted_at |
| flags | id, patient_id, rule_id, status, severity, evidence_json, created_at |
| paper_scans | id, patient_id, relay_attachment_id, extracted_json, confirmed_at, discrepancies_json |
| family_messages | id, patient_id, direction, kind, relay_message_id, played_at |

## Relay facts (from docs.relayapp.im)

- API base `https://api.relayapp.im`; Agent Token auth; send with idempotency keys.
- Local dev: `npx relaymessenger connect`, then `npx relaymessenger listen --forward-to http://localhost:3000/webhooks/relay`. Verify the Standard Webhooks signature on the raw body with `RELAY_WEBHOOK_SECRET`.
- Buttons: 1 to 5 per message, label up to 80 chars; a tap arrives as `message.received` with text equal to the label and `reply_to`.
- Forms: multi-page, answers in a `form_response` part.
- Photos: `message.received` media part with a signed URL valid 60 minutes; attachments up to 100 MiB.
- Group chats: up to 7 active members, at least one agent, several people allowed.
- Calls: agent can call a person who added it, turned on Allow Calls, and has replied. `ElevenLabsCall.connect({ relay, callId, elevenlabs: { apiKey, agentId }, initiationData })` from the `call.created` handler.
- Video: remote camera track decoded with `VideoStream` (RGBA, I420 and others), up to 1080p at 30 fps.
- Activity label: 1 to 21 visible chars, 90 second lease, renew every 60 seconds.
- Voice memos: send an uploaded audio attachment as a voice memo; download inbound media the same way as photos.

## Presage facts

- FDA 510(k) K254169 (July 2026): pulse rate and breathing rate only, iOS and Android; RMSE 1.32 bpm and 1.75 breaths/min. HRV and blood pressure not cleared.
- C++ SDK custom input: `UseCustomInput().Build(handle)`, then `handle->Send(frame, timestamp_us)` with strictly increasing timestamps. Docs: https://smartspectra.presagetech.com/docs/cpp/headless-mode.md
- Node SDK can read a recorded MP4 (H.264, 30 to 60 s, well lit, still face) with `useFile()`; Presage calls this "smoke, not accuracy".
- Breathing needs a 30 second window; HRV 60 seconds.

## Build order

1. Scaffold the repo (TypeScript server, lint, vitest, SQLite schema). FinchNode client for the demo API with typed models, scenario handling, normalization, source merge. Record fixtures. Tests.
2. Context packet builder, question picker, rules R1 to R5, answer key test.
3. Relay agent: webhook server with signature check, morning check-in with buttons, answers saved, family group creation, missed check-in job.
4. Chat call: ElevenLabs bridge on `call.created`, context packet as initiation data, memories saved after the call, voice memo to family.
5. Vitals call: Relay video frames into Presage (spike decides C++ sidecar vs fallback scan screen), result compared with baseline and spoken back.
6. Hospital paper check: photo to Claude vision, read-back and confirm buttons, rule R6 against the record.
7. Family voice messages both ways, sharing levels, consent revocation flow.
8. Stretch and polish: visit-prep PDF, weekly summary, demo script helpers, recorded backups.

Steps 1 and 2 need no API keys. Steps 3 to 7 need keys and phones (see FEEDBACK.md team tasks).
