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

export function redFlagAdvice(name: string): string {
  return `Thank you for telling me, ${name}. Please call your doctor today about this. If it gets worse or feels like an emergency, call 911. I've let your family know so someone can check in with you.`;
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
  status_vitals: "whether you checked in each day, and whether your heart rate readings are in your usual range",
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

/** The family is told it changed, not why. */
export function sharingChangedFamily(name: string, level: SharingLevel): string {
  const sees: Record<SharingLevel, string> = {
    status: `whether ${name} checked in each day`,
    status_vitals: `whether ${name} checked in each day, and whether heart rate readings are in ${name}'s usual range`,
    all: `${name}'s check-ins, heart rate readings, answers, and things to ask the doctor about`,
  };
  return `${name} changed what this group sees. From now on: ${sees[level]}. Urgent alerts still come through as before.`;
}

// Family-facing

export function familyDailyStatus(input: {
  seniorName: string;
  sharing: SharingLevel;
  outcome: DayOutcome;
  answers: AnsweredQuestion[];
  flags: { message: string }[];
  /** Today's camera heart-rate reading, if any. Shown at "status_vitals" and "all" only. */
  vitals?: { heartRate: number; inUsualRange: boolean };
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
    const where = input.vitals.inUsualRange ? `within ${name}'s usual range` : `outside ${name}'s usual range`;
    const reading = input.sharing === "all" ? `${input.vitals.heartRate} beats a minute, ${where}` : where;
    vitals = `Heart rate today: ${reading}. This is a camera estimate, not a medical test.`;
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
  // Wording at "status" is fixed by docs/DESIGN.md "Sharing levels and record consent".
  const base = `${input.seniorName} reported something she should call her doctor about today. Please check in with her.`;
  if (input.sharing !== "all") return base;
  return `${base}\n\nThe question was: ${input.questionText}\n${input.seniorName} answered: "${input.answer}"`;
}

export function familyMissedAlert(seniorName: string, time: string): string {
  return `${seniorName} hasn't answered today's check-in yet (as of ${time}). You may want to give ${seniorName} a call.`;
}
