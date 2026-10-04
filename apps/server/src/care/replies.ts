import { screenMessage } from "../safety/screen.ts";
import { softenDashes } from "../text.ts";
import type { CareAudience, CareContact, CareContacts } from "./contacts.ts";
import {
  displayPhone,
  doctorActionReply,
  familyAskDoctorReply,
  familyCrisisReply,
  familyEmergencyReply,
  familySymptomReply,
  familyVisible,
  familyVitalsAnswer,
  localTime,
} from "./copy.ts";
import type { CareFacts } from "./facts.ts";

// Follow-up replies to the doctor and the emergency contact. Fixed rules decide first, on the
// severity ladder like Harriet's own messages:
//   - an acknowledgment ("Thanks", "Ok") needs no reply;
//   - the emergency contact describing a crisis ("she wants to die"): 988, 911 if she is in danger;
//   - an emergency happening to her ("she fell", "chest pain", "she can't breathe", "unconscious",
//     or they mention 911 or an ambulance themselves): 911 now, then her doctor. Read by the app's
//     fixed safety screen (src/safety/screen.ts) on their words turned to first person ("she fell"
//     reads as "I fell"), plus a few phrases only a bystander says ("unconscious", "not breathing");
//   - a symptom or "what should I do" below that ("her knee hurts", "she seems worse", "dizzy"):
//     her doctor, no 911;
//   - the emergency contact asking about doses or changing a medicine is sent to the doctor;
//   - the doctor asking the assistant to act (call 911, send her in) gets a fixed "can't act".
// Everything else is a question or statement about the summary: a ReplyWriter (Gemini, src/care/writer.ts)
// words an answer from the stored facts only, in the audience's tone; its text is checked
// by guardReply, and the template answer is used when there is no writer or it fails.

export type InboundIntent = "none" | "family_crisis" | "family_emergency" | "family_symptom" | "family_ask_doctor" | "doctor_action" | "answer";

const ACK = /^\s*(ok(ay)?|k|kk|thanks?|thank you|thank you so much|thanks so much|ty|thx|got it|will do|great|good|noted|sounds good|perfect|cool|understood|appreciate it|👍|🙏|❤️|👌)[\s.!]*$/iu;

/** Emergencies only a bystander describes, or 911 named by them. */
const FAMILY_EMERGENCY =
  /\b(911|ambulance|emergency room|unconscious|unresponsive|not responding|won'?t wake( up)?|can'?t wake (her|him) up|(is ?n'?t|not|stopped) breathing|collaps\w*|seizure|having a stroke|having a heart attack)\b/i;

/** A symptom or a "what should I do" below an emergency: her doctor, no 911. */
const FAMILY_SYMPTOM =
  /\b(emergenc\w*|hospital|urgent\w*|needs? help|get (her )?help|trouble breathing|short(ness)? of breath|stroke|heart attack|faint\w*|confus\w*|bleeding|blood in|vomit\w*|pain|hurt\w*|dizzy|swollen|swelling|bruis\w*|symptom\w*|worse|sick|what should (i|we) do|should (i|we) (call|go|take|bring))\b/i;

const FAMILY_ASK_DOCTOR =
  /\b(dose|doses|dosage|mg|milligrams?|should (she|i|we) (take|stop|start|skip|change|cut)|stop taking|start taking|take (more|less|extra)|increase|decrease|double|halve|extra pill)\b/i;

const DOCTOR_ACTION = /\b(call 911|call an ambulance|call (her|harriet|the family|sarah)|send her (to|in)|admit her|take her to|get her to)\b/i;

/**
 * Their words about her as if she wrote them, so the app's safety screen (written in the first person)
 * reads them: "she fell" -> "I fell", "she wants to die" -> "I want to die", "her chest hurts" -> "my chest hurts".
 */
export function asHerOwnWords(text: string, seniorName?: string): string {
  let t = text;
  if (seniorName) t = t.replace(new RegExp(`\\b${seniorName.replace(/[^A-Za-z]/g, "")}('s)?\\b`, "gi"), (_m, poss: string | undefined) => (poss ? "her" : "she"));
  return t
    .replace(/\b(mom|mum|mother|grandma|nana)'s\b/gi, "her")
    .replace(/\b(my |our )?(mom|mum|mother|grandma|nana)\b/gi, "she")
    .replace(/\bshe'?s\b/gi, "I'm")
    .replace(/\bshe (is|was)\b/gi, (_m, v: string) => (v.toLowerCase() === "is" ? "I am" : "I was"))
    .replace(/\bshe (has|wants|says|doesn'?t|does)\b/gi, (_m, v: string) => `I ${({ has: "have", wants: "want", says: "say", does: "do" } as Record<string, string>)[v.toLowerCase()] ?? "don't"}`)
    .replace(/\bherself\b/gi, "myself")
    .replace(/\bher\b/gi, "my")
    .replace(/\bshe\b/gi, "I");
}

export function classifyInbound(audience: CareAudience, text: string, seniorName?: string): InboundIntent {
  if (ACK.test(text)) return "none";
  if (audience === "family") {
    const hit = screenMessage(asHerOwnWords(text, seniorName)) ?? screenMessage(text);
    if (hit?.kind === "crisis") return "family_crisis";
    if (hit?.kind === "urgent_symptom" || FAMILY_EMERGENCY.test(text)) return "family_emergency";
    if (FAMILY_SYMPTOM.test(text)) return "family_symptom";
    if (FAMILY_ASK_DOCTOR.test(text)) return "family_ask_doctor";
    return "answer";
  }
  if (DOCTOR_ACTION.test(text)) return "doctor_action";
  return "answer";
}

/** The reply a rule fixes for this intent, or undefined when the reply is to be written. */
export function fixedReply(intent: InboundIntent, facts: CareFacts | undefined, contacts: CareContacts): string | null | undefined {
  switch (intent) {
    case "none":
      return null;
    case "family_crisis":
      return familyCrisisReply(facts);
    case "family_emergency":
      return familyEmergencyReply(facts, contacts);
    case "family_symptom":
      return familySymptomReply(facts, contacts);
    case "family_ask_doctor":
      return familyAskDoctorReply(facts, contacts);
    case "doctor_action":
      return doctorActionReply(contacts);
    case "answer":
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// Writing an answer

export type ThreadTurn = { from: "assistant" | "contact"; text: string };

export type ReplyRequest = {
  contact: CareContact;
  contacts: CareContacts;
  facts: CareFacts;
  /** The summary text exactly as this contact received it. */
  summaryText: string;
  /** Earlier messages with this contact, oldest first, without the new one. */
  thread: ThreadTurn[];
  message: string;
};

export interface ReplyWriter {
  /** The reply text, or null when the message needs no reply. Throws on failure; the caller falls back. */
  write(request: ReplyRequest): Promise<string | null>;
  /** The body of the day's summary for one reader (src/care/writer.ts). Throws on failure; the caller sends the template. */
  writeSummary?(request: { audience: CareAudience; facts: CareFacts; contacts: CareContacts }): Promise<string>;
}

export const MAX_REPLY_CHARS: Record<CareAudience, number> = { doctor: 1200, family: 800 };

const DOSING_ADVICE = [
  /\b(you|she|harriet|they) (should|could|can|must|needs? to) (take|stop|start|increase|decrease|double|skip|halve|reduce|cut)\b/i,
  /\b(increase|decrease|double|halve|reduce|raise|lower|cut|adjust)\s+(her|the|his|your)\s+(dose|dosage|medication|medicine|metformin|apixaban|pills?)\b/i,
  /\b(stop|start)\s+(taking|her|the)\s+\w+/i,
];

/**
 * Check written text before it is sent. Returns the cleaned text, or undefined when it must
 * not be sent (empty, too long, or reads as dosing advice), so the template answer goes instead.
 */
export function guardReply(text: string, audience: CareAudience): string | undefined {
  let cleaned = softenDashes(text.trim()).replace(/\*\*|__|^#+\s*/gm, "");
  if (audience === "family") cleaned = cleaned.replace(/!+/g, ".");
  if (!cleaned) return undefined;
  if (cleaned.length > MAX_REPLY_CHARS[audience]) return undefined;
  if (DOSING_ADVICE.some((re) => re.test(cleaned))) return undefined;
  return cleaned;
}

/** The written reply after the guard, or the template answer. Never throws. */
export async function writeReply(writer: ReplyWriter | undefined, request: ReplyRequest, log: (line: string) => void = () => {}): Promise<string | null> {
  if (writer) {
    try {
      const written = await writer.write(request);
      if (written === null) return null;
      const safe = guardReply(written, request.contact.audience);
      if (safe) return safe;
      log("[care] written reply failed the guard; sending the template answer");
    } catch (error) {
      log(`[care] reply writer failed (${error instanceof Error ? error.message : String(error)}); sending the template answer`);
    }
  }
  return templateReply(request);
}

// ---------------------------------------------------------------------------
// Template answers (no LLM)

// Red flags come from her check-in answers, so they're answered with the day, not the record flags.
const RED_FLAGS = /\bred[ -]?flags?\b/i;
const ABOUT_VITALS = /\b(heart|pulse|vital\w*|breath\w*|bpm|rate|camera)\b/i;
const ABOUT_MEDS = /\b(medic\w*|meds|pills?|drugs?|prescri\w*|taking|refill\w*)\b/i;
const ABOUT_FLAGS = /\b(flags?|kidney|egfr|labs?|potassium|tests?|creatinine|results?|bleeding risk|ask (the|her) doctor)\b/i;
const ABOUT_DAY = /\b(how (is|was|did|does)|doing|okay|ok|feel\w*|mood|check(ed)?[ -]?in|answers?|today|morning|update)\b/i;

function vitalsAnswer(f: CareFacts, audience: CareAudience): string {
  if (audience === "family") return familyVitalsAnswer(f);
  const r = f.vitals.readings.at(-1);
  if (!r) return audience === "doctor" ? "No camera vitals were recorded today." : `${f.patient.preferredName} didn't do a camera heart-rate check today.`;
  const tz = f.patient.timezone;
  if (audience === "doctor") {
    const range = f.vitals.usualRange?.heartRate;
    return [
      `Latest camera reading ${localTime(r.takenAt, tz)}: HR ${r.heartRate ?? "n/a"} bpm, RR ${r.breathingRate ?? "n/a"} /min${r.confidence !== null ? `, confidence ${r.confidence}` : ""} (wellness estimate).`,
      range ? `Usual clinic range ${range.low} to ${range.high} bpm (${range.readings} readings).` : "",
      r.inUsualRange === undefined && f.vitals.usualRange?.note ? `Not compared: ${f.vitals.usualRange.note}` : "",
    ]
      .filter(Boolean)
      .join(" ");
  }
  return familyVitalsAnswer(f);
}

function medsAnswer(f: CareFacts, audience: CareAudience): string {
  if (f.medications.length === 0) return "I don't have her medication list right now.";
  if (audience === "doctor")
    return `Active medications on her record (${f.medications.length}): ${f.medications.map((m) => `${m.name}${m.lastFill ? `, last fill ${m.lastFill}` : ""}`).join("; ")}.`;
  if (f.patient.sharing !== "all") return "For questions about her medicines, her doctor is the right person to ask.";
  return `Her record lists ${f.medications.length} medicines. For questions about any of them, her doctor is the right person to ask.`;
}

function flagsAnswer(f: CareFacts, audience: CareAudience, contacts: CareContacts): string {
  if (audience === "doctor") {
    if (f.flags.length === 0) return "No open record flags.";
    const labs = f.recentLabs.slice(0, 4).map((l) => `${l.name} ${l.value} ${l.unit} (${l.date})`);
    return `Open flags: ${f.flags.map((x) => `${x.ruleId} (${x.status})`).join(", ")}. Recent labs: ${labs.join("; ")}.`;
  }
  if (f.patient.sharing !== "all") return `${f.patient.preferredName} keeps the details of her record between her and her doctor. ${contacts.doctor.name} is the right person to ask.`;
  const heard = familyVisible(f).heardFlags.length;
  if (heard === 0) return `There's nothing on ${f.patient.preferredName}'s list to ask the doctor about right now.`;
  return `${f.patient.preferredName} has ${heard} thing${heard === 1 ? "" : "s"} on her list to ask her doctor about. They aren't emergencies. ${contacts.doctor.name} can explain what they mean.`;
}

function dayAnswer(f: CareFacts, audience: CareAudience): string {
  const name = f.patient.preferredName;
  const c = f.checkin;
  const answers = c.answers.map((a) => `${a.question} ${a.answer}`).join(" ");
  if (audience === "doctor") {
    const red = f.redFlags.length > 0 ? ` Red flags: ${f.redFlags.map((r) => `${r.question} "${r.answer}"`).join("; ")}.` : " No red flags.";
    const outcome = { checked_in: "completed", not_today: 'declined ("not today")', missed: "missed", in_progress: "started, not finished", none: "not sent" }[c.outcome];
    return `Check-in ${outcome} on ${f.day}.${answers ? ` Answers: ${answers}` : ""}${red}`;
  }
  const base =
    c.outcome === "checked_in"
      ? `${name} checked in today${c.mood && f.patient.sharing === "all" ? ` and said she's feeling "${c.mood}"` : ""}.`
      : c.outcome === "not_today"
        ? `${name} chose to skip today's check-in.`
        : c.outcome === "missed"
          ? `${name} didn't answer today's check-in, so I don't have an update from her.`
          : `${name} hasn't finished today's check-in yet.`;
  const red = f.redFlags.length > 0 ? ` Something came up today that needs attention, so please call her today.` : "";
  return `${base}${red} Calling her is the best way to hear how she's really doing.`;
}

export function templateReply(request: ReplyRequest): string {
  const { facts: f, contact, contacts, message } = request;
  const audience = contact.audience;
  if (RED_FLAGS.test(message)) return dayAnswer(f, audience);
  if (ABOUT_VITALS.test(message)) return vitalsAnswer(f, audience);
  if (ABOUT_MEDS.test(message)) return medsAnswer(f, audience);
  if (ABOUT_FLAGS.test(message)) return flagsAnswer(f, audience, contacts);
  if (ABOUT_DAY.test(message)) return dayAnswer(f, audience);
  return audience === "doctor"
    ? "I can answer from today's summary: check-in answers, red flags, vitals, record flags, labs and medications. Anything else isn't in the data I have."
    : `I can only share what's in today's check-in. For anything else, ${f.patient.preferredName} or ${contacts.doctor.name} (${displayPhone(contacts.doctor.phone)}) would know best.`;
}
