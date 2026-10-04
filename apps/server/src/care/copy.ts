import type { RuleId } from "../rules/index.ts";
import type { CareContact, CareContacts } from "./contacts.ts";
import { LEVEL_WORDS, type CareFacts, type CareSymptom } from "./facts.ts";

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

function listJoin(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
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

/** The doctor's RED FLAGS lines, fixed: every red-flag answer, what she was told and who was alerted. */
export function doctorRedFlags(f: CareFacts): string {
  const redLines = [`RED FLAGS: ${f.redFlags.length}`];
  for (const r of f.redFlags) {
    const told = f.familyAlerted.length > 0 ? `${listJoin(f.familyAlerted)} alerted in Relay` : "no family chat linked";
    redLines.push(`- ${r.question} "${r.answer}". She was told to call her doctor today; ${told}.`);
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
  const redIds = new Set(f.redFlags.map((r) => r.questionId));
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

function vitalsForFamily(f: CareFacts): string | undefined {
  const r = f.vitals.readings.at(-1);
  if (!r || (r.heartRate === null && r.breathingRate === null)) return undefined;
  const bits: string[] = [];
  if (r.heartRate !== null) bits.push(`her heart rate was about ${Math.round(r.heartRate)} beats a minute`);
  if (r.breathingRate !== null) bits.push(`her breathing was about ${Math.round(r.breathingRate)} breaths a minute`);
  const lines = [`On her camera check, ${listJoin(bits)}. This is a camera estimate, not a medical test.`];
  if (r.inUsualRange === true) lines.push("Her heart rate was within her usual range from clinic visits.");
  else if (r.inUsualRange === false) lines.push("Her heart rate was outside her usual range from clinic visits, which is worth mentioning to her doctor.");
  else if (f.vitals.usualRange?.note && /atrial fibrillation/i.test(f.vitals.usualRange.note))
    lines.push("Because she has an irregular heartbeat (atrial fibrillation), the camera number is only a rough estimate.");
  return lines.join(" ");
}

/** The family greeting: who is writing, that it is automated, and the day. */
export function familyGreeting(f: CareFacts, contacts: CareContacts): string {
  const name = f.patient.preferredName;
  return `Hi ${contacts.emergencyContact.name}. This is ${name}'s daily check-in assistant. I'm an automated assistant, not a person. Here is ${name}'s update for ${f.day}.`;
}

export const FAMILY_CLOSING = "If you have a question about today's update, you can reply here.";

/**
 * What the emergency contact may see of the day's extra data, by her sharing level (as her family's
 * Relay status does): symptoms below level 3, her notes, visit questions, medicine reminders and label
 * photos only at "all"; a refill only at "all" or when she asked us to tell her family. Anything at
 * level 3 or more is always included (her words only at "all"), as red flags always are.
 */
export function familyVisible(f: CareFacts) {
  const all = f.patient.sharing === "all";
  const m = f.medicines;
  return {
    urgent: f.severity.symptoms.filter((s) => s.level >= 3).map((s) => ({ ...s, words: all ? s.words : null })),
    symptoms: all ? f.severity.symptoms.filter((s) => s.level < 3) : [],
    notes: all ? f.notes : [],
    visitQuestions: all ? f.visitQuestions : [],
    doses: all ? m.doses : [],
    labelMismatches: all ? m.labelMismatches : [],
    refills: all ? m.refills : m.refills.filter((r) => r.familyTold),
  };
}

/**
 * The fixed paragraph about anything urgent today, or undefined: her red-flag answers (always), then
 * anything else at level 3 or more (a typed symptom, a safety screen hit). Never written by a model.
 */
export function familyAttention(f: CareFacts, contacts: CareContacts): string | undefined {
  const name = f.patient.preferredName;
  const doctor = contacts.doctor;
  const parts: string[] = [];
  if (f.redFlags.length > 0) {
    const which = f.redFlags.map((r) => `"${r.answer}" to "${r.question}"`);
    parts.push(`One thing needs attention: ${name} answered ${listJoin(which)}. I asked ${name} to call her doctor today.`);
  }
  const covered = new Set(f.redFlags.map((r) => r.questionId));
  const others = familyVisible(f).urgent.filter((s) => !covered.has(s.topic));
  if (others.some((s) => s.level >= 4)) parts.push(`${name} told me about something urgent today, and I gave her the emergency numbers.`);
  for (const s of others.filter((x) => x.level === 3))
    parts.push(`${name} mentioned ${s.about} today${s.words ? ` ("${s.words}")` : ""}, and I asked her to call her doctor today.`);
  if (parts.length === 0) return undefined;
  parts.push(`Please call ${name} today to check on her. If you have questions about what this means, ${doctor.name} can be reached at ${displayPhone(doctor.phone)}.`);
  return parts.join(" ");
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

export function familySummary(f: CareFacts, contacts: CareContacts): string {
  const name = f.patient.preferredName;
  const sections: string[] = [familyGreeting(f, contacts)];

  const c = f.checkin;
  if (c.outcome === "checked_in") {
    const lines = [`${name} checked in today.`];
    for (const a of c.answers) lines.push(`- "${a.question}" ${name} answered: ${a.answer}`);
    sections.push(lines.join("\n"));
  } else if (c.outcome === "not_today") {
    sections.push(`${name} said "not today" to this morning's check-in. That's her choice, and I'll check in again tomorrow.`);
  } else if (c.outcome === "missed") {
    sections.push(`${name} hasn't answered this morning's check-in. You may want to give ${name} a call.`);
  } else if (c.outcome === "in_progress") {
    const lines = [`${name} started this morning's check-in but hasn't finished it yet.`];
    for (const a of c.answers) lines.push(`- "${a.question}" ${name} answered: ${a.answer}`);
    sections.push(lines.join("\n"));
  } else {
    sections.push(`There was no check-in with ${name} today.`);
  }

  const attention = familyAttention(f, contacts);
  if (attention) sections.push(attention);
  sections.push(...familyDayLines(f));

  const vitals = vitalsForFamily(f);
  if (vitals) sections.push(vitals);

  // Only flags she has already heard: she should never learn about one from her family first.
  const heard = f.flags.filter((flag) => flag.status === "told" || flag.status === "noted");
  if (heard.length > 0)
    sections.push(
      [
        `Things on ${name}'s list to ask her doctor about (not emergencies):`,
        ...heard.map((flag) => `- ${FAMILY_RULE_LABELS[flag.ruleId]}${flag.status === "noted" ? ` (${name} plans to ask her doctor)` : ""}`),
      ].join("\n"),
    );

  if (f.memories.length > 0) sections.push([`From ${name}'s call today:`, ...f.memories.map((m) => `- ${m}`)].join("\n"));

  sections.push(FAMILY_CLOSING);
  return sections.join("\n\n");
}

// ---------------------------------------------------------------------------
// Fixed replies (rules decide these; no LLM)

/** Emergency contact wrote something urgent. Doctor first, as the team asked; 911 stays as the last line. */
export function familyUrgentReply(f: CareFacts | undefined, contacts: CareContacts): string {
  const doctor = contacts.doctor;
  return [
    `I'm an automated assistant, so I don't have the medical knowledge to judge symptoms or decide what to do about them.`,
    `Please contact ${possessive(f)} doctor, ${doctor.name}, first at ${displayPhone(doctor.phone)} before acting on this.`,
    "If it looks like an emergency, call 911.",
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
