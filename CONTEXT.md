# Senior Check-in Companion

A daily check-in companion for an older adult living alone with several chronic conditions. Her health record comes from FinchNode; her conversations, calls and family chat happen in Relay.

## Language

### Health record

**Health record**:
Everything FinchNode returns about one patient across all her sources.
_Avoid_: Chart, EHR, file

**Record**:
One normalized item in a health record (a prescription, a dispense, a lab result, a vital sign, a condition), with a stable FinchNode id.
_Avoid_: Resource, entry, item

**Source**:
One health system that a record came from, such as Northstar Health System.
_Avoid_: Provider, EHR, connection

**Snapshot**:
One read of a patient's health record at a point in time, together with its sync status, consent receipts and warnings.
_Avoid_: Pull, fetch, export

### Dates

**Data as-of**:
How current a snapshot is, as FinchNode reports it; with several sources, the oldest source's date.
_Avoid_: Last sync, record date, as-of (alone)

**Check-in date**:
The day the app treats as "today" when it applies rules, picks questions and computes age; pinned in the demo, the real date in production.
_Avoid_: Today, now, as-of (alone)

### Vitals

**Usual range**:
The lowest to highest heart rate in her clinic readings from the health record; the only thing a new reading is compared against.
_Avoid_: Baseline, normal range, her normal

**Vitals reading**:
One heart-rate and breathing-rate estimate taken by the app from a camera, kept as a wellness estimate and never used to set the usual range.
_Avoid_: Measurement, scan result, vitals check

### Rules and flags

**Rule result**:
What one medication rule concludes about one snapshot: flag, checked or skipped, with the records that support it.
_Avoid_: Alert, finding, check

**Flag**:
A rule result worth raising with her doctor, tracked from new to told, noted and cleared so she hears about it once.
_Avoid_: Alert, warning, issue

**Red flag**:
An answer she gives during a check-in that a fixed rule treats as urgent, such as trouble breathing with heart failure; it tells her to call her doctor and alerts the family.
_Avoid_: Emergency, alarm, flag (alone)

### Permissions

**Record consent**:
Her permission for this app to read her health record through FinchNode; when it ends, the app stops reading and deletes its copy.
_Avoid_: Consent (alone), sharing, access

**Sharing level**:
Her choice of how much her family sees: status, status and vitals, or all; only she can change it.
_Avoid_: Consent, privacy setting, permissions

### People

**Senior**:
The older adult the app checks in with each day; Harriet in the demo.
_Avoid_: User, patient (outside FinchNode code), client

**Family chat**:
One family member's own Relay chat with the agent, where they receive status, alerts and messages; the senior and her family never share a chat.
_Avoid_: Family group, group chat, circle
