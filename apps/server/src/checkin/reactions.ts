import type { Question } from "../context/questions.ts";
import { MESSAGE_KINDS, type MessageClassification } from "../llm/types.ts";
import type { FollowUpTopic } from "./copy.ts";

// Fixed rules for what she types (src/checkin/engine.ts "Typed messages"). The LLM only
// sorts a message into a kind (src/llm/types.ts MessageKind); these rules decide what the
// engine does with it. Pure functions, so the rules can be read and tested on their own.

/** What was waiting for her when she typed. */
export type TypedAt =
  | "question" // a check-in question
  | "step" // another check-in step with buttons: the flag offer or detail (the greeting takes her open reply instead)
  | "follow_up" // a follow-up check-in ("How is your breathing now?")
  | "none"; // nothing: plain chat

/** What the engine does with a typed message. */
export type Reaction =
  | "crisis" // fixed crisis reply, family alert at every level, follow-up
  | "urgent_symptom" // fixed urgent reply, family alert at every level, follow-up
  | "answer" // count it as one of the pending buttons (if the model is sure enough)
  | "note" // detail on the pending question: saved for her doctor
  | "medicine_question" // fixed reply, saved for her next visit
  | "feeling_low" // fixed warm reply, saved as a memory
  | "family_message" // passed on to her family chats
  | "history_answer" // a fixed answer from the context digest (copy.ts historyAnswer), then the pending step again
  | "small_talk" // the model's own short reply, or a fixed reply by level when she mentions a symptom
  | "didnt_understand"; // the pending buttons again

const KINDS = new Set<string>(MESSAGE_KINDS);

/**
 * The reaction to a classified message. A kind the model made up counts as chat. Chat while a
 * check-in waits gets small talk only when the model is fairly sure it is chat; otherwise the buttons
 * again. An answer or detail with nothing pending is chat.
 */
export function reactionFor(c: Pick<MessageClassification, "kind" | "confidence">, at: TypedAt): Reaction {
  const kind = KINDS.has(c.kind) ? c.kind : "chat";
  switch (kind) {
    case "crisis":
    case "urgent_symptom":
    case "medicine_question":
    case "feeling_low":
    case "family_message":
      return kind;
    case "history_question":
      return "history_answer";
    case "answer":
      if (at !== "none") return "answer";
      break;
    case "more_detail":
      if (at === "question") return "note";
      break;
  }
  return at === "none" || c.confidence !== "low" ? "small_talk" : "didnt_understand";
}

/**
 * An explicit yes in her own words: "yes", "yeah", "yep", "yup", "I did", also with more after it
 * ("Yes but it was weirder"). Not "yeah no", "yes, not really", "I did not" or "I didn't". On a
 * red-flag question this counts as her "Yes" with no LLM involved; anything else there goes back
 * to her for a one-tap confirm, so an AI never clears a red flag.
 */
export function isExplicitYes(text: string): boolean {
  return /^\s*(?:(?:oh|well|um+|uh+|hmm+)[\s,.]+)?(?:yes|yeah|yep|yup|yea|i did)\b(?![\s,.!-]*(?:no|nope|not)\b)/i.test(text);
}

/**
 * A plain yes and nothing else ("yes", "Yep, that's right", "correct", "yes it was"): her answer to a
 * suggested confirm ("It sounds like ... Is that right?"), the same as tapping "Yes, that's right".
 * Anything more ("yes, it was really hard") is not plain and is read as usual.
 */
export function isPlainYes(text: string): boolean {
  const yes = String.raw`(?:yes|yeah|yep|yup|yea|correct|right|exactly|that'?s right|that is right|that'?s correct)`;
  const more = String.raw`(?:that'?s right|that is right|that'?s correct|correct|right|it is|it was|thanks|thank you)`;
  return new RegExp(String.raw`^\s*(?:(?:oh|well|um+|uh+)[\s,.]+)?${yes}(?:[\s,.!]+${more})*[\s,.!]*$`, "i").test(text.replace(/’/g, "'"));
}

/**
 * The button an explicit yes stands for on a red-flag question: its level-3 answer ("Yes, it was hard",
 * "Yes, bleeding"), if it has one. Ordinary questions have none, so a typed yes there goes to the LLM.
 */
export function explicitYesAnswer(q: Pick<Question, "redFlagAnswers">, text: string): string | undefined {
  if (!isExplicitYes(text)) return undefined;
  return q.redFlagAnswers[0];
}

/** What a follow-up asks about, from its stored reason (a question id, a safety kind, her topic words, or "general"). */
export function followUpTopic(reason: string): FollowUpTopic {
  if (reason === "hf-breathing-lying-flat") return "breathing";
  if (reason === "anticoagulant-bleeding") return "bleeding";
  if (reason === "hf-ankle-swelling") return "ankles";
  if (reason === "dizzy-on-standing") return "dizziness";
  if (reason === "crisis") return "crisis";
  return "general";
}
