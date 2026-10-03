import type { Amount, Change, SymptomMention } from "../llm/types.ts";

// The severity ladder (docs/DESIGN.md "Severity ladder"): every reaction to what she tells us
// comes from one level, 0 to 5, set here by fixed tables. The LLM only extracts what she said
// (which symptom, how much, new or worse than usual); it never sets a level. The safety screen
// (4 and 5) runs before any of this and wins. Pure functions, no I/O: the engine passes in her
// recent observations for the repetition rule.
//
//   0 Fine             no extra message
//   1 Small, everyday  "I've made a note for your doctor", no advice, no 911
//   2 Worth watching   "Let's keep an eye on that", a same-day follow-up, no alert
//   3 Doctor today     doctor today, "if it gets much worse, call 911", family alert
//   4 Emergency now    911 now (safety screen or model)
//   5 Crisis           988 (safety screen or model)

export type Level = 0 | 1 | 2 | 3 | 4 | 5;

export const LEVEL_NAMES: Readonly<Record<Level, string>> = {
  0: "fine",
  1: "small, everyday",
  2: "worth watching",
  3: "call your doctor today",
  4: "emergency now",
  5: "crisis",
};

/** Button answers: the level each label of each question means. Every bank button is here (test/severity.test.ts). */
export const BUTTON_LEVELS: Readonly<Record<string, Readonly<Record<string, Level>>>> = {
  "hf-ankle-swelling": { No: 0, "A little": 1, "More than usual": 2 },
  "hf-breathing-lying-flat": { Fine: 0, "A little hard": 2, "Yes, it was hard": 3 },
  "anticoagulant-bleeding": { No: 0, "A little bruising": 2, "Yes, bleeding": 3 },
  "dizzy-on-standing": { No: 0, Sometimes: 1, Often: 2 },
  "morning-medicines": { Yes: 0, "Not yet": 0, "Some of them": 1 },
  mood: { Good: 0, Okay: 0, "Not great": 1 },
};

/** Red-flag topics (breathing, bleeding): "a little" there is already worth watching, "a lot" means her doctor today. */
export const RED_FLAG_TOPICS: readonly string[] = ["hf-breathing-lying-flat", "anticoagulant-bleeding"];

/** A typed symptom: how much she describes, on an ordinary topic and on a red-flag topic. */
export const TYPED_LEVELS: Readonly<Record<Amount, { ordinary: Level; redFlag: Level }>> = {
  none: { ordinary: 0, redFlag: 0 },
  a_little: { ordinary: 1, redFlag: 2 },
  unknown: { ordinary: 1, redFlag: 2 },
  a_lot: { ordinary: 2, redFlag: 3 },
};

/** A symptom she calls new or worse than usual is at least this level (unless she has none of it). */
export const NEW_OR_WORSE_AT_LEAST: Level = 2;

/** The safety screen or the model: an urgent symptom and a crisis. */
export const SAFETY_LEVELS: Readonly<Record<"urgent_symptom" | "crisis", Level>> = { urgent_symptom: 4, crisis: 5 };

/** Her answer to a follow-up: Better, About the same (keeps the earlier level, at most 2), Worse (at least 3). */
export const FOLLOW_UP_LEVELS = { better: 0, sameAtMost: 2, worseAtLeast: 3 } as const;

/** A level-1 topic seen on `timesSeen` of her last `days` days (today included) is worth watching. */
export const REPETITION = { days: 5, timesSeen: 3, from: 1, to: 2 } as const;

/**
 * Bank topics recognised in her own topic words, so "short of breath" said in passing gets the red-flag
 * table like the breathing question does, and the repetition rule sees "puffy ankles" as the ankle topic.
 */
export const TOPIC_WORDS: readonly { topic: string; pattern: RegExp }[] = [
  { topic: "hf-breathing-lying-flat", pattern: /breath|winded|wheez/i },
  { topic: "anticoagulant-bleeding", pattern: /bleed|bruis|\bblood\b(?!\s*(?:pressure|sugar|test|work|draw))/i },
  { topic: "hf-ankle-swelling", pattern: /ankle|\bfeet\b|\bfoot\b/i },
  { topic: "dizzy-on-standing", pattern: /dizz|light-?headed|woozy/i },
];

/** One thing she told us, in a form the ladder can level. */
export type Observation =
  | { source: "button"; questionId: string; label: string }
  | { source: "typed"; mention: Pick<SymptomMention, "topic" | "questionId" | "amount" | "change"> }
  | { source: "safety"; kind: keyof typeof SAFETY_LEVELS }
  | { source: "follow_up"; answer: "better" | "same" | "worse"; priorLevel: Level };

/** An earlier observation, as the repetition rule needs it. `day` is YYYY-MM-DD. */
export type PastObservation = { day: string; topic: string; level: number };

/** The check-in date this observation belongs to, and what she told us on the days before (and earlier today). */
export type SeverityHistory = { today: string; observations: readonly PastObservation[] };

export type Severity = {
  level: Level;
  /** Why, in a few words, for logs and tests (never her words). */
  reason: string;
  /** What it is about: a bank question id, her own short topic words, or a safety kind. */
  topic: string;
};

const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
const KNOWN_TOPICS = new Set(Object.keys(BUTTON_LEVELS));

/** Longest topic kept from her words. */
export const MAX_TOPIC_LENGTH = 60;

/**
 * The topic of a typed symptom: its question id when the model matched one, a bank topic her words
 * name ("short of breath"), else her own topic words, tidied ("knee pain").
 */
export function topicOf(mention: Pick<SymptomMention, "topic" | "questionId">): string {
  if (mention.questionId && KNOWN_TOPICS.has(mention.questionId)) return mention.questionId;
  const words = norm(String(mention.topic ?? ""));
  if (KNOWN_TOPICS.has(words)) return words;
  const bank = TOPIC_WORDS.find((t) => t.pattern.test(words));
  if (bank) return bank.topic;
  return words.slice(0, MAX_TOPIC_LENGTH).trim() || "other";
}

export function isRedFlagTopic(topic: string): boolean {
  return RED_FLAG_TOPICS.includes(topic);
}

const DAY_MS = 86_400_000;
const dayNumber = (day: string) => Math.floor(Date.parse(day) / DAY_MS);

/** Distinct days, among her last REPETITION.days (today included), on which `topic` came up at level 1 or more. */
export function daysSeen(topic: string, history: SeverityHistory): number {
  const today = dayNumber(history.today);
  const days = new Set<number>([today]);
  for (const o of history.observations) {
    const d = dayNumber(o.day);
    if (o.topic === topic && o.level >= REPETITION.from && today - d >= 0 && today - d < REPETITION.days) days.add(d);
  }
  return days.size;
}

/** Level 1 seen often enough becomes 2. Anything else is left as it is. */
function withRepetition(s: Severity, history: SeverityHistory | undefined): Severity {
  if (!history || s.level !== REPETITION.from || s.topic === "other") return s;
  const seen = daysSeen(s.topic, history);
  if (seen < REPETITION.timesSeen) return s;
  return { ...s, level: REPETITION.to, reason: `${s.reason}; seen on ${seen} of her last ${REPETITION.days} days` };
}

/** The level of a typed symptom from the fixed table: how much, new or worse, and whether it is a red-flag topic. */
function typedLevel(mention: Pick<SymptomMention, "topic" | "questionId" | "amount" | "change">): Severity {
  const topic = topicOf(mention);
  const amount: Amount = mention.amount in TYPED_LEVELS ? mention.amount : "unknown";
  const red = isRedFlagTopic(topic);
  let level = red ? TYPED_LEVELS[amount].redFlag : TYPED_LEVELS[amount].ordinary;
  let reason = `typed ${amount.replace("_", " ")}${red ? " on a red-flag topic" : ""}`;
  if (amount !== "none" && (mention.change === "new" || mention.change === "worse") && level < NEW_OR_WORSE_AT_LEAST) {
    level = NEW_OR_WORSE_AT_LEAST;
    reason = `${reason}, ${mention.change}`;
  }
  return { level, reason, topic };
}

/**
 * The level of one observation. Button answers come from BUTTON_LEVELS, typed symptoms from
 * TYPED_LEVELS (new or worse: at least 2), the safety screen from SAFETY_LEVELS, follow-up answers
 * from FOLLOW_UP_LEVELS. Then the repetition rule: a level-1 topic seen on 3 of her last 5 days is 2.
 * An answer the table doesn't know is 0, with a reason that says so.
 */
export function levelFor(observation: Observation, history?: SeverityHistory): Severity {
  switch (observation.source) {
    case "button": {
      const { questionId, label } = observation;
      const table = BUTTON_LEVELS[questionId] ?? {};
      const key = Object.keys(table).find((k) => norm(k) === norm(label));
      const level = key === undefined ? 0 : (table[key] ?? 0);
      const reason = key === undefined ? `"${label}" is not in the ${questionId} table` : `button "${key}"`;
      return withRepetition({ level, reason, topic: questionId }, history);
    }
    case "typed":
      return withRepetition(typedLevel(observation.mention), history);
    case "safety":
      return { level: SAFETY_LEVELS[observation.kind], reason: `safety: ${observation.kind}`, topic: observation.kind };
    case "follow_up": {
      const { answer, priorLevel } = observation;
      const topic = "follow_up";
      if (answer === "better") return { level: FOLLOW_UP_LEVELS.better, reason: "follow-up: better", topic };
      if (answer === "same")
        return { level: Math.min(priorLevel, FOLLOW_UP_LEVELS.sameAtMost) as Level, reason: "follow-up: about the same", topic };
      // Worse after an emergency or a crisis stays there; otherwise it is her doctor today.
      return { level: Math.max(priorLevel, FOLLOW_UP_LEVELS.worseAtLeast) as Level, reason: "follow-up: worse", topic };
    }
  }
}

/** The highest of several, the first one on a tie. Undefined for none. */
export function highest<T extends { level: number }>(items: readonly T[]): T | undefined {
  let top: T | undefined;
  for (const item of items) if (top === undefined || item.level > top.level) top = item;
  return top;
}

/** The label of a question's button with exactly this level (the first one), if any. */
export function labelForLevel(questionId: string, level: Level): string | undefined {
  const table = BUTTON_LEVELS[questionId] ?? {};
  return Object.keys(table).find((k) => table[k] === level);
}

/**
 * Whether "A little, or a lot?" would change the level of this typed symptom: its amount is unknown
 * and "a little" and "a lot" land on different levels. The engine asks at most once per symptom.
 */
export function needsClarifying(mention: Pick<SymptomMention, "topic" | "questionId" | "amount" | "change">): boolean {
  if (mention.amount !== "unknown") return false;
  return typedLevel({ ...mention, amount: "a_little" }).level !== typedLevel({ ...mention, amount: "a_lot" }).level;
}

const AMOUNTS = new Set<string>(Object.keys(TYPED_LEVELS));
const CHANGES = new Set<string>(["new", "worse", "same", "better", "unknown"]);

/** The model's symptom list made safe to use: objects with a topic, amount and change from the known sets (else "unknown"). */
export function cleanMentions(xs: unknown): SymptomMention[] {
  if (!Array.isArray(xs)) return [];
  return xs.flatMap((x): SymptomMention[] => {
    if (typeof x !== "object" || x === null) return [];
    const m = x as Record<string, unknown>;
    const topic = typeof m.topic === "string" ? m.topic.trim() : "";
    if (!topic) return [];
    const amount = (typeof m.amount === "string" && AMOUNTS.has(m.amount) ? m.amount : "unknown") as Amount;
    const change = (typeof m.change === "string" && CHANGES.has(m.change) ? m.change : "unknown") as Change;
    const questionId = typeof m.questionId === "string" && m.questionId ? m.questionId : undefined;
    const words = typeof m.words === "string" ? m.words.trim() : "";
    return [{ topic, ...(questionId ? { questionId } : {}), amount, change, words }];
  });
}
