import {
  LET_ME_EXPLAIN,
  QUESTION_BANK,
  SUGGESTION_YES,
  offersExplain,
  pickQuestions,
  promptButtons,
  suggestionButtons,
  type Question,
} from "../context/questions.ts";
import { answerHistory } from "../db/answer-history.ts";
import {
  getCheckin,
  getCheckinById,
  getCheckinPatient,
  getCheckinPrompt,
  finishedCheckinsBefore,
  insertCheckin,
  latestCheckin,
  markInboundHandled,
  patientForChat,
  recordCheckinPrompt,
  updateCheckin,
  type CheckinPatient,
  type CheckinRow,
  type PromptStep,
  type StoredAnswer,
  type Suggestion,
} from "../db/checkins.ts";
import {
  deletePatientFlags,
  deletePatientSnapshots,
  getFlag,
  getSharing,
  markNoted,
  markOffered,
  markTold,
  nextFlagToOffer,
  openFlags,
  saveSnapshot,
  setSharing,
  syncFlags,
} from "../db/index.ts";
import { addFamilyRelay, familyChats, markFamilyRelayPassedOn, waitingFamilyRelays, type FamilyChat } from "../db/family.ts";
import { addClarification, closeClarification, openClarification, type Clarification } from "../db/clarifications.ts";
import {
  answerFollowUp,
  dueFollowUps,
  followUpForMessage,
  LEGACY_FOLLOW_UP_LEVEL,
  markFollowUpSent,
  nextFollowUp,
  openFollowUp,
  scheduleFollowUp,
  type FollowUpRow,
} from "../db/follow-ups.ts";
import { addMemories, recentMemories } from "../db/memories.ts";
import { addCheckinNote, addVisitQuestion, checkinNotes } from "../db/notes.ts";
import { addObservation, highestOfDay, observationsBetween, type ObservationSource } from "../db/observations.ts";
import { inboundSeen, insertPaperScan, paperScanForAttachment } from "../db/paper-scans.ts";
import { ConsentInactiveError } from "../finchnode/client.ts";
import { loadRxNavCache } from "../finchnode/fixtures.ts";
import { asOf, normalizeHealthRecord } from "../finchnode/normalize.ts";
import type { RxNavCache } from "../finchnode/rxnav.ts";
import type { SharingLevel } from "../db/index.ts";
import type {
  CheckinExtraction,
  Change,
  ClassifyInput,
  ExtractCheckinInput,
  MessageClassification,
  MessageKind,
  SmallTalkInput,
  SmallTalkReply,
  SymptomMention,
} from "../llm/types.ts";
import type { InboundMessage, OutboundMessage } from "../relay/messenger.ts";
import { runRules } from "../rules/index.ts";
import type { ExtractedPaper } from "../rules/paper-diff.ts";
import { screenMessage, type SafetyKind } from "../safety/screen.ts";
import { looksLikeInstructions } from "../safety/injection.ts";
import {
  BUTTON,
  CLARIFY_BUTTONS,
  answerPhrase,
  FOLLOW_UP_BUTTONS,
  checkinDone,
  checkinDoneAfterConcern,
  checkinGreeting,
  clarifyAmount,
  complaintReply,
  crisisReply,
  didntUnderstand,
  explainPrompt,
  familyCrisisAlert,
  familyDailyStatus,
  familyFollowUpUpdate,
  familyFollowUpWorse,
  familyMissedAlert,
  familyRedFlagAlert,
  familyRelay,
  familyRelayDone,
  familyRelayWaiting,
  familyUrgentAlert,
  feelingLowReply,
  flagDetail,
  flagNotedReply,
  flagOffer,
  followUpQuestion,
  followUpReply,
  freeTextConfirm,
  keepAnEye,
  keepAnEyeReply,
  medicineQuestionReply,
  notedForDoctor,
  noteSaved,
  notTodayReply,
  openReplyThanks,
  openReplyUnavailable,
  READING_ACTIVITY,
  recordLinkEndedFamily,
  recordLinkEndedSenior,
  redFlagAdvice,
  SHARING_BUTTONS,
  SHARING_MENU_BUTTON,
  sharingChangedFamily,
  sharingChangedSenior,
  sharingLevelFromButton,
  sharingMenu,
  smallTalkFallback,
  START_ALIASES,
  suggestedConfirm,
  symptomNotedReply,
  topicWords,
  typedReplyUnavailable,
  understoodLine,
  urgentReply,
  withLead,
  withTypingHint,
  type DayOutcome,
  type FollowUpAnswer,
  type UnderstoodItem,
} from "./copy.ts";
import type { CheckinEngine, DayResult, EngineDeps, FreeTextAnswer } from "./engine-types.ts";
import { PAPER_CONFIRM_BUTTONS, paperReadback } from "./paper-check.ts";
import {
  createPaperFlow,
  isPaperConfirm,
  isPaperFollowUp,
  isPaperReject,
  pendingFollowUp as pendingPaperFollowUp,
  pendingReadback,
  type FreshRecord,
  type PaperSend,
} from "./paper-flow.ts";
import { explicitYesAnswer, followUpTopic, isPlainYes, reactionFor, type TypedAt } from "./reactions.ts";
import {
  REPETITION,
  TYPED_LEVELS,
  cleanMentions,
  highest,
  labelForLevel,
  levelFor,
  needsClarifying,
  topicOf,
  type Level,
  type Severity,
  type SeverityHistory,
} from "./severity.ts";

// The daily check-in as a small state machine over the checkins row:
//   greeting -> question (each one she hasn't answered, in order) -> flag_offer -> flag_detail -> done
// "Not today" ends it from greeting or any question. Each inbound message is
// handled in one synchronous DB transaction that also plans the messages to
// send; the sends happen after, in order, with idempotency keys
// `${patientId}:${day}:<step>` so a replay never double-sends.
//
// Family messages (daily status, red-flag alert, missed alert, sharing changed,
// record link ended) go to every linked family chat: each family member's own
// direct chat with the agent (src/db/family.ts), keyed
// `${patientId}:${day}:<step>:family:<handle>`. A member who hasn't messaged the
// agent yet has no chat and is skipped; with nobody linked, family sends are skipped.
// Family chats never reach the check-in: patientForChat matches only her own chat.
//
// Outside the check-in, at any time and without breaking it: "Sharing" opens the
// sharing menu and a tap on a level changes it (family told it changed, not why);
// the paper check (src/checkin/paper-flow.ts) answers its own buttons; a follow-up's
// "Better" / "About the same" / "Worse" answers the follow-up. Each re-sends whatever
// the check-in was waiting for, so she can carry on.
//
// Stale taps: every message that carries a check-in step's buttons is remembered
// with that step (checkin_prompts). A tap names the message it replies to
// (InboundMessage.replyTo); a tap on a message sent for another step, another day
// or no step at all doesn't answer what is pending now. It re-sends the current
// prompt instead. "Not today" from the greeting or any question of the pending
// check-in still ends the day. Typed text (no replyTo) is matched as before.
//
// Severity ladder (src/checkin/severity.ts, docs/DESIGN.md): every answer, typed symptom,
// follow-up answer and safety hit gets a level from fixed tables, saved in symptom_observations.
// The reaction follows the level:
//   0  nothing extra: straight to the next question or the close.
//   1  "Thanks, I've made a note of that for your doctor." before the next message, at most once
//      per check-in (in chat: "Sorry to hear about your knee pain..."; mood "Not great": the warm
//      feeling-low words instead). No advice, no 911.
//   2  "Thanks for telling me, Harriet. Let's keep an eye on that." before the next message (in
//      chat, on its own), and a follow-up later today. No alert; a flag may still be offered.
//   3  A red flag: thanked calmly, told who was told, to call her doctor today and 911 only if it
//      gets much worse; every family chat is alerted. The remaining questions are still asked,
//      but no flag is offered that day (checkins.concern_at).
//   4, 5  The safety screen's urgent and crisis replies (below).
// A follow-up check-in is scheduled `followUpDelayMinutes` after a level 2 or more (src/db/follow-ups.ts,
// sent by runDueFollowUps); while one is coming, the closing says we'll check on her this afternoon.
// Better is level 0, About the same keeps the level (at most 2), Worse is level 3 again.
//
// Open question first (docs/DESIGN.md "Severity ladder"): the greeting asks how she is, in her own
// words, with "Quick questions" (BUTTON.start; "Let's start" still works) and "Not today" as buttons.
// What she types while the greeting waits is her open reply, read by the understanding pass below.
// No LLM, or it failed: openReplyUnavailable, then the questions with buttons. Silence is never "No":
// a reply that told us nothing gets "Thanks" and the questions as usual.
//
// One understanding pass (live log 2026-10-07: one message is often several answers and a symptom).
// Everything she types during the check-in (her open reply, any message while a question waits,
// her words after "Let me explain") goes through it:
//   1. The safety screen, as for any typed message (a hit wins).
//   2. In parallel: llm.extractCheckin against today's UNANSWERED questions (answers to any of them,
//      every symptom with its topic, memories) and llm.classifyMessage for her kind of message
//      (crisis and urgent win like a screen hit; medicine_question, family_message and feeling_low get
//      their fixed replies). Her chat shows "Reading your message".
//   3. Fixed rules apply all of it (understandWords, applyUnderstanding):
//      - A sure enough answer to an ordinary question is recorded (via "free_text", her words) and
//        levelled like a tap, symptoms about it raising it, never lowering it.
//      - A red-flag question is recorded from her words only at level 3 (the red-flag advice and alert
//        as for a tap). A calmer reading is never recorded: it becomes a suggested confirm, "It sounds
//        like <phrase>. Is that right?" with "Yes, that's right", the other answers and "Let me
//        explain" (checkins.suggestions_json). Her tap records it ("Yes, that's right": the suggested
//        answer via "confirmed", her words kept; another answer: that answer). A plain typed yes counts
//        as "Yes, that's right"; an explicit yes with more ("yes, it was hard") is her "Yes" as before.
//      - Each symptom is levelled under its own topic (a question id, else her topic words), saved as
//        an observation and as a note on that topic (checkin_notes.topic; question_id only when the
//        topic is one of today's questions). A symptom about a question still to be asked is only
//        noted (her answer to it will level it). Nothing is noted on the pending question unless it
//        is about that question.
//      - Then ONE reply: level 3 sends its own messages; otherwise one fixed line says back what was
//        understood (copy.ts understoodLine: "Got it: ankles feeling fine. I've noted the back pain for
//        your doctor."), folded before the first question she hasn't answered (or the end of the
//        check-in, as after a last answer).
//      - The classifier was shown the pending question; the extraction was not. When the extraction
//        understood something else but nothing about the pending question, the classifier's sure answer
//        to it fills in (recorded, or a suggestion below level 3; its level-3 reading alone is never
//        recorded, and nothing calmer is suggested over it).
//   When the pass understood nothing (no answer, no suggestion, no symptom on another topic), or the
//   extraction failed, a question's message falls back to the classifier alone ("Typed messages"
//   below, including the generic confirm on a red-flag question). Instruction-like text
//   (src/safety/injection.ts) counts as nothing read.
//
// Questions she didn't cover are asked in order with their buttons; on a symptom question the buttons
// end with "Let me explain" (src/context/questions.ts). Tapping it gets explainPrompt with no buttons
// and marks the question (checkins.explain_at); her next message goes through the understanding pass,
// and if nothing in it is understood it is kept as a note on that question for her doctor (noteSaved)
// rather than "didn't understand". On her first HINT_CHECKINS check-ins (answered or "not today"),
// each question carries the typing hint under it.
//
// Typed messages: anything she types that isn't a button label, in this order (while a question
// waits, after the understanding pass above found nothing).
//   1. Safety screen (src/safety/screen.ts), fixed phrases, no LLM: a crisis (self-harm, not
//      wanting to live) or an urgent symptom (chest pain, a fall) wins over everything, even
//      mid-question. Fixed reply (988 / 911), an alert to every family chat at every sharing
//      level (detail only at "all"), a follow-up; the check-in pauses: no flag offer today, and
//      the pending question isn't asked again in the same reply (its buttons still work).
//   2. The LLM sorts the message (llm.classifyMessage, with the pending question if any); her chat
//      shows "Reading your message". No LLM, or it fails: while something waits, the buttons with
//      typedReplyUnavailable (our trouble, not hers); with nothing pending, smallTalkFallback.
//   3. Fixed rules react by kind (src/checkin/reactions.ts); the model's own words only for chat:
//      - crisis / urgent_symptom (the screen missed it): as in 1.
//      - answer to an ordinary question: a high or medium confidence match counts as that tap
//        (stored with her words, via "free_text"), and symptoms she typed may raise its level, never
//        lower it. No sure match, but a symptom on this question whose amount is unclear and would
//        change the level: "A little, or a lot?" once (clarifications), her tap sets the level.
//        Otherwise "didn't understand" with the buttons.
//      - answer to a red-flag question: an explicit yes in her words ("yes", "yeah", "yes but...",
//        "I did") counts as its level-3 answer ("Yes, it was hard"), a fixed rule that needs no LLM,
//        checked even when the model says something else; anything else gets the one-tap confirm with
//        the graded buttons, since an AI never clears a red flag. Her words are saved as a note on
//        that question either way.
//      - more_detail while a question waits: saved as a note on it (checkin_notes, for her doctor;
//        family sees notes only at "all"), and noteSaved with the question's buttons again.
//      - medicine_question: fixed reply, saved for her next visit (visit_questions).
//      - feeling_low: fixed warm reply, saved as a memory, no alert.
//      - family_message: her message passed on to every linked family chat (or kept until one links).
//      - chat: the model's small talk. Symptoms she mentions get a fixed reply by level instead (1:
//        symptomNotedReply, 2: keepAnEyeReply and a follow-up, 3: the red-flag reply and alert); a
//        complaint with no symptom read gets complaintReply (level-1 wording). While a check-in
//        waits, chat the model isn't sure of gets "didn't understand" with the buttons.
//      Each reaction while a check-in step waits re-sends that step after it.
//   Memories and complaints the model picked out are saved as memories (never on a crisis or
//   urgent symptom), never acted on.
// The LLM call is async and planning is a synchronous transaction, so planning runs twice: the
// first pass stops at typed text and asks for the LLM's reading without writing anything (the
// message stays unhandled); the second pass plans with it. A message already handled never
// reaches the LLM. If what was pending changed while the model read, its answer doesn't count.

export type EngineOptions = {
  /** MISSED_CHECKIN_TIME, shown in the family's missed check-in alert. */
  missedCheckinTime?: string;
  /** RxNav lookups for normalization. Defaults to the recorded cache in fixtures/. */
  rxnav?: RxNavCache;
  /** Minutes from a red flag or safety hit to its follow-up check-in. Defaults to DEFAULT_FOLLOW_UP_DELAY_MINUTES. */
  followUpDelayMinutes?: number;
};

/** A follow-up check-in comes this many minutes after a red flag or a safety hit (a morning concern: early afternoon). */
export const DEFAULT_FOLLOW_UP_DELAY_MINUTES = 180;

/** Which check-in step a message's buttons belong to; recorded with the sent message id once it is out. */
type PromptRef = { checkinId: number; step: PromptStep; questionIndex: number };
type Send = {
  chatId: string;
  message: OutboundMessage;
  key: string;
  prompt?: PromptRef;
  /** This send is a follow-up check-in: its message id is stored once it is out. */
  followUpId?: number;
};

/** What a check-in step shows: its text and buttons. */
type Prompt = { step: PromptStep; text: string; buttons: string[] };

/** What was waiting for her when she typed. */
type TypedContext =
  | { at: "question"; c: CheckinRow; q: Question }
  | { at: "step"; c: CheckinRow; prompt: Prompt }
  | { at: "follow_up"; f: FollowUpRow }
  | { at: "none" };

/** Typed text the first planning pass found, which needs the LLM before it can be planned. */
type FreeTextNeed = {
  kind: "classify";
  /** What was pending (contextKey), to tell later whether the reading still applies. */
  context: string;
  at: TypedAt;
  classify: ClassifyInput;
  smallTalk: SmallTalkInput;
  /** An explicit yes on a red-flag question: the reply is fixed, so no small talk is asked for. */
  noSmallTalk: boolean;
  /** The check-in question she typed about, if any: detail is noted on it even if the check-in moved on. */
  about: NoteTarget | undefined;
  /** While a question waits: the understanding pass's extraction, against today's unanswered questions. */
  extract?: ExtractCheckinInput | undefined;
};

/** Where a note goes: one question of one check-in. */
type NoteTarget = { checkinId: number; questionId: string };

/** What the LLM made of it. `classification` undefined: no LLM, or it failed or timed out. */
type FreeTextResult = {
  kind: "classify";
  context: string;
  about: NoteTarget | undefined;
  classification: MessageClassification | undefined;
  smallTalk: SmallTalkReply | undefined;
  /** The understanding pass's reading (a question was waiting); undefined when not asked for or it failed. */
  extraction?: CheckinExtraction | undefined;
};

/** Her open reply (typed while the greeting waits), which needs the LLM's extraction first. */
type OpenNeed = {
  kind: "extract";
  /** The greeting it answers (openContext), to tell later whether the reading still applies. */
  context: string;
  extract: ExtractCheckinInput;
  /** Read alongside the extraction for a crisis or urgent reading only. */
  classify: ClassifyInput;
};

/** What the LLM made of her open reply. */
type OpenResult = {
  kind: "extract";
  context: string;
  /** Undefined: no LLM, or the extraction failed or timed out. */
  extraction: CheckinExtraction | undefined;
  /** The model's kind of message, tidied (undefined: it failed). */
  classification: MessageClassification | undefined;
  /** The model read a crisis or an urgent symptom: it wins like a screen hit. */
  safety: SafetyKind | undefined;
};

/** Her words kept for her doctor on one topic: a question id (questionId set when it is one of the check-in's), or her topic words. */
type TopicNote = { questionId: string | null; topic: string; words: string };

/** What one typed message told us, by fixed rules, before anything is written (see "One understanding pass"). */
type Understanding = {
  /** Answers to record: ordinary questions, and red-flag questions read at level 3. */
  recorded: { q: Question; label: string; own: Severity; raisedBy: SymptomMention | undefined; words: string }[];
  /** Red-flag questions read below level 3: the answer to suggest, for her tap. */
  suggested: { q: Question; answer: string }[];
  /** Her words worth keeping for her doctor, by topic. */
  notes: TopicNote[];
  /** Symptoms on anything but the questions still open, levelled under their own topic. */
  others: { m: SymptomMention; sev: Severity }[];
  /** Anything to record, suggest or react to. */
  understood: boolean;
};

/** A plan, or (first pass only, nothing written) the typed text that needs the LLM first. */
type Planned = { sends: Send[] } | { needs: FreeTextNeed | OpenNeed };

/** The LLM's reading of the message being planned, from the first pass's need. */
type Reading = FreeTextResult | OpenResult;

/** Memories passed to small talk as context, newest first. */
export const SMALL_TALK_MEMORIES = 10;
/** A small-talk reply longer than this (or empty, or with a long dash) is not sent; the fallback is. */
export const MAX_SMALL_TALK_REPLY = 500;
/** Longest family message passed on, in characters. */
export const MAX_FAMILY_RELAY = 500;

/** The model's small-talk text if it is fit to send as is, else undefined (the caller sends a template). */
export function checkedSmallTalk(text: string): string | undefined {
  const one = text.replace(/[ \t]+/g, " ").trim();
  if (!one || one.length > MAX_SMALL_TALK_REPLY || /[\u2013\u2014]/.test(one)) return undefined;
  return one;
}

/** Only high and medium confidence answers are recorded. */
const confident = (m: Pick<MessageClassification, "confidence">) => m.confidence === "high" || m.confidence === "medium";

/**
 * Whether an extraction reads anything the pass could use: a sure answer that is one of a question's
 * options, or a symptom. Read before planning, to tell whether small talk is worth asking for.
 */
function extractionReads(x: CheckinExtraction, questions: ExtractCheckinInput["questions"]): boolean {
  const answers = x.answers.some((a) => confident(a) && questions.some((q) => q.id === a.questionId && q.options.some((o) => is(o, a.answer))));
  return answers || x.symptoms.some((m) => m.amount !== "none");
}

/** Her first this many check-ins (answered or "not today") show the typing hint under each question. */
export const HINT_CHECKINS = 3;

/** A message carrying `step`'s buttons for check-in `c` (for a question, the one at c.questionIndex). */
function promptFor(c: CheckinRow, step: PromptStep): PromptRef {
  return { checkinId: c.id, step, questionIndex: step === "question" ? c.questionIndex : 0 };
}

const norm = (s: string) => s.trim().toLowerCase();
const is = (text: string, label: string) => norm(text) === norm(label);

/** "Quick questions", or an older label of it ("Let's start"). */
const isStart = (text: string) => [BUTTON.start, ...START_ALIASES].some((label) => is(text, label));

/** "Not today", tapped or typed ("not today.", "Not today, thanks"). */
const isNotToday = (text: string) => /^\s*not\s+today\b[\s,.!]*(?:thanks|thank\s+you)?[\s,.!]*$/i.test(text);

/** The index of the first of today's questions she hasn't answered, or undefined when she answered them all. */
function firstUnanswered(c: Pick<CheckinRow, "answers" | "questionIds">): number | undefined {
  const done = new Set(c.answers.map((a) => a.questionId));
  const index = c.questionIds.findIndex((id) => !done.has(id));
  return index < 0 ? undefined : index;
}

/** How many of today's questions she hasn't answered yet. */
function unansweredCount(c: Pick<CheckinRow, "answers" | "questionIds">): number {
  const done = new Set(c.answers.map((a) => a.questionId));
  return c.questionIds.filter((id) => !done.has(id)).length;
}

/** The answer her words suggested on this question, waiting for her tap, if any. */
function suggestionFor(c: Pick<CheckinRow, "suggestions">, questionId: string): Suggestion | undefined {
  return Object.hasOwn(c.suggestions, questionId) ? c.suggestions[questionId] : undefined;
}

/** The check-in's suggestions without the one on this question. */
function withoutSuggestion(c: Pick<CheckinRow, "suggestions">, questionId: string): Record<string, Suggestion> {
  const rest = { ...c.suggestions };
  delete rest[questionId];
  return rest;
}

/** How a note is introduced to her family at "all": the question it is about, else its topic ("Back pain:"). */
function noteHeading(n: { questionId: string | null; topic: string }): string {
  if (n.questionId) return QUESTIONS_BY_ID.get(n.questionId)?.text ?? n.questionId;
  const words = QUESTIONS_BY_ID.get(n.topic)?.text ?? topicWords(n.topic);
  if (!words) return "Also:";
  return words.endsWith("?") ? words : `${words.charAt(0).toUpperCase()}${words.slice(1)}:`;
}

/** Today's questions she hasn't answered, as the extraction reads them. */
function unansweredForExtraction(c: Pick<CheckinRow, "answers" | "questionIds">): ExtractCheckinInput["questions"] {
  const done = new Set(c.answers.map((a) => a.questionId));
  return c.questionIds
    .filter((id) => !done.has(id))
    .map(questionById)
    .map((q) => ({ id: q.id, question: q.text, options: [...q.buttons] }));
}

/** Identity of the greeting an open reply answers, compared after the LLM has read it. */
const openContext = (c: CheckinRow) => `open:${c.id}`;

/** An extraction with its lists made safe to use (answers with strings, symptoms with known amounts and changes). */
function tidyExtraction(x: CheckinExtraction): CheckinExtraction {
  const answers = (Array.isArray(x.answers) ? x.answers : []).filter(
    (a): a is CheckinExtraction["answers"][number] => typeof a === "object" && a !== null && typeof a.questionId === "string" && typeof a.answer === "string",
  );
  const memories = Array.isArray(x.memories) ? x.memories.filter((m): m is string => typeof m === "string") : [];
  return { answers, symptoms: cleanMentions(x.symptoms), memories };
}

const QUESTIONS_BY_ID = new Map<string, Question>(
  QUESTION_BANK.map(({ id, text, buttons, redFlagAnswers }) => [id, { id, text, buttons, redFlagAnswers }]),
);

const FOLLOW_UP_LABELS: string[] = Object.values(FOLLOW_UP_BUTTONS);

/** "Better" -> "better", and so on; undefined for anything else. */
function followUpAnswerOf(text: string): FollowUpAnswer | undefined {
  return (Object.keys(FOLLOW_UP_BUTTONS) as FollowUpAnswer[]).find((k) => is(text, FOLLOW_UP_BUTTONS[k]));
}

/** Every button label the engine sends, normalized. A message that equals one is a tap (maybe late), not small talk. */
const ALL_LABELS = new Set(
  [
    ...Object.values(BUTTON),
    ...START_ALIASES,
    LET_ME_EXPLAIN,
    SUGGESTION_YES,
    ...QUESTION_BANK.flatMap((q) => q.buttons),
    ...Object.values(SHARING_BUTTONS),
    SHARING_MENU_BUTTON,
    ...PAPER_CONFIRM_BUTTONS,
    ...FOLLOW_UP_LABELS,
    ...Object.values(CLARIFY_BUTTONS),
  ].map(norm),
);
const isButtonLabel = (text: string) => ALL_LABELS.has(norm(text));

function questionById(id: string): Question {
  const q = QUESTIONS_BY_ID.get(id);
  if (!q) throw new Error(`Check-in refers to unknown question "${id}"`);
  return q;
}

/** A family member as she knows them: display name, else their Relay handle. */
const familyName = (f: FamilyChat) => f.displayName || f.handle;

/** An ISO timestamp `minutes` after `iso`. */
function plusMinutes(iso: string, minutes: number): string {
  return new Date(Date.parse(iso) + minutes * 60_000).toISOString();
}

/** Identity of what was pending when she typed, compared after the LLM has read it. */
function contextKey(ctx: TypedContext): string {
  switch (ctx.at) {
    case "question":
      return `question:${ctx.c.id}:${ctx.c.questionIndex}`;
    case "step":
      return `step:${ctx.c.id}:${ctx.prompt.step}`;
    case "follow_up":
      return `follow_up:${ctx.f.id}`;
    case "none":
      return "none";
  }
}

/** A classification with its lists made safe to use (strings only, symptoms with known amounts and changes). */
function tidy(c: MessageClassification): MessageClassification {
  const strings = (xs: unknown) => (Array.isArray(xs) ? xs.filter((x): x is string => typeof x === "string") : []);
  return { ...c, complaints: strings(c.complaints), memories: strings(c.memories), symptoms: cleanMentions(c.symptoms) };
}

/**
 * What a chat reply is built from: the symptoms she mentioned (a fixed reply by level), a complaint
 * the model found without saying which symptom or how much (the fixed level-1 reply), or small talk.
 */
function chatBasis(c: Pick<MessageClassification, "complaints" | "symptoms">): "symptoms" | "complaint" | "talk" {
  const symptoms = c.symptoms ?? [];
  if (symptoms.some((m) => levelFor({ source: "typed", mention: m }).level > 0)) return "symptoms";
  if (symptoms.length === 0 && c.complaints.length > 0) return "complaint";
  return "talk";
}

/** A clarifying tap ("A little" / "A lot") as an amount. */
function clarifyTapOf(text: string): "a_little" | "a_lot" | undefined {
  return (Object.keys(CLARIFY_BUTTONS) as (keyof typeof CLARIFY_BUTTONS)[]).find((k) => is(text, CLARIFY_BUTTONS[k]));
}

/** The labels a clarifying tap stands for on this question, when it has both (ankles, dizziness). */
function clarifyLabels(questionId: string): { a_little: string; a_lot: string } | undefined {
  const aLittle = labelForLevel(questionId, TYPED_LEVELS.a_little.ordinary);
  const aLot = labelForLevel(questionId, TYPED_LEVELS.a_lot.ordinary);
  return aLittle && aLot ? { a_little: aLittle, a_lot: aLot } : undefined;
}

/** The YYYY-MM-DD `days` days before `day`. */
function daysBefore(day: string, days: number): string {
  return new Date(Date.parse(day) - days * 86_400_000).toISOString().slice(0, 10);
}

export function createCheckinEngine(deps: EngineDeps, options: EngineOptions = {}): CheckinEngine {
  const { db, messenger, clock } = deps;
  const missedCheckinTime = options.missedCheckinTime ?? "12:00";
  const followUpDelayMinutes = options.followUpDelayMinutes ?? DEFAULT_FOLLOW_UP_DELAY_MINUTES;
  let rxnav = options.rxnav;
  const rxnavCache = () => (rxnav ??= loadRxNavCache());
  const paperFlow = createPaperFlow({ db, clock, rxnav: rxnavCache });

  /**
   * Send in order. Every send is attempted even if an earlier one fails, so one family
   * chat that refuses a message (say the person blocked the agent) can't hold back the
   * others or her next question. The first failure is rethrown after the rest went out.
   */
  async function deliver(sends: Send[]): Promise<void> {
    const failures: unknown[] = [];
    for (const s of sends) {
      try {
        const sent = await messenger.send(s.chatId, s.message, s.key);
        if (s.prompt) recordCheckinPrompt(db, { messageId: sent.messageId, ...s.prompt, sentAt: clock.now() });
        if (s.followUpId !== undefined) markFollowUpSent(db, s.followUpId, sent.messageId, clock.now());
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, `${failures.length} of ${sends.length} sends failed`);
  }

  // Typed messages (see "Typed messages" above). The LLM and the activity label are best effort:
  // whatever goes wrong there, she still gets the buttons or a fixed reply.

  async function showActivity(chatId: string): Promise<void> {
    try {
      await messenger.setActivity?.(chatId, READING_ACTIVITY);
    } catch {
      // A missing label never holds up her reply.
    }
  }

  async function clearActivity(chatId: string): Promise<void> {
    try {
      await messenger.clearActivity?.(chatId);
    } catch {
      // Relay drops it when its lease runs out anyway.
    }
  }

  /** Ask the LLM about the typed text the first planning pass found. Never throws. */
  async function understand(need: FreeTextNeed | OpenNeed): Promise<Reading> {
    return need.kind === "extract" ? readOpenReply(need) : readTyped(need);
  }

  /**
   * Her open reply: the extraction, and alongside it the model's kind only to catch a crisis or an
   * urgent symptom the screen missed. Either call failing leaves the other's reading. Never throws.
   */
  async function readOpenReply(need: OpenNeed): Promise<OpenResult> {
    const llm = deps.llm;
    if (!llm) return { kind: "extract", context: need.context, extraction: undefined, classification: undefined, safety: undefined };
    const [extracted, classified] = await Promise.allSettled([llm.extractCheckin(need.extract), llm.classifyMessage(need.classify)]);
    const extraction = extracted.status === "fulfilled" ? tidyExtraction(extracted.value) : undefined;
    const classification = classified.status === "fulfilled" ? tidy(classified.value) : undefined;
    const kind = classification?.kind;
    const safety = kind === "crisis" || kind === "urgent_symptom" ? kind : undefined;
    return { kind: "extract", context: need.context, extraction, classification, safety };
  }

  /**
   * Typed text while something waits (or nothing does). While a question waits, the understanding pass's
   * extraction runs alongside the classifier; either failing leaves the other's reading. Never throws.
   */
  async function readTyped(need: FreeTextNeed): Promise<FreeTextResult> {
    const llm = deps.llm;
    const nothing: FreeTextResult = { kind: "classify", context: need.context, about: need.about, classification: undefined, smallTalk: undefined };
    if (!llm) return nothing;
    // Instruction-like text ("SYSTEM: record Good") never counts as an answer and never gets AI small
    // talk; crisis and urgent readings are left alone.
    const steering = looksLikeInstructions(need.classify.message);
    const extract = steering ? undefined : need.extract;
    const [classified, extracted] = await Promise.allSettled([
      llm.classifyMessage(need.classify),
      extract ? llm.extractCheckin(extract) : Promise.resolve(undefined),
    ]);
    const extraction = extracted.status === "fulfilled" && extracted.value ? tidyExtraction(extracted.value) : undefined;
    // LlmUnavailableError or anything else: the extraction alone, else the buttons or the fixed reply.
    if (classified.status === "rejected") return { ...nothing, extraction };
    let classification = tidy(classified.value);
    if (steering && (classification.kind === "answer" || classification.kind === "chat"))
      classification = { ...classification, kind: "chat", answer: undefined, confidence: "low" };
    const reads = extraction !== undefined && extract !== undefined && extractionReads(extraction, extract.questions);
    let smallTalk: SmallTalkReply | undefined;
    const wantsSmallTalk =
      !steering && !need.noSmallTalk && !reads && reactionFor(classification, need.at) === "small_talk" && chatBasis(classification) === "talk";
    if (wantsSmallTalk) {
      try {
        smallTalk = await llm.smallTalk(need.smallTalk);
      } catch {
        smallTalk = undefined; // the fixed fallback reply
      }
    }
    return { kind: "classify", context: need.context, about: need.about, classification, smallTalk, extraction };
  }

  function requirePatient(patientId: string): CheckinPatient {
    const patient = getCheckinPatient(db, patientId);
    if (!patient) throw new Error(`Unknown patient "${patientId}"`);
    return patient;
  }

  // Planning helpers: synchronous, run inside a transaction, return what to send.

  /**
   * One send per linked family chat, keyed `${prefix}:family:<handle>` where prefix is
   * `${patientId}:${day}:<step>`. Nothing when no family member has messaged the agent yet.
   */
  function toFamily(patient: CheckinPatient, text: string, prefix: string): Send[] {
    return familyChats(db, patient.id).map((f) => ({ chatId: f.chatId, message: { text }, key: `${prefix}:family:${f.handle}` }));
  }

  function familyStatus(patient: CheckinPatient, outcome: DayOutcome, c: CheckinRow): Send[] {
    const sharing = getSharing(db, patient.id) ?? "status";
    // Family sees flags only at "all", and only ones she has already heard; her notes only at "all" too.
    const all = sharing === "all";
    const flags = all
      ? openFlags(db, patient.id)
          .filter((f) => f.status === "told" || f.status === "noted")
          .map((f) => ({ message: f.message }))
      : [];
    const notes = all ? checkinNotes(db, c.id).map((n) => ({ questionText: noteHeading(n), text: n.text })) : [];
    // The day's highest level, said in words at "all" ("we're keeping an eye on it").
    const top = all ? highestOfDay(db, patient.id, c.date) : undefined;
    const text = familyDailyStatus({
      seniorName: patient.preferredName,
      sharing,
      outcome,
      answers: c.answers.map(({ questionId, questionText, answer }) => ({ questionId, questionText, answer })),
      flags,
      notes,
      ...(top && top.level > 0 ? { highest: { level: top.level, topic: top.topic } } : {}),
    });
    return toFamily(patient, text, `${patient.id}:${c.date}:status`);
  }

  /** A follow-up check-in `followUpDelayMinutes` from now (level 2 or more), joining one already waiting. */
  function followUpLater(patient: CheckinPatient, c: CheckinRow | undefined, reason: string, level: Level): void {
    const now = clock.now();
    scheduleFollowUp(db, { patientId: patient.id, checkinId: c?.id ?? null, reason, level, createdAt: now, dueAt: plusMinutes(now, followUpDelayMinutes) });
  }

  /**
   * A red flag or a safety hit (level 3 or more): the check-in (if one is pending) remembers it, so no
   * flag is offered that day and the closing changes; a follow-up check-in is scheduled. Returns the
   * check-in's concern time.
   */
  function noteConcern(patient: CheckinPatient, c: CheckinRow | undefined, reason: string, level: Level): string {
    const concernAt = c?.concernAt ?? clock.now();
    if (c && !c.concernAt) updateCheckin(db, c.id, { concernAt });
    followUpLater(patient, c, reason, level);
    return concernAt;
  }

  /** The check-in date an observation belongs to: its check-in's, else the latest check-in's, else the clock's. */
  function dayFor(patientId: string, c?: CheckinRow): string {
    return c?.date ?? latestCheckin(db, patientId)?.date ?? clock.now().slice(0, 10);
  }

  /** What the repetition rule needs: her observations on the last REPETITION.days check-in dates up to `day`. */
  function historyFor(patientId: string, day: string): SeverityHistory {
    return { today: day, observations: observationsBetween(db, patientId, daysBefore(day, REPETITION.days - 1), day) };
  }

  function observe(
    patient: CheckinPatient,
    day: string,
    c: CheckinRow | undefined,
    sev: Pick<Severity, "level" | "topic">,
    detail: { source: ObservationSource; questionId?: string; amount?: string; change?: string; words?: string },
  ): void {
    addObservation(db, { patientId: patient.id, checkinId: c?.id ?? null, day, topic: sev.topic, level: sev.level, createdAt: clock.now(), ...detail });
  }

  /**
   * Level 3: her reply (doctor today, 911 only if it gets much worse, who was told), every family chat
   * alerted (detail at "all"), the concern noted and a follow-up. `moreQuestions`: the check-in's questions still to come.
   */
  function levelThree(
    patient: CheckinPatient,
    c: CheckinRow | undefined,
    reason: string,
    chatId: string,
    key: string,
    detail: { questionText?: string; answer?: string; words?: string },
    moreQuestions = 0,
  ): { sends: Send[]; concernAt: string } {
    const concernAt = noteConcern(patient, c, reason, 3);
    const sharing = getSharing(db, patient.id) ?? "status";
    // Name the family members actually told (display name, else their Relay handle); none linked: no family line.
    const advice = redFlagAdvice(patient.preferredName, familyChats(db, patient.id).map(familyName), moreQuestions);
    return {
      concernAt,
      sends: [{ chatId, message: { text: advice }, key }, ...toFamily(patient, familyRedFlagAlert({ seniorName: patient.preferredName, sharing, ...detail }), key)],
    };
  }

  /** A question as she reads it: its text, and the typing hint under it on her first HINT_CHECKINS check-ins. */
  function questionText(patient: CheckinPatient, c: CheckinRow, q: Question): string {
    return finishedCheckinsBefore(db, patient.id, c.date) < HINT_CHECKINS ? withTypingHint(q.text) : q.text;
  }

  /**
   * What a question's message shows: the question with its buttons, or, when her words suggested an
   * answer on it (a red-flag question), the suggested confirm with "Yes, that's right" first.
   */
  function questionPrompt(patient: CheckinPatient, c: CheckinRow, q: Question): { text: string; buttons: string[] } {
    const s = suggestionFor(c, q.id);
    const phrase = s && answerPhrase(q.id, s.answer);
    if (s && phrase) return { text: suggestedConfirm(phrase), buttons: suggestionButtons(q, s.answer) };
    return { text: questionText(patient, c, q), buttons: promptButtons(q) };
  }

  /**
   * Ask question `index`; `lead` (a level 1 or 2 line, or what was understood) goes before it.
   * `messageId`: the typed message this answers, so asking the same question again is a new send.
   */
  function askQuestion(patient: CheckinPatient, c: CheckinRow, index: number, chatId: string, lead?: string, messageId?: string): Send[] {
    const q = questionById(c.questionIds[index]!);
    updateCheckin(db, c.id, { step: "question", questionIndex: index, explainAt: null });
    const p = questionPrompt(patient, c, q);
    return [
      {
        chatId,
        message: { text: withLead(lead, p.text), buttons: p.buttons },
        key: `${patient.id}:${c.date}:question:${index}${messageId ? `:${messageId}` : ""}`,
        prompt: { checkinId: c.id, step: "question", questionIndex: index },
      },
    ];
  }

  function finishCheckedIn(patient: CheckinPatient, c: CheckinRow, chatId: string, lead?: string): Send[] {
    updateCheckin(db, c.id, { step: "done", pendingFlagId: null, finishedAt: clock.now() });
    // While a follow-up for today is still to come (a concern, or something worth watching), she hears
    // we'll check on her again this afternoon.
    const waiting = nextFollowUp(db, patient.id);
    const followUpComing = waiting !== undefined && (c.concernAt !== null || waiting.checkinId === c.id);
    const text = followUpComing ? checkinDoneAfterConcern(patient.preferredName) : checkinDone(patient.preferredName);
    return [
      { chatId, message: { text: withLead(lead, text), buttons: [SHARING_MENU_BUTTON] }, key: `${patient.id}:${c.date}:done` },
      ...familyStatus(patient, "checked_in", c),
    ];
  }

  function afterLastQuestion(patient: CheckinPatient, c: CheckinRow, chatId: string, lead?: string): Send[] {
    updateCheckin(db, c.id, { status: "answered", explainAt: null });
    // After a red flag or a safety hit, no flag offer that day: one worry at a time.
    const flag = c.concernAt ? undefined : nextFlagToOffer(db, patient.id, c.date);
    if (!flag) return finishCheckedIn(patient, c, chatId, lead);
    markOffered(db, flag.flagId, c.date);
    updateCheckin(db, c.id, { step: "flag_offer", pendingFlagId: Number(flag.flagId) });
    return [
      {
        chatId,
        message: { text: withLead(lead, flagOffer()), buttons: [BUTTON.tellMeMore, BUTTON.later] },
        key: `${patient.id}:${c.date}:flag-offer`,
        prompt: promptFor(c, "flag_offer"),
      },
    ];
  }

  /** The first question she hasn't answered, with `lead` before it; with none left, the end of the check-in. */
  function nextStep(patient: CheckinPatient, c: CheckinRow, chatId: string, lead?: string, messageId?: string): Send[] {
    const next = firstUnanswered(c);
    return next === undefined ? afterLastQuestion(patient, c, chatId, lead) : askQuestion(patient, c, next, chatId, lead, messageId);
  }

  function notToday(patient: CheckinPatient, c: CheckinRow, chatId: string): Send[] {
    updateCheckin(db, c.id, { status: "skipped", step: "done", pendingFlagId: null, finishedAt: clock.now() });
    return [
      { chatId, message: { text: notTodayReply(patient.preferredName) }, key: `${patient.id}:${c.date}:not-today` },
      ...familyStatus(patient, "not_today", c),
    ];
  }

  /**
   * Her answer to the pending question (a tap, or her words mapped to a button), and the reaction its
   * level asks for (see "Severity ladder" above). `mentions`: symptoms the model read in her words.
   * Those about this question may raise its level, never lower it; others (her knee, while she answers
   * about her ankles) are saved and reacted to by their own level.
   */
  function answerQuestion(
    patient: CheckinPatient,
    c: CheckinRow,
    q: Question,
    answer: string,
    chatId: string,
    freeText?: FreeTextAnswer,
    mentions: SymptomMention[] = [],
  ): Send[] {
    const name = patient.preferredName;
    const history = historyFor(patient.id, c.date);
    const button = levelFor({ source: "button", questionId: q.id, label: answer }, history);
    const typed = mentions.map((m) => ({ m, ...levelFor({ source: "typed", mention: m }, history) }));
    const raisedBy = highest(typed.filter((t) => t.topic === q.id && t.level > button.level));
    const own: Severity = raisedBy ? { ...raisedBy, topic: q.id } : button;
    const others = typed.filter((t) => t.topic !== q.id);
    const other = highest(others);
    const level = Math.max(own.level, other?.level ?? 0) as Level;

    // "Noted for your doctor" is said at most once per check-in: not again after a level-1 answer, or
    // after something small she told us earlier in it (her open reply, chat while a question waited).
    const notedBefore =
      c.answers.some((a) => a.level === 1) || observationsBetween(db, patient.id, c.date, c.date).some((o) => o.checkinId === c.id && o.level === 1);
    const stored: StoredAnswer & Partial<FreeTextAnswer> = { questionId: q.id, questionText: q.text, answer, at: clock.now(), level, ...freeText };
    const answers: StoredAnswer[] = [...c.answers, stored];
    const suggestions = withoutSuggestion(c, q.id);
    updateCheckin(db, c.id, { answers, suggestions, ...(q.id === "mood" ? { mood: answer } : {}) });
    const asked = openClarification(db, c.id, q.id);
    if (asked) closeClarification(db, asked.id, answer, clock.now());
    observe(patient, c.date, c, own, {
      source: freeText?.via === "free_text" ? "typed" : "button",
      questionId: q.id,
      ...(raisedBy ? { amount: raisedBy.m.amount, change: raisedBy.m.change } : {}),
      ...(freeText ? { words: freeText.freeText } : {}),
    });
    for (const t of others) observe(patient, c.date, c, t, { source: "typed", amount: t.m.amount, change: t.m.change, words: t.m.words });

    let updated: CheckinRow = { ...c, answers, suggestions };
    const sends: Send[] = [];
    let lead: string | undefined;
    if (level >= 3) {
      const fromAnswer = own.level >= 3;
      const reason = fromAnswer ? q.id : other!.topic;
      const detail = fromAnswer ? { questionText: q.text, answer, ...(freeText ? { words: freeText.freeText } : {}) } : { ...(freeText ? { words: freeText.freeText } : {}) };
      const three = levelThree(patient, c, reason, chatId, `${patient.id}:${c.date}:red-flag:${reason}`, detail, unansweredCount(updated));
      updated = { ...updated, concernAt: three.concernAt };
      sends.push(...three.sends);
    } else if (level === 2) {
      followUpLater(patient, c, own.level === 2 ? q.id : other!.topic, 2);
      lead = keepAnEye(name);
    } else if (level === 1 && q.id === "mood" && own.level === 1) {
      lead = feelingLowReply(name); // "Not great": the warm feeling-low words, not "noted for your doctor"
    } else if (level === 1 && !notedBefore) {
      lead = notedForDoctor(); // once per check-in
    }

    sends.push(...nextStep(patient, updated, chatId, lead));
    return sends;
  }

  /** Her tap on "A little" / "A lot": the question's answer at that amount, with what she typed and any change she described. */
  function answerClarified(patient: CheckinPatient, c: CheckinRow, q: Question, asked: Clarification, amount: "a_little" | "a_lot", chatId: string): Send[] {
    const labels = clarifyLabels(q.id);
    const label = labels?.[amount] ?? q.buttons[0]!;
    const words = asked.words ?? "";
    const mention: SymptomMention = { topic: q.id, questionId: q.id, amount, change: (asked.change ?? "unknown") as Change, words };
    return answerQuestion(patient, c, q, label, chatId, words ? { via: "free_text", freeText: words } : undefined, [mention]);
  }

  /**
   * The one clarifying question: she typed about today's question, the model isn't sure which button,
   * and how much she has of it is unclear in a way that changes the level. Asked once per question of a
   * check-in (never twice); undefined when it doesn't apply.
   */
  function planClarify(patient: CheckinPatient, msg: InboundMessage, c: CheckinRow, q: Question, mentions: SymptomMention[], text: string): Send[] | undefined {
    if (!clarifyLabels(q.id)) return undefined;
    const unclear = mentions.find((m) => topicOf(m) === q.id && needsClarifying(m));
    if (!unclear) return undefined;
    const id = addClarification(db, { patientId: patient.id, checkinId: c.id, questionId: q.id, change: unclear.change, words: text, askedAt: clock.now() });
    if (id === undefined) return undefined;
    return [
      {
        chatId: msg.chatId,
        message: { text: clarifyAmount(patient.preferredName), buttons: [CLARIFY_BUTTONS.a_little, CLARIFY_BUTTONS.a_lot] },
        key: `${patient.id}:${c.date}:clarify:${q.id}`,
        prompt: promptFor(c, "question"),
      },
    ];
  }

  /**
   * Symptoms she mentioned in chat (nothing pending, or chat while a check-in waits): saved, and a fixed
   * reply by the highest level. 1: sorry, noted for her doctor. 2: keep an eye on it, a follow-up later
   * today. 3: the red-flag reply and alert. No reply mentions 911 below 3.
   */
  function planSymptoms(patient: CheckinPatient, msg: InboundMessage, c: CheckinRow | undefined, mentions: SymptomMention[]): Send[] {
    const name = patient.preferredName;
    const day = dayFor(patient.id, c);
    const history = historyFor(patient.id, day);
    const leveled = mentions.map((m) => ({ m, ...levelFor({ source: "typed", mention: m }, history) }));
    for (const t of leveled) observe(patient, day, c, t, { source: "typed", amount: t.m.amount, change: t.m.change, words: t.m.words });
    const top = highest(leveled);
    const key = `${patient.id}:reply:${msg.messageId}`;
    if (!top || top.level === 0) return [];
    if (top.level >= 3) return levelThree(patient, c, top.topic, msg.chatId, `${patient.id}:red-flag:${msg.messageId}`, { words: msg.text.trim() }).sends;
    if (top.level === 2) {
      followUpLater(patient, c, top.topic, 2);
      return [{ chatId: msg.chatId, message: { text: keepAnEyeReply(name) }, key }];
    }
    const topics = leveled.filter((t) => t.level >= 1).map((t) => t.topic);
    return [{ chatId: msg.chatId, message: { text: symptomNotedReply(name, topics) }, key }];
  }

  /** The check-in still waiting for her, if any. */
  function pendingCheckin(patientId: string): CheckinRow | undefined {
    const c = latestCheckin(db, patientId);
    return c && c.finishedAt === null && c.step !== "done" ? c : undefined;
  }

  /** What the check-in's current step shows (text and buttons), or undefined when nothing is waiting. */
  function currentPrompt(patient: CheckinPatient, c: CheckinRow): Prompt | undefined {
    switch (c.step) {
      case "greeting":
        return { step: c.step, text: checkinGreeting(patient.preferredName, c.questionIds.length), buttons: [BUTTON.start, BUTTON.notToday] };
      case "question": {
        const q = questionById(c.questionIds[c.questionIndex]!);
        return { step: c.step, ...questionPrompt(patient, c, q) };
      }
      case "flag_offer":
        return { step: c.step, text: flagOffer(), buttons: [BUTTON.tellMeMore, BUTTON.later] };
      case "flag_detail": {
        const flag = c.pendingFlagId !== null ? getFlag(db, c.pendingFlagId) : undefined;
        return flag ? { step: c.step, text: flagDetail(flag.message), buttons: [BUTTON.willAskDoctor, BUTTON.later] } : undefined;
      }
      case "done":
        return undefined;
    }
  }

  /** Re-send what the check-in is waiting for, after another flow or a reply, so she can carry on. */
  function reprompt(patient: CheckinPatient, chatId: string, messageId: string): Send[] {
    const c = pendingCheckin(patient.id);
    const p = c && currentPrompt(patient, c);
    if (!c || !p) return [];
    return [{ chatId, message: { text: p.text, buttons: p.buttons }, key: `${patient.id}:${c.date}:again:${messageId}`, prompt: promptFor(c, p.step) }];
  }

  /**
   * The day slot of a sharing-change key. A sharing change isn't tied to a check-in, so this is
   * the date of the message itself; the message id after it keeps each change distinct.
   */
  function sharingDay(msg: InboundMessage): string {
    return (msg.at || clock.now()).slice(0, 10);
  }

  /** "Sharing" and a tap on a level. Only her own chat gets here (patientForChat). */
  function planSharing(patient: CheckinPatient, msg: InboundMessage): Send[] | undefined {
    const chatId = msg.chatId;
    if (is(msg.text, SHARING_MENU_BUTTON)) {
      const current = getSharing(db, patient.id);
      return [
        {
          chatId,
          message: { text: sharingMenu(current), buttons: [SHARING_BUTTONS.status, SHARING_BUTTONS.status_vitals, SHARING_BUTTONS.all] },
          key: `${patient.id}:sharing-menu:${msg.messageId}`,
        },
      ];
    }
    // Case-insensitive, like every other button here.
    const level =
      sharingLevelFromButton(msg.text) ?? (Object.keys(SHARING_BUTTONS) as SharingLevel[]).find((l) => is(msg.text, SHARING_BUTTONS[l]));
    if (!level) return undefined;
    const before = getSharing(db, patient.id);
    setSharing(db, patient.id, level);
    return [
      { chatId, message: { text: sharingChangedSenior(level) }, key: `${patient.id}:sharing-changed:${msg.messageId}` },
      // The family hears that it changed, not why; nothing if she picked the level she already had.
      ...(before === level
        ? []
        : toFamily(patient, sharingChangedFamily(patient.preferredName, level), `${patient.id}:${sharingDay(msg)}:sharing-changed:${msg.messageId}`)),
      ...reprompt(patient, chatId, msg.messageId),
    ];
  }

  /**
   * A tap (or reply) on a message other than the one the check-in is waiting on: an earlier
   * question, another day's check-in, or a message that carried no check-in buttons. It must not
   * answer what is pending now. "Not today" from the greeting or any question of the pending
   * check-in is the exception: it still ends the day.
   */
  function isStaleTap(c: CheckinRow, replyTo: string, text: string): boolean {
    const prompt = getCheckinPrompt(db, replyTo);
    if (!prompt || prompt.checkinId !== c.id) return true;
    if (prompt.step === c.step && (c.step !== "question" || prompt.questionIndex === c.questionIndex)) return false;
    return !(is(text, BUTTON.notToday) && (prompt.step === "greeting" || prompt.step === "question"));
  }

  /**
   * The paper check's own buttons. A pending read-back takes "Yes" / "No" whatever else is pending.
   * The R6 follow-up ("I'll ask my doctor" / "Later") goes to the paper check unless the check-in
   * itself is offering a flag, since those buttons belong to that step too; a tap on a message that
   * isn't the check-in's own (the R6 message, say) still goes to the paper check.
   */
  function planPaper(patient: CheckinPatient, msg: InboundMessage, fresh: FreshRecord | undefined): Send[] | undefined {
    const chatId = msg.chatId;
    const to = (sends: PaperSend[]): Send[] => sends.map((s) => ({ chatId, ...s }));
    if (isPaperConfirm(msg.text) || isPaperReject(msg.text)) {
      // "Yes, that's right" on a check-in message is the check-in's suggested confirm, not the paper's.
      if (msg.replyTo && getCheckinPrompt(db, msg.replyTo)) return undefined;
      const scan = pendingReadback(db, patient.id);
      if (!scan) return undefined;
      if (isPaperReject(msg.text)) return [...to(paperFlow.reject(patient.id, scan)), ...reprompt(patient, chatId, msg.messageId)];
      if (!fresh) return undefined; // the read-back appeared after the snapshot check; can't happen in one process
      const { sends, done } = paperFlow.confirm(patient.id, scan, fresh);
      return [...to(sends), ...(done ? reprompt(patient, chatId, msg.messageId) : [])];
    }
    if (isPaperFollowUp(msg.text)) {
      const c = pendingCheckin(patient.id);
      const forCheckin = c && (c.step === "flag_offer" || c.step === "flag_detail") && !(msg.replyTo && isStaleTap(c, msg.replyTo, msg.text));
      if (forCheckin) return undefined;
      const scan = pendingPaperFollowUp(db, patient.id);
      if (!scan) return undefined;
      return [...to(paperFlow.followUp(patient.id, scan, msg.text)), ...reprompt(patient, chatId, msg.messageId)];
    }
    return undefined;
  }

  // Follow-up check-ins (src/db/follow-ups.ts).

  /**
   * "Better" / "About the same" / "Worse": a tap on the follow-up (or on a message repeating its
   * buttons), or the label typed while one waits. A second tap on an answered follow-up does nothing.
   */
  function planFollowUpTap(patient: CheckinPatient, msg: InboundMessage): Send[] | undefined {
    const answer = followUpAnswerOf(msg.text);
    const tapped = msg.replyTo ? followUpForMessage(db, msg.replyTo) : undefined;
    const own = tapped && tapped.patientId === patient.id ? tapped : undefined;
    if (!answer) return undefined;
    if (own?.answeredAt) return [];
    const f = own ?? openFollowUp(db, patient.id);
    if (!f) return undefined;
    return planFollowUpAnswer(patient, f, answer, msg);
  }

  /**
   * Her answer to a follow-up, levelled like anything else: Better 0 (a warm close), About the same
   * keeps the earlier level at most 2 (keep an eye on it), Worse at least 3 (her doctor today and an
   * alert to every family chat; 911 now after an urgent symptom, 988 after a crisis).
   */
  function planFollowUpAnswer(patient: CheckinPatient, f: FollowUpRow, answer: FollowUpAnswer, msg: InboundMessage): Send[] {
    if (!answerFollowUp(db, f.id, FOLLOW_UP_BUTTONS[answer], clock.now())) return [];
    const name = patient.preferredName;
    const topic = followUpTopic(f.reason);
    const sharing = getSharing(db, patient.id) ?? "status";
    const key = `${patient.id}:follow-up:${f.id}:answer`;
    const names = familyChats(db, patient.id).map(familyName);
    const sev = levelFor({ source: "follow_up", answer, priorLevel: (f.level ?? LEGACY_FOLLOW_UP_LEVEL) as Level });
    const c = f.checkinId !== null ? getCheckinById(db, f.checkinId) : undefined;
    observe(patient, dayFor(patient.id, c), c, { level: sev.level, topic: f.reason }, { source: "follow_up" });
    const worse = topic === "crisis" ? crisisReply(name, names) : sev.level >= 4 ? urgentReply(name, names) : redFlagAdvice(name, names);
    const sends: Send[] =
      answer === "worse"
        ? [
            { chatId: msg.chatId, message: { text: worse }, key },
            ...toFamily(patient, familyFollowUpWorse({ seniorName: name, sharing, topic }), key),
          ]
        : [
            { chatId: msg.chatId, message: { text: followUpReply(name, answer, topic) }, key },
            // The family hears how she is doing only at "all"; below it they already had the alert.
            ...(sharing === "all" ? toFamily(patient, familyFollowUpUpdate({ seniorName: name, topic, answer }), key) : []),
          ];
    return [...sends, ...reprompt(patient, msg.chatId, msg.messageId)];
  }

  // Typed messages (see "Typed messages" above).

  /** A crisis or urgent symptom, from the safety screen or the model. */
  function planSafety(patient: CheckinPatient, msg: InboundMessage, kind: SafetyKind): Send[] {
    const name = patient.preferredName;
    const sharing = getSharing(db, patient.id) ?? "status";
    const names = familyChats(db, patient.id).map(familyName);
    const words = msg.text.trim();
    // The check-in pauses: nothing more is asked in this reply, no flag offer today.
    const c = pendingCheckin(patient.id);
    const sev = levelFor({ source: "safety", kind });
    noteConcern(patient, c, kind, sev.level);
    observe(patient, dayFor(patient.id, c), c, sev, { source: "safety" });
    const key = `${patient.id}:safety:${msg.messageId}`;
    const reply = kind === "crisis" ? crisisReply(name, names) : urgentReply(name, names);
    const alert = kind === "crisis" ? familyCrisisAlert({ seniorName: name, sharing, words }) : familyUrgentAlert({ seniorName: name, sharing, words });
    return [{ chatId: msg.chatId, message: { text: reply }, key }, ...toFamily(patient, alert, key)];
  }

  /** The buttons waiting for her answer when she typed (none with nothing pending); a question's include "Let me explain". */
  function buttonsOf(ctx: TypedContext): string[] {
    switch (ctx.at) {
      case "question":
        return promptButtons(ctx.q);
      case "step":
        return [...ctx.prompt.buttons];
      case "follow_up":
        return [...FOLLOW_UP_LABELS];
      case "none":
        return [];
    }
  }

  /** The answers among the pending buttons: what her words can be matched to, and what a reply lists. */
  function answersOf(ctx: TypedContext): string[] {
    return ctx.at === "question" ? [...ctx.q.buttons] : buttonsOf(ctx);
  }

  /** A reply carrying the pending buttons, remembered as that step's prompt so a tap on it answers it. */
  function withButtons(patient: CheckinPatient, ctx: TypedContext, msg: InboundMessage, text: string, slot: string): Send {
    const key = `${patient.id}:${slot}:${msg.messageId}`;
    const message = { text, ...(ctx.at === "none" ? {} : { buttons: buttonsOf(ctx) }) };
    if (ctx.at === "question") return { chatId: msg.chatId, message, key: `${patient.id}:${ctx.c.date}:${slot}:${msg.messageId}`, prompt: promptFor(ctx.c, "question") };
    if (ctx.at === "step") return { chatId: msg.chatId, message, key: `${patient.id}:${ctx.c.date}:${slot}:${msg.messageId}`, prompt: promptFor(ctx.c, ctx.prompt.step) };
    return { chatId: msg.chatId, message, key };
  }

  /** After a reply that isn't an answer: the check-in's step again (a follow-up's buttons are still on it). */
  function again(patient: CheckinPatient, ctx: TypedContext, msg: InboundMessage): Send[] {
    return ctx.at === "question" || ctx.at === "step" ? reprompt(patient, msg.chatId, msg.messageId) : [];
  }

  /** The ClassifyInput's pending question: what she saw and its buttons. */
  function pendingFor(ctx: TypedContext, name: string): ClassifyInput["pending"] {
    switch (ctx.at) {
      case "question":
        return { question: ctx.q.text, options: [...ctx.q.buttons] };
      case "step":
        return { question: ctx.prompt.text, options: [...ctx.prompt.buttons] };
      case "follow_up":
        return { question: followUpQuestion(name, followUpTopic(ctx.f.reason)), options: [...FOLLOW_UP_LABELS] };
      case "none":
        return undefined;
    }
  }

  function saveNote(patient: CheckinPatient, about: NoteTarget, text: string): void {
    addCheckinNote(db, { patientId: patient.id, ...about, text, createdAt: clock.now() });
  }

  /** Complaints the model found without saying which symptom or how much: saved at level 1 for her doctor (complaintReply). */
  function noteComplaints(patient: CheckinPatient, ctx: TypedContext, complaints: string[]): void {
    const c = ctx.at === "question" || ctx.at === "step" ? ctx.c : pendingCheckin(patient.id);
    const day = dayFor(patient.id, c);
    for (const words of complaints)
      observe(patient, day, c, { level: 1, topic: topicOf({ topic: words }) }, { source: "typed", amount: "unknown", change: "unknown", words });
  }

  /**
   * Typed text that isn't a label of what is pending. See "Typed messages" above.
   * `understood` is the LLM's reading from handleInbound; without it (and with an LLM) this asks for one.
   */
  function planTyped(patient: CheckinPatient, msg: InboundMessage, ctx: TypedContext, understood: FreeTextResult | undefined): Planned {
    const name = patient.preferredName;
    const text = msg.text.trim();
    if (!text) return { sends: ctx.at === "none" ? [] : [withButtons(patient, ctx, msg, didntUnderstand(answersOf(ctx)), "didnt-understand")] };
    // A plain yes to a suggested confirm ("It sounds like ... Is that right?") is her "Yes, that's right":
    // a fixed rule, no LLM. More than a plain yes is read as usual.
    const suggested = ctx.at === "question" ? suggestionFor(ctx.c, ctx.q.id) : undefined;
    if (ctx.at === "question" && suggested && isPlainYes(text)) return { sends: confirmSuggestion(patient, ctx.c, ctx.q, suggested, msg.chatId) };
    const redFlagYes = ctx.at === "question" ? explicitYesAnswer(ctx.q, text) : undefined;
    const context = contextKey(ctx);
    const here: NoteTarget | undefined = ctx.at === "question" ? { checkinId: ctx.c.id, questionId: ctx.q.id } : undefined;
    if (deps.llm && understood === undefined) {
      return {
        needs: {
          kind: "classify",
          context,
          at: ctx.at,
          about: here,
          noSmallTalk: redFlagYes !== undefined,
          classify: { seniorName: name, message: text, pending: pendingFor(ctx, name) },
          smallTalk: { seniorName: name, message: text, memories: recentMemories(db, patient.id, SMALL_TALK_MEMORIES) },
          // The understanding pass, while a question waits (an explicit yes on a red-flag question needs none).
          ...(ctx.at === "question" && redFlagYes === undefined
            ? { extract: { seniorName: name, message: text, questions: unansweredForExtraction(ctx.c), answeringNow: ctx.c.questionIds[ctx.c.questionIndex] } }
            : {}),
        },
      };
    }
    // Read against what was pending then. If that changed meanwhile, an answer to it doesn't count
    // (an explicit yes included), and detail is noted on the question she was writing about.
    const stale = understood !== undefined && understood.context !== context;
    const about = understood ? understood.about : here;
    const cls = understood?.classification;
    // After "Let me explain", this message is her explanation of the question: whatever can't be matched
    // to an answer is kept as a note for her doctor. The mark is used up by this message.
    const explaining = ctx.at === "question" && ctx.c.explainAt !== null && !stale;
    if (ctx.at === "question" && ctx.c.explainAt !== null) updateCheckin(db, ctx.c.id, { explainAt: null });
    const noted = (): Send[] => {
      if (about) saveNote(patient, about, text);
      return [withButtons(patient, ctx, msg, noteSaved(name), "note")];
    };

    if (cls?.kind === "crisis" || cls?.kind === "urgent_symptom") return { sends: planSafety(patient, msg, cls.kind) };
    if (cls) addMemories(db, patient.id, [...cls.memories, ...cls.complaints], clock.now());

    // An explicit yes on a red-flag question is her "Yes": a fixed rule, with or without the LLM.
    if (ctx.at === "question" && redFlagYes !== undefined && !stale) {
      saveNote(patient, { checkinId: ctx.c.id, questionId: ctx.q.id }, text);
      return { sends: answerQuestion(patient, ctx.c, ctx.q, redFlagYes, msg.chatId, { via: "free_text", freeText: text }) };
    }

    // The understanding pass: what her words told us about any of today's unanswered questions and any
    // symptom, applied at once, then what was understood said back before the next question.
    const extraction = ctx.at === "question" && !stale ? understood?.extraction : undefined;
    if (ctx.at === "question" && extraction) {
      addMemories(db, patient.id, extraction.memories, clock.now());
      const label = cls?.kind === "answer" && confident(cls) ? ctx.q.buttons.find((b) => is(cls.answer ?? "", b)) : undefined;
      const u = understandWords(patient, ctx.c, extraction, text, { id: ctx.q.id, label });
      if (u.understood) return { sends: applyUnderstanding(patient, msg, ctx.c, u, text, cls) };
    }
    // Nothing understood: the classifier's reading alone, as before. Its replies show the question's own
    // buttons, so a suggestion waiting on it is dropped.
    if (ctx.at === "question" && suggestionFor(ctx.c, ctx.q.id)) updateCheckin(db, ctx.c.id, { suggestions: withoutSuggestion(ctx.c, ctx.q.id) });

    // No LLM, or it failed: our trouble, so say so and offer the buttons; nothing pending, the fixed reply.
    // Her explanation after "Let me explain" is still kept for her doctor.
    if (!cls) {
      if (explaining) return { sends: noted() };
      if (ctx.at === "none") return { sends: [{ chatId: msg.chatId, message: { text: smallTalkFallback(name) }, key: `${patient.id}:small-talk:${msg.messageId}` }] };
      return { sends: [withButtons(patient, ctx, msg, typedReplyUnavailable(answersOf(ctx)), "typed-unavailable")] };
    }

    const reply = (t: string): Send => ({ chatId: msg.chatId, message: { text: t }, key: `${patient.id}:reply:${msg.messageId}` });
    const didnt = (): Send[] => (explaining ? noted() : [withButtons(patient, ctx, msg, didntUnderstand(answersOf(ctx)), "didnt-understand")]);

    switch (reactionFor(cls, ctx.at)) {
      case "crisis":
      case "urgent_symptom":
        return { sends: planSafety(patient, msg, cls.kind as SafetyKind) }; // handled above; kept for completeness
      case "answer":
        return { sends: planTypedAnswer(patient, msg, ctx, stale ? undefined : cls, text, didnt) };
      case "note": {
        if (!about) return { sends: didnt() };
        saveNote(patient, about, text);
        return { sends: [withButtons(patient, ctx, msg, noteSaved(name), "note")] };
      }
      case "medicine_question":
        addVisitQuestion(db, { patientId: patient.id, text, createdAt: clock.now() });
        return { sends: [reply(medicineQuestionReply(name)), ...again(patient, ctx, msg)] };
      case "feeling_low":
        addMemories(db, patient.id, [text], clock.now());
        return { sends: [reply(feelingLowReply(name)), ...again(patient, ctx, msg)] };
      case "family_message":
        return { sends: [...planFamilyRelay(patient, msg, text), ...again(patient, ctx, msg)] };
      case "small_talk": {
        const talk = understood?.smallTalk;
        if (talk) addMemories(db, patient.id, [...talk.memories, ...talk.complaints], clock.now());
        const basis = chatBasis(cls);
        // Symptoms she mentioned: a fixed reply by level (see "Severity ladder" above), never the model's words.
        if (basis === "symptoms") {
          const c = ctx.at === "question" || ctx.at === "step" ? ctx.c : pendingCheckin(patient.id);
          if (explaining && about) saveNote(patient, about, text);
          return { sends: [...planSymptoms(patient, msg, c, cls.symptoms ?? []), ...again(patient, ctx, msg)] };
        }
        if (explaining) return { sends: noted() };
        const complaints = basis === "complaint" ? cls.complaints : (talk?.complaints ?? []);
        if (complaints.length > 0) noteComplaints(patient, ctx, complaints);
        const said = complaints.length > 0 ? complaintReply(name) : talk ? checkedSmallTalk(talk.text) : undefined;
        if (said === undefined && ctx.at !== "none")
          return { sends: [withButtons(patient, ctx, msg, typedReplyUnavailable(answersOf(ctx)), "typed-unavailable")] };
        return { sends: [reply(said ?? smallTalkFallback(name)), ...again(patient, ctx, msg)] };
      }
      case "didnt_understand":
        return { sends: didnt() };
    }
  }

  /** The model says she answered what is pending. `cls` undefined: its reading no longer applies. */
  function planTypedAnswer(
    patient: CheckinPatient,
    msg: InboundMessage,
    ctx: TypedContext,
    cls: MessageClassification | undefined,
    text: string,
    didnt: () => Send[],
  ): Send[] {
    if (!cls) return didnt();
    const label = confident(cls) ? answersOf(ctx).find((b) => is(cls.answer ?? "", b)) : undefined;
    switch (ctx.at) {
      case "question": {
        const { c, q } = ctx;
        if (q.redFlagAnswers.length > 0) {
          // Never recorded from the model: her words are kept, and she gets the question again with its
          // buttons (a tap on this message answers it, through the normal red-flag rule).
          saveNote(patient, { checkinId: c.id, questionId: q.id }, text);
          return [withButtons(patient, ctx, msg, freeTextConfirm(text, q.text), "free-text-confirm")];
        }
        const mentions = cls.symptoms ?? [];
        if (label === undefined) return planClarify(patient, msg, c, q, mentions, text) ?? didnt();
        return answerQuestion(patient, c, q, label, msg.chatId, { via: "free_text", freeText: text }, mentions);
      }
      case "step": {
        if (label === undefined) return didnt();
        return planOtherStep(patient, ctx.c, { ...msg, text: label }) ?? didnt();
      }
      case "follow_up": {
        const answer = label === undefined ? undefined : followUpAnswerOf(label);
        if (answer === undefined) return didnt();
        return planFollowUpAnswer(patient, ctx.f, answer, msg);
      }
      case "none":
        return [];
    }
  }

  /**
   * She asked for something to be passed on to her family: her own message, as she typed it (the
   * model's shortened version can read oddly), to every linked family chat. With none linked it is
   * kept, and passed on when one is (passOnFamilyMessages).
   */
  function planFamilyRelay(patient: CheckinPatient, msg: InboundMessage, text: string): Send[] {
    const words = text.length > MAX_FAMILY_RELAY ? `${text.slice(0, MAX_FAMILY_RELAY).trimEnd()}...` : text;
    const family = familyChats(db, patient.id);
    const now = clock.now();
    const id = addFamilyRelay(db, { patientId: patient.id, text: words, createdAt: now, passedOnAt: family.length > 0 ? now : null });
    const key = `${patient.id}:reply:${msg.messageId}`;
    if (family.length === 0) return [{ chatId: msg.chatId, message: { text: familyRelayWaiting(patient.preferredName) }, key }];
    return [
      ...toFamily(patient, familyRelay(patient.preferredName, words), `${patient.id}:family-relay:${id}`),
      { chatId: msg.chatId, message: { text: familyRelayDone(patient.preferredName, family.map(familyName)) }, key },
    ];
  }

  /**
   * Plan one inbound message. Asking for the LLM (`needs`) happens before anything is written,
   * so the message stays unhandled until the pass that has the LLM's answer.
   */
  function planInbound(msg: InboundMessage, fresh: FreshRecord | undefined, understood?: Reading): Planned {
    const patient = patientForChat(db, msg.chatId);
    if (!patient) return { sends: [] };
    if (inboundSeen(db, msg.messageId)) return { sends: [] };
    const planned = routeInbound(patient, msg, fresh, understood);
    if (!("needs" in planned)) markInboundHandled(db, msg.messageId, msg.chatId, clock.now());
    return planned;
  }

  function routeInbound(patient: CheckinPatient, msg: InboundMessage, fresh: FreshRecord | undefined, understood: Reading | undefined): Planned {
    // 1. The safety screen, before anything else: a hit wins even mid-question.
    const hit = screenMessage(msg.text);
    if (hit) return { sends: planSafety(patient, msg, hit.kind) };

    // 2. Buttons that live outside the check-in.
    const outside = planSharing(patient, msg) ?? planPaper(patient, msg, fresh) ?? planFollowUpTap(patient, msg);
    if (outside) return { sends: outside };

    const typed = understood?.kind === "classify" ? understood : undefined;
    const c = pendingCheckin(patient.id);
    // Her open reply was read, but the greeting it answered isn't waiting any more (she tapped while the
    // model read): a crisis or urgent reading still wins; otherwise only her memories are kept.
    if (understood?.kind === "extract" && !(c && c.step === "greeting" && understood.context === openContext(c))) {
      if (understood.safety) return { sends: planSafety(patient, msg, understood.safety) };
      if (understood.extraction && !looksLikeInstructions(msg.text)) addMemories(db, patient.id, understood.extraction.memories, clock.now());
      return { sends: [] };
    }

    // Typed text swiped as a reply to a follow-up that waits: about the follow-up.
    const onFollowUp = msg.replyTo ? followUpForMessage(db, msg.replyTo) : undefined;
    if (onFollowUp && onFollowUp.patientId === patient.id && !onFollowUp.answeredAt)
      return planTyped(patient, msg, { at: "follow_up", f: onFollowUp }, typed);

    if (!c) {
      // Nothing pending: a late tap (one of our labels) or a paper check waiting for her is left alone.
      if (isButtonLabel(msg.text) || pendingReadback(db, patient.id) || pendingPaperFollowUp(db, patient.id)) return { sends: [] };
      const f = openFollowUp(db, patient.id);
      return planTyped(patient, msg, f ? { at: "follow_up", f } : { at: "none" }, typed);
    }
    const chatId = msg.chatId;
    const text = msg.text;
    // A tap on an old message re-sends what is pending instead of answering it.
    if (msg.replyTo !== undefined && isStaleTap(c, msg.replyTo, text)) return { sends: reprompt(patient, chatId, msg.messageId) };

    if (c.step === "question") {
      if (isNotToday(text)) return { sends: notToday(patient, c, chatId) };
      const q = questionById(c.questionIds[c.questionIndex]!);
      // "Let me explain": she'll tell it in her own words; her next message is about this question.
      if (offersExplain(q.id) && is(text, LET_ME_EXPLAIN)) return { sends: planExplain(patient, c, chatId, msg.messageId) };
      // "Yes, that's right" on a suggested confirm: the answer her words suggested. With none waiting, the prompt again.
      if (is(text, SUGGESTION_YES)) {
        const suggested = suggestionFor(c, q.id);
        return { sends: suggested ? confirmSuggestion(patient, c, q, suggested, chatId) : reprompt(patient, chatId, msg.messageId) };
      }
      // Her tap on "A little, or a lot?" sets the level of what she typed about this question.
      const asked = openClarification(db, c.id, q.id);
      const amount = asked ? clarifyTapOf(text) : undefined;
      if (asked && amount) return { sends: answerClarified(patient, c, q, asked, amount, chatId) };
      const answer = q.buttons.find((b) => is(text, b));
      if (answer === undefined) return planTyped(patient, msg, { at: "question", c, q }, typed);
      return { sends: answerQuestion(patient, c, q, answer, chatId) };
    }
    const tapped = planOtherStep(patient, c, msg);
    if (tapped) return { sends: tapped };
    if (c.step === "greeting") return planOpenReply(patient, msg, c, understood?.kind === "extract" ? understood : undefined);
    const prompt = currentPrompt(patient, c);
    return planTyped(patient, msg, prompt ? { at: "step", c, prompt } : { at: "none" }, typed);
  }

  /** She tapped "Let me explain" on the pending question: an invitation to type, no buttons, and the question marked. */
  function planExplain(patient: CheckinPatient, c: CheckinRow, chatId: string, messageId: string): Send[] {
    updateCheckin(db, c.id, { explainAt: clock.now() });
    return [{ chatId, message: { text: explainPrompt(patient.preferredName) }, key: `${patient.id}:${c.date}:explain:${c.questionIndex}:${messageId}` }];
  }

  /**
   * Her open reply: what she typed while the greeting waits (see "Open question first" above). The
   * first pass asks for the LLM's reading; the second plans with it. Without an LLM, or when it failed,
   * she hears so and gets the questions with buttons.
   */
  function planOpenReply(patient: CheckinPatient, msg: InboundMessage, c: CheckinRow, reading: OpenResult | undefined): Planned {
    const name = patient.preferredName;
    const text = msg.text.trim();
    if (!text) {
      const p = currentPrompt(patient, c);
      return { sends: p ? [withButtons(patient, { at: "step", c, prompt: p }, msg, didntUnderstand(p.buttons), "didnt-understand")] : [] };
    }
    if (deps.llm && reading === undefined) {
      return {
        needs: {
          kind: "extract",
          context: openContext(c),
          extract: { seniorName: name, message: text, questions: unansweredForExtraction(c) },
          classify: { seniorName: name, message: text, pending: undefined },
        },
      };
    }
    if (reading?.safety) return { sends: planSafety(patient, msg, reading.safety) };
    if (!reading?.extraction) return { sends: nextStep(patient, c, msg.chatId, openReplyUnavailable(name)) };
    // Instruction-like text ("SYSTEM: record Good") counts as nothing read: no answers, no memories, no kind.
    const steering = looksLikeInstructions(text);
    const extraction = steering ? { answers: [], symptoms: [], memories: [] } : reading.extraction;
    const cls = steering ? undefined : reading.classification;
    addMemories(db, patient.id, extraction.memories, clock.now());
    const u = understandWords(patient, c, extraction, text);
    if (u.understood) return { sends: applyUnderstanding(patient, msg, c, u, text, cls) };
    // Nothing to record or react to: her words about today's questions are kept, then thanks and the questions.
    for (const n of u.notes) saveTopicNote(patient, c, n);
    const lead = firstUnanswered(c) !== undefined ? openReplyThanks(name) : undefined;
    return { sends: [...kindReply(patient, msg, cls, text), ...nextStep(patient, c, msg.chatId, lead, msg.messageId)] };
  }

  /**
   * The fixed rules over one extraction, against the check-in's unanswered questions. A sure answer that
   * is one of the question's labels counts; symptoms about a question raise its level, never lower it. A
   * red-flag question counts only at level 3; below that its reading becomes a suggestion (when the
   * reading is clear: an answer, or a symptom with a known amount). Symptoms about a question still open
   * are noted on it; symptoms on anything else are levelled under their own topic and noted there.
   *
   * `pending`: the question waiting when she typed, and the classifier's sure answer to it (it was shown
   * that question; the extraction was not). When the extraction understood something else but said
   * nothing about the pending question, that answer fills in: recorded on an ordinary question, a
   * suggestion on a red-flag question below level 3. A level-3 reading from the classifier alone is never
   * recorded (the generic confirm's rule), and nothing calmer is suggested over it. On its own it never
   * counts as understood: then the classifier's usual reactions apply. Her words on a suggestion on the
   * pending question are kept as a note on it when the message told us nothing else.
   */
  function understandWords(
    patient: CheckinPatient,
    c: CheckinRow,
    x: CheckinExtraction,
    text: string,
    pending?: { id: string; label: string | undefined },
  ): Understanding {
    const history = historyFor(patient.id, c.date);
    const done = new Set(c.answers.map((a) => a.questionId));
    const open = c.questionIds.filter((id) => !done.has(id)).map(questionById);
    const mentions = cleanMentions(x.symptoms).filter((m) => m.amount !== "none");
    const wordsOf = (ms: SymptomMention[]) => ms.map((m) => m.words).filter(Boolean).join("; ");
    const buttonLevel = (q: Question, label: string) => levelFor({ source: "button", questionId: q.id, label }, history);

    const picked = new Map<string, string>();
    for (const a of x.answers) {
      const q = open.find((t) => t.id === a.questionId);
      if (!q || picked.has(q.id) || !confident(a)) continue;
      const label = q.buttons.find((b) => is(a.answer, b));
      if (label !== undefined) picked.set(q.id, label);
    }

    const u: Understanding = { recorded: [], suggested: [], notes: [], others: [], understood: false };
    let byClassifierOnly: Question | undefined;
    for (const q of open) {
      const mine = mentions.filter((m) => topicOf(m) === q.id);
      const typed = mine.map((m) => ({ m, ...levelFor({ source: "typed", mention: m }, history) }));
      const extracted = picked.get(q.id);
      // The classifier's answer, only where the extraction said nothing about this question.
      const fallback = pending?.id === q.id && extracted === undefined && mine.length === 0 ? pending.label : undefined;
      const note = (): void => {
        if (mine.length > 0) u.notes.push({ questionId: q.id, topic: q.id, words: wordsOf(mine) || text });
      };
      if (q.redFlagAnswers.length > 0) {
        const button = extracted === undefined ? undefined : buttonLevel(q, extracted);
        const level = Math.max(button?.level ?? 0, ...typed.map((t) => t.level));
        if (level >= 3) {
          // The model may raise a red flag, never clear one: level 3 counts straight away.
          const answer = extracted !== undefined && q.redFlagAnswers.some((r) => is(r, extracted)) ? extracted : q.redFlagAnswers[0]!;
          const raisedBy = (button?.level ?? 0) >= 3 ? undefined : highest(typed.filter((t) => t.level >= 3));
          const own: Severity = raisedBy ? { ...raisedBy, topic: q.id } : buttonLevel(q, answer);
          u.recorded.push({ q, label: answer, own, raisedBy: raisedBy?.m, words: wordsOf(mine) || text });
          continue;
        }
        note();
        // Below 3 it is never recorded from her words: a suggestion for her tap, when the reading is clear.
        const classified = pending?.id === q.id && pending.label !== undefined ? buttonLevel(q, pending.label).level : undefined;
        if (classified !== undefined && classified >= 3) continue; // the classifier reads more: she gets the question itself
        const clear = extracted !== undefined || mine.some((m) => m.amount !== "unknown");
        const answer = clear ? (labelForLevel(q.id, level as Level) ?? extracted) : fallback;
        if (answer === undefined || answerPhrase(q.id, answer) === undefined) continue;
        u.suggested.push({ q, answer });
        if (!clear) byClassifierOnly = q;
        continue;
      }
      const label = extracted ?? fallback;
      if (label === undefined) {
        note(); // asked with buttons next; what she said about it is kept for her doctor
        continue;
      }
      const button = buttonLevel(q, label);
      const raisedBy = highest(typed.filter((t) => t.level > button.level));
      const own: Severity = raisedBy ? { ...raisedBy, topic: q.id } : button;
      u.recorded.push({ q, label, own, raisedBy: raisedBy?.m, words: wordsOf(mine) || text });
      if (extracted === undefined) byClassifierOnly = q;
    }
    // Symptoms on anything else (her back, or a question she already answered): their own topic.
    const openIds = new Set(open.map((q) => q.id));
    for (const m of mentions.filter((x) => !openIds.has(topicOf(x)))) {
      const sev = levelFor({ source: "typed", mention: m }, history);
      u.others.push({ m, sev });
      u.notes.push({ questionId: c.questionIds.includes(sev.topic) ? sev.topic : null, topic: sev.topic, words: m.words || text });
    }
    const onlySuggested = u.recorded.length === 0 && u.others.length === 0 && u.suggested.length === 1;
    const id = pending?.id;
    if (id !== undefined && onlySuggested && u.suggested[0]!.q.id === id && !u.notes.some((n) => n.questionId === id))
      u.notes.push({ questionId: id, topic: id, words: text });
    // What the classifier alone filled in doesn't make the message understood.
    u.understood = u.recorded.length + u.suggested.length + u.others.length - (byClassifierOnly ? 1 : 0) > 0;
    return u;
  }

  /**
   * Apply what one typed message told us: notes, answers and observations saved, suggestions kept for her
   * tap, a follow-up for anything worth watching. Then ONE reply: her kind of message's fixed reply if it
   * has one (a medicine question, a message for her family, feeling low), and level 3's own messages, or
   * the line that says back what was understood, before the first question she hasn't answered (or the
   * end of the check-in).
   */
  function applyUnderstanding(patient: CheckinPatient, msg: InboundMessage, c: CheckinRow, u: Understanding, text: string, cls: MessageClassification | undefined): Send[] {
    const now = clock.now();
    const sends: Send[] = [...kindReply(patient, msg, cls, text)];
    for (const n of u.notes) saveTopicNote(patient, c, n);
    const answers: StoredAnswer[] = [...c.answers];
    const suggestions: Record<string, Suggestion> = { ...c.suggestions };
    let mood: string | undefined;
    for (const r of u.recorded) {
      const stored: StoredAnswer & FreeTextAnswer = { questionId: r.q.id, questionText: r.q.text, answer: r.label, at: now, level: r.own.level, via: "free_text", freeText: text };
      answers.push(stored);
      delete suggestions[r.q.id];
      if (r.q.id === "mood") mood = r.label;
      const asked = openClarification(db, c.id, r.q.id);
      if (asked) closeClarification(db, asked.id, r.label, now);
      observe(patient, c.date, c, r.own, {
        source: "typed",
        questionId: r.q.id,
        ...(r.raisedBy ? { amount: r.raisedBy.amount, change: r.raisedBy.change } : {}),
        words: r.words,
      });
    }
    for (const s of u.suggested) suggestions[s.q.id] = { answer: s.answer, words: text };
    for (const o of u.others) observe(patient, c.date, c, o.sev, { source: "typed", amount: o.m.amount, change: o.m.change, words: o.m.words });
    updateCheckin(db, c.id, { answers, suggestions, ...(mood !== undefined ? { mood } : {}) });
    let updated: CheckinRow = { ...c, answers, suggestions, ...(mood !== undefined ? { mood } : {}) };

    type Told = UnderstoodItem & { words: string; q?: Question };
    const told: Told[] = [
      ...u.recorded.map((r): Told => ({ topic: r.q.id, level: r.own.level, answer: r.label, words: r.words, q: r.q })),
      ...u.others.map((o): Told => ({ topic: o.sev.topic, level: o.sev.level, words: o.m.words })),
    ];
    // Each thing worth watching asks for a follow-up, as a tap would (several join into one).
    for (const t of told) if (t.level === 2) followUpLater(patient, updated, t.topic, 2);
    const top = highest(told);
    let lead: string | undefined;
    if (top && top.level >= 3) {
      const detail = top.q && top.answer !== undefined ? { questionText: top.q.text, answer: top.answer, words: text } : { words: top.words || text };
      const three = levelThree(patient, updated, top.topic, msg.chatId, `${patient.id}:${c.date}:red-flag:${top.topic}`, detail, unansweredCount(updated));
      updated = { ...updated, concernAt: three.concernAt };
      sends.push(...three.sends);
    } else {
      lead = understoodLine(told);
    }
    sends.push(...nextStep(patient, updated, msg.chatId, lead, msg.messageId));
    return sends;
  }

  /** Her tap on "Yes, that's right" (or a plain typed yes) on a suggested confirm: the suggested answer, her words kept. */
  function confirmSuggestion(patient: CheckinPatient, c: CheckinRow, q: Question, s: Suggestion, chatId: string): Send[] {
    return answerQuestion(patient, c, q, s.answer, chatId, { via: "confirmed", freeText: s.words });
  }

  /** The fixed reply for her kind of message, if it has one: a medicine question, a message for her family, feeling low. */
  function kindReply(patient: CheckinPatient, msg: InboundMessage, cls: MessageClassification | undefined, text: string): Send[] {
    const kind: MessageKind | undefined = cls?.kind;
    const reply = (t: string): Send => ({ chatId: msg.chatId, message: { text: t }, key: `${patient.id}:reply:${msg.messageId}` });
    switch (kind) {
      case "medicine_question":
        addVisitQuestion(db, { patientId: patient.id, text, createdAt: clock.now() });
        return [reply(medicineQuestionReply(patient.preferredName))];
      case "feeling_low":
        addMemories(db, patient.id, [text], clock.now());
        return [reply(feelingLowReply(patient.preferredName))];
      case "family_message":
        return planFamilyRelay(patient, msg, text);
      default:
        return [];
    }
  }

  function saveTopicNote(patient: CheckinPatient, c: CheckinRow, n: TopicNote): void {
    addCheckinNote(db, { patientId: patient.id, checkinId: c.id, questionId: n.questionId, topic: n.topic, text: n.words, createdAt: clock.now() });
  }

  /** The greeting and the flag steps: their buttons. Anything else is typed text (undefined). */
  function planOtherStep(patient: CheckinPatient, c: CheckinRow, msg: InboundMessage): Send[] | undefined {
    const { chatId, text } = msg;
    switch (c.step) {
      case "greeting": {
        if (isNotToday(text)) return notToday(patient, c, chatId);
        if (isStart(text)) return nextStep(patient, c, chatId);
        return undefined;
      }
      case "flag_offer": {
        if (is(text, BUTTON.tellMeMore)) {
          // No flag left to tell (record consent ended since it was offered): the check-in just ends.
          const flag = c.pendingFlagId !== null ? getFlag(db, c.pendingFlagId) : undefined;
          if (!flag) return finishCheckedIn(patient, c, chatId);
          markTold(db, flag.flagId, clock.now(), c.date);
          updateCheckin(db, c.id, { step: "flag_detail" });
          return [
            {
              chatId,
              message: { text: flagDetail(flag.message), buttons: [BUTTON.willAskDoctor, BUTTON.later] },
              key: `${patient.id}:${c.date}:flag-detail`,
              prompt: promptFor(c, "flag_detail"),
            },
          ];
        }
        // "Later" leaves the flag new; it is offered again another day. "Not today" here means the same.
        if (is(text, BUTTON.later) || is(text, BUTTON.notToday)) return finishCheckedIn(patient, c, chatId);
        return undefined;
      }
      case "flag_detail": {
        if (is(text, BUTTON.willAskDoctor)) {
          if (c.pendingFlagId === null) return finishCheckedIn(patient, c, chatId); // the flag was deleted
          markNoted(db, c.pendingFlagId, clock.now());
          return [
            { chatId, message: { text: flagNotedReply() }, key: `${patient.id}:${c.date}:flag-noted` },
            ...finishCheckedIn(patient, c, chatId),
          ];
        }
        // "Later" after hearing it leaves the flag told.
        if (is(text, BUTTON.later) || is(text, BUTTON.notToday)) return finishCheckedIn(patient, c, chatId);
        return undefined;
      }
      case "question": // planned by routeInbound
      case "done":
        return undefined;
    }
  }

  /** Sends follow-ups due by `now`; at most one run at a time (the agent's timer may fire during a slow send). */
  let followUpRun: Promise<number> | undefined;
  async function sendDueFollowUps(now: string): Promise<number> {
    const failures: unknown[] = [];
    let sent = 0;
    for (const f of dueFollowUps(db, now)) {
      const patient = getCheckinPatient(db, f.patientId);
      if (!patient?.relayChatId) continue; // not linked (any more): it waits
      try {
        await deliver([
          {
            chatId: patient.relayChatId,
            message: { text: followUpQuestion(patient.preferredName, followUpTopic(f.reason)), buttons: [...FOLLOW_UP_LABELS] },
            key: `${f.patientId}:follow-up:${f.id}`,
            followUpId: f.id,
          },
        ]);
        sent += 1;
      } catch (error) {
        failures.push(error); // stays unsent; the next run tries again with the same key
      }
    }
    if (failures.length > 0) throw failures[0];
    return sent;
  }

  return {
    async startDay(patientId: string, day: string): Promise<DayResult> {
      const patient = requirePatient(patientId);
      if (getCheckin(db, patientId, day)) return { kind: "already_started" };
      if (!patient.relayChatId) throw new Error(`Patient "${patientId}" has no Relay chat yet`);
      const chatId = patient.relayChatId;

      let raw;
      try {
        raw = await deps.loadSnapshot(patient.finchnodePatientId);
      } catch (error) {
        if (!(error instanceof ConsentInactiveError)) throw error;
        // Record consent ended: stop reading, delete our copy (snapshots and the flags from them),
        // tell her and the family. Chats, check-ins and memories stay.
        db.transaction(() => {
          deletePatientSnapshots(db, patientId);
          deletePatientFlags(db, patientId);
        })();
        await deliver([
          { chatId, message: { text: recordLinkEndedSenior(patient.preferredName) }, key: `${patientId}:${day}:record-consent-ended` },
          ...toFamily(patient, recordLinkEndedFamily(patient.preferredName), `${patientId}:${day}:record-consent-ended`),
        ]);
        return { kind: "record_consent_ended" };
      }

      const record = normalizeHealthRecord(raw, { rxnav: rxnavCache() });
      // On the record as it stood that day, like the rules and the packet. Red-flag questions
      // come up when due, from what she answered on earlier days.
      const questions = pickQuestions(asOf(record, day), day, { history: answerHistory(db, patientId, day) });
      const questionIds = questions.map((q) => q.id);
      const checkinId = db.transaction((): number | undefined => {
        // A second startDay may have run while the snapshot loaded.
        if (getCheckin(db, patientId, day)) return undefined;
        const now = clock.now();
        saveSnapshot(db, { patientId, fetchedAt: now, syncStatus: raw.meta.syncStatus, raw });
        syncFlags(db, patientId, runRules({ record, checkinDate: day }), now);
        return insertCheckin(db, { patientId, date: day, questionIds, sentAt: now });
      })();
      if (checkinId === undefined) return { kind: "already_started" };

      await deliver([
        {
          chatId,
          message: { text: checkinGreeting(patient.preferredName, questions.length), buttons: [BUTTON.start, BUTTON.notToday] },
          key: `${patientId}:${day}:greeting`,
          prompt: { checkinId, step: "greeting", questionIndex: 0 },
        },
      ]);
      return { kind: "sent", questionIds };
    },

    async handleInbound(msg: InboundMessage): Promise<void> {
      // A "Yes" to a paper read-back needs a fresh snapshot. Load it before the transaction,
      // so a failed load leaves the message unhandled and a retry can try again.
      let fresh: FreshRecord | undefined;
      if (isPaperConfirm(msg.text) && !inboundSeen(db, msg.messageId)) {
        const patient = patientForChat(db, msg.chatId);
        if (patient && pendingReadback(db, patient.id)) {
          try {
            fresh = { kind: "record", raw: await deps.loadSnapshot(patient.finchnodePatientId) };
          } catch (error) {
            if (!(error instanceof ConsentInactiveError)) throw error;
            fresh = { kind: "consent_ended" };
          }
        }
      }
      const plan = (understood?: Reading) => db.transaction(() => planInbound(msg, fresh, understood))();
      const first = plan();
      if (!("needs" in first)) {
        await deliver(first.sends);
        return;
      }
      // Typed text: read it with the LLM (her chat shows that it's reading), then plan again with the reading.
      await showActivity(msg.chatId);
      try {
        const second = plan(await understand(first.needs));
        // The second pass has a reading, so it never asks again; if it somehow did, nothing is sent.
        await deliver("needs" in second ? [] : second.sends);
      } finally {
        await clearActivity(msg.chatId);
      }
    },

    async startPaperCheck(patientId: string, paper: ExtractedPaper, attachmentId?: string): Promise<{ scanId: number }> {
      const patient = requirePatient(patientId);
      if (!patient.relayChatId) throw new Error(`Patient "${patientId}" has no Relay chat yet`);
      const chatId = patient.relayChatId;
      const scanId = db.transaction((): number => {
        // The same photo delivered twice is one paper check.
        const existing = attachmentId ? paperScanForAttachment(db, patientId, attachmentId) : undefined;
        return existing?.id ?? insertPaperScan(db, { patientId, paper, attachmentId: attachmentId ?? null, createdAt: clock.now() });
      })();
      await messenger.send(chatId, { text: paperReadback(paper), buttons: [...PAPER_CONFIRM_BUTTONS] }, `${patientId}:paper:${scanId}:readback`);
      return { scanId };
    },

    async runMissedCheckin(patientId: string, day: string): Promise<"marked_missed" | "nothing_to_do"> {
      const patient = requirePatient(patientId);
      const sends = db.transaction((): Send[] | undefined => {
        const c = getCheckin(db, patientId, day);
        // Only an untouched check-in is missed; a partly answered one is not. After a safety hit
        // the family already had an alert, and a follow-up is on its way.
        if (!c || c.status !== "sent" || c.answers.length > 0 || c.finishedAt !== null || c.concernAt !== null) return undefined;
        updateCheckin(db, c.id, { status: "missed" });
        return toFamily(patient, familyMissedAlert(patient.preferredName, missedCheckinTime), `${patientId}:${day}:missed`);
      })();
      if (!sends) return "nothing_to_do";
      await deliver(sends);
      return "marked_missed";
    },

    runDueFollowUps(now: string): Promise<number> {
      followUpRun ??= sendDueFollowUps(now).finally(() => {
        followUpRun = undefined;
      });
      return followUpRun;
    },

    async passOnFamilyMessages(patientId: string): Promise<number> {
      const patient = requirePatient(patientId);
      if (familyChats(db, patientId).length === 0) return 0;
      let passed = 0;
      for (const r of waitingFamilyRelays(db, patientId)) {
        await deliver(toFamily(patient, familyRelay(patient.preferredName, r.text), `${patientId}:family-relay:${r.id}`));
        markFamilyRelayPassedOn(db, r.id, clock.now());
        passed += 1;
      }
      return passed;
    },
  };
}
