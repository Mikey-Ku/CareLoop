import { activeMedications, type Condition, type PatientRecord } from "../finchnode/normalize.ts";
import type { Category } from "../finchnode/types.ts";
import { medsInClass, type DrugClass } from "../rules/drug-classes.ts";

// Daily question bank, keyed by condition or drug class (docs/DESIGN.md
// "Daily questions and red flags"). At most 3 a day. Red-flag questions come up
// on a cadence (see QUESTION_CADENCE and pickQuestions); the others rotate.
// "Not today" belongs to the check-in message itself, not to each question.

export type Question = {
  id: string;
  text: string;
  /** Relay allows 1 to 5 buttons, each up to 80 characters. */
  buttons: string[];
  /** Answers a fixed red-flag rule acts on. Empty when the question has none. */
  redFlagAnswers: string[];
};

type BankEntry = Question & {
  appliesTo: { condition: RegExp } | { drugClasses: DrugClass[] } | "everyone";
  needs: Category[];
  /** Answers that need no follow-up. Any other answer (red-flag answers included) is a worrying answer. */
  calmAnswers: string[];
  /**
   * Questions about the same thing. After a worrying answer to any of them, the group's red-flag
   * questions are due every day and its other questions are asked first, for `followUpDays`.
   */
  group: string;
};

export const QUESTION_BANK: BankEntry[] = [
  {
    id: "hf-ankle-swelling",
    text: "Have your ankles or feet been more swollen than usual?",
    buttons: ["No", "A little", "Yes, more than usual"],
    redFlagAnswers: [],
    calmAnswers: ["No"],
    group: "heart_failure",
    appliesTo: { condition: /heart failure/i },
    needs: ["conditions"],
  },
  {
    id: "hf-breathing-lying-flat",
    text: "Did you have trouble breathing when lying flat last night?",
    buttons: ["No", "Yes"],
    redFlagAnswers: ["Yes"],
    calmAnswers: ["No"],
    group: "heart_failure",
    appliesTo: { condition: /heart failure/i },
    needs: ["conditions"],
  },
  {
    id: "anticoagulant-bleeding",
    text: "Have you had any unusual bruising or bleeding?",
    buttons: ["No", "Yes"],
    redFlagAnswers: ["Yes"],
    calmAnswers: ["No"],
    group: "bleeding",
    appliesTo: { drugClasses: ["anticoagulant"] },
    needs: ["medications"],
  },
  {
    id: "dizzy-on-standing",
    text: "Have you felt dizzy when standing up?",
    buttons: ["No", "Sometimes", "Yes, often"],
    redFlagAnswers: [],
    calmAnswers: ["No"],
    group: "dizzy-on-standing",
    appliesTo: { drugClasses: ["betaBlocker", "loopDiuretic"] },
    needs: ["medications"],
  },
  {
    id: "morning-medicines",
    text: "Did you take your morning medicines?",
    buttons: ["Yes", "Not yet", "Some of them"],
    redFlagAnswers: [],
    calmAnswers: ["Yes"],
    group: "morning-medicines",
    appliesTo: { drugClasses: [] },
    needs: ["medications"],
  },
  {
    id: "mood",
    text: "How are you feeling today?",
    buttons: ["Good", "Okay", "Not great"],
    redFlagAnswers: [],
    calmAnswers: ["Good", "Okay"],
    group: "mood",
    appliesTo: "everyone",
    needs: [],
  },
];

export const MAX_QUESTIONS_PER_DAY = 3;

/**
 * How often red-flag questions come up. These are product cadence values the team can
 * change (FEEDBACK.md), not clinical thresholds.
 */
export type QuestionCadence = {
  /** A red-flag question is due again this many days after she last answered it (2: every other day). */
  redFlagEveryDays: number;
  /** After a worrying answer, the group's red-flag questions are due every day for this many days. */
  followUpDays: number;
  /** At most this many red-flag questions a day, so the other questions keep a slot. */
  maxRedFlagQuestions: number;
};

export const QUESTION_CADENCE: Readonly<QuestionCadence> = {
  redFlagEveryDays: 2,
  followUpDays: 3,
  maxRedFlagQuestions: 2,
};

/** One answer she gave on an earlier check-in date (YYYY-MM-DD). See src/db/answer-history.ts. */
export type AnswerHistoryEntry = { day: string; questionId: string; answer: string };

export type PickOptions = {
  /** Her answers on check-in dates before this one. Only answered questions count as asked. */
  history?: readonly AnswerHistoryEntry[];
  /** Defaults to MAX_QUESTIONS_PER_DAY. */
  max?: number;
  /** Defaults to QUESTION_CADENCE. */
  cadence?: Partial<QuestionCadence>;
};

const INACTIVE_CONDITION_STATUSES = new Set(["inactive", "resolved", "remission", "entered-in-error"]);

/** A condition counts unless the record says it ended. A missing status counts as active. */
export function isActiveCondition(c: Condition): boolean {
  return !INACTIVE_CONDITION_STATUSES.has((c.status ?? "").toLowerCase());
}

function applies(entry: BankEntry, record: PatientRecord): boolean {
  if (!entry.needs.every((c) => record.sharedCategories.includes(c))) return false;
  if (entry.appliesTo === "everyone") return true;
  if ("condition" in entry.appliesTo) {
    const pattern = entry.appliesTo.condition;
    return record.conditions.some((c) => isActiveCondition(c) && pattern.test(c.name));
  }
  const meds = activeMedications(record);
  if (entry.appliesTo.drugClasses.length === 0) return meds.length > 0;
  return entry.appliesTo.drugClasses.some((dc) => medsInClass(meds, dc).length > 0);
}

const toQuestion = ({ id, text, buttons, redFlagAnswers }: BankEntry): Question => ({ id, text, buttons, redFlagAnswers });

export function eligibleQuestions(record: PatientRecord): Question[] {
  return QUESTION_BANK.filter((e) => applies(e, record)).map(toQuestion);
}

const BANK_BY_ID = new Map(QUESTION_BANK.map((e) => [e.id, e]));
const norm = (s: string) => s.trim().toLowerCase();
const isRedFlagQuestion = (e: BankEntry) => e.redFlagAnswers.length > 0;

/** Days since 1970-01-01 for a YYYY-MM-DD date, or NaN. */
function dayNumber(day: string): number {
  return Math.floor(Date.parse(day) / 86_400_000);
}

/** A worrying answer: anything but one of the question's calm answers. */
export function isWorryingAnswer(questionId: string, answer: string): boolean {
  const entry = BANK_BY_ID.get(questionId);
  return entry !== undefined && !entry.calmAnswers.some((a) => norm(a) === norm(answer));
}

/**
 * Today's questions, at most `max` (3), asked in bank order. Same inputs, same questions.
 *
 * Red-flag questions (breathing lying flat, bleeding) are picked first, at most
 * `maxRedFlagQuestions` (2), and only when due: never answered in `history`, last answered
 * `redFlagEveryDays` or more days ago, or any question in its group got a worrying answer
 * in the last `followUpDays` days (then it is due every day). When more are due than fit,
 * the one answered longest ago (or never) wins. A "not today" or missed day leaves no
 * answers, so it doesn't count as asked.
 *
 * The other slots go to the remaining eligible questions: those in a group with a recent
 * worrying answer first (ankle swelling after "A little"), then the one answered longest
 * ago, with a rotation by date breaking ties. With no history that is a plain day rotation.
 */
export function pickQuestions(record: PatientRecord, checkinDate: string, options: PickOptions = {}): Question[] {
  const max = options.max ?? MAX_QUESTIONS_PER_DAY;
  const cadence: QuestionCadence = { ...QUESTION_CADENCE, ...options.cadence };
  const today = dayNumber(checkinDate);
  if (Number.isNaN(today)) throw new Error(`pickQuestions: checkinDate must be YYYY-MM-DD, got "${checkinDate}"`);

  // Days since she last answered each question, and the groups with a recent worrying answer.
  const daysSince = new Map<string, number>();
  const worriedGroups = new Set<string>();
  for (const h of options.history ?? []) {
    const ago = today - dayNumber(h.day);
    if (!(ago > 0)) continue; // only days strictly before the check-in date (NaN fails too)
    daysSince.set(h.questionId, Math.min(daysSince.get(h.questionId) ?? Infinity, ago));
    const entry = BANK_BY_ID.get(h.questionId);
    if (entry && ago <= cadence.followUpDays && isWorryingAnswer(h.questionId, h.answer)) worriedGroups.add(entry.group);
  }
  const ago = (e: BankEntry) => daysSince.get(e.id) ?? Number.MAX_SAFE_INTEGER; // never answered: longest ago
  const followUp = (e: BankEntry) => worriedGroups.has(e.group);

  const eligible = QUESTION_BANK.filter((e) => applies(e, record));
  const redFlag = eligible
    .filter((e) => isRedFlagQuestion(e) && (ago(e) >= cadence.redFlagEveryDays || followUp(e)))
    .sort((a, b) => ago(b) - ago(a)) // stable: ties keep bank order
    .slice(0, Math.max(0, Math.min(cadence.maxRedFlagQuestions, max)));

  const others = eligible.filter((e) => !isRedFlagQuestion(e));
  const slots = Math.max(0, max - redFlag.length);
  const start = others.length > 0 ? (((today * Math.max(slots, 1)) % others.length) + others.length) % others.length : 0;
  const rotated = others.map((_, i) => others[(start + i) % others.length]!);
  const rest = rotated.sort((a, b) => Number(followUp(b)) - Number(followUp(a)) || ago(b) - ago(a)).slice(0, slots);

  const picked = new Set([...redFlag, ...rest]);
  return eligible.filter((e) => picked.has(e)).map(toQuestion);
}
