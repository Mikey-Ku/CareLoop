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
| Harriet (senior) | Friendly check-ins, plain answers about her own medicines, heart rate compared with her usual range, messages from family | Relay chat and calls |
| Sarah (daughter, caregiver) | Daily status, missed check-in alerts, flags, limited to what Harriet allows | Relay group chat |
| Doctor | Vitals trend, reported symptoms, medication flags with sources, her questions | Visit-prep PDF (stretch) |

Demo patient: Harriet Lindqvist, FinchNode synthetic scenario `polypharmacy-senior` (patient id `patient-demo-polypharmacy`): 78, CKD stage 3, atrial fibrillation, heart failure, type 2 diabetes, 14 medicines.

## MVP (demo core)

1. Morning chat check-in in Relay with buttons, at most 3 questions picked from her record.
2. "Call me to chat": ElevenLabs voice call through Relay that remembers what she shared and ends by pointing her to family.
3. "Check my vitals": Relay video call, quiet minute, Presage heart rate compared with her usual range from clinic readings in the record; breathing rate said back and saved, not compared (her record has no breathing-rate readings).
4. Voice messages between Harriet and family through Relay, both ways.
5. Hospital paper check: photo of discharge or visit papers, read back for her to confirm, compared with her FinchNode medication list.
6. Missed check-in alert to the family group.

If time: medication rules shown to the user, consent controls and revocation, visit-prep PDF, weekly family summary.
Slide only: plain-language lab explanations, other languages, story capture.
Later: smart pillbox.

## Constraints

- Synthetic data only. Never connect to real patient records during the hackathon.
- FinchNode is read-only. Nothing is written back to the EHR; our own database holds what Harriet tells us.
- No diagnosis and no dosing advice. Fixed rules decide flags; the LLM only words them.
- Presage FDA clearance (K254169) covers pulse rate and breathing rate on its iOS/Android setup only. Readings taken from Relay call video on our server are a wellness estimate. Never show blood pressure or HRV.
- Red flags always alert the family, even at the lowest sharing level; the sharing level only limits how much the alert says. Safety wins over privacy here, on purpose.
- At most 3 questions a day. "Not today" is always an option and never gets a guilt message.
- The voice always says it is an AI. No voice cloning. No human-friend persona. Calls are short and end by pointing to a real person.
- Secrets only in `.env`.

## Success criteria for the demo

- Paper check catches the planted change in a printed synthetic discharge sheet.
- Medication rules match a written answer key on the FinchNode demo patients.
- In-call heart rate is close to Presage's own app on the same person in the same minute (or the fallback scan screen is used).
- A full check-in takes a few taps and under a minute for the text path.

## Claims we will not make

That it reduces readmissions, that it diagnoses anything, or that heart rate read during a Relay call is FDA-cleared.
