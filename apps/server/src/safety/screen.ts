// Fixed phrase screen for the two kinds of message that must never depend on
// a model: a crisis (self-harm, not wanting to live) and an urgent symptom
// (chest pain, a fall, can't breathe). It runs before the LLM; a hit wins.
//
// The phrase lists are a demo starting point for the team to review
// (FEEDBACK.md), not clinical criteria. They lean toward flagging: a false
// alarm costs her one extra message, a miss could cost much more.
//
// CONTRACT for the engine: screenMessage(text) returns a hit or undefined.
//
// How a phrase matches:
// - Case-insensitive, on whole words, after normalizing: curly quotes and
//   apostrophes dropped ("don't", "don’t" and "dont" are the same word),
//   punctuation and emoji turned into spaces, repeated spaces collapsed.
// - Spelled-out and run-together forms are folded together: "cannot",
//   "can not" and "can't" are one word; so are "i am" / "i'm" / "im",
//   "do not" / "dont", "wanna" / "want to", "my self" / "myself", plus a few
//   common misspellings ("breath" for "breathe", "sucide", "feinted").
// - A negation just before a phrase cancels it ("no chest pain", "haven't had
//   a fall", "not suicidal"): one of NEGATIONS within the three words before,
//   in the same clause (punctuation, "but" and "and" end a clause), with no
//   "I" or "she" in between (so "no I can't breathe" still hits).
// - A few phrases carry idiom guards ("I fell asleep", "the leaves fell down",
//   "passed out the cookies", "killed myself laughing").

export type SafetyKind = "crisis" | "urgent_symptom";

export type SafetyHit = {
  kind: SafetyKind;
  /** The phrase that matched, as listed below, for logs and tests (never logged with her full message). */
  matched: string;
};

type PhraseRule = {
  phrase: string;
  /** Cancels the hit when one of these word sequences comes right after the phrase. */
  unlessAfter?: readonly string[];
  /** Cancels the hit when one of these words is among the two words before the phrase (same clause). */
  unlessBefore?: readonly string[];
  /** For phrases a negation leaves just as worrying ("I don't see the point in going on"). */
  ignoreNegation?: boolean;
};

/** "black stool" is her body, not the kitchen stool ("the black stool"). */
const FURNITURE = ["the", "that", "this", "bar", "kitchen", "piano", "step"];
/** A knock to the head long ago, or the idiom, is not news ("hit my head against the wall"). */
const PAST_OR_IDIOM = ["against the wall", "against a wall", "years ago", "year ago", "last year", "a long time ago"];

/** Words that make what follows something else than her ("the leaves fell down", "it blacked out"). */
const NOT_HER = ["the", "a", "an", "my", "his", "her", "our", "their", "its", "it", "that", "this", "they", "some", "everything"];

const CRISIS_RULES: readonly PhraseRule[] = [
  { phrase: "kill myself", unlessAfter: ["laughing"] },
  { phrase: "killing myself", unlessAfter: ["laughing", "trying", "to", "over", "with"] },
  { phrase: "end my life" },
  { phrase: "take my own life" },
  { phrase: "take my life", unlessAfter: ["savings", "insurance"] },
  { phrase: "end it all" },
  { phrase: "ending it all" },
  { phrase: "all my pills at once" },
  { phrase: "all of my pills at once" },
  { phrase: "not wake up", unlessAfter: ["early", "until", "before", "at", "in time"] },
  { phrase: "never wake up", unlessAfter: ["early", "until", "before", "at", "in time"] },
  { phrase: "want to die", unlessAfter: ["laughing", "of embarrassment", "of boredom", "my hair"] },
  { phrase: "wish I was dead" },
  { phrase: "wish I were dead" },
  { phrase: "better off dead" },
  { phrase: "don't want to be here anymore" },
  { phrase: "don't want to be here no more" },
  { phrase: "don't want to be alive" },
  { phrase: "don't want to live" },
  { phrase: "better off without me" },
  { phrase: "no reason to live" },
  { phrase: "nothing to live for" },
  { phrase: "no point in living" },
  { phrase: "point of living", ignoreNegation: true, unlessAfter: ["in", "near", "here"] },
  { phrase: "point in living", ignoreNegation: true, unlessAfter: ["in", "near", "here"] },
  { phrase: "point in going on", ignoreNegation: true },
  { phrase: "tired of living" },
  // "I hurt myself" alone is usually an accident for an older adult ("I hurt myself gardening"),
  // so self-harm needs a word of intent.
  { phrase: "want to hurt myself" },
  { phrase: "going to hurt myself" },
  { phrase: "thinking about hurting myself" },
  { phrase: "thoughts of hurting myself" },
  { phrase: "harm myself" },
  { phrase: "self harm" },
  { phrase: "suicide" },
  { phrase: "suicidal" },
  // Added after the first content eval (docs/content-eval.md): indirect and Spanish forms.
  { phrase: "notice if I was gone", ignoreNegation: true },
  { phrase: "nobody would miss me", ignoreNegation: true },
  { phrase: "no one would miss me", ignoreNegation: true },
  { phrase: "quiero morir" },
  { phrase: "no quiero vivir", ignoreNegation: true },
];

const URGENT_RULES: readonly PhraseRule[] = [
  { phrase: "chest pain" },
  { phrase: "pain in my chest" },
  { phrase: "chest pressure" },
  { phrase: "pressure in my chest" },
  { phrase: "chest hurts" },
  { phrase: "chest hurt" },
  { phrase: "chest is hurting" },
  { phrase: "chest is tight" },
  { phrase: "chest feels tight" },
  { phrase: "tightness in my chest" },
  { phrase: "can't breathe" }, // also "cannot breathe", "can not breathe", "cant breath"
  { phrase: "can't catch my breath" },
  { phrase: "struggling to breathe" },
  { phrase: "gasping for air" },
  { phrase: "fell down", unlessBefore: NOT_HER, unlessAfter: ["the rabbit hole"] },
  {
    phrase: "I fell",
    unlessAfter: ["asleep", "behind", "for", "in love", "apart", "short", "ill", "sick", "off the wagon", "last year", "years ago", "a few years ago"],
  },
  { phrase: "I've fallen", unlessAfter: ["asleep", "behind", "for", "in love"] },
  { phrase: "had a fall", unlessAfter: ["festival", "fair", "party", "picnic", "wedding", "sale", "wreath"] },
  { phrase: "took a fall" },
  { phrase: "took a tumble" },
  { phrase: "slipped and fell" },
  { phrase: "tripped and fell" },
  { phrase: "fainted", unlessAfter: ["when i saw", "when i heard", "at the price", "at the bill"] },
  {
    phrase: "passed out",
    unlessAfter: ["the cookies", "the flyers", "the candy", "the papers", "the programs", "the hymnals", "the cards", "cookies", "flyers", "candy", "papers", "programs", "hymnals", "cards"],
  },
  { phrase: "blacked out", unlessBefore: NOT_HER },
  { phrase: "won't stop bleeding" },
  { phrase: "can't stop the bleeding" },
  { phrase: "bleeding a lot" },
  { phrase: "bleeding heavily" },
  { phrase: "coughing up blood" },
  { phrase: "throwing up blood" },
  { phrase: "vomiting blood" },
  { phrase: "face drooping" },
  { phrase: "face is drooping" },
  { phrase: "face is droopy" },
  { phrase: "face feels droopy" },
  { phrase: "slurred speech" },
  { phrase: "slurring my words" },
  { phrase: "can't move my arm" },
  { phrase: "can't move my leg" },
  { phrase: "can't feel my arm" },
  { phrase: "can't feel my leg" },
  { phrase: "can't feel my face" },
  { phrase: "worst headache" },
  { phrase: "having a stroke" },
  { phrase: "having a heart attack" },
  { phrase: "call 911" },
  { phrase: "call an ambulance" },
  { phrase: "need an ambulance" },
  // Added after the first content eval (docs/content-eval.md): chest pain described as weight,
  // a voice-typing error, breathlessness right now, bleeding without the word, basic Spanish.
  { phrase: "sitting on my chest" },
  { phrase: "weight on my chest" },
  { phrase: "chest feels heavy" },
  { phrase: "chest is heavy" },
  { phrase: "chess pain" },
  { phrase: "I'm short of breath" },
  { phrase: "so short of breath" },
  { phrase: "really short of breath" },
  { phrase: "blood everywhere" },
  { phrase: "blood all over" },
  { phrase: "me duele el pecho" },
  { phrase: "no puedo respirar", ignoreNegation: true },
  { phrase: "me caí" },
  { phrase: "me cai" },
  // Added for what a blood thinner, an ACE inhibitor and a fall risk make urgent (standard apixaban and
  // lisinopril advice, 2026-10-04): bleeding that shows in stool or urine, a knock to the head, swelling of the
  // tongue, lips or throat, losing sight or feeling on one side. Treated as urgent, the cautious reading,
  // until a clinician has reviewed the list (docs/DESIGN.md "Message kinds and reactions").
  { phrase: "black stool", unlessBefore: FURNITURE },
  { phrase: "black stools" },
  { phrase: "black tarry stool" },
  { phrase: "tarry stool" },
  { phrase: "tarry stools" },
  { phrase: "black poop" },
  { phrase: "stool was black" },
  { phrase: "stool is black" },
  { phrase: "stools were black" },
  { phrase: "stools are black" },
  { phrase: "blood in my stool" },
  { phrase: "blood in my stools" },
  { phrase: "bloody stool" },
  { phrase: "bloody stools" },
  { phrase: "blood in my urine" },
  { phrase: "bloody urine" },
  { phrase: "red urine" },
  { phrase: "hit my head", unlessAfter: PAST_OR_IDIOM },
  { phrase: "bumped my head", unlessAfter: PAST_OR_IDIOM },
  { phrase: "banged my head", unlessAfter: PAST_OR_IDIOM },
  { phrase: "knocked my head", unlessAfter: PAST_OR_IDIOM },
  { phrase: "head injury", unlessAfter: PAST_OR_IDIOM },
  { phrase: "tongue is swelling" },
  { phrase: "tongue swelling" },
  { phrase: "swollen tongue" },
  { phrase: "tongue is swollen" },
  { phrase: "lips are swelling" },
  { phrase: "lips are swollen" },
  { phrase: "swollen lips" },
  { phrase: "throat is swelling" },
  { phrase: "throat is swollen" },
  { phrase: "throat swelling" },
  { phrase: "throat is closing" },
  { phrase: "lost my vision" },
  { phrase: "went blind" },
  { phrase: "numb on one side" },
  { phrase: "numbness on one side" },
];

/** Crisis phrases, as matched (see the rules above). A demo starting point for the team to review, not clinical criteria. */
export const CRISIS_PHRASES: readonly string[] = CRISIS_RULES.map((r) => r.phrase);
/** Urgent-symptom phrases, as matched (see the rules above). A demo starting point for the team to review, not clinical criteria. */
export const URGENT_PHRASES: readonly string[] = URGENT_RULES.map((r) => r.phrase);

/** Words that negate a phrase right after them, after normalizing (so "didn't" is "didnt"). */
export const NEGATIONS: readonly string[] = [
  "no", "not", "never", "without", "dont", "didnt", "doesnt", "havent", "hasnt", "hadnt",
  "isnt", "wasnt", "arent", "werent", "nor", "neither",
];

/** Words that end a negation's reach ("no fever but chest pain"). */
const CLAUSE_WORDS = new Set(["but", "and", "so", "though", "although", "however", "yet", "except", "because", "cause", "cuz", "now", "until", "then", "also"]);
/** A subject between a negation and a phrase means the negation was about something else ("no I can't breathe"). */
const SUBJECTS = new Set(["i", "im", "ive", "id", "ill", "she", "shes", "he", "hes", "we", "were", "they", "theyre"]);
const NEGATION_SET = new Set(NEGATIONS);
const NEGATION_WINDOW = 3;
const BEFORE_WINDOW = 2;

/** One word folded to another (or to two). Applied to her text and to the phrases alike. */
const WORD_FOLDS: Record<string, string[]> = {
  cannot: ["cant"],
  wanna: ["want", "to"],
  wana: ["want", "to"],
  gonna: ["going", "to"],
  alot: ["a", "lot"],
  breath: ["breathe"],
  breth: ["breathe"],
  brethe: ["breathe"],
  pains: ["pain"],
  arms: ["arm"],
  legs: ["leg"],
  sucide: ["suicide"],
  suiside: ["suicide"],
  suicde: ["suicide"],
  sucidal: ["suicidal"],
  suicdal: ["suicidal"],
  kil: ["kill"],
  chesst: ["chest"],
  feinted: ["fainted"],
  fainting: ["fainted"],
  bleding: ["bleeding"],
  hedache: ["headache"],
  headach: ["headache"],
  slured: ["slurred"],
};

/** Two words folded to one form. Checked before WORD_FOLDS. */
const PAIR_FOLDS: Record<string, string[]> = {
  "can not": ["cant"],
  "can t": ["cant"],
  "do not": ["dont"],
  "don t": ["dont"],
  "did not": ["didnt"],
  "does not": ["doesnt"],
  "is not": ["isnt"],
  "was not": ["wasnt"],
  "are not": ["arent"],
  "were not": ["werent"],
  "have not": ["havent"],
  "has not": ["hasnt"],
  "had not": ["hadnt"],
  "will not": ["wont"],
  "won t": ["wont"],
  "could not": ["couldnt"],
  "would not": ["wouldnt"],
  "should not": ["shouldnt"],
  "i am": ["im"],
  "i m": ["im"],
  "i have": ["ive"],
  "i ve": ["ive"],
  "my self": ["myself"],
  "any more": ["anymore"],
  "passing out": ["passed", "out"],
  "blacking out": ["blacked", "out"],
};

type Token = { word: string; clause: number };

/** Her text as words, each tagged with the clause it sits in. Exported for tests. */
export function tokenize(text: string): Token[] {
  const cleaned = text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/['\u2018\u2019\u201B\u02BC`\u00B4]/g, "")
    .replace(/[\u2013\u2014]/g, ",");
  const raw: Token[] = [];
  let clause = 0;
  // Split into clauses on sentence punctuation, then into words on anything that isn't a letter or digit.
  for (const part of cleaned.split(/[.!?;:,\n()"\u201C\u201D]+/)) {
    for (const word of part.split(/[^\p{L}\p{N}]+/u)) {
      if (!word) continue;
      if (CLAUSE_WORDS.has(word)) {
        raw.push({ word, clause });
        clause += 1;
        continue;
      }
      raw.push({ word, clause });
    }
    clause += 1;
  }
  const out: Token[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const here = raw[i]!;
    const next = raw[i + 1];
    const after = raw[i + 2];
    // Preserve the affirmative "not only" construction before folding auxiliary
    // negations ("has not", "had not", "do not") into a single word.
    const notOnly = next?.word === "not" && after?.word === "only" && next.clause === here.clause && after.clause === here.clause;
    const pair = next && next.clause === here.clause && !notOnly ? PAIR_FOLDS[`${here.word} ${next.word}`] : undefined;
    if (pair) {
      for (const word of pair) out.push({ word, clause: here.clause });
      i += 1;
      continue;
    }
    const fold = Object.hasOwn(WORD_FOLDS, here.word) ? WORD_FOLDS[here.word] : undefined;
    if (fold) for (const word of fold) out.push({ word, clause: here.clause });
    else out.push(here);
  }
  return out;
}

type CompiledRule = { phrase: string; words: string[]; unlessAfter: string[][]; unlessBefore: Set<string>; ignoreNegation: boolean };

function compile(rules: readonly PhraseRule[]): CompiledRule[] {
  const words = (s: string) => tokenize(s).map((t) => t.word);
  return rules.map((rule) => ({
    phrase: rule.phrase,
    words: words(rule.phrase),
    unlessAfter: (rule.unlessAfter ?? []).map(words),
    unlessBefore: new Set((rule.unlessBefore ?? []).flatMap(words)),
    ignoreNegation: rule.ignoreNegation ?? false,
  }));
}

const CRISIS = compile(CRISIS_RULES);
const URGENT = compile(URGENT_RULES);

export function screenMessage(text: string): SafetyHit | undefined {
  const tokens = tokenize(text);
  if (tokens.length === 0) return undefined;
  const crisis = firstHit(tokens, CRISIS);
  if (crisis) return { kind: "crisis", matched: crisis };
  const urgent = firstHit(tokens, URGENT);
  if (urgent) return { kind: "urgent_symptom", matched: urgent };
  return undefined;
}

function firstHit(tokens: Token[], rules: CompiledRule[]): string | undefined {
  for (const rule of rules) {
    for (let start = 0; start + rule.words.length <= tokens.length; start += 1) {
      if (!rule.words.every((word, k) => tokens[start + k]!.word === word)) continue;
      if (isNegated(tokens, start, rule) || isGuarded(tokens, start, rule)) continue;
      return rule.phrase;
    }
  }
  return undefined;
}

/** The words before `start` in the same clause, nearest first, up to `limit`. */
function wordsBefore(tokens: Token[], start: number, limit: number): string[] {
  const clause = tokens[start]!.clause;
  const out: string[] = [];
  for (let i = start - 1; i >= 0 && out.length < limit; i -= 1) {
    const token = tokens[i]!;
    if (token.clause !== clause) break;
    out.push(token.word);
  }
  return out;
}

function isNegated(tokens: Token[], start: number, rule: CompiledRule): boolean {
  if (rule.ignoreNegation) return false;
  // A phrase that starts with its own subject ("I fell") can't be negated from before it: "no I fell" is an answer, then the news.
  if (SUBJECTS.has(rule.words[0]!)) return false;
  const before = wordsBefore(tokens, start, NEGATION_WINDOW);
  for (let offset = 0; offset < before.length; offset += 1) {
    const word = before[offset]!;
    if (SUBJECTS.has(word)) return false;
    // "Not only chest pain" affirms the symptom; it does not deny it. Only skip
    // this exact same-clause pair, so another negation still cancels the hit.
    const next = tokens[start - offset];
    if (word === "not" && next?.word === "only" && next.clause === tokens[start]!.clause) continue;
    if (NEGATION_SET.has(word)) return true;
  }
  return false;
}

function isGuarded(tokens: Token[], start: number, rule: CompiledRule): boolean {
  if (rule.unlessBefore.size > 0 && wordsBefore(tokens, start, BEFORE_WINDOW).some((w) => rule.unlessBefore.has(w))) return true;
  const end = start + rule.words.length;
  return rule.unlessAfter.some((seq) => seq.length > 0 && seq.every((word, k) => tokens[end + k]?.word === word));
}
