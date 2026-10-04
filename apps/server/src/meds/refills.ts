import { activeMedications, type Dispense, type Medication, type PatientRecord } from "../finchnode/normalize.ts";
import { doseForm, plainName } from "./schedule.ts";

// Refill reminders: guide, don't act (docs/BRIEF.md "Refills"). From her fill dates only:
// a fill runs out on its fill date plus its days supply. A fill is due for a reminder when
// it runs out within `remindDays` (REFILL_REMIND_DAYS, default 5) of the check-in date and
// not before it: a fill that already ran out is ignored, so an old record never floods her.
// Nothing is ordered or called; she gets the words to ask with.

export const DEFAULT_REFILL_REMIND_DAYS = 5;
/** At most this many refill reminders a day. */
export const MAX_REFILL_REMINDERS_PER_DAY = 2;

export type RefillDue = {
  med: Medication;
  medicationKey: string;
  /** "apixaban 5 mg". */
  plain: string;
  /** "tablets" or "capsules", for the request she reads out. */
  form: "tablet" | "capsule" | undefined;
  fillDate: string;
  daysSupply: number;
  runOut: string;
  /** Days from the check-in date to the run-out date (0 to remindDays). */
  daysLeft: number;
};

const DAY_MS = 86_400_000;

function dayNumber(day: string): number {
  return Math.floor(Date.parse(`${day}T00:00:00Z`) / DAY_MS);
}

/** YYYY-MM-DD plus n days. */
export function plusDays(day: string, n: number): string {
  return new Date((dayNumber(day) + n) * DAY_MS).toISOString().slice(0, 10);
}

/** Her latest fill of one medication (by fill date) with a days supply, if any. */
export function latestFill(dispenses: readonly Dispense[], medicationKey: string): (Dispense & { date: string; daysSupply: number }) | undefined {
  const fills = dispenses.filter(
    (d): d is Dispense & { date: string; daysSupply: number } =>
      d.medicationKey === medicationKey && d.date !== undefined && typeof d.daysSupply === "number" && d.daysSupply > 0,
  );
  return fills.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)).at(-1);
}

/**
 * Active medications whose latest fill runs out on or after `day` and within `remindDays` of it,
 * soonest first. `record` should already be as of `day` (asOf), so later fills don't count yet.
 */
export function refillsDue(record: PatientRecord, day: string, remindDays = DEFAULT_REFILL_REMIND_DAYS): RefillDue[] {
  const today = dayNumber(day);
  const due: RefillDue[] = [];
  for (const med of activeMedications(record)) {
    const fill = latestFill(record.dispenses, med.key);
    if (!fill) continue;
    const runOut = plusDays(fill.date, fill.daysSupply);
    const daysLeft = dayNumber(runOut) - today;
    if (daysLeft < 0 || daysLeft > remindDays) continue;
    due.push({ med, medicationKey: med.key, plain: plainName(med), form: doseForm(med), fillDate: fill.date, daysSupply: fill.daysSupply, runOut, daysLeft });
  }
  return due.sort((a, b) => a.daysLeft - b.daysLeft || a.plain.localeCompare(b.plain));
}

const SHORT_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const LONG_MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "2026-07-02" -> "Jul 2". */
export function shortDay(day: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  const month = match ? SHORT_MONTHS[Number(match[2]) - 1] : undefined;
  return match && month ? `${month} ${Number(match[3])}` : day;
}

/** "1948-03-02" -> "March 2, 1948". */
export function longDay(day: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  const month = match ? LONG_MONTHS[Number(match[2]) - 1] : undefined;
  return match && month ? `${month} ${Number(match[3])}, ${match[1]}` : day;
}
