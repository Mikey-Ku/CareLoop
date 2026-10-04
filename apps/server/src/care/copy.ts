import type { RuleId } from "../rules/index.ts";
import type { CareContact, CareContacts } from "./contacts.ts";
import { LEVEL_WORDS, type CareFacts, type CareSymptom } from "./facts.ts";
import { andList } from "../text.ts";

// Every word the doctor and the emergency contact read over Photon, as fixed templates
// built from CareFacts. Rules decided everything in the facts; these only word them.
// Doctor: compact, labelled, numbers with dates and sources. Emergency contact: plain
// words, warm but not gushing, never reassurance the data doesn't support. Same house
// style as src/checkin/copy.ts: no em dashes, no diagnosis, no dosing advice.

const DEFAULT_TZ = "America/Detroit";

/** "09:05" in her time zone. */
export function localTime(iso: string, timezone: string | null): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: timezone ?? DEFAULT_TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));
}

/** "+1 555-555-0100" for North American numbers; other E.164 numbers as they are. */
export function displayPhone(e164: string): string {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164);
  return m ? `+1 ${m[1]}-${m[2]}-${m[3]}` : e164;
}

/** "Glomerular filtration rate [Volume Rate/Area] in Serum: 31 mL/min" -> "Glomerular filtration rate: 31 mL/min". */
function shortEvidence(value: string): string {
  const colon = value.indexOf(": ");
  if (colon < 0) return value;
  const name = value.slice(0, colon).split(" [")[0]!.trim();
  return `${name}: ${value.slice(colon + 2)}`;
}

export const DOCTOR_RULE_LABELS: Record<RuleId, string> = {
  R1: "Metformin with eGFR below the review threshold",
  R2: "Apixaban dose vs label dose-reduction criteria",
  R3: "Anticoagulant with aspirin and/or an SSRI (bleeding risk)",
  R4: "High-normal potassium on ACE inhibitor plus potassium supplement, eGFR falling",
  R5: "Gap between pharmacy refills",
  R6: "Hospital paper differs from the medication list",
};

export const FAMILY_RULE_LABELS: Record<RuleId, string> = {
  R1: "her kidney test results and her metformin",
  R2: "whether her blood thinner (apixaban) dose is the right one for her",
  R3: "a combination of her medicines that can raise the chance of bleeding",
  R4: "her potassium level, her kidney test and two of her medicines",
  R5: "a gap between her pharmacy refills",
  R6: "a difference between her hospital papers and her medication list",
};

const FLAG_STATUS_FOR_DOCTOR = { new: "not yet discussed with her", told: "she has been told", noted: "she plans to raise it with you" } as const;

// ---------------------------------------------------------------------------
// Doctor

const OUTCOME_FOR_DOCTOR: Record<CareFacts["checkin"]["outcome"], string> = {
  checked_in: "Completed",
  not_today: 'Declined ("Not today")',
  missed: "Not answered (missed)",
  in_progress: "Started, not finished",
  none: "No check-in sent",
};

function vitalsLinesForDoctor(f: CareFacts): string[] {
  const { readings, usualRange } = f.vitals;
  const tz = f.patient.timezone;
  const lines = ["VITALS (camera estimate, wellness only, not a diagnostic reading)"];
  if (readings.length === 0) lines.push("- None taken today.");
  for (const r of readings) {
    const parts = [
      r.heartRate !== null ? `HR ${Math.round(r.heartRate)} bpm` : "HR not read",
      r.breathingRate !== null ? `RR ${Math.round(r.breathingRate)} /min` : "RR not read",
      ...(r.confidence !== null ? [`confidence ${r.confidence}`] : []),
      `method ${r.method}`,
    ];
    const compared =
      r.inUsualRange === undefined ? (usualRange?.note ? ` Not compared with usual range: ${usualRange.note}` : "") : r.inUsualRange ? " Within usual range." : " Outside usual range.";
    lines.push(`- ${localTime(r.takenAt, tz)}: ${parts.join(", ")}.${compared}`);
  }
  const hr = usualRange?.heartRate;
  lines.push(hr ? `Usual clinic HR range: ${hr.low} to ${hr.high} bpm from ${hr.readings} readings.` : "Usual clinic HR range: not enough clinic readings.");
  return lines;
}

/** The doctor's summary header: who, the date, how current her record is, and that an automated assistant sent it. */
export function doctorHeader(f: CareFacts): string {
  const who = [f.patient.fullName ?? f.patient.preferredName, f.patient.age !== null ? String(f.patient.age) : undefined].filter(Boolean).join(", ");
  return [
    `Daily check-in summary for ${who} (synthetic demo patient).`,
    `Date: ${f.day}. Record data as of ${f.dataAsOf ?? "unknown"}${f.record === "none" ? " (no record copy stored: record access ended or not read)" : ""}.`,
    "Sent by an automated check-in assistant. Flags come from fixed rules on her answers and her FinchNode record.",
  ].join("\n");
}

/** A red flag's answer: in quotes when it is her answer or her words, as is when it says what happened. */
function quotedIfHers(r: CareFacts["redFlags"][number]): string {
  return r.source === "answer" || r.source === "typed" || r.source === "button" ? `"${r.answer}"` : r.answer;
}

/** The doctor's RED FLAGS lines, fixed: every red-flag answer, what she was told and who was alerted. */
export function doctorRedFlags(f: CareFacts): string {
  const redLines = [`RED FLAGS: ${f.redFlags.length}`];
  for (const r of f.redFlags) {
    const told = f.familyAlerted.length > 0 ? `${andList(f.familyAlerted)} alerted in Relay` : "no family chat linked";
    const advice =
      r.level >= 5 || r.questionId === "crisis"
        ? "She was given 988 (911 if in danger)"
        : r.level === 4
          ? "She was told to call 911 if it was happening, then her doctor"
          : "She was told to call her doctor today";
    redLines.push(`- L${r.level} ${r.question} ${quotedIfHers(r)}. ${advice}; ${told}.`);
  }
  return redLines.join("\n");
}

/** The doctor's footer: the emergency contact, and that replies are answered. */
export function doctorFooter(contacts: CareContacts): string {
  const ec = contacts.emergencyContact;
  return `Emergency contact: ${ec.name}${ec.relationship ? ` (${ec.relationship})` : ""}, ${displayPhone(ec.phone)}. Reply here with questions about this summary.`;
}

const SOURCE_FOR_DOCTOR: Record<string, string> = {
  button: "tapped",
  typed: "typed",
  follow_up: "follow-up",
  safety: "safety screen",
  photo: "label photo",
};

/** "L2 worth watching: knee pain, "my knee aches" (typed)". */
function symptomLine(s: CareSymptom): string {
  return `- L${s.level} ${LEVEL_WORDS[s.level] ?? ""}: ${s.about}${s.words ? `, "${s.words}"` : ""} (${SOURCE_FOR_DOCTOR[s.source] ?? s.source})`;
}

/** The day's extra data for the doctor, as labelled lines: symptoms by level, her notes, visit questions, medicines. */
export function doctorDayLines(f: CareFacts): string[] {
  const sections: string[] = [];
  const top = f.severity.highest;
  sections.push(
    top
      ? [`SYMPTOMS (severity ladder; highest today L${top.level}, ${LEVEL_WORDS[top.level] ?? ""})`, ...f.severity.symptoms.map(symptomLine)].join("\n")
      : "SYMPTOMS (severity ladder): nothing above level 0 today.",
  );
  if (f.notes.length > 0) sections.push(["HER NOTES FOR YOU", ...f.notes.map((n) => `- ${n.about}: "${n.text}"`)].join("\n"));
  if (f.visitQuestions.length > 0) sections.push(["VISIT QUESTIONS (asked today)", ...f.visitQuestions.map((q) => `- ${q}`)].join("\n"));
  const m = f.medicines;
  const medLines = [
    ...m.doses.map((d) => `- ${d.slot === "morning" ? "Morning" : "Evening"} medicines reminder: ${d.status}.`),
    ...m.labelMismatches.map((l) =>
      l.outcome === "strength_differs"
        ? `- Label photo: ${l.label}; her list has ${l.onHerList ?? "another strength"} (strength differs; she was told to check with her pharmacist).`
        : `- Label photo: ${l.label}; not on her medication list (she was told to check with her pharmacist).`,
    ),
    ...m.refills.map((r) => `- Refill: ${r.medicine}, runs out ${r.runsOut}; ${r.status === "asked" ? "she says she asked for it" : r.status === "snoozed" ? "reminded, she'll do it tomorrow" : "reminded"}${r.familyTold ? "; family told" : ""}.`),
  ];
  if (medLines.length > 0) sections.push(["MEDICINES TODAY", ...medLines].join("\n"));
  return sections;
}

/**
 * The doctor's summary: fixed data sections. `overview`, when given, is the LLM's few lines about the day
 * (src/care/writer.ts), placed under the header and labelled; the data lines stay as they are.
 */
export function doctorSummary(f: CareFacts, contacts: CareContacts, overview?: string): string {
  const tz = f.patient.timezone;
  const sections: string[] = [];

  sections.push(doctorHeader(f));
  if (overview) sections.push(`OVERVIEW (worded by the assistant from the data below)\n${overview}`);

  const c = f.checkin;
  const timing =
    c.startedAt && c.outcome !== "none"
      ? ` (sent ${localTime(c.startedAt, tz)}${c.finishedAt ? `, finished ${localTime(c.finishedAt, tz)}` : ""})`
      : "";
  const checkinLines = [`CHECK-IN: ${OUTCOME_FOR_DOCTOR[c.outcome]}${timing}.`];
  const redIds = new Set(f.redFlags.filter((r) => r.source === "answer").map((r) => r.questionId));
  for (const a of c.answers)
    checkinLines.push(`- ${a.question} ${a.answer}${redIds.has(a.questionId) ? "  [RED FLAG]" : a.worrying ? "  [non-routine answer]" : ""}`);
  if (c.answers.length === 0 && c.outcome !== "none") checkinLines.push("- No answers recorded.");
  sections.push(checkinLines.join("\n"));

  sections.push(doctorRedFlags(f));
  sections.push(...doctorDayLines(f));

  sections.push(vitalsLinesForDoctor(f).join("\n"));

  const flagLines = [`RECORD FLAGS (rule-based, for review): ${f.flags.length}`];
  for (const flag of f.flags) {
    const seen = new Set<string>();
    const evidence = flag.evidence
      .map((e) => `${shortEvidence(e.value)}${e.date ? ` (${e.date})` : ""}`)
      .filter((e) => (seen.has(e) ? false : (seen.add(e), true)))
      .slice(0, 5);
    flagLines.push(
      `- ${flag.ruleId} ${DOCTOR_RULE_LABELS[flag.ruleId]} [${flag.severity ?? "unrated"}; ${FLAG_STATUS_FOR_DOCTOR[flag.status]}]` +
        (evidence.length > 0 ? `\n  Evidence: ${evidence.join("; ")}` : ""),
    );
  }
  sections.push(flagLines.join("\n"));

  if (f.recentLabs.length > 0)
    sections.push(
      ["RECENT LABS", ...f.recentLabs.slice(0, 6).map((l) => `- ${l.name} ${l.value} ${l.unit} (${l.date}${l.refRange ? `; ref ${l.refRange}` : ""})`)].join("\n"),
    );
  if (f.medications.length > 0)
    sections.push(`ACTIVE MEDICATIONS (${f.medications.length}): ${f.medications.map((m) => m.name).join("; ")}`);
  if (f.conditions.length > 0) sections.push(`CONDITIONS: ${f.conditions.join("; ")}`);
  if (f.memories.length > 0) sections.push(["SHARED ON HER CALL TODAY", ...f.memories.map((m) => `- ${m}`)].join("\n"));

  sections.push(doctorFooter(contacts));
  return sections.join("\n\n");
}

// ---------------------------------------------------------------------------
// Emergency contact (family)
//
// What the emergency contact reads follows Harriet's sharing level, as her family's Relay messages do
// (familyDailyStatus, familyRedFlagAlert in src/checkin/copy.ts):
//   status         how the check-in went, and the base line of anything urgent (no detail)
//   status_vitals  also her camera heart rate as within or outside her usual range, no number (with
//                  atrial fibrillation only "checked, a camera estimate")
//   all            also her answers, the urgent detail, the number, flags she has heard (told or
//                  noted), her notes, visit questions, medicines, other symptoms and her call's memories
// Anything at level 3 or more always gets its base line: safety wins over privacy, on purpose.

/** Whether the camera reading is compared with her usual range (not with atrial fibrillation). */
const isAfib = (f: CareFacts) => /atrial fibrillation/i.test(f.vitals.usualRange?.note ?? "");

function vitalsForFamily(f: CareFacts): string | undefined {
  const sharing = f.patient.sharing;
  if (sharing === "status") return undefined;
  const r = f.vitals.readings.at(-1);
  if (!r || (r.heartRate === null && r.breathingRate === null)) return undefined;
  const estimate = "This is a camera estimate, not a medical test.";
  const name = f.patient.preferredName;
  if (sharing === "status_vitals") {
    if (r.inUsualRange === true) return `${name}'s camera heart-rate check today was within her usual range from clinic visits. ${estimate}`;
    if (r.inUsualRange === false) return `${name}'s camera heart-rate check today was outside her usual range from clinic visits, which is worth mentioning to her doctor. ${estimate}`;
    return `${name}'s heart rate was checked today with the camera. ${estimate}`;
  }
  const bits: string[] = [];
  if (r.heartRate !== null) bits.push(`her heart rate was about ${Math.round(r.heartRate)} beats a minute`);
  if (r.breathingRate !== null) bits.push(`her breathing was about ${Math.round(r.breathingRate)} breaths a minute`);
  const lines = [`On her camera check, ${andList(bits)}. ${estimate}`];
  if (r.inUsualRange === true) lines.push("Her heart rate was within her usual range from clinic visits.");
  else if (r.inUsualRange === false) lines.push("Her heart rate was outside her usual range from clinic visits, which is worth mentioning to her doctor.");
  else if (isAfib(f)) lines.push("Because she has an irregular heartbeat (atrial fibrillation), the camera number is only a rough estimate.");
  return lines.join(" ");
}

/** The family greeting: who is writing, that it is automated, and the day. */
export function familyGreeting(f: CareFacts, contacts: CareContacts): string {
  const name = f.patient.preferredName;
  return `Hi ${contacts.emergencyContact.name}. This is ${name}'s daily check-in assistant. I'm an automated assistant, not a person. Here is ${name}'s update for ${f.day}.`;
}

export const FAMILY_CLOSING = "If you have a question about today's update, you can reply here.";

/**
 * What the emergency contact may see beyond how the check-in went and the urgent base lines, by her
 * sharing level (see above). Everything below level 3 is "all" only; a refill also when she asked us to
 * tell her family.
 */
export function familyVisible(f: CareFacts) {
  const all = f.patient.sharing === "all";
  const m = f.medicines;
  return {
    answers: all ? f.checkin.answers : [],
    symptoms: all ? f.severity.symptoms.filter((s) => s.level < 3) : [],
    notes: all ? f.notes : [],
    visitQuestions: all ? f.visitQuestions : [],
    doses: all ? m.doses : [],
    labelMismatches: all ? m.labelMismatches : [],
    refills: all ? m.refills : m.refills.filter((r) => r.familyTold),
    heardFlags: all ? f.flags.filter((x) => x.status === "told" || x.status === "noted") : [],
    memories: all ? f.memories : [],
  };
}

/**
 * The fixed paragraph about anything urgent today (level 3 and up), or undefined. Never written by a
 * model. The base lines match her family's Relay alerts and go out at every sharing level: a crisis
 * (call her now), an urgent symptom (call her now), something to call her doctor about (call her
 * today). The detail (the question and her answer, what she was told) only at "all". 911 only for
 * level 4 and up.
 */
export function familyAttention(f: CareFacts, contacts: CareContacts): string | undefined {
  if (f.redFlags.length === 0) return undefined;
  const name = f.patient.preferredName;
  const all = f.patient.sharing === "all";
  const crisis = f.redFlags.some((r) => r.questionId === "crisis" || r.level >= 5);
  const urgent = f.redFlags.some((r) => r.level === 4 && r.questionId !== "crisis");
  const three = f.redFlags.filter((r) => r.level === 3);
  const lines: string[] = [];
  if (crisis) {
    lines.push(`${name} may be going through a very hard time. Please call her now.`);
    if (all) lines.push(`I asked ${name} to call or text 988, the Suicide & Crisis Lifeline, or 911 if in danger.`);
  }
  if (urgent) {
    lines.push(`${name} told me about something that may be urgent. Please call ${name} now to check on her.`);
    if (all) lines.push(`I asked ${name} to call 911 if it's happening now, and then her doctor.`);
  }
  if (three.length > 0) {
    lines.push(`${name} reported something she should call her doctor about.${crisis || urgent ? "" : ` Please call ${name} today to check on her.`}`);
    if (all) {
      for (const r of three) lines.push(`- ${r.question} ${quotedIfHers(r)}`);
      lines.push(`I asked ${name} to call her doctor today.`);
    }
  }
  lines.push(`If you have questions about what this means, ${contacts.doctor.name} can be reached at ${displayPhone(contacts.doctor.phone)}.`);
  return lines.join("\n");
}

/** The day's extra data for the family, in plain words, cut by her sharing level (familyVisible). */
export function familyDayLines(f: CareFacts): string[] {
  const name = f.patient.preferredName;
  const v = familyVisible(f);
  const sections: string[] = [];
  const small = v.symptoms.map((s) => `- ${s.about}${s.level === 2 ? " (we're keeping an eye on it)" : " (noted for her doctor)"}${s.words ? `: "${s.words}"` : ""}`);
  if (small.length > 0) sections.push([`${name} also mentioned:`, ...small].join("\n"));
  if (v.notes.length > 0) sections.push([`${name} wrote these down for her doctor:`, ...v.notes.map((n) => `- ${n.about}: "${n.text}"`)].join("\n"));
  if (v.visitQuestions.length > 0) sections.push([`Questions ${name} wants to ask at her next visit:`, ...v.visitQuestions.map((q) => `- ${q}`)].join("\n"));
  const meds = [
    ...v.doses.map((d) => `- ${d.slot === "morning" ? "Morning" : "Evening"} medicines: ${d.status === "taken" ? "she said she took them" : "not confirmed"}.`),
    ...v.labelMismatches.map((l) => `- A medicine label she photographed (${l.label}) didn't match her list, so I asked her to check with her pharmacist.`),
    ...v.refills.map((r) => `- ${r.medicine} runs out around ${r.runsOut}${r.status === "asked" ? "; she says she has asked for a refill" : "; I reminded her to ask for a refill"}.`),
  ];
  if (meds.length > 0) sections.push([`${name}'s medicines today:`, ...meds].join("\n"));
  return sections;
}

/** How the check-in went, in one line; her answers under it at "all" only. */
function familyOutcome(f: CareFacts): string {
  const name = f.patient.preferredName;
  const answers = familyVisible(f).answers.map((a) => `- "${a.question}" ${name} answered: ${a.answer}`);
  const c = f.checkin;
  switch (c.outcome) {
    case "checked_in":
      return [`${name} checked in today.`, ...answers].join("\n");
    case "not_today":
      return `${name} said "not today" to this morning's check-in. That's her choice, and I'll check in again tomorrow.`;
    case "missed":
      return `${name} hasn't answered this morning's check-in. You may want to give ${name} a call.`;
    case "in_progress":
      return [`${name} started this morning's check-in but hasn't finished it yet.`, ...answers].join("\n");
    case "none":
      return `There was no check-in with ${name} today.`;
  }
}

export function familySummary(f: CareFacts, contacts: CareContacts): string {
  const name = f.patient.preferredName;
  const v = familyVisible(f);
  const sections: string[] = [familyGreeting(f, contacts), familyOutcome(f)];

  const attention = familyAttention(f, contacts);
  if (attention) sections.push(attention);
  sections.push(...familyDayLines(f));

  const vitals = vitalsForFamily(f);
  if (vitals) sections.push(vitals);

  // Only flags she has already heard: she should never learn about one from her family first.
  if (v.heardFlags.length > 0)
    sections.push(
      [
        `Things on ${name}'s list to ask her doctor about (not emergencies):`,
        ...v.heardFlags.map((flag) => `- ${FAMILY_RULE_LABELS[flag.ruleId]}${flag.status === "noted" ? ` (${name} plans to ask her doctor)` : ""}`),
      ].join("\n"),
    );

  if (v.memories.length > 0) sections.push([`From ${name}'s call today:`, ...v.memories.map((m) => `- ${m}`)].join("\n"));

  sections.push(FAMILY_CLOSING);
  return sections.join("\n\n");
}

/** Her camera reading for a family reply, as her sharing level allows; undefined when it allows none. */
export function familyVitalsAnswer(f: CareFacts): string {
  const name = f.patient.preferredName;
  if (f.patient.sharing === "status") return `${name} keeps her health readings between her and her doctor, so I can't share them.`;
  return vitalsForFamily(f) ?? `${name} didn't do a camera heart-rate check today.`;
}

// ---------------------------------------------------------------------------
// Fixed replies (rules decide these; no LLM)

/**
 * The emergency contact describes an emergency happening to her (a fall, chest pain, can't breathe,
 * unconscious: the safety screen's level 4). 911 now, then her doctor.
 */
export function familyEmergencyReply(f: CareFacts | undefined, contacts: CareContacts): string {
  const doctor = contacts.doctor;
  return [
    "If this is happening now, please call 911 right away.",
    `After that, call ${possessive(f)} doctor, ${doctor.name}, at ${displayPhone(doctor.phone)}.`,
    "I'm an automated assistant, so I can't judge symptoms or act on them myself.",
  ].join(" ");
}

/** The emergency contact says she may harm herself or not want to live (level 5). 988, and 911 if she is in danger. */
export function familyCrisisReply(f: CareFacts | undefined): string {
  const who = f ? f.patient.preferredName : "she";
  return [
    `Please call or text 988, the Suicide & Crisis Lifeline, now. They can help you support ${f ? who : "her"}.`,
    `If ${who} is in danger right now, call 911.`,
    "I'm an automated assistant, so I can't act on this myself.",
  ].join(" ");
}

/** The emergency contact describes a symptom or asks what to do (below level 4): her doctor, no 911. */
export function familySymptomReply(f: CareFacts | undefined, contacts: CareContacts): string {
  const doctor = contacts.doctor;
  return [
    "I'm an automated assistant, so I don't have the medical knowledge to judge symptoms or decide what to do about them.",
    `Please contact ${possessive(f)} doctor, ${doctor.name}, at ${displayPhone(doctor.phone)}.`,
  ].join(" ");
}

/** "Harriet's", or "her" when there is no summary to name her from. */
function possessive(f: CareFacts | undefined): string {
  return f ? `${f.patient.preferredName}'s` : "her";
}

/** The doctor asked the assistant to do something (call 911, send her in). It can't act. */
export function doctorActionReply(contacts: CareContacts): string {
  const ec = contacts.emergencyContact;
  return `Noted. I'm an automated assistant and can't take action or contact anyone on your behalf. Her emergency contact is ${ec.name}${ec.relationship ? ` (${ec.relationship})` : ""} at ${displayPhone(ec.phone)}.`;
}

/** A question that needs her doctor, from the emergency contact: dosing, whether to change a medicine. */
export function familyAskDoctorReply(f: CareFacts | undefined, contacts: CareContacts): string {
  return `That's a question for ${possessive(f)} doctor. I can't give advice about medicines or doses. ${contacts.doctor.name} can be reached at ${displayPhone(contacts.doctor.phone)}.`;
}

export function noSummaryReply(contact: CareContact): string {
  return contact.audience === "doctor"
    ? "No check-in summary has been sent yet, so I have nothing to answer from. The next summary goes out after her next check-in."
    : "I haven't sent an update yet, so I don't have anything to share. You'll get one after the next check-in.";
}
