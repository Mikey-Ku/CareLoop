import type { SharingLevel } from "../db/index.ts";

// Every word the senior and her family read, as fixed templates. No LLM here:
// run 4 may reword through Claude, but these are the safe defaults and the
// fallback. Rules from docs/BRIEF.md: "Not today" never gets a guilt message;
// red flags reach the family at every sharing level, with detail only at "all".
//
// Style for everything here: short sentences, plain words, no exclamation marks,
// no em dashes. The assistant says what it is and never acts like a friend or a
// clinician. Flags are always "something to ask your doctor", never advice to
// start, stop or change a medicine.
//
// CONTRACT: the signatures below are what the engine calls. The copy agent owns
// the wording and may add functions, but must not change these signatures.

export const BUTTON = {
  start: "Let's start",
  notToday: "Not today",
  tellMeMore: "Tell me more",
  later: "Later",
  willAskDoctor: "I'll ask my doctor",
} as const;

export type DayOutcome = "checked_in" | "not_today" | "missed";

export type AnsweredQuestion = { questionId: string; questionText: string; answer: string };

/** "a", "a and b", "a, b and c". */
function listJoin(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

// Senior-facing

export function checkinGreeting(name: string, questionCount: number): string {
  if (questionCount <= 0) return `Good morning, ${name}. This is your check-in assistant. There are no questions today. I just wanted to say hello.`;
  const questions = questionCount === 1 ? "1 short question" : `${questionCount} short questions`;
  return `Good morning, ${name}. This is your check-in assistant. I have ${questions} for you today. If today isn't a good day, just tap "${BUTTON.notToday}".`;
}

/** Reply to "Not today". Never implies she should have answered. */
export function notTodayReply(name: string): string {
  return `That's fine, ${name}. I'll check in again tomorrow. Have a good day.`;
}

/**
 * After a red-flag answer. Leads with who was told, then her doctor, then 911.
 * `familyNames` are the family members whose chats got the alert: left out, it says
 * "your family"; an empty list (nobody linked) says nothing about family, so she is
 * never told someone was alerted when no one was. No pronouns for family members:
 * the app doesn't know them.
 */
export function redFlagAdvice(name: string, familyNames?: string[]): string {
  const names = familyNames?.map((n) => n.trim()).filter((n) => n.length > 0);
  const who = names === undefined ? "your family" : names.length > 0 ? listJoin(names) : undefined;
  const doctor = "call your doctor today about this.";
  const first = who ? [`${name}, I've asked ${who} to check on you.`, `Please ${doctor}`] : [`${name}, please ${doctor}`];
  return [...first, "If it gets worse or feels like an emergency, call 911."].join(" ");
}

export function flagOffer(): string {
  return "There's one thing in your health record that may be worth asking your doctor about. Would you like to hear it?";
}

/** `message` is the rule result's plain message. */
export function flagDetail(message: string): string {
  return `${message}\n\nThis isn't an emergency. It's something to ask your doctor about at your next visit. Please don't change how you take any medicine before talking with your doctor.`;
}

export function flagNotedReply(): string {
  return "Good. I've added it to your list of things to ask your doctor at your next visit.";
}

export function checkinDone(name: string): string {
  return `That's everything for today, ${name}. Thank you. I'll check in again tomorrow.`;
}

export function didntUnderstand(buttons: string[]): string {
  const quoted = buttons.map((b) => `"${b}"`);
  return `Sorry, I didn't understand that. You can tap one of these: ${listJoin(quoted)}.`;
}

// Free text (src/checkin/engine.ts): what she types instead of tapping a button.

/** The activity label her chat shows while the assistant reads what she typed (Relay: 1 to 21 characters). */
export const READING_ACTIVITY = "Reading your message";

/** How much of her own words a confirm quotes back. */
export const QUOTE_MAX_CHARS = 120;

/** Her words on one line, cut at a word near QUOTE_MAX_CHARS. Double quotes and long dashes are softened. */
function quoteHerWords(reply: string): string {
  const one = reply.replace(/\s+/g, " ").replace(/"/g, "'").replace(/\s*[\u2013\u2014]\s*/g, " - ").trim();
  if (one.length <= QUOTE_MAX_CHARS) return one;
  const cut = one.slice(0, QUOTE_MAX_CHARS);
  const space = cut.lastIndexOf(" ");
  return `${(space > QUOTE_MAX_CHARS / 2 ? cut.slice(0, space) : cut).replace(/[\s.,;:]+$/, "")}...`;
}

/**
 * She typed an answer to a red-flag question. The app never records that answer from what an
 * AI made of her words: it quotes them back and asks the question again with its own buttons,
 * so the red-flag rule only ever acts on a tap.
 */
export function freeTextConfirm(reply: string, questionText: string): string {
  return `You wrote: "${quoteHerWords(reply)}"\nJust to check: ${questionText}`;
}

/**
 * She mentioned a health complaint outside a check-in. A fixed reply, not the model's words, and
 * no family alert: under the rules this isn't a red flag, so she is pointed to her doctor and 911.
 */
export function complaintReply(name: string): string {
  return `Thank you for telling me, ${name}. If this is worrying you, please call your doctor. If it feels like an emergency, call 911.`;
}

/**
 * The reply to a message outside a check-in when the assistant can't read it (no LLM, or it is down).
 * It can't tell what she wrote, so it points to her doctor and 911 in case it was something worrying.
 */
export function smallTalkFallback(name: string): string {
  return `Thanks for your message, ${name}. I'll be back with your next check-in. If something is worrying you, please call your doctor. If it feels like an emergency, call 911.`;
}

// Hospital paper check (after the read-back)

/** After "No, something's off". */
export const PAPER_REJECTED_REPLY =
  "Thank you for checking. I won't use what I read. Please bring the papers to your doctor or pharmacist so they can go over them with you.";
/**
 * After "Later" on the paper result. She has heard it, so the flag is told and is not
 * offered again on its own (the same as "Later" after a check-in flag's detail).
 */
export const PAPER_LATER_REPLY =
  "That's fine. When you can, please bring the papers to your doctor or pharmacist and ask about this.";
/** No medicines were read off the papers. */
export const PAPER_NOTHING_TO_COMPARE =
  "There were no medicines on the papers to compare with your medication list, so there's nothing to check.";
/** Record consent ended between the read-back and her "Yes". */
export const PAPER_NO_RECORD_REPLY =
  "I can't compare the papers with your medication list, because the link to your health record has ended. Please bring the papers to your doctor or pharmacist.";

// Record consent (docs/DESIGN.md "Sharing levels and record consent")

/** Record consent ended (FinchNode 410). Plain words, no cause, no blame. */
export function recordLinkEndedSenior(name: string): string {
  return `${name}, the link to your health record has ended. I've stopped reading it and deleted my copy. Our chats are still here. You can ask to have them deleted too.`;
}

export function recordLinkEndedFamily(name: string): string {
  return `The link to ${name}'s health record has ended. The app has stopped reading it and deleted its copy.`;
}

// Sharing level (only the senior changes it)

/** Label of the button in the senior's chat that opens the sharing menu. */
export const SHARING_MENU_BUTTON = "Sharing";

/** One button per sharing level. Each is at most 80 characters (Relay limit). */
export const SHARING_BUTTONS: Record<SharingLevel, string> = {
  status: "Just check-ins",
  status_vitals: "Check-ins and heart rate",
  all: "Everything",
};

/** Maps a tapped sharing button back to its level. */
export function sharingLevelFromButton(label: string): SharingLevel | undefined {
  const match = (Object.keys(SHARING_BUTTONS) as SharingLevel[]).find((level) => SHARING_BUTTONS[level] === label.trim());
  return match;
}

/** What the family sees at each level, finishing the sentence "Your family sees ...". */
const SEES: Record<SharingLevel, string> = {
  status: "whether you checked in each day",
  status_vitals: "whether you checked in each day, and how your heart rate checks went",
  all: "whether you checked in, your heart rate readings, your answers, and the things to ask your doctor about",
};

export function sharingMenu(current?: SharingLevel): string {
  const lines = [
    "You decide how much your family sees. You can change this any time.",
    "",
    `"${SHARING_BUTTONS.status}": ${SEES.status}.`,
    `"${SHARING_BUTTONS.status_vitals}": ${SEES.status_vitals}.`,
    `"${SHARING_BUTTONS.all}": ${SEES.all}.`,
    "",
    "If you ever tell me something urgent, your family always hears about it, so someone can check on you.",
  ];
  if (current) lines.push(`Right now it's set to "${SHARING_BUTTONS[current]}".`);
  return lines.join("\n");
}

export function sharingChangedSenior(level: SharingLevel): string {
  return `Done. Your family now sees ${SEES[level]}. You can change this any time with the "${SHARING_MENU_BUTTON}" button.`;
}

/** The family is told it changed, not why. Sent to each family member in their own chat with the agent. */
export function sharingChangedFamily(name: string, level: SharingLevel): string {
  const sees: Record<SharingLevel, string> = {
    status: `whether ${name} checked in each day`,
    status_vitals: `whether ${name} checked in each day, and how ${name}'s heart rate checks went`,
    all: `${name}'s check-ins, heart rate readings, answers, and things to ask the doctor about`,
  };
  return `${name} changed what you see here. From now on: ${sees[level]}. Urgent alerts still come through as before.`;
}

// Family-facing. Each family member reads these in their own chat with the agent
// (a family chat), so they speak to one person, never to "the group".

export function familyDailyStatus(input: {
  seniorName: string;
  sharing: SharingLevel;
  outcome: DayOutcome;
  answers: AnsweredQuestion[];
  flags: { message: string }[];
  /**
   * Today's camera heart-rate reading, if any. Shown at "status_vitals" and "all" only.
   * `inUsualRange` is left out when the reading isn't compared with her usual range
   * (no usual range, or atrial fibrillation; see the packet's `usualRange.compareHeartRate`):
   * then it is shown as an estimate only, with the number at "all" and without it at
   * "status_vitals", which shows no numbers.
   */
  vitals?: { heartRate: number; inUsualRange?: boolean };
}): string {
  const name = input.seniorName;
  const base =
    input.outcome === "checked_in"
      ? `${name} checked in today.`
      : input.outcome === "not_today"
        ? `${name} said "not today" to today's check-in.`
        : `${name} didn't answer today's check-in.`;

  let vitals = "";
  if (input.vitals && input.sharing !== "status") {
    const { heartRate, inUsualRange } = input.vitals;
    const estimate = "This is a camera estimate, not a medical test.";
    if (inUsualRange === undefined) {
      vitals = input.sharing === "all" ? `Heart rate today: about ${heartRate} beats a minute. ${estimate}` : `Heart rate checked today. ${estimate}`;
    } else {
      const where = inUsualRange ? `within ${name}'s usual range` : `outside ${name}'s usual range`;
      const reading = input.sharing === "all" ? `${heartRate} beats a minute, ${where}` : where;
      vitals = `Heart rate today: ${reading}. ${estimate}`;
    }
  }
  if (input.sharing !== "all") return [base, vitals].filter(Boolean).join("\n\n");

  const answers = input.answers.map((a) => `- ${a.questionText} ${a.answer}`).join("\n");
  const flags = input.flags.map((f) => `- ${f.message}`).join("\n");
  return [
    base,
    vitals,
    answers && `${name}'s answers:\n${answers}`,
    flags && `Things for ${name} to ask the doctor about:\n${flags}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function familyRedFlagAlert(input: {
  seniorName: string;
  sharing: SharingLevel;
  questionText: string;
  answer: string;
}): string {
  // No medical detail below "all" (docs/DESIGN.md "Sharing levels and record consent").
  // It asks for a call today, matching what the senior hears (redFlagAdvice).
  const base = `${input.seniorName} reported something she should call her doctor about. Please call ${input.seniorName} today to check on her.`;
  if (input.sharing !== "all") return base;
  return `${base}\n\nThe question was: ${input.questionText}\n${input.seniorName} answered: "${input.answer}"`;
}

/**
 * The reply a family member gets the first time they message the agent (or add it),
 * sent once when their family chat is linked.
 */
export function familyWelcome(seniorName: string): string {
  return [
    `Hello. I'm ${seniorName}'s check-in assistant. I'm an AI, not a person.`,
    `Each day I'll send you an update on ${seniorName}'s check-in here.`,
    `${seniorName} decides how much you see and can change it any time.`,
    `If ${seniorName} tells me something urgent, you'll always hear about it here.`,
  ].join(" ");
}

export function familyMissedAlert(seniorName: string, time: string): string {
  return `${seniorName} hasn't answered today's check-in yet (as of ${time}). You may want to give ${seniorName} a call.`;
}
