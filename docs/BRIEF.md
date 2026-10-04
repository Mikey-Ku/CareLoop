# BRIEF: Senior Check-in Companion (working name)

MHacks 2026 entry for the FinchNode prompt: "Build an app that makes healthcare easier for patients, clinicians, or care teams using the FinchNode API. Projects should demonstrate a working FinchNode integration using our synthetic demo health records."

## Pitch

A daily check-in companion for older adults who live alone with several chronic conditions. Each morning it starts a short, friendly chat in Relay, then offers a voice call to talk or a video call to check vitals. Every question and flag comes from the senior's real record (FinchNode), and the companionship steers her toward family instead of replacing them.

## The problem

Older adults with several conditions face two problems at once: medicines and results spread across places nobody reconciles, and long stretches alone between visits. Family caregivers fill both gaps without the records.

| Gap | Number | Source |
| --- | --- | --- |
| Many medicines | 43.0% of US adults 65+ take 5+ prescription drugs; 44.6% take at least one Beers Criteria drug | Innes, JAMA Intern Med 2024, https://pubmed.ncbi.nlm.nih.gov/38949837/ |
| Medication harm | Adults 65+: 12.1 ED visits per 1,000 per year for medication harm; blood thinners are the top cause | Budnitz, JAMA 2021, https://pubmed.ncbi.nlm.nih.gov/34609453/ |
| Hidden kidney disease | 14% of US adults have CKD; 87% don't know it | CDC 2026, https://www.cdc.gov/kidney-disease/php/data-research/index.html |
| Lists that disagree | 2.85 unintended medication discrepancies per patient across 18 hospitals | MARQUIS2, https://pubmed.ncbi.nlm.nih.gov/33927025/ |
| Caregivers | 63 million US family caregivers; over half do medical tasks; about 20% trained | AARP/NAC 2025, https://www.aarp.org/press/releases/2025-07-24-new-report-reveals-crisis-point-for-americas-63-million-family-caregivers.html |
| Heart failure readmissions | 22.4 per 100 Medicare HF admissions within 30 days (2020) | AHRQ HCUP 2024, https://hcup-us.ahrq.gov/reports/statbriefs/SB307-508.pdf |
| Loneliness | 33% of adults 50 to 80 felt lonely and 29% isolated (2024) | U-M Healthy Aging Poll, https://ihpi.umich.edu/news/loneliness-and-isolation-back-pre-pandemic-levels-still-high-older-adults |

## Users

| Person | Gets | Where |
| --- | --- | --- |
| Harriet (senior) | A daily check-in by text or by video call, help with her medicines, heart rate as a wellness estimate, messages from family | Relay chat and Relay calls |
| Sarah (daughter, caregiver) | Daily status, alerts when something needs attention, limited to what Harriet allows | Her own Relay chat with the agent (Relay chats hold at most one person, so there is no shared group) |
| Doctor | A weekly summary: symptoms by severity, her words, vitals, medicine questions, flags with sources | A printable report (page 1 stands alone, labs and medicines on page 2) and a link |

Demo patient: Harriet Lindqvist, FinchNode synthetic scenario `polypharmacy-senior` (patient id `patient-demo-polypharmacy`): 78, CKD stage 3, atrial fibrillation, heart failure, type 2 diabetes, 14 medicines.

## MVP: the five features (team goal, set 2026-10-03)

Everything we build serves one of these. `docs/DEFINITION_OF_DONE.md` says when each is finished.

1. **Video check-in call.** Harriet calls the agent on Relay. An ElevenLabs voice holds a short, warm conversation that covers the same check-in as the text path (today's questions, how she's feeling), and guides her through a Presage reading during the call ("look at the camera and hold still for a minute"), then says her heart rate back as an estimate. After the call, what she said goes through the same extraction and severity ladder as text, so a spoken answer and a typed answer are recorded the same way. The voice says it is an AI and ends by pointing her to her family.
2. **Text check-in.** The Relay chat check-in that exists today: open question first, buttons as a fallback, the severity ladder, the safety screen. Goal now: smooth and reliable, with the Gemini calls working every time.
3. **Medication helper.** A morning reminder listing the medicines she takes in the morning, from her FinchNode record. "Do you remember how many to take?" with a gentle check. She can send a photo of a bottle or label; the agent reads it, names the medicine and strength, and checks it against her record. When a fill is running low, a refill reminder that guides her: who to ask, a ready-to-read request, and an offer to tell her family.
4. **Doctor report.** All of the week's data, from our local database and her FinchNode record, as one organized, professional summary her doctor can read in a minute.
5. **Family updates.** Check-ins, alerts and updates to each family member, plus Harriet's messages passed on. Relay family chats today; SMS or iMessage is a possible later channel, not part of the MVP.

### Defaults for the open questions (change them in FEEDBACK.md if you disagree)

- **Dosing:** the agent reads back what her prescription or label says ("Your metformin label says: take 1 tablet with your evening meal"). It never tells her to change, skip, double or stop a dose. If a photo and her record disagree: "These don't match. Please check with your pharmacist before taking it."
- **Refills:** guide, don't act. Detect running low from her fill dates, remind her, give her a ready-to-read refill request (medicine and strength) and offer to tell her family. No automated calls or orders to pharmacies.
- **Doctor delivery:** a printable report (two pages; page 1 stands alone) and a shareable link. Optional: the same data as a FHIR bundle, to show it speaks the hospital's format.
- **Family channel:** Relay family chats. SMS or iMessage only if time allows after everything else.

## Constraints

- Synthetic data only. Never connect to real patient records during the hackathon.
- FinchNode is read-only. Nothing is written back to the EHR; our own database holds what Harriet tells us.
- No diagnosis and no dosing advice. Fixed rules decide flags and severity; the LLM only reads and words. Reading back what her prescription or label says is allowed; recommending any change is not.
- Presage FDA clearance (K254169) covers pulse rate and breathing rate on its iOS/Android setup only. Readings taken from Relay call video on our server are a wellness estimate. Never show blood pressure or HRV.
- Red flags always alert the family, even at the lowest sharing level; the sharing level only limits how much the alert says. Safety wins over privacy here, on purpose.
- At most 3 questions a day. "Not today" is always an option and never gets a guilt message.
- The voice always says it is an AI. No voice cloning. No human-friend persona. Calls are short and end by pointing to a real person.
- Secrets only in `.env`.

## Success criteria for the demo

- A video call that checks in by voice and reads her heart rate, recorded the same way as a text check-in.
- A text check-in that takes one message on a good day and reacts in proportion (no alarm for small things).
- A morning medication reminder that matches her record, and a photographed bottle recognised and checked against it.
- A doctor report built from a week of check-ins, page 1 readable on its own.
- Family updates reaching a second phone.
- Medication rules match the answer key; the paper check catches the planted change.

## Claims we will not make

That it reduces readmissions, that it diagnoses anything, or that heart rate read during a Relay call is FDA-cleared.
