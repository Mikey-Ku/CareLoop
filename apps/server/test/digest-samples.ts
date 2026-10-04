import type { DayFacts, Digest } from "../src/context/digest.ts";

// A hand-built digest for the history answers' copy tests (test/copy.test.ts, test/history.test.ts).
// Synthetic: Harriet's week as the simulator would leave it on Tue 2026-09-01.

const DAY = "2026-09-01";

const quiet = (day: string, patch: Partial<DayFacts> = {}): DayFacts => ({
  day,
  checkin: "checked in",
  symptoms: [],
  answers: [],
  doses: { morning: { status: "taken", time: "8:12" } },
  notes: [],
  ...patch,
});

export function sampleDigest(patch: { today?: Partial<Digest["today"]>; standing?: Partial<Digest["standing"]>; who?: Partial<Digest["who"]>; week?: DayFacts[] } = {}): Digest {
  return {
    day: DAY,
    who: {
      firstName: "Harriet",
      age: 78,
      conditions: ["Heart failure", "Atrial fibrillation"],
      medicines: [{ name: "Apixaban 5 mg", directions: "Take 1 tablet by mouth twice daily" }],
      flags: [{ message: "You take apixaban, aspirin and sertraline. Taken together, they can raise the chance of bleeding.", status: "noted" }],
      ...patch.who,
    },
    today: {
      ...quiet(DAY, { doses: { morning: { status: "taken", time: "8:12" }, evening: { status: "waiting" } } }),
      questions: [{ id: "morning-medicines", question: "Did you take your morning medicines?", answer: "Yes" }],
      call: undefined,
      familyPassedOn: [],
      ...patch.today,
    },
    week: patch.week ?? [
      quiet("2026-08-25", { checkin: "no check-in", doses: {} }),
      quiet("2026-08-26"),
      quiet("2026-08-27"),
      quiet("2026-08-28"),
      quiet("2026-08-29"),
      quiet("2026-08-30", { symptoms: [{ topic: "hf-ankle-swelling", level: 1 }] }),
      quiet("2026-08-31", { symptoms: [{ topic: "hf-ankle-swelling", level: 1 }, { topic: "knee pain", level: 1 }] }),
    ],
    standing: {
      memories: ["my granddaughter Mia visits on Sunday"],
      visitQuestions: ["Is the aspirin still on my list after the hospital?"],
      refill: { name: "apixaban 5 mg", runOut: "2026-09-03", status: "upcoming" },
      family: [{ from: "Sarah", day: "2026-08-31", text: "Bring the photos on Sunday" }],
      lastReading: { day: "2026-08-31", heartRate: 72, breathingRate: null },
      ...patch.standing,
    },
  };
}
