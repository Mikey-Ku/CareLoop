import type { Db } from "../db/index.ts";
import type { HealthRecord } from "../finchnode/types.ts";
import type { LlmClient } from "../llm/types.ts";
import type { InboundMessage, Messenger } from "../relay/messenger.ts";
import type { ExtractedPaper } from "../rules/paper-diff.ts";

// Contract for the check-in engine (src/checkin/engine.ts). The terminal
// simulator and, in run 2, the Relay webhook server both drive it through this.

export type Clock = {
  /** ISO timestamp for stored rows. */
  now(): string;
};

export type EngineDeps = {
  db: Db;
  messenger: Messenger;
  clock: Clock;
  /** Reads a FinchNode snapshot for a subject (live client or recorded fixture). Throws ConsentInactiveError on 410. */
  loadSnapshot(subject: string): Promise<HealthRecord>;
  /**
   * Reads what she types instead of tapping (free text). Optional: without it a typed reply counts
   * only when it equals a button label, as before, and a message outside a check-in gets a fixed reply.
   */
  llm?: LlmClient | undefined;
};

/**
 * Extra fields on a stored answer (checkins.answers_json) when what she typed was mapped to a
 * button: how it came in and her words. A tap, or typing the label itself, stores neither.
 */
export type FreeTextAnswer = { via: "free_text"; freeText: string };

export type DayResult =
  | { kind: "sent"; questionIds: string[] }
  | { kind: "already_started" }
  | { kind: "record_consent_ended" };

export interface CheckinEngine {
  /**
   * Morning job for one patient on one check-in date (YYYY-MM-DD): snapshot, rules,
   * flag sync, then the check-in message. Idempotent per patient and day.
   */
  startDay(patientId: string, day: string): Promise<DayResult>;
  /**
   * Every message from the senior's chat (button taps and free text). Messages from other chats are ignored,
   * family chats included: a family member can never answer a check-in or change her sharing level.
   * Besides the check-in it handles, at any time: "Sharing" (the sharing menu and a tap on a level), and the
   * paper check's "Yes, that's right" / "No, something's off" and the R6 follow-up buttons.
   * A button tap whose replyTo is not the message waiting for an answer (a stale tap) re-sends the
   * current prompt instead of recording an answer; typed text without replyTo is matched as before.
   * Free text (with `llm`): typed text that isn't a label is mapped to one of an ordinary question's
   * buttons, quoted back for a one-tap confirm on a red-flag question, and answered as small talk when
   * nothing is pending. Never more than one reply per message; a message already handled never reaches the LLM.
   */
  handleInbound(message: InboundMessage): Promise<void>;
  /** Noon job: a check-in still unanswered becomes missed and every linked family chat is told. */
  runMissedCheckin(patientId: string, day: string): Promise<"marked_missed" | "nothing_to_do">;
  /**
   * Hospital paper check, after the photo was read: stores a paper_scans row and sends her the read-back
   * with "Yes, that's right" / "No, something's off". Her answer arrives through handleInbound.
   * Idempotent per Relay attachment id. Not a check-in.
   */
  startPaperCheck(patientId: string, paper: ExtractedPaper, attachmentId?: string): Promise<{ scanId: number }>;
}
