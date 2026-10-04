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
   * Reads what she types instead of tapping (free text): sorts each typed message into a kind
   * (classifyMessage) and writes small talk. Optional: without it a typed reply counts only when it
   * equals a button label (or is an explicit yes on a red-flag question), the safety screen still
   * runs, and anything else gets a fixed reply. Read on every message, so a getter can swap it.
   */
  llm?: LlmClient | undefined;
};

/**
 * Extra fields on a stored answer (checkins.answers_json) when what she typed was mapped to a
 * button: how it came in and her words. "free_text": her words were read as that answer.
 * "confirmed": her words suggested it on a red-flag question and she tapped "Yes, that's right".
 * A tap, or typing the label itself, stores neither.
 */
export type FreeTextAnswer = { via: "free_text" | "confirmed"; freeText: string };

export type DayResult =
  | { kind: "sent"; questionIds: string[] }
  | { kind: "already_started" }
  | { kind: "record_consent_ended" };

/** A medicines reminder: sent, already sent for that day and slot, nothing taken then, or no record to read (consent ended). */
export type MedsReminderResult = "sent" | "already_sent" | "nothing_to_send" | "no_record";

/**
 * What became of a photo she sent: not read (no LLM), a medicine label checked against her list, hospital
 * papers read back for her confirm, unreadable, something else, rejected (too large or not a photo type),
 * or failed (the model or her record couldn't be read; she was told).
 */
export type PhotoOutcome = "not_read" | "label" | "papers" | "unreadable" | "other" | "rejected" | "failed";

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
   * Typed messages: the safety screen first (a crisis or urgent symptom wins over everything). During the
   * check-in (her open reply, any message while a question waits, "Let me explain") one understanding pass
   * (engine.ts "One understanding pass") reads answers to any of today's unanswered questions and every
   * symptom, fixed rules level and record them (a red-flag question below level 3 only after her tap on a
   * suggested confirm), and one line says back what was understood before the next question. Otherwise
   * (engine.ts "Typed messages") the LLM sorts the message and fixed rules react: an answer, detail kept
   * for her doctor, a medicine question, feeling low, a message for her family, or small talk.
   * A message already handled never reaches the LLM. Also answers a follow-up's "Better" / "About the same" / "Worse".
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
  /**
   * Follow-up job (the agent runs it every minute; the simulator on /later): sends every follow-up
   * check-in due by `now` (ISO), "Checking in again, Harriet. How is your breathing now?" with
   * "Better" / "About the same" / "Worse". Each goes out once. Returns how many were sent.
   */
  runDueFollowUps(now: string): Promise<number>;
  /**
   * Passes on what she asked to be passed to her family while no family chat was linked yet, now that
   * one is. Returns how many messages went out (0 while still nobody is linked).
   */
  passOnFamilyMessages(patientId: string): Promise<number>;

  // Medication helper (src/meds/flow.ts). Taps on its buttons arrive through handleInbound.

  /**
   * MEDS_MORNING_TIME / MEDS_EVENING_TIME job: her medicines for that time (the evening one also lists
   * bedtime), her prescription's instructions verbatim, with "Taken" / "Not yet" / "I have a question".
   * Once per patient, day and slot. The morning one also plans the day's memory check.
   */
  sendMedsReminder(patientId: string, day: string, slot: "morning" | "evening"): Promise<MedsReminderResult>;
  /** Every minute: the one re-reminder after "Not yet", when due by `now` (ISO) and still not taken. Returns how many went out. */
  runMedsNudges(now: string): Promise<number>;
  /** Morning job: refill reminders for fills running out within REFILL_REMIND_DAYS (at most 2 a day). Returns how many went out. */
  runRefillCheck(patientId: string, day: string): Promise<number>;
  /** MISSED_CHECKIN_TIME job, after runMissedCheckin: a morning reminder with no "Taken" becomes missed (family status at "all" only). */
  runMedsMissed(patientId: string, day: string): Promise<"marked_missed" | "nothing_to_do">;
  /**
   * A photo from her chat (the inbox downloaded it; never logged). With an LLM it is read: a medicine
   * label is checked against her active medicines, discharge papers start the paper check, anything else
   * gets a kind fixed reply. Without one: photoNotYet. Her chat shows "Reading your photo" meanwhile.
   */
  handlePhoto(patientId: string, image: Uint8Array, mimeType: string, attachmentId: string): Promise<PhotoOutcome>;
}
