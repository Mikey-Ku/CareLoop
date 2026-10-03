import type { Db } from "../db/index.ts";
import type { HealthRecord } from "../finchnode/types.ts";
import type { InboundMessage, Messenger } from "../relay/messenger.ts";

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
};

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
  /** Every message from the senior's chat (button taps and free text). Messages from other chats are ignored. */
  handleInbound(message: InboundMessage): Promise<void>;
  /** Noon job: a check-in still unanswered becomes missed and the family group is told. */
  runMissedCheckin(patientId: string, day: string): Promise<"marked_missed" | "nothing_to_do">;
}
