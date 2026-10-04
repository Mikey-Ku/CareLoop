# Relay video-call symptom screening

This lane connects a Relay video call to the existing FinchNode and SmartSpectra adapters. Relay owns the call and WebRTC transport. `@relaymessenger/elevenlabs` owns speech recognition, turn taking, and spoken audio. Gemini is the only model used by the backend screening operation. FinchNode is read-only context. Presage receives video frames only. Raw video and raw audio are never written to the database or sent to Gemini.

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
```

`ELEVENLABS_TOOL_SECRET` is the bearer secret configured on the ElevenLabs server-tool URLs. `PRESAGE_API_KEY`, `GEMINI_API_KEY`, and `ELEVENLABS_API_KEY` are non-enumerable config fields and are not printed by startup logs. Never add a real key to Git.

## ElevenLabs agent setup

Create a conversational ElevenLabs Agent with a warm, calm voice and configure the Relay bridge with `ELEVENLABS_AGENT_ID`. The agent is a conversational shell, not the medical decision maker. Its system prompt should be equivalent to:

```text
You are a warm, professional symptom-interview voice for a care team. Ask one question at a time and keep the interview short. Ask what is bothering the patient, when it started, whether it is changing, how severe it feels, and relevant associated symptoms.

Do not diagnose. Do not recommend medications, doses, or treatment. Do not invent medical conclusions. Do not interpret symptoms yourself. When the interview has enough evidence, call the backend screen_symptoms operation and read only its approved patientResponseText. The backend response is authoritative.

If the patient uses urgent or crisis language, stop the interview and call `screen_symptoms` immediately. That operation runs the deterministic safety rules before any Gemini call and returns the fixed emergency or crisis response. Read only its `patientResponseText`; do not wait for or add model interpretation.

Before a Presage reading, explain that a quiet camera measurement is needed, ask permission, ask the patient to remain still and stop talking for 30 to 45 seconds, and require the face and upper chest to be visible. Call quiet_measurement only after permission is explicit. Read validation feedback when available. A missing or zero-confidence result must be reported as no usable reading.

Use a caring, respectful, concise tone. The patient should feel heard and valued. You are not a clinician and must not imply otherwise.
```

Configure two ElevenLabs server tools that send JSON containing only identifiers and structured control data. The Relay bridge provides these dynamic variables when it connects:

* `call_id`: the active Relay call ID.
* `patient_id`: the authenticated local patient ID.
* `patient_name`: the patient's preferred name.

Use `{{call_id}}` in the tool body. Do not ask the patient for an ID and do not use a phone number as an identifier.

* `POST /integrations/elevenlabs/screen-symptoms`, body `{ "callId": "..." }`.
* `POST /integrations/elevenlabs/quiet-measurement`, body `{ "callId": "...", "permissionGranted": true }`.

Both endpoints require `Authorization: Bearer $ELEVENLABS_TOOL_SECRET`. Put the public HTTPS URL of this server in the tool configuration. Do not put audio, video, or a full FinchNode record in tool arguments.

Configure the screening webhook to wait for its response before the agent continues. The endpoint deliberately returns only `{ "patientResponseText": "..." }`; the full screening result remains backend-only. This keeps concern level, FinchNode evidence, and caregiver-only details out of the patient voice channel.

## Runtime flow

1. Relay WebSocket receives `call.created`.
2. The inbox inserts the event by `event_id`, then acknowledges it. The call handler is scheduled in the background and does not hold the WebSocket callback open.
3. `ElevenLabsCall.connect` joins the Relay room and answers the ringing call. The handler checks the 32 second Relay answer deadline.
4. A subscribed Relay `VideoStream` is decoded as RGBA. Width, height, stride, and the Relay capture timestamp are preserved. Unsupported frames are rejected with diagnostics that contain no media data.
5. SmartSpectra receives frames through `useCustomInput()`. Audio is used only as an in-memory speech-activity signal, so talking during the quiet phase invalidates the measurement without persisting the audio.
6. The short interview is transcribed as bounded text turns. After permission, the quiet phase lasts 30 to 45 seconds. Breathing readings before the full window, while talking, or with zero confidence are not usable.
7. The backend loads FinchNode context, applies deterministic safety rules first, then calls Gemini with transcript evidence, structured vitals, FinchNode context, memories, and observations.
8. The backend persists call metadata, audit transcript text, structured vitals, and the screening result. It never persists raw audio or raw video.
9. The approved `patientResponseText` is the only health response the ElevenLabs Agent should read back.

## Phone testing

Use a real Relay patient account with camera and microphone permission. Start the agent, then make a video call from the Relay app. Verify, in order:

* `call.created` is stored once and the call answers within 32 seconds.
* The agent voice greets the patient and asks one question at a time.
* The patient sees a clear quiet-measurement explanation and grants permission.
* The face and upper chest remain in frame, the phone is propped up, lighting is even, and the patient does not speak for 30 to 45 seconds.
* Validation hints are shown or spoken without exposing raw media.
* The result distinguishes a usable reading from a missing or zero-confidence reading.
* Gemini receives structured text and vitals only, never the media stream.
* Ending or interrupting the call stops and destroys SmartSpectra cleanly.

## Presage limitations

SmartSpectra is a wellness and informational SDK, not a diagnostic or treatment system. Pulse needs a shorter analysis window than breathing. Breathing needs a full 30 second window, upper chest visibility, a stable camera, and no talking. Confidence begins at zero during warm-up and should be treated as unusable until the required window is complete. `stable: false`, validation warnings, motion, poor lighting, framing problems, low frame rate, and AFib context all reduce how much meaning can safely be assigned to a reading. A camera heart-rate estimate is not compared against the patient's usual range when FinchNode records AFib.

The call flow intentionally reports uncertainty rather than converting missing values into a confident result. A human caregiver or clinician must review the structured output before action.

## Local commands

```bash
cd apps/server
npm install
npm run lint
npm test
npm run agent
```

For a direct file spike, use `npm run vitals:video -- --video /absolute/path/to/clip.mp4` and inspect the normalized JSON. Real videos and secret values must remain outside Git.
