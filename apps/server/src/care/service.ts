import type { Clock } from "../checkin/engine-types.ts";
import {
  careThread,
  getCareSummary,
  hasCareSummaryForDay,
  insertCareSummary,
  latestSentSummary,
  markOutboundFailed,
  markOutboundSent,
  planOutbound,
  recordInbound,
  type CareSummaryRow,
} from "../db/care.ts";
import type { Db } from "../db/index.ts";
import type { RxNavCache } from "../finchnode/rxnav.ts";
import type { CareInbound, CareMessenger } from "../photon/care-messenger.ts";
import { contactForPhone, maskPhone, type CareAudience, type CareContact, type CareContacts } from "./contacts.ts";
import { doctorSummary, familySummary, noSummaryReply } from "./copy.ts";
import { buildCareFacts } from "./facts.ts";
import { classifyInbound, fixedReply, writeReply, type ReplyWriter } from "./replies.ts";

// After a check-in (or, once lanes 2 and 3 land, a call) the day's facts are frozen into a
// care summary and texted over Photon: a data summary to her doctor and a plain-language
// one to her emergency contact. Replies from either number are answered from that summary.
//
// Idempotency: each outbound text is planned in care_messages under a stable key before it
// is sent, and marked sent after; a planned-but-unsent row is retried, a sent one skipped.
// Keys: `care:<patientId>:<day>:<trigger>:<audience>` and `care-reply:<photon message id>`.
// Inbound texts dedupe on Photon's message id. A failed send to one contact never stops
// the other. Log lines carry masked numbers and never message text.

/** Trigger for the one daily summary (check-in ended, or the noon job). */
export const DAY_TRIGGER = "day";

export type SendOutcome = "sent" | "already_sent" | "failed";
export type SummaryResult = { summaryId: number; doctor: SendOutcome; family: SendOutcome };

export type CareServiceDeps = {
  db: Db;
  patientId: string;
  contacts: CareContacts;
  messenger: CareMessenger;
  clock: Clock;
  rxnav: () => RxNavCache;
  /** Words follow-up answers. Without one, template answers are sent. */
  writer?: ReplyWriter;
  log?: (line: string) => void;
};

export type InboundResult = "replied" | "no_reply" | "duplicate" | "unknown_sender" | "failed";

export function createCareService(deps: CareServiceDeps) {
  const { db, patientId, contacts, messenger, clock } = deps;
  const log = deps.log ?? ((line: string) => console.log(line));

  const contactFor = (audience: CareAudience): CareContact => (audience === "doctor" ? contacts.doctor : contacts.emergencyContact);
  const renderFor = (summary: CareSummaryRow, audience: CareAudience) =>
    audience === "doctor" ? doctorSummary(summary.facts, contacts) : familySummary(summary.facts, contacts);

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
    const doctor = await deliver({ audience: "doctor", kind: "summary", summaryId: summary.id, key: keyFor("doctor"), text: renderFor(summary, "doctor") });
    const family = await deliver({ audience: "family", kind: "summary", summaryId: summary.id, key: keyFor("family"), text: renderFor(summary, "family") });
    return { summaryId: summary.id, doctor, family };
  }

  return {
    sendSummaries,

    /** The day's summary unless one already exists for that day (any trigger). For the noon job. */
    async ensureDaySummary(day: string): Promise<SummaryResult | undefined> {
      if (hasCareSummaryForDay(db, patientId, day)) return undefined;
      return sendSummaries(day, DAY_TRIGGER);
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

      const intent = classifyInbound(audience, message.text);
      let reply = fixedReply(intent, summary?.facts, contacts);
      if (reply === undefined) {
        reply = summary
          ? await writeReply(
              deps.writer,
              {
                contact,
                contacts,
                facts: summary.facts,
                summaryText: renderFor(summary, audience),
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
