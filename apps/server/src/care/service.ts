import type { Clock } from "../checkin/engine-types.ts";
import {
  careThread,
  getCareSummary,
  insertCareSummary,
  latestSentSummary,
  markOutboundFailed,
  markOutboundSent,
  outboundForKey,
  planOutbound,
  sentSummaryText,
  recordInbound,
  type CareSummaryRow,
} from "../db/care.ts";
import { getCheckin } from "../db/checkins.ts";
import type { Db } from "../db/index.ts";
import type { RxNavCache } from "../finchnode/rxnav.ts";
import type { CareInbound, CareMessenger } from "../photon/care-messenger.ts";
import { contactForPhone, maskPhone, type CareAudience, type CareContact, type CareContacts } from "./contacts.ts";
import { noSummaryReply } from "./copy.ts";
import { buildCareFacts } from "./facts.ts";
import { classifyInbound, fixedReply, writeReply, type ReplyWriter } from "./replies.ts";
import { composeSummary, templateSummary } from "./writer.ts";

// After a check-in (or, once lanes 2 and 3 land, a call) the day's facts are frozen into a
// care summary and texted over Photon: a data summary to her doctor and a plain-language
// one to her emergency contact. Replies from either number are answered from that summary.
//
// Idempotency: each outbound text is planned in care_messages under a stable key before it
// is sent, and marked sent after; a planned-but-unsent row is retried, a sent one skipped.
// Keys: `care:<patientId>:<day>:<trigger>:<audience>` and `care-reply:<photon message id>`.
// Inbound texts dedupe on Photon's message id. A failed send to one contact never stops
// the other. Log lines carry masked numbers and never message text.

/** Trigger for the day's summary once her check-in is over (checked in or "not today"). */
export const DAY_TRIGGER = "day";
/**
 * Trigger for the noon summary of a missed check-in (no answers by MISSED_CHECKIN_TIME). Its own
 * trigger, so if she checks in after noon after all, the finished day's summary still goes out.
 */
export const MISSED_TRIGGER = "missed";

export type SendOutcome = "sent" | "already_sent" | "failed";
export type SummaryResult = { summaryId: number; doctor: SendOutcome; family: SendOutcome };

export type CareServiceDeps = {
  db: Db;
  patientId: string;
  contacts: CareContacts;
  messenger: CareMessenger;
  clock: Clock;
  rxnav: () => RxNavCache;
  /** Words the summaries' bodies and follow-up answers (src/care/writer.ts, Gemini). Without one, templates are sent. */
  writer?: ReplyWriter;
  log?: (line: string) => void;
};

export type InboundResult = "replied" | "no_reply" | "duplicate" | "unknown_sender" | "failed";

export function createCareService(deps: CareServiceDeps) {
  const { db, patientId, contacts, messenger, clock } = deps;
  const log = deps.log ?? ((line: string) => console.log(line));

  const contactFor = (audience: CareAudience): CareContact => (audience === "doctor" ? contacts.doctor : contacts.emergencyContact);
  /** The summary as this reader got it (written or template); the template when none went out yet. */
  const sentText = (summary: CareSummaryRow, audience: CareAudience) =>
    sentSummaryText(db, summary.id, audience) ?? templateSummary(audience, summary.facts, contacts);

  /** The text for a summary not planned yet: written by the writer inside the fixed parts, else the template. */
  async function summaryText(summary: CareSummaryRow, audience: CareAudience, key: string): Promise<string> {
    const planned = outboundForKey(db, key);
    if (planned) return planned.text; // a retry sends exactly what was planned
    const { text, by } = await composeSummary(deps.writer, { audience, facts: summary.facts, contacts }, log);
    log(`[care] ${audience} summary ${by === "writer" ? "worded by the LLM" : "from the template"}`);
    return text;
  }

  /** Send one planned text unless it already went out. Never throws. */
  async function deliver(input: {
    audience: CareAudience;
    kind: "summary" | "reply";
    summaryId: number | null;
    key: string;
    text: string;
  }): Promise<SendOutcome> {
    const contact = contactFor(input.audience);
    const row = planOutbound(db, { patientId, phone: contact.phone, createdAt: clock.now(), ...input });
    if (row.sentAt) return "already_sent";
    try {
      const sent = await messenger.send(contact.phone, row.text, row.idempotencyKey ?? input.key);
      markOutboundSent(db, row.id, clock.now(), sent.messageId);
      log(`[care] ${input.kind} sent to ${input.audience} ${maskPhone(contact.phone)}`);
      return "sent";
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      markOutboundFailed(db, row.id, message);
      log(`[care] ${input.kind} to ${input.audience} ${maskPhone(contact.phone)} failed: ${message}`);
      return "failed";
    }
  }

  async function sendSummaries(day: string, trigger: string = DAY_TRIGGER): Promise<SummaryResult> {
    const summary =
      getCareSummary(db, patientId, day, trigger) ??
      insertCareSummary(db, { patientId, day, trigger, facts: buildCareFacts(db, { patientId, day, trigger, rxnav: deps.rxnav() }), createdAt: clock.now() });
    const keyFor = (audience: CareAudience) => `care:${patientId}:${day}:${trigger}:${audience}`;
    const doctor = await deliver({ audience: "doctor", kind: "summary", summaryId: summary.id, key: keyFor("doctor"), text: await summaryText(summary, "doctor", keyFor("doctor")) });
    const family = await deliver({ audience: "family", kind: "summary", summaryId: summary.id, key: keyFor("family"), text: await summaryText(summary, "family", keyFor("family")) });
    return { summaryId: summary.id, doctor, family };
  }

  return {
    sendSummaries,

    /**
     * The noon job: the missed-day summary, only when the day's check-in really was missed (marked
     * missed: no answers by MISSED_CHECKIN_TIME). A check-in still in progress, or paused by a concern
     * (her family already had the alert), sends nothing at noon: its summary goes out when it ends.
     * Sending twice is a no-op.
     */
    async missedDaySummary(day: string): Promise<SummaryResult | undefined> {
      if (getCheckin(db, patientId, day)?.status !== "missed") return undefined;
      return sendSummaries(day, MISSED_TRIGGER);
    },

    /** A text from the doctor or the emergency contact. Never throws. */
    async handleInbound(message: CareInbound): Promise<InboundResult> {
      const contact = contactForPhone(contacts, message.fromPhone);
      if (!contact) {
        log(`[care] text from an unknown number ${maskPhone(message.fromPhone)} ignored`);
        return "unknown_sender";
      }
      const audience = contact.audience;
      const summary = latestSentSummary(db, patientId, audience);
      const thread = careThread(db, patientId, audience);
      if (!recordInbound(db, { patientId, audience, phone: contact.phone, photonMessageId: message.messageId, text: message.text, createdAt: message.at, summaryId: summary?.id ?? null }))
        return "duplicate";

      const intent = classifyInbound(audience, message.text, summary?.facts.patient.preferredName);
      let reply = fixedReply(intent, summary?.facts, contacts);
      if (reply === undefined) {
        reply = summary
          ? await writeReply(
              deps.writer,
              {
                contact,
                contacts,
                facts: summary.facts,
                summaryText: sentText(summary, audience),
                thread: thread.map((m) => ({ from: m.direction === "outbound" ? "assistant" : "contact", text: m.text })),
                message: message.text,
              },
              log,
            )
          : noSummaryReply(contact);
      }
      log(`[care] text from ${audience} ${maskPhone(contact.phone)}: ${intent}${reply === null ? ", no reply needed" : ""}`);
      if (reply === null) return "no_reply";
      const outcome = await deliver({ audience, kind: "reply", summaryId: summary?.id ?? null, key: `care-reply:${message.messageId}`, text: reply });
      return outcome === "failed" ? "failed" : "replied";
    },
  };
}

export type CareService = ReturnType<typeof createCareService>;
