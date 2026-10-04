import { activeMedications, type Condition, type PatientRecord } from "../finchnode/normalize.ts";
import type { Category } from "../finchnode/types.ts";
import { medsInClass, type DrugClass } from "../rules/drug-classes.ts";
import { dayNumber } from "../days.ts";

// Daily question bank, keyed by condition or drug class (docs/DESIGN.md
// "Daily questions and red flags"). At most 3 a day. Red-flag questions come up
// on a cadence (see QUESTION_CADENCE and pickQuestions); the others rotate.
// "Not today" belongs to the check-in message itself, not to each question.
//
// Symptom questions have graded answers (docs/DESIGN.md "Severity ladder"): each
// button's level is in src/checkin/severity.ts BUTTON_LEVELS, and only the level-3
// answers ("Yes, it was hard", "Yes, bleeding") are red-flag answers. At most
// MAX_QUESTION_BUTTONS buttons each, leaving room for one more: symptom questions
// (ankles, breathing, bleeding, dizziness) also offer "Let me explain" (LET_ME_EXPLAIN), added
// when the question is sent (promptButtons). `buttons` stays the answers only, which
// is what the LLM maps her words onto and what the severity table levels.

export type Question = {
  id: string;
  text: string;
  /** Relay allows 1 to 5 buttons, each up to 80 characters; the bank keeps to MAX_QUESTION_BUTTONS. */
  buttons: string[];
  /** Level-3 answers (her doctor today, family alert). Empty when the question has none. */
  redFlagAnswers: string[];
};

type BankEntry = Question & {
  /** A symptom question: its message also offers "Let me explain". */
  symptom: boolean;
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
    symptom: true,
    text: "Have your ankles or feet been more swollen than usual?",
    buttons: ["No", "A little", "More than usual"],
    redFlagAnswers: [],
    calmAnswers: ["No"],
    group: "heart_failure",
    appliesTo: { condition: /heart failure/i },
    needs: ["conditions"],
  },
  {
    id: "hf-breathing-lying-flat",
    symptom: true,
    text: "How was your breathing last night when you lay down?",
    buttons: ["Fine", "A little hard", "Yes, it was hard"],
    redFlagAnswers: ["Yes, it was hard"],
    calmAnswers: ["Fine"],
    group: "heart_failure",
    appliesTo: { condition: /heart failure/i },
    needs: ["conditions"],
  },
  {
    id: "anticoagulant-bleeding",
    symptom: true,
    text: "Any unusual bruising or bleeding?",
    buttons: ["No", "A little bruising", "Yes, bleeding"],
    redFlagAnswers: ["Yes, bleeding"],
    calmAnswers: ["No"],
    group: "bleeding",
    appliesTo: { drugClasses: ["anticoagulant"] },
    needs: ["medications"],
  },
  {
    id: "dizzy-on-standing",
    symptom: true,
    text: "Have you felt dizzy when standing up?",
    buttons: ["No", "Sometimes", "Often"],
    redFlagAnswers: [],
    calmAnswers: ["No"],
    group: "dizzy-on-standing",
    appliesTo: { drugClasses: ["betaBlocker", "loopDiuretic"] },
    needs: ["medications"],
  },
  {
    id: "morning-medicines",
    symptom: false,
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
    symptom: false,
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

/** Buttons per bank question at most, so one more can be added to any of them within Relay's 5. */
export const MAX_QUESTION_BUTTONS = 4;

/**
 * The extra button on every symptom question. Tapping it, she is invited to say it in her own
 * words; it is never an answer (src/checkin/engine.ts "Let me explain").
 */
export const LET_ME_EXPLAIN = "Let me explain";

/** Whether this question's message offers "Let me explain" (the symptom questions). */
export function offersExplain(questionId: string): boolean {
  return QUESTION_BANK.some((e) => e.id === questionId && e.symptom);
}

/** The buttons a question's message carries: its answers, then "Let me explain" on a symptom question. */
export function promptButtons(q: Pick<Question, "id" | "buttons">): string[] {
  return offersExplain(q.id) ? [...q.buttons, LET_ME_EXPLAIN] : [...q.buttons];
}

/**
 * The first button of a suggested confirm on a red-flag question ("It sounds like ... Is that right?"):
 * her tap records the suggested answer (src/checkin/engine.ts).
 */
export const SUGGESTION_YES = "Yes, that's right";

/** Buttons on a suggested confirm, at most this many. */
export const MAX_SUGGESTION_BUTTONS = 4;

/**
 * The buttons of a suggested confirm: "Yes, that's right", the question's other answers, then "Let me
 * explain" when it offers it and there is room (at most MAX_SUGGESTION_BUTTONS).
 */
export function suggestionButtons(q: Pick<Question, "id" | "buttons">, suggested: string): string[] {
  const others = q.buttons.filter((b) => b.trim().toLowerCase() !== suggested.trim().toLowerCase());
  const buttons = [SUGGESTION_YES, ...others];
  if (offersExplain(q.id) && buttons.length < MAX_SUGGESTION_BUTTONS) buttons.push(LET_ME_EXPLAIN);
  return buttons.slice(0, MAX_SUGGESTION_BUTTONS);
}

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
