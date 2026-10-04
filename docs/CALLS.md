# Video check-in call

MVP feature 1 (`docs/BRIEF.md`). Harriet calls the agent on Relay. An ElevenLabs voice holds a short, warm daily check-in: it says it is an AI, asks how she is, covers today's unanswered check-in questions, guides a quiet Presage reading, says her heart rate back as a camera estimate, and ends by pointing her to her family. What she says goes through the same safety screen, understanding pass and severity ladder as typed text, so a spoken answer and a typed answer are recorded the same way.

Who does what:

* Relay owns the call and the WebRTC transport. `@relaymessenger/elevenlabs` owns speech recognition, turn taking and the spoken audio.
* The ElevenLabs agent is a conversational shell. It never decides anything about her health and never words a health reaction itself: it reads back the fixed text our server tools return.
* The server keeps the rules. Fixed rules decide every level (`src/checkin/severity.ts`); the LLM (Gemini) only extracts what she said, as for typed text. Everything the voice reads back about her health is fixed copy chosen by level (`src/calls/copy.ts`).
* FinchNode is read-only. The voice gets her first name, today's questions, yesterday's topics, up to 3 memories and family names. No conditions, medicines, labs or other record details.
* Presage receives video frames only, and only pulse rate and breathing rate are requested. Never blood pressure or HRV. Raw video and raw audio are never stored or sent to a model.

## Call shape (about 3 minutes)

| Part | Time | What happens |
| --- | --- | --- |
| Hello | 10 s | "Hi Harriet, I'm an AI check-in assistant. This will take about three minutes." (the server sets this as the first message) |
| Open question | 30 to 60 s | "How are you feeling today?" She talks; the voice doesn't interrupt. It may follow up on yesterday ("Yesterday you mentioned some ankle swelling. How is it today?") or a memory ("Is your granddaughter still coming Sunday?"). |
| Today's questions | about 1 min | Only today's unanswered check-in questions, conversationally, one at a time. Skip what she already covered. |
| Quiet minute | about 45 s | "Rest your phone so I can see your face, and I'll stay quiet for half a minute." Presage reads. |
| Read back | 15 s | Fixed text from the server: heart rate as a camera estimate (no usual-range comparison with AFib), then one "I've noted ... for your doctor" line from the ladder. |
| Goodbye | 10 s | Points her to family by name when known: "Maybe give Sarah a call today." |

Relay's 32 seconds is only the time to answer. The call's length is ours: the server ends the ElevenLabs session after `CALL_MAX_MINUTES` (default 4).

## Exact packages

The implementation was inspected against these package versions:

| Package | Version |
| --- | --- |
| `@relaymessenger/sdk` | `0.5.1` |
| `@relaymessenger/elevenlabs` | `0.1.1` |
| `@smartspectra/node-sdk` | `3.4.0` |
| `node-webcodecs` | `1.3.0` |

Relay's current Node call transport also resolves `werift`, `@evan/opus`, `rtp-packet`, and `mediabunny` through the SDK peer dependency set. Keep the lockfile intact so the installed peer set stays compatible.

## Environment

Copy `.env.example` to `.env` and fill only local secrets:

```text
RELAY_AGENT_TOKEN=
PATIENT_RELAY_HANDLE=
ELEVENLABS_API_KEY=
ELEVENLABS_AGENT_ID=
ELEVENLABS_TOOL_SECRET=
GEMINI_API_KEY=
PRESAGE_API_KEY=
CALL_MAX_MINUTES=4
VITALS_MIN_CONFIDENCE=1
CALL_QUIET_MEASUREMENT_MS=30000
```

`ELEVENLABS_TOOL_SECRET` is the bearer secret on the ElevenLabs server-tool URLs (compared in constant time). `PRESAGE_API_KEY`, `GEMINI_API_KEY`, and `ELEVENLABS_API_KEY` are non-enumerable config fields and are not printed by startup logs. Never add a real key to Git.

`VITALS_MIN_CONFIDENCE` is the lowest SmartSpectra confidence (0 to 100) a reading needs. The default 1 only keeps out the warm-up zeros; raise it after the side-by-side tests in `docs/DEFINITION_OF_DONE.md`.

## Who may call

Only the patient's own Relay handle (`PATIENT_RELAY_HANDLE`) gets the check-in. Anyone else gets a short polite text ("Sorry, I can only take check-in calls from the person I'm set up for. Goodbye.") and the call is ended. Nothing from her record is read and nothing goes to a model.

## ElevenLabs agent setup

Create a conversational ElevenLabs Agent and put its id in `ELEVENLABS_AGENT_ID`. The server overrides the first message and passes these dynamic variables when it connects:

| Variable | Example |
| --- | --- |
| `call_id` | the Relay call id (use it in every tool body) |
| `patient_id` | the local patient id |
| `patient_name` | `Harriet` |
| `todays_questions` | `How was your breathing last night when you lay down? \| Have you felt dizzy when standing up?` or `none` |
| `yesterday` | `ankle swelling; knee pain` or `nothing` |
| `recent_memories` | `granddaughter visiting Sunday` or `none` |
| `family_names` | `Sarah` or `none` |
| `quiet_prompt` | `Rest your phone so I can see your face, and I'll stay quiet for half a minute.` |
| `closing_line` | `Thank you for talking with me, Harriet. Maybe give Sarah a call today. Take care.` |
| `max_minutes` | `4` |

### Agent prompt

```text
You are an AI check-in assistant for {{patient_name}}, an older adult. This is a short daily check-in call of about three minutes, not a medical interview. You are not a doctor, a nurse, or a friend, and you never pretend to be a person. If she asks, say you are an AI assistant.

How you talk: one question at a time. Short, plain sentences. No medical terms. Speak calmly. Let her finish; older adults often pause mid-thought, so wait before you reply. If she didn't hear you, say it again in simpler words.

The call, in order:
1. The greeting has already said you are an AI and asked how she is feeling. Listen. If it fits, ask about yesterday ({{yesterday}}) or something from her life ({{recent_memories}}), once.
2. Today's questions: {{todays_questions}}. Ask only these, one at a time, in your own warm words. Skip any she already answered. If the list is none, skip this part. Never ask about anything else medical.
3. The quiet minute: say exactly "{{quiet_prompt}}". When she agrees, call quiet_measurement with permissionGranted true. Then stay completely silent for about 30 seconds. Then call vitals_result. If its status is measuring, stay quiet a little longer and call it again. Read its patientResponseText exactly, word for word. If she says no to the reading, call quiet_measurement with permissionGranted false and skip to the goodbye.
4. Goodbye: say exactly "{{closing_line}}" and end the call.
Keep the whole call under {{max_minutes}} minutes.

Safety: if she mentions chest pain, trouble breathing, a fall, fainting, signs of a stroke, bleeding that won't stop, or wanting to hurt herself or not wanting to live, stop and call screen_symptoms at once. Read its patientResponseText exactly, word for word, then stay with her calmly. Do not add advice of your own.

Never give medical advice or dosing advice. Never tell her to start, stop, skip, change or double a medicine, and never guess what a symptom means. If she asks about a medicine or a dose, say exactly: "That's one for your doctor or pharmacist. I'll add it to your list." Then go on.

Never say heart rate, breathing, blood pressure or any other number unless it comes from vitals_result. Never mention blood pressure or heart rate variability.
```

### Dashboard settings

* Voice: warm and calm, one of ElevenLabs' stock voices. No voice cloning.
* Speaking speed: about 0.9 (slightly slower than default).
* Turn eagerness: Patient (waits longer before taking its turn, so a pause mid-thought isn't the end of her turn).
* Turn timeout: 30 seconds (the longest). It must stay quiet through the half-minute reading, and it gives her time to think.
* Interruptions: on, so she can talk over it.
* Max conversation duration: 300 seconds, as a backstop. The server ends the call after `CALL_MAX_MINUTES` anyway.
* Language: English.
* System tools: End call on (the goodbye ends the call).
* First message: leave empty or anything; the server overrides it with the AI disclosure.
* Security tab: enable the override for the first message. ElevenLabs only accepts overrides that are enabled there, and the server sends one on every call.
* Keep the agent private (authentication on): the server gets a signed URL for it with `ELEVENLABS_API_KEY`, so the API key alone is not enough; `ELEVENLABS_AGENT_ID` is required too.

### Server tools

Three webhook tools, each `POST` with JSON, header `Authorization: Bearer $ELEVENLABS_TOOL_SECRET`, response timeout 20 seconds, and "wait for response" on. The bodies carry only identifiers and structured control data. Never audio, video, or record data.

| Tool | URL | Body | Returns |
| --- | --- | --- | --- |
| `screen_symptoms` | `https://<public host>/integrations/elevenlabs/screen-symptoms` | `{ "callId": "{{call_id}}" }` | `{ "patientResponseText": "..." }` |
| `quiet_measurement` | `https://<public host>/integrations/elevenlabs/quiet-measurement` | `{ "callId": "{{call_id}}", "permissionGranted": true }` | `{ "status": "measuring", "durationMs": 30000 }` |
| `vitals_result` | `https://<public host>/integrations/elevenlabs/vitals-result` | `{ "callId": "{{call_id}}" }` | `{ "status": "reading", "patientResponseText": "..." }` |

`patientResponseText` is the only health text the voice reads. The level, her record and everything else stay on the server.

### HTTPS tunnel for the tools

ElevenLabs calls the tools over public HTTPS. `npm run agent` serves them on `PORT` (default 3000), next to `/health`. For a demo from a laptop:

```bash
cd apps/server && npm run agent          # serves http://localhost:3000
cloudflared tunnel --url http://localhost:3000   # or: ngrok http 3000
```

Put the printed `https://...` host in the three tool URLs, and check `https://<host>/health` answers before a call. The tunnel URL changes each time it starts unless you use a named tunnel.

The tunnel forwards the whole port, but the doctor report is not reachable through it: `/report` answers 404 to any request carrying `X-Forwarded-For`, `Forwarded` or `CF-Connecting-IP`. Open it on the laptop or from a phone on the same Wi-Fi.

### Contact Card animation

When the agent sends no video, Relay shows its Contact Card, and the card can carry a Rive animation (https://docs.relayapp.im/calls/rive.md). That is the place for a logo or a speaking animation; the ElevenLabs bridge already drives the `viseme` and `speaking` inputs when a Rive file is set. Not built yet.

## Runtime flow

1. The Relay WebSocket delivers `call.created`. The inbox stores the event by `event_id`, acknowledges it, and schedules the call in the background; it never waits for a call's lifetime or its end-of-call work.
2. The caller's handle must match hers, or the call is declined (above).
3. The server loads her call context from the check-in engine (today's check-in is created without a greeting when the call comes first), at most 5 seconds, then `ElevenLabsCall.connect` joins the Relay room and answers. The handler checks Relay's 32 second answer deadline and starts the `CALL_MAX_MINUTES` timer.
4. Each of her transcript turns is stored as text and screened at once with the fixed safety screen. A crisis or an urgent symptom takes the text check-in's safety path immediately: her crisis or urgent reply in her chat, an alert to every family chat at every sharing level, an observation at level 4 or 5, and a follow-up.
5. `screen_symptoms` reads everything she said so far, fresh every time (no cache): the safety screen per turn, then the understanding pass (extraction against today's unanswered questions, the classifier alongside), levelled by fixed rules. Nothing is recorded yet; safety still acts. The reply is fixed copy by level: 1 noted for her doctor, 2 keep an eye on it, 3 call her doctor today (911 only if it gets much worse), 4 911 now, 5 988.
6. The Relay video track is decoded as RGBA and sent to SmartSpectra (`useCustomInput()`), which is asked for pulse rate and breathing rate only. Audio is used only as an in-memory speech signal. A reading counts only from the quiet window she agreed to; heart rate needs its own confidence (at least `VITALS_MIN_CONFIDENCE`) and doesn't need breathing; breathing also needs the full window; talking through more than a fifth of the window voids the reading, one loud sound doesn't.
7. `vitals_result` says the heart rate back with a fixed template ("Your heart rate is about 72 beats a minute. This is a camera estimate, not a medical test."), with an in or out of usual range phrase only when her record says to compare (never with AFib), breathing said but never compared, then the ladder's one line. Each accepted reading is saved to `vitals_readings` (method `relay_call`, with its confidence).
8. When the call ends (her goodbye, a hang-up, or the time limit), the server records her turns through the same understanding pass and ladder as typed text: answers via `voice`, `symptom_observations` and notes as for typed words, memories saved, a follow-up at level 2, the family alert at level 3. A medicine question the voice answered with the fixed reply goes on her list for the next visit.
9. Then ONE message goes to her Relay chat: "Here's what I noted from our call: ..." built from fixed copy and the recorded answers and levels (heart rate as a camera estimate), with "That's right" and "Something's wrong". "That's right" carries the check-in on (any question she didn't cover, then the close and her family's daily status). "Something's wrong" takes the call's answers back and opens the Let me explain path on the first of them.
10. The call's result (`call_sessions.screening_json`) keeps the ladder level, the topics and the vitals. No raw audio or video is stored.

## Phone testing

Use a real Relay patient account with camera and microphone permission. Start the agent and the tunnel, then make a video call from the Relay app. Verify, in order:

* `call.created` is stored once and the call answers within 10 seconds.
* The first sentence says it is an AI check-in assistant and that the call is short.
* It asks today's questions one at a time, and mentions yesterday or a memory.
* The quiet-minute prompt is read, the phone rests with the face in frame, and the voice stays silent.
* The heart rate comes back as a camera estimate, with no usual-range words for Harriet (AFib).
* "Should I stop my aspirin?" gets "That's one for your doctor or pharmacist. I'll add it to your list."
* The goodbye names her family, and the call ends by about 3 minutes (the server cuts it at 4).
* After the call: one "Here's what I noted from our call" message in her chat; `checkins` and `symptom_observations` rows like a typed check-in.
* Saying "I have chest pain" during the call alerts the family chat at once.
* Ending or interrupting the call stops and destroys SmartSpectra cleanly.

## Presage limitations

SmartSpectra is a wellness and informational SDK, not a diagnostic or treatment system. Presage's FDA clearance covers pulse rate and breathing rate on its own iOS and Android setup only; a reading from Relay call video on our server is a wellness estimate. Pulse needs a shorter analysis window than breathing. Breathing needs a full 30 second window, upper chest visibility, a stable camera, and no talking. Confidence (0 to 100) begins at zero during warm-up. `stable: false`, validation warnings, motion, poor lighting, framing problems, low frame rate, and AFib all reduce how much meaning a reading has. A camera heart rate is never compared with her usual range when her record shows AFib.

## Local commands

```bash
cd apps/server
npm run lint
npm test
npm run agent
```

For a direct file spike, use `npm run vitals:video -- /absolute/path/to/clip.mp4` and inspect the normalized JSON. Real videos and secret values must remain outside Git.
