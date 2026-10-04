import type { Db } from "../db/index.ts";
import type { HealthRecord } from "../finchnode/types.ts";
import type { LlmClient } from "../llm/types.ts";
import type { InboundMessage, Messenger } from "../relay/messenger.ts";
import type { ExtractedPaper } from "../rules/paper-diff.ts";
import type { SafetyKind } from "../safety/screen.ts";
import type { UnderstoodItem } from "./copy.ts";

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
 * "voice": she said it on a video check-in call (recordSpokenCheckin); `freeText` is what she said.
 * A tap, or typing the label itself, stores neither.
 */
export type FreeTextAnswer = { via: "free_text" | "confirmed" | "voice"; freeText: string };

/** One thing she said on a call: `id` is stable for the turn (it dedupes the safety path), `text` her words. */
export type SpokenTurn = { id: string; text: string };

/** What the call's voice may know before it starts: no record details beyond what the check-in uses. */
export type CallCheckinContext = {
  firstName: string;
  /** Today's check-in questions she hasn't answered yet; when she has answered them all, all of them again (the call is a full check-in). */
  questions: { id: string; text: string }[];
  /** Yesterday's level 1+ topics in plain words ("ankle swelling", "knee pain"). */
  yesterday: string[];
  /** Up to 3 recent memories ("granddaughter visiting Sunday"). */
  memories: string[];
  /** Family members with a linked chat (display name, else handle). */
  familyNames: string[];
};

/** The severity ladder's reading of what she said on a call. */
export type SpokenCheckinResult = {
  /** The highest level, safety included. */
  level: number;
  /** Set when the safety screen or the model read a crisis or an urgent symptom. */
  safety?: SafetyKind;
  /** What was understood (answers recorded, symptoms by topic), for the fixed read-back lines. */
  items: UnderstoodItem[];
  /** The post-call message sent to her chat (record mode only). */
  summaryMessageId?: string;
};

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
   * current prompt instead of recording an answer; typed text without replyTo goes to the most recently sent
   * prompt still waiting for her (engine.ts "Latest prompt wins").
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

  // Video check-in calls (src/calls, docs/CALLS.md): what she says goes through the same safety screen,
  // understanding pass and severity ladder as what she types.

  /**
   * Before a call is answered: her first name, today's unanswered questions (the day's check-in is
   * created without a greeting when there is none yet), yesterday's level 1+ topics, up to 3 memories,
   * family names. Never throws for a missing record: no questions then.
   */
  callCheckinContext(patientId: string, day: string): Promise<CallCheckinContext>;
  /**
   * One of her turns as it arrives: the safety screen, and on a hit the same safety path as a typed
   * message (crisis or urgent reply in her chat, every family chat alerted at every sharing level, an
   * observation at 4 or 5, a follow-up). Once per turn id.
   */
  screenSpokenTurn(patientId: string, turn: SpokenTurn): Promise<{ kind: SafetyKind; level: number } | undefined>;
  /**
   * Her call's turns through the understanding pass: the safety screen per turn (as screenSpokenTurn),
   * extraction against today's unanswered questions with the classifier alongside, fixed rules level
   * everything. `assessOnly`: the level and what was understood, nothing recorded (safety still acts).
   * Otherwise answers are recorded via "voice", observations and notes as for typed words, memories
   * saved, a follow-up at 2, the family alert at 3, and with `callId` ONE message to her chat ("Here's
   * what I noted from our call: ...", "That's right" / "Something's wrong").
   */
  recordSpokenCheckin(
    patientId: string,
    day: string,
    turns: readonly SpokenTurn[],
    options?: { callId?: string; assessOnly?: boolean; reading?: { heartRate: number | null; breathingRate: number | null } },
  ): Promise<SpokenCheckinResult>;
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
