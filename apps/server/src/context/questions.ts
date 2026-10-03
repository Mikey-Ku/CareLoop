import { activeMedications, type Condition, type PatientRecord } from "../finchnode/normalize.ts";
import type { Category } from "../finchnode/types.ts";
import { medsInClass, type DrugClass } from "../rules/drug-classes.ts";

// Daily question bank, keyed by condition or drug class (docs/DESIGN.md
// "Daily questions and red flags"). At most 3 a day, rotating across days.
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
};

export const QUESTION_BANK: BankEntry[] = [
  {
    id: "hf-ankle-swelling",
    text: "Have your ankles or feet been more swollen than usual?",
    buttons: ["No", "A little", "Yes, more than usual"],
    redFlagAnswers: [],
    appliesTo: { condition: /heart failure/i },
    needs: ["conditions"],
  },
  {
    id: "hf-breathing-lying-flat",
    text: "Did you have trouble breathing when lying flat last night?",
    buttons: ["No", "Yes"],
    redFlagAnswers: ["Yes"],
    appliesTo: { condition: /heart failure/i },
    needs: ["conditions"],
  },
  {
    id: "anticoagulant-bleeding",
    text: "Have you had any unusual bruising or bleeding?",
    buttons: ["No", "Yes"],
    redFlagAnswers: ["Yes"],
    appliesTo: { drugClasses: ["anticoagulant"] },
    needs: ["medications"],
  },
  {
    id: "dizzy-on-standing",
    text: "Have you felt dizzy when standing up?",
    buttons: ["No", "Sometimes", "Yes, often"],
    redFlagAnswers: [],
    appliesTo: { drugClasses: ["betaBlocker", "loopDiuretic"] },
    needs: ["medications"],
  },
  {
    id: "morning-medicines",
    text: "Did you take your morning medicines?",
    buttons: ["Yes", "Not yet", "Some of them"],
    redFlagAnswers: [],
    appliesTo: { drugClasses: [] },
    needs: ["medications"],
  },
  {
    id: "mood",
    text: "How are you feeling today?",
    buttons: ["Good", "Okay", "Not great"],
    redFlagAnswers: [],
    appliesTo: "everyone",
    needs: [],
  },
];

export const MAX_QUESTIONS_PER_DAY = 3;

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

export function eligibleQuestions(record: PatientRecord): Question[] {
  return QUESTION_BANK.filter((e) => applies(e, record)).map(({ id, text, buttons, redFlagAnswers }) => ({
    id,
    text,
    buttons,
    redFlagAnswers,
  }));
}

/** Rotates through eligible questions by day, so each comes up in turn. Same date, same questions. */
export function pickQuestions(record: PatientRecord, checkinDate: string, max = MAX_QUESTIONS_PER_DAY): Question[] {
  const eligible = eligibleQuestions(record);
  if (eligible.length <= max) return eligible;
  const parsed = Date.parse(checkinDate);
  if (Number.isNaN(parsed)) throw new Error(`pickQuestions: checkinDate must be YYYY-MM-DD, got "${checkinDate}"`);
  const dayNumber = Math.floor(parsed / 86_400_000);
  const start = (((dayNumber * max) % eligible.length) + eligible.length) % eligible.length;
  return Array.from({ length: max }, (_, i) => eligible[(start + i) % eligible.length]!);
}
