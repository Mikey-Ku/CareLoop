import type { RuleId } from "../rules/index.ts";
import type { CareContact, CareContacts } from "./contacts.ts";
import type { CareFacts } from "./facts.ts";

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

const DOCTOR_RULE_LABELS: Record<RuleId, string> = {
  R1: "Metformin with eGFR below the review threshold",
  R2: "Apixaban dose vs label dose-reduction criteria",
  R3: "Anticoagulant with aspirin and/or an SSRI (bleeding risk)",
  R4: "High-normal potassium on ACE inhibitor plus potassium supplement, eGFR falling",
  R5: "Gap between pharmacy refills",
  R6: "Hospital paper differs from the medication list",
};

const FAMILY_RULE_LABELS: Record<RuleId, string> = {
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

export function doctorSummary(f: CareFacts, contacts: CareContacts): string {
  const tz = f.patient.timezone;
  const who = [f.patient.fullName ?? f.patient.preferredName, f.patient.age !== null ? String(f.patient.age) : undefined].filter(Boolean).join(", ");
  const sections: string[] = [];

  sections.push(
    [
      `Daily check-in summary for ${who} (synthetic demo patient).`,
      `Date: ${f.day}. Record data as of ${f.dataAsOf ?? "unknown"}${f.record === "none" ? " (no record copy stored: record access ended or not read)" : ""}.`,
      "Sent by an automated check-in assistant. Flags come from fixed rules on her answers and her FinchNode record.",
    ].join("\n"),
  );

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

  const redLines = [`RED FLAGS: ${f.redFlags.length}`];
  for (const r of f.redFlags) {
    const told = f.familyAlerted.length > 0 ? `${listJoin(f.familyAlerted)} alerted in Relay` : "no family chat linked";
    redLines.push(`- ${r.question} "${r.answer}". She was told to call her doctor today; ${told}.`);
  }
  sections.push(redLines.join("\n"));

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

  const ec = contacts.emergencyContact;
  sections.push(
    `Emergency contact: ${ec.name}${ec.relationship ? ` (${ec.relationship})` : ""}, ${displayPhone(ec.phone)}. Reply here with questions about this summary.`,
  );
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

export function familySummary(f: CareFacts, contacts: CareContacts): string {
  const name = f.patient.preferredName;
  const ec = contacts.emergencyContact;
  const doctor = contacts.doctor;
  const sections: string[] = [
    `Hi ${ec.name}. This is ${name}'s daily check-in assistant. I'm an automated assistant, not a person. Here is ${name}'s update for ${f.day}.`,
  ];

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

  if (f.redFlags.length > 0) {
    const which = f.redFlags.map((r) => `"${r.answer}" to "${r.question}"`);
    sections.push(
      `One thing needs attention: ${name} answered ${listJoin(which)}. I asked ${name} to call her doctor today. Please call ${name} today to check on her. ` +
        `If you have questions about what this means, ${doctor.name} can be reached at ${displayPhone(doctor.phone)}.`,
    );
  }

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

  sections.push("If you have a question about today's update, you can reply here.");
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
