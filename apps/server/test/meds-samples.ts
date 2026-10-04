import * as copy from "../src/checkin/copy.ts";
import { loadRxNavCache, loadSnapshot } from "../src/finchnode/fixtures.ts";
import { activeMedications, normalizeHealthRecord } from "../src/finchnode/normalize.ts";
import { medicationSchedule, medsForSlot, type ScheduledMedication } from "../src/meds/schedule.ts";

// Sample inputs for the medication helper's copy (shared by test/copy.test.ts and test/meds.test.ts).
// Harriet's synthetic record: her 14 prescriptions and their instructions.

export const NAME = "Harriet";

export const harrietRecord = normalizeHealthRecord(loadSnapshot("patient-demo-polypharmacy"), { rxnav: loadRxNavCache() });
export const harrietSchedule: ScheduledMedication[] = medicationSchedule(activeMedications(harrietRecord));

const line = (s: ScheduledMedication) => ({ name: s.name, instructions: s.instructions });

/** Every medication helper reply and message, from Harriet's medicines and a spread of inputs. */
export function medsOutputs(): string[] {
  const morning = medsForSlot(harrietSchedule, "morning").map(line);
  const evening = medsForSlot(harrietSchedule, "evening").map(line);
  const bedtime = medsForSlot(harrietSchedule, "bedtime").map(line);
  const out: string[] = [
    copy.medsReminder(NAME, "morning", morning),
    copy.medsReminder(NAME, "evening", evening, bedtime),
    copy.medsReminder(NAME, "evening", [], bedtime),
    copy.medsReminder(NAME, "evening", evening),
    copy.medsTakenReply(NAME, "morning"),
    copy.medsTakenReply(NAME, "evening"),
    copy.medsNotYetReply(NAME, true),
    copy.medsNotYetReply(NAME, false),
    copy.medsNudge(NAME, "morning"),
    copy.medsNudge(NAME, "evening"),
    copy.medsQuestionPrompt(NAME),
    copy.memoryCheckRight(NAME),
    copy.labelNotOnList(),
    copy.labelUnreadable(),
    copy.labelNoRecord(),
    copy.photoOther(NAME),
    copy.photoReadFailed(NAME),
    copy.photoRejected(),
    copy.photoCouldNotOpen(NAME),
    copy.refillAskedReply(NAME),
    copy.refillTomorrowReply(NAME),
    copy.familyMedsNotConfirmed(NAME),
    copy.MEDS_NOT_CONFIRMED_LINE,
    copy.READING_PHOTO_ACTIVITY,
  ];
  for (const s of harrietSchedule) {
    out.push(copy.medsLine(line(s)));
    if (s.instructions) {
      out.push(copy.labelSaysLine(s.instructions), copy.labelMatchReply(s.plain, s.instructions, "label"), copy.labelMatchReply(s.plain, s.instructions, "list"));
    }
    out.push(copy.labelMatchReply(s.plain, undefined));
    for (const slot of ["morning", "midday", "evening", "bedtime"] as const) out.push(copy.memoryCheckQuestion(s.ingredient, s.count?.unit ?? "tablet", slot));
    out.push(copy.labelStrengthDiffers(s.ingredient, "2.5 mg", s.plain.slice(s.ingredient.length + 1) || "5 mg"));
    out.push(copy.familyRefillNotice(NAME, s.plain, "Aug 1"));
    for (const born of [undefined, "March 2, 1948"])
      for (const prescriber of [undefined, "Dr. Rivera"])
        out.push(
          copy.refillReminder({ medicine: s.plain, daysSupply: 30, filled: "Jul 2", runOut: "Aug 1", fullName: "Harriet Lindqvist", born, item: `${s.plain} tablets`, prescriber }),
        );
  }
  for (const names of [undefined, [], ["Sarah"], ["Sarah", "Tom"]]) out.push(copy.refillToldFamilyReply(NAME, names));
  for (const names of [[], ["Sarah"], ["Sarah Lindqvist"], ["Sarah", "Tom"]]) {
    const button = copy.refillTellButton(names);
    if (button) out.push(button);
  }
  for (const n of [1, 2, 3]) out.push(...copy.memoryCheckButtons(n));
  out.push(...Object.values(copy.MEDS_BUTTONS), ...Object.values(copy.REFILL_BUTTONS), copy.MEMORY_NOT_SURE);
  return out;
}

/** The medication helper's new copy functions, for test/copy.test.ts "covers every exported function". */
export const MEDS_COPY_FUNCTIONS = [
  "medsLine", "medsReminder", "medsTakenReply", "medsNotYetReply", "medsNudge", "medsQuestionPrompt", "memoryCheckQuestion",
  "memoryCheckButtons", "memoryCheckRight", "labelSaysLine", "labelMatchReply", "labelStrengthDiffers", "labelNotOnList",
  "labelUnreadable", "labelNoRecord", "photoOther", "photoReadFailed", "photoRejected", "photoCouldNotOpen", "refillTellButton",
  "refillReminder", "refillAskedReply", "refillTomorrowReply", "refillToldFamilyReply", "familyRefillNotice", "familyMedsNotConfirmed",
];
