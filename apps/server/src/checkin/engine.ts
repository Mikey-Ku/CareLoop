import { QUESTION_BANK, pickQuestions, type Question } from "../context/questions.ts";
import {
  getCheckin,
  getCheckinPatient,
  insertCheckin,
  latestCheckin,
  markInboundHandled,
  patientForChat,
  updateCheckin,
  type CheckinPatient,
  type CheckinRow,
  type StoredAnswer,
} from "../db/checkins.ts";
import {
  deletePatientSnapshots,
  getFlag,
  getSharing,
  markNoted,
  markOffered,
  markTold,
  nextFlagToOffer,
  openFlags,
  saveSnapshot,
  syncFlags,
} from "../db/index.ts";
import { ConsentInactiveError } from "../finchnode/client.ts";
import { loadRxNavCache } from "../finchnode/fixtures.ts";
import { normalizeHealthRecord } from "../finchnode/normalize.ts";
import type { RxNavCache } from "../finchnode/rxnav.ts";
import type { InboundMessage, OutboundMessage } from "../relay/messenger.ts";
import { runRules } from "../rules/index.ts";
import {
  BUTTON,
  checkinDone,
  checkinGreeting,
  didntUnderstand,
  familyDailyStatus,
  familyMissedAlert,
  familyRedFlagAlert,
  flagDetail,
  flagNotedReply,
  flagOffer,
  notTodayReply,
  recordLinkEndedFamily,
  recordLinkEndedSenior,
  redFlagAdvice,
  type DayOutcome,
} from "./copy.ts";
import type { CheckinEngine, DayResult, EngineDeps } from "./engine-types.ts";
import { evaluateRedFlag } from "./red-flags.ts";

// The daily check-in as a small state machine over the checkins row:
//   greeting -> question (one per index) -> flag_offer -> flag_detail -> done
// "Not today" ends it from greeting or any question. Each inbound message is
// handled in one synchronous DB transaction that also plans the messages to
// send; the sends happen after, in order, with idempotency keys
// `${patientId}:${day}:<step>` so a replay never double-sends.

export type EngineOptions = {
  /** MISSED_CHECKIN_TIME, shown in the family's missed check-in alert. */
  missedCheckinTime?: string;
  /** RxNav lookups for normalization. Defaults to the recorded cache in fixtures/. */
  rxnav?: RxNavCache;
};

type Send = { chatId: string; message: OutboundMessage; key: string };

const norm = (s: string) => s.trim().toLowerCase();
const is = (text: string, label: string) => norm(text) === norm(label);

const QUESTIONS_BY_ID = new Map<string, Question>(
  QUESTION_BANK.map(({ id, text, buttons, redFlagAnswers }) => [id, { id, text, buttons, redFlagAnswers }]),
);

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

  async function deliver(sends: Send[]): Promise<void> {
    for (const s of sends) await messenger.send(s.chatId, s.message, s.key);
  }

  function requirePatient(patientId: string): CheckinPatient {
    const patient = getCheckinPatient(db, patientId);
    if (!patient) throw new Error(`Unknown patient "${patientId}"`);
    return patient;
  }

  // Planning helpers: synchronous, run inside a transaction, return what to send.

  /** Sends to the family group, or nothing when she has no family group yet. */
  function toFamily(patient: CheckinPatient, text: string, key: string): Send[] {
    return patient.familyChatId ? [{ chatId: patient.familyChatId, message: { text }, key }] : [];
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
    return toFamily(patient, text, `${patient.id}:${day}:family-status`);
  }

  function askQuestion(patient: CheckinPatient, c: CheckinRow, index: number, chatId: string): Send[] {
    const q = questionById(c.questionIds[index]!);
    updateCheckin(db, c.id, { step: "question", questionIndex: index });
    return [{ chatId, message: { text: q.text, buttons: [...q.buttons] }, key: `${patient.id}:${c.date}:question:${index}` }];
  }

  function finishCheckedIn(patient: CheckinPatient, c: CheckinRow, chatId: string): Send[] {
    updateCheckin(db, c.id, { step: "done", pendingFlagId: null, finishedAt: clock.now() });
    return [
      { chatId, message: { text: checkinDone(patient.preferredName) }, key: `${patient.id}:${c.date}:done` },
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

  function answerQuestion(patient: CheckinPatient, c: CheckinRow, q: Question, answer: string, chatId: string): Send[] {
    const answers: StoredAnswer[] = [...c.answers, { questionId: q.id, questionText: q.text, answer, at: clock.now() }];
    updateCheckin(db, c.id, { answers, ...(q.id === "mood" ? { mood: answer } : {}) });
    const updated: CheckinRow = { ...c, answers };
    const sends: Send[] = [];

    const red = evaluateRedFlag(q, answer);
    if (red) {
      const sharing = getSharing(db, patient.id) ?? "status";
      sends.push(
        { chatId, message: { text: redFlagAdvice(patient.preferredName) }, key: `${patient.id}:${c.date}:red-flag:${q.id}` },
        ...toFamily(
          patient,
          familyRedFlagAlert({ seniorName: patient.preferredName, sharing, questionText: red.questionText, answer: red.answer }),
          `${patient.id}:${c.date}:family-red-flag:${q.id}`,
        ),
      );
    }

    const next = c.questionIndex + 1;
    if (next < c.questionIds.length) sends.push(...askQuestion(patient, updated, next, chatId));
    else sends.push(...afterLastQuestion(patient, updated, chatId));
    return sends;
  }

  function planInbound(msg: InboundMessage): Send[] {
    const patient = patientForChat(db, msg.chatId);
    if (!patient) return [];
    if (!markInboundHandled(db, msg.messageId, msg.chatId, clock.now())) return [];
    const c = latestCheckin(db, patient.id);
    if (!c || c.finishedAt !== null || c.step === "done") return []; // free text with nothing pending: memories are a later run
    const chatId = msg.chatId;
    const text = msg.text;
    const didnt = (buttons: string[]): Send[] => [
      {
        chatId,
        message: { text: didntUnderstand(buttons), buttons },
        key: `${patient.id}:${c.date}:didnt-understand:${msg.messageId}`,
      },
    ];

    switch (c.step) {
      case "greeting": {
        if (is(text, BUTTON.notToday)) return notToday(patient, c, chatId);
        if (is(text, BUTTON.start))
          return c.questionIds.length > 0 ? askQuestion(patient, c, 0, chatId) : afterLastQuestion(patient, c, chatId);
        return didnt([BUTTON.start, BUTTON.notToday]);
      }
      case "question": {
        if (is(text, BUTTON.notToday)) return notToday(patient, c, chatId);
        const q = questionById(c.questionIds[c.questionIndex]!);
        const answer = q.buttons.find((b) => is(text, b));
        if (answer === undefined) return didnt(q.buttons);
        return answerQuestion(patient, c, q, answer, chatId);
      }
      case "flag_offer": {
        if (is(text, BUTTON.tellMeMore) && c.pendingFlagId !== null) {
          const flag = getFlag(db, c.pendingFlagId);
          if (!flag) return finishCheckedIn(patient, c, chatId);
          markTold(db, flag.flagId, clock.now(), c.date);
          updateCheckin(db, c.id, { step: "flag_detail" });
          return [
            {
              chatId,
              message: { text: flagDetail(flag.message), buttons: [BUTTON.willAskDoctor, BUTTON.later] },
              key: `${patient.id}:${c.date}:flag-detail`,
            },
          ];
        }
        // "Later" leaves the flag new; it is offered again another day. "Not today" here means the same.
        if (is(text, BUTTON.later) || is(text, BUTTON.notToday)) return finishCheckedIn(patient, c, chatId);
        return didnt([BUTTON.tellMeMore, BUTTON.later]);
      }
      case "flag_detail": {
        if (is(text, BUTTON.willAskDoctor) && c.pendingFlagId !== null) {
          markNoted(db, c.pendingFlagId, clock.now());
          return [
            { chatId, message: { text: flagNotedReply() }, key: `${patient.id}:${c.date}:flag-noted` },
            ...finishCheckedIn(patient, c, chatId),
          ];
        }
        // "Later" after hearing it leaves the flag told.
        if (is(text, BUTTON.later) || is(text, BUTTON.notToday)) return finishCheckedIn(patient, c, chatId);
        return didnt([BUTTON.willAskDoctor, BUTTON.later]);
      }
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
        // Record consent ended: stop reading, delete our copy, tell her and the family.
        deletePatientSnapshots(db, patientId);
        await deliver([
          { chatId, message: { text: recordLinkEndedSenior(patient.preferredName) }, key: `${patientId}:${day}:record-consent-ended` },
          ...toFamily(patient, recordLinkEndedFamily(patient.preferredName), `${patientId}:${day}:family-record-consent-ended`),
        ]);
        return { kind: "record_consent_ended" };
      }

      const record = normalizeHealthRecord(raw, { rxnav: rxnavCache() });
      const questions = pickQuestions(record, day);
      const planned = db.transaction((): DayResult => {
        // A second startDay may have run while the snapshot loaded.
        if (getCheckin(db, patientId, day)) return { kind: "already_started" };
        const now = clock.now();
        saveSnapshot(db, { patientId, fetchedAt: now, syncStatus: raw.meta.syncStatus, raw });
        syncFlags(db, patientId, runRules({ record, checkinDate: day }), now);
        insertCheckin(db, { patientId, date: day, questionIds: questions.map((q) => q.id), sentAt: now });
        return { kind: "sent", questionIds: questions.map((q) => q.id) };
      })();
      if (planned.kind !== "sent") return planned;

      await messenger.send(
        chatId,
        { text: checkinGreeting(patient.preferredName, questions.length), buttons: [BUTTON.start, BUTTON.notToday] },
        `${patientId}:${day}:greeting`,
      );
      return planned;
    },

    async handleInbound(msg: InboundMessage): Promise<void> {
      const sends = db.transaction(() => planInbound(msg))();
      await deliver(sends);
    },

    async runMissedCheckin(patientId: string, day: string): Promise<"marked_missed" | "nothing_to_do"> {
      const patient = requirePatient(patientId);
      const sends = db.transaction((): Send[] | undefined => {
        const c = getCheckin(db, patientId, day);
        // Only an untouched check-in is missed; a partly answered one is not.
        if (!c || c.status !== "sent" || c.answers.length > 0 || c.finishedAt !== null) return undefined;
        updateCheckin(db, c.id, { status: "missed" });
        return toFamily(patient, familyMissedAlert(patient.preferredName, missedCheckinTime), `${patientId}:${day}:family-missed`);
      })();
      if (!sends) return "nothing_to_do";
      await deliver(sends);
      return "marked_missed";
    },
  };
}

