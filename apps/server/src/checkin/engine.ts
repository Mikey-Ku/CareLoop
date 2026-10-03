import { QUESTION_BANK, pickQuestions, type Question } from "../context/questions.ts";
import { answerHistory } from "../db/answer-history.ts";
import {
  getCheckin,
  getCheckinPatient,
  getCheckinPrompt,
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
import { familyChats } from "../db/family.ts";
import { addMemories, recentMemories } from "../db/memories.ts";
import { inboundSeen, insertPaperScan, paperScanForAttachment } from "../db/paper-scans.ts";
import { ConsentInactiveError } from "../finchnode/client.ts";
import { loadRxNavCache } from "../finchnode/fixtures.ts";
import { asOf, normalizeHealthRecord } from "../finchnode/normalize.ts";
import type { RxNavCache } from "../finchnode/rxnav.ts";
import type { SharingLevel } from "../db/index.ts";
import type { AnswerMapping, MapAnswerInput, SmallTalkInput, SmallTalkReply } from "../llm/types.ts";
import type { InboundMessage, OutboundMessage } from "../relay/messenger.ts";
import { runRules } from "../rules/index.ts";
import type { ExtractedPaper } from "../rules/paper-diff.ts";
import {
  BUTTON,
  checkinDone,
  checkinGreeting,
  complaintReply,
  didntUnderstand,
  familyDailyStatus,
  familyMissedAlert,
  familyRedFlagAlert,
  flagDetail,
  flagNotedReply,
  flagOffer,
  freeTextConfirm,
  notTodayReply,
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
  type DayOutcome,
} from "./copy.ts";
import type { CheckinEngine, DayResult, EngineDeps, FreeTextAnswer } from "./engine-types.ts";
import { PAPER_CONFIRM_BUTTONS, paperReadback } from "./paper-check.ts";
import {
  createPaperFlow,
  isPaperConfirm,
  isPaperFollowUp,
  isPaperReject,
  pendingFollowUp,
  pendingReadback,
  type FreshRecord,
  type PaperSend,
} from "./paper-flow.ts";
import { evaluateRedFlag } from "./red-flags.ts";

// The daily check-in as a small state machine over the checkins row:
//   greeting -> question (one per index) -> flag_offer -> flag_detail -> done
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
// the paper check (src/checkin/paper-flow.ts) answers its own buttons. Either one
// re-sends whatever the check-in was waiting for, so she can carry on.
//
// Stale taps: every message that carries a check-in step's buttons is remembered
// with that step (checkin_prompts). A tap names the message it replies to
// (InboundMessage.replyTo); a tap on a message sent for another step, another day
// or no step at all doesn't answer what is pending now. It re-sends the current
// prompt instead. "Not today" from the greeting or any question of the pending
// check-in still ends the day. Typed text (no replyTo) is matched as before.
//
// Free text (deps.llm, src/llm): what she types that isn't a button label.
//   - An ordinary question: the LLM maps it to one of the question's buttons. A high or
//     medium confidence match is recorded as if she tapped it (with her words, via
//     "free_text"); anything else gets "didn't understand" with the buttons, as before.
//   - A red-flag question (breathing lying flat, bleeding): never recorded from the LLM.
//     Her words are quoted back with the question and its buttons (freeTextConfirm), so the
//     red-flag rule only acts on her tap. Needs no LLM; with one, it is asked afterwards,
//     in the background, only for other complaints she mentioned.
//   - Nothing pending (no open step, no paper check waiting): small talk. Things she
//     mentions are saved as memories; a health complaint gets the fixed complaintReply,
//     not the model's words, and no family alert (not a red flag under the rules).
//     No LLM, or it fails: the fixed smallTalkFallback.
// Other complaints from any mapping are saved as memories, never acted on. The LLM call
// is async and planning is a synchronous transaction, so planning runs twice: the first
// pass stops at free text and asks for an LLM answer without writing anything (the
// message stays unhandled); the second pass plans with it. A message already handled
// never reaches the LLM. Her chat shows "Reading your message" while it reads.

export type EngineOptions = {
  /** MISSED_CHECKIN_TIME, shown in the family's missed check-in alert. */
  missedCheckinTime?: string;
  /** RxNav lookups for normalization. Defaults to the recorded cache in fixtures/. */
  rxnav?: RxNavCache;
};

/** Which check-in step a message's buttons belong to; recorded with the sent message id once it is out. */
type PromptRef = { checkinId: number; step: PromptStep; questionIndex: number };
type Send = { chatId: string; message: OutboundMessage; key: string; prompt?: PromptRef };

/** Free text the first planning pass found, which needs the LLM before it can be planned. */
type FreeTextNeed =
  | { kind: "answer"; checkinId: number; questionIndex: number; input: MapAnswerInput }
  | { kind: "small_talk"; input: SmallTalkInput };

/** What the LLM made of it. `undefined` means it couldn't help (unavailable, failed or timed out). */
type FreeTextResult =
  | { kind: "answer"; checkinId: number; questionIndex: number; mapping: AnswerMapping | undefined }
  | { kind: "small_talk"; reply: SmallTalkReply | undefined };

type Plan = {
  sends: Send[];
  /** Red-flag free text: once her confirm is out, ask the LLM only for other complaints she mentioned. */
  complaintsFrom?: { patientId: string; input: MapAnswerInput };
};

/** A plan, or (first pass only, nothing written) the free text that needs the LLM first. */
type Planned = Plan | { needs: FreeTextNeed };

/** Memories passed to small talk as context, newest first. */
export const SMALL_TALK_MEMORIES = 10;
/** A small-talk reply longer than this (or empty, or with a long dash) is not sent; the fallback is. */
export const MAX_SMALL_TALK_REPLY = 500;

/** The model's small-talk text if it is fit to send as is, else undefined (the caller sends a template). */
export function checkedSmallTalk(text: string): string | undefined {
  const one = text.replace(/[ \t]+/g, " ").trim();
  if (!one || one.length > MAX_SMALL_TALK_REPLY || /[\u2013\u2014]/.test(one)) return undefined;
  return one;
}

/** Only high and medium confidence mappings are recorded. */
const confident = (m: AnswerMapping) => m.confidence === "high" || m.confidence === "medium";

/** A message carrying `step`'s buttons for check-in `c` (for a question, the one at c.questionIndex). */
function promptFor(c: CheckinRow, step: PromptStep): PromptRef {
  return { checkinId: c.id, step, questionIndex: step === "question" ? c.questionIndex : 0 };
}

const norm = (s: string) => s.trim().toLowerCase();
const is = (text: string, label: string) => norm(text) === norm(label);

const QUESTIONS_BY_ID = new Map<string, Question>(
  QUESTION_BANK.map(({ id, text, buttons, redFlagAnswers }) => [id, { id, text, buttons, redFlagAnswers }]),
);

/** Every button label the engine sends, normalized. A message that equals one is a tap (maybe late), not small talk. */
const ALL_LABELS = new Set(
  [
    ...Object.values(BUTTON),
    ...QUESTION_BANK.flatMap((q) => q.buttons),
    ...Object.values(SHARING_BUTTONS),
    SHARING_MENU_BUTTON,
    ...PAPER_CONFIRM_BUTTONS,
  ].map(norm),
);
const isButtonLabel = (text: string) => ALL_LABELS.has(norm(text));

function questionById(id: string): Question {
  const q = QUESTIONS_BY_ID.get(id);
  if (!q) throw new Error(`Check-in refers to unknown question "${id}"`);
  return q;
}

export function createCheckinEngine(deps: EngineDeps, options: EngineOptions = {}): CheckinEngine {
  const { db, messenger, clock } = deps;
  const missedCheckinTime = options.missedCheckinTime ?? "12:00";
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
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, `${failures.length} of ${sends.length} sends failed`);
  }

  // Free text (see "Free text" above). The LLM and the activity label are best effort: whatever
  // goes wrong there, she still gets the button reply or the fixed template.

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

  /** Ask the LLM about the free text the first planning pass found. Never throws. */
  async function understand(need: FreeTextNeed): Promise<FreeTextResult> {
    const llm = deps.llm;
    if (need.kind === "answer") {
      const { checkinId, questionIndex } = need;
      let mapping: AnswerMapping | undefined;
      try {
        mapping = llm ? await llm.mapAnswer(need.input) : undefined;
      } catch {
        mapping = undefined; // LlmUnavailableError or anything else: "didn't understand" with the buttons
      }
      return { kind: "answer", checkinId, questionIndex, mapping };
    }
    let reply: SmallTalkReply | undefined;
    try {
      reply = llm ? await llm.smallTalk(need.input) : undefined;
    } catch {
      reply = undefined; // the fixed fallback reply
    }
    return { kind: "small_talk", reply };
  }

  /**
   * After the confirm for a red-flag question is out: ask the LLM only for other complaints she
   * mentioned and save them as memories. Its answer to the question is ignored. Runs in the
   * background and never throws.
   */
  async function saveOtherComplaints(patientId: string, input: MapAnswerInput): Promise<void> {
    if (!deps.llm) return;
    try {
      const { otherComplaints } = await deps.llm.mapAnswer(input);
      addMemories(db, patientId, otherComplaints, clock.now());
    } catch {
      // Memories are a nice-to-have; her confirm already went out.
    }
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

  function familyStatus(patient: CheckinPatient, outcome: DayOutcome, answers: StoredAnswer[], day: string): Send[] {
    const sharing = getSharing(db, patient.id) ?? "status";
    // Family sees flags only at "all", and only ones she has already heard.
    const flags =
      sharing === "all"
        ? openFlags(db, patient.id)
            .filter((f) => f.status === "told" || f.status === "noted")
            .map((f) => ({ message: f.message }))
        : [];
    const text = familyDailyStatus({
      seniorName: patient.preferredName,
      sharing,
      outcome,
      answers: answers.map(({ questionId, questionText, answer }) => ({ questionId, questionText, answer })),
      flags,
    });
    return toFamily(patient, text, `${patient.id}:${day}:status`);
  }

  function askQuestion(patient: CheckinPatient, c: CheckinRow, index: number, chatId: string): Send[] {
    const q = questionById(c.questionIds[index]!);
    updateCheckin(db, c.id, { step: "question", questionIndex: index });
    return [
      {
        chatId,
        message: { text: q.text, buttons: [...q.buttons] },
        key: `${patient.id}:${c.date}:question:${index}`,
        prompt: { checkinId: c.id, step: "question", questionIndex: index },
      },
    ];
  }

  function finishCheckedIn(patient: CheckinPatient, c: CheckinRow, chatId: string): Send[] {
    updateCheckin(db, c.id, { step: "done", pendingFlagId: null, finishedAt: clock.now() });
    return [
      {
        chatId,
        message: { text: checkinDone(patient.preferredName), buttons: [SHARING_MENU_BUTTON] },
        key: `${patient.id}:${c.date}:done`,
      },
      ...familyStatus(patient, "checked_in", c.answers, c.date),
    ];
  }

  function afterLastQuestion(patient: CheckinPatient, c: CheckinRow, chatId: string): Send[] {
    updateCheckin(db, c.id, { status: "answered" });
    const flag = nextFlagToOffer(db, patient.id, c.date);
    if (!flag) return finishCheckedIn(patient, c, chatId);
    markOffered(db, flag.flagId, c.date);
    updateCheckin(db, c.id, { step: "flag_offer", pendingFlagId: Number(flag.flagId) });
    return [
      {
        chatId,
        message: { text: flagOffer(), buttons: [BUTTON.tellMeMore, BUTTON.later] },
        key: `${patient.id}:${c.date}:flag-offer`,
        prompt: promptFor(c, "flag_offer"),
      },
    ];
  }

  function notToday(patient: CheckinPatient, c: CheckinRow, chatId: string): Send[] {
    updateCheckin(db, c.id, { status: "skipped", step: "done", pendingFlagId: null, finishedAt: clock.now() });
    return [
      { chatId, message: { text: notTodayReply(patient.preferredName) }, key: `${patient.id}:${c.date}:not-today` },
      ...familyStatus(patient, "not_today", c.answers, c.date),
    ];
  }

  function answerQuestion(patient: CheckinPatient, c: CheckinRow, q: Question, answer: string, chatId: string, freeText?: FreeTextAnswer): Send[] {
    const stored: StoredAnswer & Partial<FreeTextAnswer> = { questionId: q.id, questionText: q.text, answer, at: clock.now(), ...freeText };
    const answers: StoredAnswer[] = [...c.answers, stored];
    updateCheckin(db, c.id, { answers, ...(q.id === "mood" ? { mood: answer } : {}) });
    const updated: CheckinRow = { ...c, answers };
    const sends: Send[] = [];

    const red = evaluateRedFlag(q, answer);
    if (red) {
      const sharing = getSharing(db, patient.id) ?? "status";
      sends.push(
        // Name the family members actually told (display name, else their Relay handle); none linked: no family line.
        {
          chatId,
          message: { text: redFlagAdvice(patient.preferredName, familyChats(db, patient.id).map((f) => f.displayName || f.handle)) },
          key: `${patient.id}:${c.date}:red-flag:${q.id}`,
        },
        ...toFamily(
          patient,
          familyRedFlagAlert({ seniorName: patient.preferredName, sharing, questionText: red.questionText, answer: red.answer }),
          `${patient.id}:${c.date}:red-flag:${q.id}`,
        ),
      );
    }

    const next = c.questionIndex + 1;
    if (next < c.questionIds.length) sends.push(...askQuestion(patient, updated, next, chatId));
    else sends.push(...afterLastQuestion(patient, updated, chatId));
    return sends;
  }

  /** The check-in still waiting for her, if any. */
  function pendingCheckin(patientId: string): CheckinRow | undefined {
    const c = latestCheckin(db, patientId);
    return c && c.finishedAt === null && c.step !== "done" ? c : undefined;
  }

  /** Re-send what the check-in is waiting for, after the sharing or paper flow, so she can carry on. */
  function reprompt(patient: CheckinPatient, chatId: string, messageId: string): Send[] {
    const c = pendingCheckin(patient.id);
    if (!c) return [];
    const key = `${patient.id}:${c.date}:again:${messageId}`;
    const one = (step: PromptStep, text: string, buttons: string[]): Send[] => [
      { chatId, message: { text, buttons }, key, prompt: promptFor(c, step) },
    ];
    switch (c.step) {
      case "greeting":
        return one(c.step, checkinGreeting(patient.preferredName, c.questionIds.length), [BUTTON.start, BUTTON.notToday]);
      case "question": {
        const q = questionById(c.questionIds[c.questionIndex]!);
        return one(c.step, q.text, [...q.buttons]);
      }
      case "flag_offer":
        return one(c.step, flagOffer(), [BUTTON.tellMeMore, BUTTON.later]);
      case "flag_detail": {
        const flag = c.pendingFlagId !== null ? getFlag(db, c.pendingFlagId) : undefined;
        return flag ? one(c.step, flagDetail(flag.message), [BUTTON.willAskDoctor, BUTTON.later]) : [];
      }
      case "done":
        return [];
    }
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
      const scan = pendingFollowUp(db, patient.id);
      if (!scan) return undefined;
      return [...to(paperFlow.followUp(patient.id, scan, msg.text)), ...reprompt(patient, chatId, msg.messageId)];
    }
    return undefined;
  }

  /**
   * Her typed reply to the pending question, when it isn't one of its labels. See "Free text" above.
   * `understood` is the LLM's answer from handleInbound; without it (and with an LLM) this asks for one.
   */
  function planFreeTextAnswer(
    patient: CheckinPatient,
    c: CheckinRow,
    q: Question,
    msg: InboundMessage,
    understood: FreeTextResult | undefined,
    didnt: () => Send[],
  ): Planned {
    const reply = msg.text.trim();
    if (!reply) return { sends: didnt() };
    const input: MapAnswerInput = { question: q.text, options: [...q.buttons], reply };
    if (q.redFlagAnswers.length > 0) {
      // Never recorded from the LLM: her words and the question again, with its buttons. A tap on this
      // message answers the question (it is recorded as its prompt), through the normal red-flag rule.
      return {
        sends: [
          {
            chatId: msg.chatId,
            message: { text: freeTextConfirm(reply, q.text), buttons: [...q.buttons] },
            key: `${patient.id}:${c.date}:free-text-confirm:${msg.messageId}`,
            prompt: promptFor(c, "question"),
          },
        ],
        ...(deps.llm ? { complaintsFrom: { patientId: patient.id, input } } : {}),
      };
    }
    // An answer for another question (the check-in moved on while the LLM read) counts as no answer.
    const result =
      understood?.kind === "answer" && understood.checkinId === c.id && understood.questionIndex === c.questionIndex ? understood : undefined;
    if (deps.llm && understood === undefined) return { needs: { kind: "answer", checkinId: c.id, questionIndex: c.questionIndex, input } };
    const mapping = result?.mapping;
    if (mapping) addMemories(db, patient.id, mapping.otherComplaints, clock.now());
    const answer = mapping && confident(mapping) ? q.buttons.find((b) => is(mapping.answer, b)) : undefined;
    if (answer === undefined) return { sends: didnt() };
    return { sends: answerQuestion(patient, c, q, answer, msg.chatId, { via: "free_text", freeText: reply }) };
  }

  /** A message with nothing pending: small talk. See "Free text" above. */
  function planSmallTalk(patient: CheckinPatient, msg: InboundMessage, understood: FreeTextResult | undefined): Planned {
    const message = msg.text.trim();
    if (!message) return { sends: [] };
    if (deps.llm && understood === undefined)
      return {
        needs: { kind: "small_talk", input: { seniorName: patient.preferredName, message, memories: recentMemories(db, patient.id, SMALL_TALK_MEMORIES) } },
      };
    const reply = understood?.kind === "small_talk" ? understood.reply : undefined;
    let text = smallTalkFallback(patient.preferredName);
    if (reply) {
      addMemories(db, patient.id, [...reply.memories, ...reply.complaints], clock.now());
      text = reply.complaints.length > 0 ? complaintReply(patient.preferredName) : (checkedSmallTalk(reply.text) ?? text);
    }
    return { sends: [{ chatId: msg.chatId, message: { text }, key: `${patient.id}:small-talk:${msg.messageId}` }] };
  }

  /**
   * Plan one inbound message. Asking for the LLM (`needs`) happens before anything is written,
   * so the message stays unhandled until the pass that has the LLM's answer.
   */
  function planInbound(msg: InboundMessage, fresh: FreshRecord | undefined, understood?: FreeTextResult): Planned {
    const patient = patientForChat(db, msg.chatId);
    if (!patient) return { sends: [] };
    if (inboundSeen(db, msg.messageId)) return { sends: [] };
    const planned = routeInbound(patient, msg, fresh, understood);
    if (!("needs" in planned)) markInboundHandled(db, msg.messageId, msg.chatId, clock.now());
    return planned;
  }

  function routeInbound(patient: CheckinPatient, msg: InboundMessage, fresh: FreshRecord | undefined, understood: FreeTextResult | undefined): Planned {
    const outside = planSharing(patient, msg) ?? planPaper(patient, msg, fresh);
    if (outside) return { sends: outside };
    const c = pendingCheckin(patient.id);
    if (!c) {
      // Nothing pending: small talk, unless it's a late tap (one of our labels) or a paper check waits for her.
      if (isButtonLabel(msg.text) || pendingReadback(db, patient.id) || pendingFollowUp(db, patient.id)) return { sends: [] };
      return planSmallTalk(patient, msg, understood);
    }
    const chatId = msg.chatId;
    const text = msg.text;
    // A tap on an old message re-sends what is pending instead of answering it.
    if (msg.replyTo !== undefined && isStaleTap(c, msg.replyTo, text)) return { sends: reprompt(patient, chatId, msg.messageId) };
    // "Didn't understand" repeats the step's buttons, so a tap on it answers that step.
    const didnt = (step: PromptStep, buttons: string[]): Send[] => [
      {
        chatId,
        message: { text: didntUnderstand(buttons), buttons },
        key: `${patient.id}:${c.date}:didnt-understand:${msg.messageId}`,
        prompt: promptFor(c, step),
      },
    ];

    if (c.step === "question") {
      if (is(text, BUTTON.notToday)) return { sends: notToday(patient, c, chatId) };
      const q = questionById(c.questionIds[c.questionIndex]!);
      const answer = q.buttons.find((b) => is(text, b));
      if (answer === undefined) return planFreeTextAnswer(patient, c, q, msg, understood, () => didnt("question", q.buttons));
      return { sends: answerQuestion(patient, c, q, answer, chatId) };
    }
    return { sends: planOtherStep(patient, c, msg, didnt) };
  }

  /** The greeting and the flag steps: buttons only, free text gets "didn't understand". */
  function planOtherStep(patient: CheckinPatient, c: CheckinRow, msg: InboundMessage, didnt: (step: PromptStep, buttons: string[]) => Send[]): Send[] {
    const { chatId, text } = msg;
    switch (c.step) {
      case "greeting": {
        if (is(text, BUTTON.notToday)) return notToday(patient, c, chatId);
        if (is(text, BUTTON.start))
          return c.questionIds.length > 0 ? askQuestion(patient, c, 0, chatId) : afterLastQuestion(patient, c, chatId);
        return didnt(c.step, [BUTTON.start, BUTTON.notToday]);
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
        return didnt(c.step, [BUTTON.tellMeMore, BUTTON.later]);
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
        return didnt(c.step, [BUTTON.willAskDoctor, BUTTON.later]);
      }
      case "question": // planned by routeInbound
      case "done":
        return [];
    }
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
      const plan = (understood?: FreeTextResult) => db.transaction(() => planInbound(msg, fresh, understood))();
      const first = plan();
      if (!("needs" in first)) {
        await deliver(first.sends);
        // Not awaited: her tap on the confirm (the next message) must never wait for a nice-to-have.
        if (first.complaintsFrom) void saveOtherComplaints(first.complaintsFrom.patientId, first.complaintsFrom.input);
        return;
      }
      // Free text: read it with the LLM (her chat shows that it's reading), then plan again with the answer.
      await showActivity(msg.chatId);
      try {
        const second = plan(await understand(first.needs));
        // The second pass has an answer, so it never asks again; if it somehow did, nothing is sent.
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
        // Only an untouched check-in is missed; a partly answered one is not.
        if (!c || c.status !== "sent" || c.answers.length > 0 || c.finishedAt !== null) return undefined;
        updateCheckin(db, c.id, { status: "missed" });
        return toFamily(patient, familyMissedAlert(patient.preferredName, missedCheckinTime), `${patientId}:${day}:missed`);
      })();
      if (!sends) return "nothing_to_do";
      await deliver(sends);
      return "marked_missed";
    },
  };
}

