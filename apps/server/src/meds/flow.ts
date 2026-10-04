import {
  MEDS_BUTTONS,
  MEMORY_NOT_SURE,
  REFILL_BUTTONS,
  familyMedsNotConfirmed,
  familyRefillNotice,
  familyRelayWaiting,
  labelMatchReply,
  labelNotOnList,
  labelSaysLine,
  labelStrengthDiffers,
  labelUnreadable,
  medsNotYetReply,
  medsNudge,
  medsQuestionPrompt,
  medsReminder,
  medsTakenReply,
  memoryCheckButtons,
  paperChangeNote,
  withPaperNote,
  memoryCheckQuestion,
  memoryCheckRight,
  refillAskedReply,
  refillReminder,
  refillTellButton,
  refillToldFamilyReply,
  refillTomorrowReply,
  withLead,
} from "../checkin/copy.ts";
import type { Clock } from "../checkin/engine-types.ts";
import { getCheckin, getCheckinPrompt, type CheckinPatient } from "../db/checkins.ts";
import { addFamilyRelay } from "../db/family.ts";
import { getSharing, type Db } from "../db/index.ts";
import {
  answerMemoryCheck,
  getDose,
  getDoseById,
  getMedPrompt,
  getRefill,
  getRefillById,
  insertDose,
  insertLabelCheck,
  labelCheckFor,
  markMemoryAsked,
  markRefillFamilyTold,
  markRefillReminded,
  memoryCheckById,
  memoryCheckFor,
  memoryChecksAskedBefore,
  openDose,
  openRefill,
  pendingMemoryCheck,
  planMemoryCheck,
  planNudge,
  refillsRemindedOn,
  setDoseStatus,
  setRefillStatus,
  type DoseRow,
  type LabelOutcome,
  type MedPromptKind,
  type MemoryCheckRow,
  type RefillRow,
  type ReminderSlot,
} from "../db/meds.ts";
import { addVisitQuestion } from "../db/notes.ts";
import { closeWaitingPrompts, openWaitingPrompt } from "../db/waiting-prompts.ts";
import { addObservation } from "../db/observations.ts";
import type { Medication } from "../finchnode/normalize.ts";
import type { DischargePaperReading, MedicineLabelReading } from "../llm/types.ts";
import type { InboundMessage, OutboundMessage } from "../relay/messenger.ts";
import type { ExtractedPaper } from "../rules/paper-diff.ts";
import { sameIngredient, sameStrength } from "../rules/paper-diff.ts";
import { looksLikeInstructions } from "../safety/injection.ts";
import { MAX_REFILL_REMINDERS_PER_DAY, longDay, shortDay, type RefillDue } from "./refills.ts";
import { addDays } from "../days.ts";
import { paperChangeFor, unresolvedPaperChanges } from "./paper-notes.ts";
import { labelInstructions, medicineWords, medsForSlot, memoryCandidates, plainName, strengthWords, type ScheduledMedication } from "./schedule.ts";

// The medication helper's planning, inside the engine's transactions (like src/checkin/paper-flow.ts):
// synchronous, returns what to send. The engine loads her record first and delivers after.
//
// Reminder (morning, evening): her medicines for that time with her prescription's words verbatim,
// buttons "Taken" / "Not yet" / "I have a question" (med_doses).
//   Taken    -> recorded. Morning: the check-in's "morning-medicines" question that day is recorded as
//               "Yes" and not asked (hooks.morningTaken); with no check-in step waiting, the day's memory
//               check follows in the same message.
//   Not yet  -> one gentle re-reminder after MEDS_NUDGE_MINUTES (runMedsNudges), never more, no guilt.
//   I have a question -> "Go ahead" (a waiting prompt, src/db/waiting-prompts.ts); her next typed message,
//               unless something newer was sent since (engine.ts "Latest prompt wins"), is her medicine
//               question: the fixed "ask your doctor or pharmacist" reply, and it goes on her visit list.
//   No "Taken" by MISSED_CHECKIN_TIME -> missed; her family's daily status at "all" says so. No alert.
// Memory check: one medicine a day, rotating through scheduled medicines with a known count. Right ->
// "That's right"; wrong or "Not sure" -> only her label's words. Typed numbers count ("one", "just one").
// Refills: guide, don't act (src/meds/refills.ts). At most MAX_REFILL_REMINDERS_PER_DAY a day.
// Hospital papers (src/meds/paper-notes.ts): while an R6 discrepancy is unresolved, a medicine her papers say
// was stopped or changed gets paperChangeNote after its words in the reminder, the memory check and a
// matching label photo. It stays on her list; nothing tells her to stop it.
// Label photos: matched with her list by ingredient and strength (src/rules/paper-diff.ts helpers).
// A mismatch or an unknown medicine goes on her visit list and is a level-2 "medicine check"
// observation for her doctor; no family alert.
//
// A typed button label is the check-in's when the check-in's own step shows that label ("Not yet" is
// also a morning-medicines answer); a tap names its message (med_prompts), so it always lands here.

/** Which helper prompt a send carries; stored with its message id once it is out (med_prompts). */
export type MedPromptRef = { patientId: string; kind: MedPromptKind; refId: number };
export type MedSend = { chatId: string; message: OutboundMessage; key: string; medPrompt?: MedPromptRef };

/** What the check-in engine lends the medication helper. */
export type MedsHooks = {
  /** One send per linked family chat, keyed `${prefix}:family:<handle>`. */
  toFamily(patient: CheckinPatient, text: string, prefix: string): MedSend[];
  /** The names of the family members whose chats are linked (display name, else handle). */
  familyNames(patientId: string): string[];
  /**
   * "Taken" on the morning reminder of `day`: the check-in's morning-medicines question is recorded as "Yes".
   * `advanced`: that question was the one waiting, and `sends` carry the check-in's next step.
   */
  morningTaken(patient: CheckinPatient, day: string, chatId: string): { sends: MedSend[]; advanced: boolean };
  /** The check-in step waiting for her, again (nothing when none waits). */
  reprompt(patient: CheckinPatient, chatId: string, messageId: string): MedSend[];
  /** Whether a check-in step is waiting for her. */
  checkinBusy(patientId: string): boolean;
  /** Whether the check-in's waiting step shows this button label (then a typed label is the check-in's). */
  checkinTakes(patient: CheckinPatient, text: string): boolean;
};

export type MedsOptions = {
  /** MEDS_NUDGE_MINUTES: "Not yet" to the one re-reminder. */
  nudgeMinutes: number;
};

export const DEFAULT_MEDS_NUDGE_MINUTES = 60;

export const REMINDER_BUTTONS: readonly string[] = [MEDS_BUTTONS.taken, MEDS_BUTTONS.notYet, MEDS_BUTTONS.question];

/** Every fixed label the helper sends (the engine treats a late one as a tap, not small talk). */
export const MEDS_LABELS: readonly string[] = [...REMINDER_BUTTONS, MEMORY_NOT_SURE, REFILL_BUTTONS.asked, REFILL_BUTTONS.tomorrow, "Tell my family"];

const norm = (s: string) => s.trim().toLowerCase();
const is = (text: string, label: string) => norm(text) === norm(label);

type DoseAction = "taken" | "not_yet" | "question";

function doseAction(text: string): DoseAction | undefined {
  if (is(text, MEDS_BUTTONS.taken)) return "taken";
  if (is(text, MEDS_BUTTONS.notYet)) return "not_yet";
  if (is(text, MEDS_BUTTONS.question)) return "question";
  return undefined;
}

const COUNT_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 };

/**
 * Her answer to "how many do you take?": a count (tapped, or typed as "1", "one", "just one", "two tablets")
 * or "not_sure" ("Not sure", "I don't know"). Undefined for anything else.
 */
export function memoryAnswer(text: string): number | "not_sure" | undefined {
  const t = norm(text).replace(/[.!?]+$/, "").replace(/\s+/g, " ");
  if (/^(?:not sure|i'?m not sure|unsure|no idea|(?:i )?don'?t know|(?:i )?can'?t remember|i forget)$/.test(t)) return "not_sure";
  const match = /^(?:i take |i think )?(?:just |only )?(\d+|one|two|three|four|five|six)(?: (?:tablets?|capsules?|pills?))?$/.exec(t);
  if (!match) return undefined;
  const raw = match[1]!;
  const n = /^\d+$/.test(raw) ? Number(raw) : COUNT_WORDS[raw];
  return n !== undefined && n > 0 ? n : undefined;
}

type RefillAction = "asked" | "tomorrow" | "tell";

/** Longest text read from a photo that is ever echoed back. */
const MAX_LABEL_WORDS = 200;

/** A label's printed instructions, safe to read back word for word, or undefined. */
function labelWordsFromPhoto(instructions: string | undefined): string | undefined {
  const words = labelInstructions(instructions?.replace(/"/g, "'"));
  if (!words || words.length > MAX_LABEL_WORDS || /[–—]/.test(words) || looksLikeInstructions(words)) return undefined;
  return words;
}

/** A medicine name read from a photo, for her visit list: plain characters, short. */
function safeName(name: string): string {
  return name.replace(/[^A-Za-z0-9 .,%/()+-]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);
}

/** Discharge papers read off a photo, as the paper check reads them (R6 after her confirm). */
export function paperFromReading(p: DischargePaperReading): ExtractedPaper {
  return {
    kind: "discharge",
    ...(p.organization ? { organization: p.organization } : {}),
    ...(p.date && /^\d{4}-\d{2}-\d{2}$/.test(p.date) ? { date: p.date } : {}),
    medications: p.medications
      .filter((m) => typeof m.name === "string" && m.name.trim().length > 0)
      .map((m) => ({
        name: m.name.trim(),
        ...(m.strength ? { strength: m.strength } : {}),
        ...(m.instructions ? { instructions: m.instructions } : {}),
        change: m.change,
      })),
    synthetic: true,
  };
}

/** What a label check decided, before anything is written. */
export type LabelResult =
  | { outcome: "match"; med: Medication; instructions: string | undefined; from: "label" | "list"; reply: string }
  | { outcome: "strength_differs"; med: Medication; labelStrength: string; reply: string }
  | { outcome: "not_on_list"; reply: string }
  | { outcome: "unreadable"; reply: string };

/**
 * A photographed label against her active medicines: same ingredient and strength is a match; same
 * ingredient at another strength is a mismatch; no such ingredient is not on her list; low confidence,
 * no name or no strength read is unreadable. Pure.
 */
export function checkLabel(label: MedicineLabelReading, active: readonly Medication[]): LabelResult {
  const unreadable: LabelResult = { outcome: "unreadable", reply: labelUnreadable() };
  const name = typeof label.medicineName === "string" ? label.medicineName.trim() : "";
  if (label.confidence === "low" || !name) return unreadable;
  const matches = active.filter((m) => sameIngredient(name, m.name));
  if (matches.length === 0) return { outcome: "not_on_list", reply: labelNotOnList() };
  const labelStrength = strengthWords(label.strength) ?? strengthWords(name);
  if (!labelStrength) return unreadable;
  const same = matches.find((m) => sameStrength(labelStrength, m.strength) === true);
  if (same) {
    const fromLabel = labelWordsFromPhoto(label.instructions);
    const instructions = fromLabel ?? labelInstructions(same.sig);
    const from = fromLabel ? "label" : "list";
    return { outcome: "match", med: same, instructions, from, reply: labelMatchReply(plainName(same), instructions, from) };
  }
  const other = matches.find((m) => sameStrength(labelStrength, m.strength) === false);
  if (!other) return unreadable;
  const listStrength = strengthWords(other.strength) ?? "another strength";
  return { outcome: "strength_differs", med: other, labelStrength, reply: labelStrengthDiffers(medicineWords(other.name), labelStrength, listStrength) };
}

export function createMedsFlow(deps: { db: Db; clock: Clock; hooks: MedsHooks; options: MedsOptions }) {
  const { db, clock, hooks, options } = deps;
  const plusMinutes = (iso: string, minutes: number) => new Date(Date.parse(iso) + minutes * 60_000).toISOString();
  /** The hospital-papers note for a medicine on her list, or undefined (src/meds/paper-notes.ts). */
  const paperNote = (patientId: string, med: { name: string; strength?: string | undefined }): string | undefined => {
    const kind = paperChangeFor(unresolvedPaperChanges(db, patientId), med);
    return kind ? paperChangeNote(kind) : undefined;
  };
  const reply = (patient: CheckinPatient, msg: InboundMessage, text: string, extra: Partial<MedSend> = {}): MedSend => ({
    chatId: msg.chatId,
    message: { text },
    key: `${patient.id}:meds:${msg.messageId}`,
    ...extra,
  });

  function refillAction(patient: CheckinPatient, text: string, tapped: boolean): RefillAction | undefined {
    if (is(text, REFILL_BUTTONS.asked)) return "asked";
    if (is(text, REFILL_BUTTONS.tomorrow)) return "tomorrow";
    const tell = refillTellButton(hooks.familyNames(patient.id));
    if ((tell && is(text, tell)) || is(text, "Tell my family") || (tapped && /^tell\s+\S+$/i.test(text.trim()))) return "tell";
    return undefined;
  }

  function planDose(patient: CheckinPatient, msg: InboundMessage, dose: DoseRow, action: DoseAction): MedSend[] {
    const name = patient.preferredName;
    const now = clock.now();
    const again = () => hooks.reprompt(patient, msg.chatId, msg.messageId);
    switch (action) {
      case "taken": {
        closeWaitingPrompts(db, patient.id, now, "meds_question");
        const already = dose.status === "taken";
        if (!already) setDoseStatus(db, dose.id, "taken", now);
        const thanks = medsTakenReply(name, dose.slot);
        if (dose.slot !== "morning" || already) return [reply(patient, msg, thanks), ...again()];
        const checkin = hooks.morningTaken(patient, dose.day, msg.chatId);
        if (checkin.advanced) return [reply(patient, msg, thanks), ...checkin.sends];
        if (hooks.checkinBusy(patient.id)) return [reply(patient, msg, thanks), ...again()];
        const memory = memoryCheckFor(db, patient.id, dose.day);
        if (!memory || memory.askedAt !== null) return [reply(patient, msg, thanks)];
        markMemoryAsked(db, memory.id, now);
        const question = withPaperNote(memoryCheckQuestion(memory.ingredient, memory.unit, memory.slot), paperNote(patient.id, { name: memory.ingredient }));
        const text = withLead(thanks, question);
        return [reply(patient, msg, text, { message: { text, buttons: memoryCheckButtons(memory.count) }, medPrompt: { patientId: patient.id, kind: "memory", refId: memory.id } })];
      }
      case "not_yet": {
        closeWaitingPrompts(db, patient.id, now, "meds_question");
        if (dose.status === "taken") return [reply(patient, msg, medsNotYetReply(name, false)), ...again()];
        setDoseStatus(db, dose.id, "not_yet", now);
        const remind = dose.nudgedAt === null && planNudge(db, dose.id, plusMinutes(now, options.nudgeMinutes));
        return [reply(patient, msg, medsNotYetReply(name, remind)), ...again()];
      }
      case "question":
        openWaitingPrompt(db, { patientId: patient.id, kind: "meds_question", refId: dose.id, at: now });
        return [reply(patient, msg, medsQuestionPrompt(name))];
    }
  }

  function planMemoryAnswer(patient: CheckinPatient, msg: InboundMessage, m: MemoryCheckRow, answer: number | "not_sure"): MedSend[] {
    const correct = answer === m.count;
    if (!answerMemoryCheck(db, m.id, answer === "not_sure" ? MEMORY_NOT_SURE : String(answer), correct, clock.now())) return [];
    // Right: said so. Wrong or not sure: only her label's words, nothing more.
    const said = correct ? memoryCheckRight(patient.preferredName) : labelSaysLine(m.instructions);
    const text = withPaperNote(said, paperNote(patient.id, { name: m.ingredient }));
    return [reply(patient, msg, text), ...hooks.reprompt(patient, msg.chatId, msg.messageId)];
  }

  function planRefillAnswer(patient: CheckinPatient, msg: InboundMessage, r: RefillRow, action: RefillAction): MedSend[] {
    const name = patient.preferredName;
    const now = clock.now();
    const again = () => hooks.reprompt(patient, msg.chatId, msg.messageId);
    switch (action) {
      case "asked":
        setRefillStatus(db, r.id, "asked", now);
        return [reply(patient, msg, refillAskedReply(name)), ...again()];
      case "tomorrow":
        setRefillStatus(db, r.id, "snoozed", now, addDays(r.lastRemindedDay ?? now.slice(0, 10), 1));
        return [reply(patient, msg, refillTomorrowReply(name)), ...again()];
      case "tell": {
        const notice = familyRefillNotice(name, r.name, shortDay(r.runOut));
        const names = hooks.familyNames(patient.id);
        if (names.length === 0) {
          // Nobody linked yet: kept and passed on when someone is (the engine's passOnFamilyMessages).
          addFamilyRelay(db, { patientId: patient.id, text: notice, createdAt: now, passedOnAt: null });
          return [reply(patient, msg, familyRelayWaiting(name)), ...again()];
        }
        markRefillFamilyTold(db, r.id, now);
        return [
          ...hooks.toFamily(patient, notice, `${patient.id}:refill:${r.id}:${msg.messageId}`),
          reply(patient, msg, refillToldFamilyReply(name, names)),
          ...again(),
        ];
      }
    }
  }

  return {
    /**
     * A tap on a reminder, memory check or refill message, or one of their labels typed. Undefined when
     * it isn't the helper's (the check-in takes it).
     */
    planTap(patient: CheckinPatient, msg: InboundMessage): MedSend[] | undefined {
      const text = msg.text.trim();
      const prompt = msg.replyTo ? getMedPrompt(db, msg.replyTo) : undefined;
      if (prompt && prompt.patientId === patient.id) {
        if (prompt.kind === "dose") {
          const dose = getDoseById(db, prompt.refId);
          const action = doseAction(text);
          return dose && action ? planDose(patient, msg, dose, action) : undefined;
        }
        if (prompt.kind === "memory") {
          const m = memoryCheckById(db, prompt.refId);
          const answer = memoryAnswer(text);
          return m && answer !== undefined ? planMemoryAnswer(patient, msg, m, answer) : undefined;
        }
        const r = getRefillById(db, prompt.refId);
        const action = refillAction(patient, text, true);
        return r && action ? planRefillAnswer(patient, msg, r, action) : undefined;
      }
      // A tap on one of the check-in's messages is the check-in's.
      if (msg.replyTo && getCheckinPrompt(db, msg.replyTo)) return undefined;
      // A typed label: the check-in's when its waiting step shows it.
      if (hooks.checkinTakes(patient, text)) return undefined;
      const action = doseAction(text);
      const dose = action ? openDose(db, patient.id) : undefined;
      if (action && dose) return planDose(patient, msg, dose, action);
      const m = pendingMemoryCheck(db, patient.id);
      const answer = m ? memoryAnswer(text) : undefined;
      if (m && answer !== undefined) return planMemoryAnswer(patient, msg, m, answer);
      const r = openRefill(db, patient.id);
      const refill = r ? refillAction(patient, text, false) : undefined;
      if (r && refill) return planRefillAnswer(patient, msg, r, refill);
      return undefined;
    },

    /**
     * The morning or evening reminder for `day` (the evening one with her bedtime medicines too). The
     * morning one also plans the day's memory check. Undefined when this one already went out; [] when
     * she takes nothing at that time.
     */
    planReminder(patient: CheckinPatient, day: string, slot: ReminderSlot, schedule: readonly ScheduledMedication[]): MedSend[] | undefined {
      const chatId = patient.relayChatId;
      if (!chatId) return [];
      const changes = unresolvedPaperChanges(db, patient.id);
      const line = (s: ScheduledMedication) => {
        const kind = paperChangeFor(changes, s.med);
        return { name: s.name, instructions: s.instructions, ...(kind ? { note: paperChangeNote(kind) } : {}) };
      };
      const lines = medsForSlot(schedule, slot).map(line);
      const bedtime = slot === "evening" ? medsForSlot(schedule, "bedtime").map(line) : [];
      if (lines.length === 0 && bedtime.length === 0) return [];
      const now = clock.now();
      const doseId = insertDose(db, { patientId: patient.id, day, slot, sentAt: now });
      if (doseId === undefined) return undefined;
      if (slot === "morning") {
        // One medicine a day, in turn, among those with a known count.
        const candidates = memoryCandidates(schedule);
        const pick = candidates[memoryChecksAskedBefore(db, patient.id, day) % Math.max(candidates.length, 1)];
        if (pick)
          planMemoryCheck(db, {
            patientId: patient.id,
            day,
            medicationKey: pick.med.key,
            ingredient: pick.med.ingredient,
            unit: pick.count.unit,
            slot: pick.slot,
            count: pick.count.n,
            instructions: pick.instructions,
            plannedAt: now,
          });
      }
      return [
        {
          chatId,
          message: { text: medsReminder(patient.preferredName, slot, lines, bedtime), buttons: [...REMINDER_BUTTONS] },
          key: `${patient.id}:${day}:meds-${slot}`,
          medPrompt: { patientId: patient.id, kind: "dose", refId: doseId },
        },
      ];
    },

    /** The one re-reminder for a dose still "not yet". */
    nudgeSend(patient: CheckinPatient, dose: DoseRow): MedSend | undefined {
      if (!patient.relayChatId) return undefined;
      return {
        chatId: patient.relayChatId,
        message: { text: medsNudge(patient.preferredName, dose.slot), buttons: [...REMINDER_BUTTONS] },
        key: `${patient.id}:${dose.day}:meds-${dose.slot}:nudge`,
        medPrompt: { patientId: patient.id, kind: "dose", refId: dose.id },
      };
    },

    /**
     * Refill reminders for `day`: fills due (soonest first), skipping those she has asked for, snoozed
     * past today, or reminded about today already; at most MAX_REFILL_REMINDERS_PER_DAY a day.
     */
    planRefills(
      patient: CheckinPatient,
      day: string,
      due: readonly RefillDue[],
      who: { fullName: string; birthDate: string | undefined },
    ): MedSend[] {
      const chatId = patient.relayChatId;
      if (!chatId) return [];
      const now = clock.now();
      let sentToday = refillsRemindedOn(db, patient.id, day);
      const tell = refillTellButton(hooks.familyNames(patient.id));
      const sends: MedSend[] = [];
      for (const d of due) {
        if (sentToday >= MAX_REFILL_REMINDERS_PER_DAY) break;
        const row = getRefill(db, patient.id, d.medicationKey, d.fillDate);
        if (row?.status === "asked" || row?.lastRemindedDay === day) continue;
        if (row?.snoozedUntil && row.snoozedUntil > day) continue;
        const id = markRefillReminded(db, { patientId: patient.id, medicationKey: d.medicationKey, fillDate: d.fillDate, name: d.plain, runOut: d.runOut, day, at: now });
        sentToday += 1;
        const text = refillReminder({
          medicine: d.plain,
          daysSupply: d.daysSupply,
          filled: shortDay(d.fillDate),
          runOut: shortDay(d.runOut),
          fullName: who.fullName,
          born: who.birthDate ? longDay(who.birthDate) : undefined,
          item: d.form ? `${d.plain} ${d.form}s` : d.plain,
        });
        sends.push({
          chatId,
          message: { text, buttons: [REFILL_BUTTONS.asked, REFILL_BUTTONS.tomorrow, ...(tell ? [tell] : [])] },
          key: `${patient.id}:${day}:refill:${d.medicationKey}:${d.fillDate}`,
          medPrompt: { patientId: patient.id, kind: "refill", refId: id },
        });
      }
      return sends;
    },

    /**
     * MISSED_CHECKIN_TIME: a morning reminder with no "Taken" is missed. Her family hears it only at
     * "all", in the daily status; when that already went out (or won't come), as one line now. No alert.
     * Undefined when there was nothing to mark.
     */
    planMissed(patient: CheckinPatient, day: string): MedSend[] | undefined {
      const dose = getDose(db, patient.id, day, "morning");
      if (!dose || dose.status === "taken" || dose.status === "missed") return undefined;
      setDoseStatus(db, dose.id, "missed", clock.now());
      if ((getSharing(db, patient.id) ?? "status") !== "all") return [];
      const c = getCheckin(db, patient.id, day);
      if (c && c.finishedAt === null && c.status !== "missed") return []; // her daily status is still to come and will say it
      return hooks.toFamily(patient, familyMedsNotConfirmed(patient.preferredName), `${patient.id}:${day}:meds-missed`);
    },

    /**
     * A photographed medicine label, against her active medicines on `day`. A mismatch or an unknown
     * medicine goes on her visit list and is a level-2 "medicine check" observation (once per attachment).
     */
    planLabel(
      patient: CheckinPatient,
      attachmentId: string,
      label: MedicineLabelReading,
      active: readonly Medication[],
      at: { day: string; checkinId: number | null },
    ): { sends: MedSend[]; outcome: LabelOutcome } {
      const result = checkLabel(label, active);
      const now = clock.now();
      if (!labelCheckFor(db, patient.id, attachmentId)) {
        const labelName = typeof label.medicineName === "string" ? safeName(label.medicineName) : "";
        insertLabelCheck(db, {
          patientId: patient.id,
          attachmentId,
          outcome: result.outcome,
          medicationKey: result.outcome === "match" || result.outcome === "strength_differs" ? result.med.key : null,
          labelMedicine: labelName || null,
          labelStrength: strengthWords(label.strength) ?? null,
          createdAt: now,
        });
        let question: string | undefined;
        if (result.outcome === "strength_differs") {
          const list = strengthWords(result.med.strength) ?? "another strength";
          question = `A medicine label I photographed says ${medicineWords(result.med.name)} ${result.labelStrength}, but my medication list has ${list}. Which is right?`;
        } else if (result.outcome === "not_on_list") {
          question = `A medicine label I photographed${labelName ? ` (${labelName})` : ""} isn't on my medication list. Should it be?`;
        }
        if (question) {
          addVisitQuestion(db, { patientId: patient.id, text: question, createdAt: now });
          addObservation(db, {
            patientId: patient.id,
            checkinId: at.checkinId,
            day: at.day,
            topic: "medicine check",
            level: 2,
            source: "photo",
            words: question,
            createdAt: now,
          });
        }
      }
      const chatId = patient.relayChatId;
      const reply = result.outcome === "match" ? withPaperNote(result.reply, paperNote(patient.id, result.med)) : result.reply;
      return { outcome: result.outcome, sends: chatId ? [{ chatId, message: { text: reply }, key: `${patient.id}:photo:${attachmentId}:label` }] : [] };
    },
  };
}

export type MedsFlow = ReturnType<typeof createMedsFlow>;
