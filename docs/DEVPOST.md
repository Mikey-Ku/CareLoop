# Devpost draft

Working title: **Check-in Companion**. Tagline: an AI caregiving companion that makes daily check-ins easy and gives doctors the context behind the numbers. All data is synthetic. Every claim below is backed by something in this repo; leave out anything that is not proven live before you present.

## Inspiration
Older adults who live alone with several conditions fall between visits. Their doctor sees a snapshot, their family worries without knowing, and a daily "how are you?" is easy to skip or forget. We wanted a check-in people will actually answer, and a summary a clinician can use in two minutes.

## What it does
Harriet, 78 (atrial fibrillation, heart failure, kidney disease, 14 medicines), is read live from FinchNode's API, and everything below builds on that record.
- **Video check-in call** in Relay: it says it is an AI, asks the questions she has not answered, and offers a quiet camera reading of pulse and breathing, said back as an estimate.
- **Text check-in:** at most three questions chosen from her record, by tap or in her own words, with a severity ladder and fixed, careful reactions.
- **Medication helper:** reminders from her record, a label photo checked against her list, refill reminders.
- **Doctor report:** a two-page clinical summary of the week (her words, flags with evidence, medicines, labs).
- **Family updates:** each family member follows along in their own Relay chat, within her sharing settings.

## How we built it
| Tool | Part |
| --- | --- |
| FinchNode | Her synthetic health record, read live and read-only: it picks the questions, feeds our fixed rules (R1 to R6) for interactions, lab trends and hospital-paper differences, gives the call and chat their context, and is cited in the doctor report |
| Relay Messenger | Chat, video call and photos, over WebSocket; the call's audio and video reach our server |
| ElevenLabs | Realtime speech-to-text (Scribe v2) and the spoken voice (Flash v2.5) on the call |
| Presage | Pulse and breathing estimates from the call's video, only inside a window she agrees to |
| Gemini | Understanding what she says and wording questions, behind fixed rules |

Node and TypeScript, SQLite, one server (`apps/server`), no build step.

## Responsible by design
Rules decide every medical flag; the model only words things. A phrase screen runs before any model and gives fixed 911 and 988 replies. What the model writes for the voice is checked first: no dosing advice, diagnosis or reassurance. The agent always says it is an AI, the camera is consented, family sees only what she shares, and the camera number is a wellness estimate, never a diagnosis.

## Challenges
Making a live call feel natural: a quiet voice, a rough first second, slow replies, being cut off by noise, a dropped transcription session. We measured each, fixed it, and wrote a test for it. Keeping the model from over-reading or advising. Two coding agents (Claude Code and Codex) building in parallel, kept apart by a file split and pull requests.

## Accomplishments
Over 1,800 automated tests and 15 scripted offline demos; a 145-message content evaluation against the safety screen and Gemini; live checks of Relay, Gemini, ElevenLabs and FinchNode; a doctor report coded with SNOMED CT, LOINC, RxNorm and UCUM.

## What's next
Daily weight for heart failure, a clinician's review of the safety phrase lists, real consent flows for family, more languages (speech recognition is set to English today), and a live accuracy study of the camera reading.

## Built with
FinchNode, Relay Messenger, ElevenLabs, Presage SmartSpectra, Gemini, Node.js, TypeScript, SQLite, Vitest.
