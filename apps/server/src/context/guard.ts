import { DOSING_ADVICE } from "../care/writer.ts";
import { DRUG_CLASSES } from "../rules/drug-classes.ts";

// The reply guard for the model's small talk (src/checkin/engine.ts checkedSmallTalk). The model sees the
// context digest, so it could repeat or invent a health fact. The reply is sent only if it:
//   - has no dash used as punctuation (long dashes, " - ", "--": the project writes none),
//   - has no dosing words,
//   - tells her to do nothing medical (not even to ask her doctor: the app does that, in fixed words),
//   - names no medicine or condition, and states no number, that is in neither the digest it was written
//     from nor her own message.
// Anything else falls back to the fixed reply. Heuristics on purpose: a miss only costs a friendly sentence.

const DASH = /[\u2012-\u2015\u2212]|\s-{1,2}\s|--/;

const MORE_DOSING = [
  /\b(?:take|taking)\s+(?:more|less|extra|another|an extra|double|both)\b/i,
  /\b(?:skip|skipping|skipped|double|doubling|halve|halving|stop|stopping|increase|increasing|decrease|decreasing)\b[^.!?]{0,40}\b(?:doses?|pills?|medicines?|medications?|tablets?|capsules?)\b/i,
  /\b(?:overdose|dosage|dosing)\b/i,
];

/** Words that make a sentence medical. */
const MEDICAL =
  /\b(?:doctors?|dr|nurses?|pharmacists?|physicians?|clinic|hospital|emergency|er|911|988|medicines?|medications?|pills?|tablets?|doses?|symptoms?|treatment|prescriptions?|appointments?|check-?ups?|blood pressure|heart rate|pulse|diagnos\w*|therapy|health)\b/i;
/** "You should ...", "please ...", "I suggest ...", "it would be a good idea to ...": a sentence with one of these and a medical word is advice. */
const DIRECTIVE =
  /\b(?:you|she)\s+(?:should|must|need to|needs to|ought to|have to|had better|might want to|may want to)\b|\b(?:should|must|need to|ought to|had better|make sure|be sure|remember to|try to|consider|please)\b|\b(?:i|we)(?:\s+would|'d)?\s+(?:recommend|suggest|advise|urge|encourage)\b|\bwhy not\b|\bit\s*(?:would be|might be|may be|could be|is|'s)\s+(?:a\s+)?(?:best|better|good|great|wise|important|worth|sensible|helpful)\b|\b(?:good|great|best) idea to\b|\b(?:let|tell)\s+(?:your\s+)?(?:doctors?|nurses?|pharmacists?)\b|\bdon'?t\s+(?:forget|ignore|wait)\b/i;
/** Sending her to her doctor, nurse or pharmacist is advice too, with or without "should": the app does that, in fixed words. */
const POINTS_TO_CLINICIAN =
  /\b(?:reach out to|talk to|talk with|speak to|speak with|share (?:this|it|that|your \w+) with|let|tell|ask|call|see|visit|contact|check with|mention (?:it|this|that) to|bring (?:it|this|that) up with|consult|go to)\b[^.!?]{0,60}\b(?:doctors?|nurses?|pharmacists?|physicians?|clinic|hospital)\b|\b(?:doctors?|nurses?|pharmacists?|physicians?)\b[^.!?]{0,40}\b(?:to ask|to talk to|to call|to see|to speak (?:to|with)|to check with|can help|can advise|would know|would be (?:great|best|the best|good))\b/i;
/** A sentence that starts by telling her to do something with a medical word in it: "Call your doctor." */
const MEDICAL_IMPERATIVE = /^\s*(?:please\s+)?(?:call|see|visit|contact|ask|talk to|speak to|speak with|check with|take|go to)\b/i;
/** Medical instructions on their own: "Elevate your feet." */
const ALWAYS_MEDICAL = /^\s*(?:please\s+)?(?:elevate|rest your|ice|monitor|track|get checked|lie down)\b/i;

/** Medicines named outside her list: her drug classes, and the common ones an older adult might mention. */
const MEDICINE_WORDS = new Set<string>([
  ...Object.values(DRUG_CLASSES).flat(),
  ..."potassium acetaminophen tylenol ibuprofen advil motrin naproxen aleve insulin prednisone coumadin eliquis xarelto lasix lipitor synthroid zoloft xanax ativan ambien tramadol oxycodone morphine codeine gabapentin amlodipine losartan hydrochlorothiazide diltiazem digoxin amiodarone clopidogrel plavix zocor crestor januvia ozempic benadryl melatonin".split(" "),
]);
/** Endings of generic drug names, for the ones not in the list. */
const DRUG_ENDING = /^[a-z]{3,}(?:pril|olol|sartan|statin|formin|azole|oxetine|pram|zepam|zolam|cillin|mycin|floxacin|dipine|semide|thiazide|parin|xaban|farin|gliptin|glutide|tidine|prazole|triptan|oxacin)$/;

const CONDITION_TERMS = [
  "diabetes", "diabetic", "heart failure", "heart attack", "heart disease", "atrial fibrillation", "afib", "a-fib", "hypertension", "high blood pressure",
  "low blood pressure", "arthritis", "osteoarthritis", "cholesterol", "hyperlipidemia", "thyroid", "hypothyroidism", "reflux", "gerd", "insomnia", "kidney",
  "stroke", "cancer", "dementia", "alzheimer", "copd", "asthma", "pneumonia", "infection", "anemia", "depression", "anxiety", "sleep apnea", "migraine",
];

/**
 * The reply, or undefined when it must not be sent. `known`: the digest the model was given (none when the
 * context couldn't be built) and her own message: the only places a number, medicine or condition may come from.
 */
export function guardSmallTalk(text: string, known: { digest?: string | undefined; message: string }): string | undefined {
  const reply = text.trim();
  if (!reply || DASH.test(reply)) return undefined;
  if ([...DOSING_ADVICE, ...MORE_DOSING].some((re) => re.test(reply))) return undefined;
  const sentences = reply.split(/(?<=[.!?])\s+/);
  for (const sentence of sentences) {
    if (ALWAYS_MEDICAL.test(sentence)) return undefined;
    if (POINTS_TO_CLINICIAN.test(sentence)) return undefined;
    if (MEDICAL.test(sentence) && (DIRECTIVE.test(sentence) || MEDICAL_IMPERATIVE.test(sentence))) return undefined;
  }
  const haystack = `${known.digest ?? ""}\n${known.message}`.toLowerCase();
  const lower = reply.toLowerCase();
  const numbersIn = (t: string) => t.match(/\d+(?:[.,]\d+)*/g) ?? [];
  const allowed = new Set(numbersIn(haystack));
  if (numbersIn(lower).some((n) => !allowed.has(n))) return undefined;
  const words = lower.match(/[a-z][a-z-]*/g) ?? [];
  if (words.some((w) => (MEDICINE_WORDS.has(w) || DRUG_ENDING.test(w)) && !haystack.includes(w))) return undefined;
  if (CONDITION_TERMS.some((term) => new RegExp(`\\b${term.replace(/[-\s]/g, "[-\\s]")}`).test(lower) && !haystack.includes(term))) return undefined;
  return reply;
}
