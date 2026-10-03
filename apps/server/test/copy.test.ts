import { describe, expect, it } from "vitest";
import * as copy from "../src/checkin/copy.ts";
import {
  BUTTON,
  SHARING_BUTTONS,
  SHARING_MENU_BUTTON,
  checkinDone,
  checkinGreeting,
  didntUnderstand,
  familyDailyStatus,
  familyMissedAlert,
  familyRedFlagAlert,
  flagDetail,
  flagNotedReply,
  flagOffer,
  notTodayReply,
  recordLinkEndedFamily,
  recordLinkEndedSenior,
  redFlagAdvice,
  sharingChangedFamily,
  sharingChangedSenior,
  sharingLevelFromButton,
  sharingMenu,
  type AnsweredQuestion,
  type DayOutcome,
} from "../src/checkin/copy.ts";
import type { SharingLevel } from "../src/db/index.ts";
import { QUESTION_BANK } from "../src/context/questions.ts";
import { loadRxNavCache, loadSnapshot } from "../src/finchnode/fixtures.ts";
import { normalizeHealthRecord } from "../src/finchnode/normalize.ts";
import { runRules } from "../src/rules/index.ts";

const NAME = "Harriet";
const LEVELS: SharingLevel[] = ["status", "status_vitals", "all"];
const OUTCOMES: DayOutcome[] = ["checked_in", "not_today", "missed"];
const EM_DASH = /[—–]/; // em and en dash

const ANSWERS: AnsweredQuestion[] = [
  { questionId: "hf-ankle-swelling", questionText: "Have your ankles or feet been more swollen than usual?", answer: "A little" },
  { questionId: "mood", questionText: "How are you feeling today?", answer: "Okay" },
];
const FLAG_MESSAGE = "You take apixaban, aspirin and sertraline. Taken together, they can raise the chance of bleeding.";
const RED_FLAG = { questionText: "Did you have trouble breathing when lying flat last night?", answer: "Yes" };

// Plain-language flag messages from the real rules on the demo patients.
const rxnav = loadRxNavCache();
const ruleFlagMessages = ["patient-demo-polypharmacy", "patient-demo-001", "patient-demo-multi-source"].flatMap((subject) => {
  const record = normalizeHealthRecord(loadSnapshot(subject), { rxnav });
  return runRules({ record, checkinDate: "2026-09-01" })
    .filter((r) => r.status === "flag")
    .map((r) => r.message);
});

/** Every string any export can produce, from a spread of sample inputs. */
function allOutputs(): string[] {
  const out: string[] = [];
  for (const n of [0, 1, 3]) out.push(checkinGreeting(NAME, n));
  out.push(notTodayReply(NAME), redFlagAdvice(NAME), flagOffer(), flagNotedReply(), checkinDone(NAME));
  out.push(flagDetail(FLAG_MESSAGE), ...ruleFlagMessages.map(flagDetail));
  out.push(didntUnderstand([BUTTON.start, BUTTON.notToday]), didntUnderstand(["Yes"]));
  out.push(recordLinkEndedSenior(NAME), recordLinkEndedFamily(NAME), familyMissedAlert(NAME, "12:00 PM"));
  out.push(sharingMenu());
  for (const level of LEVELS) {
    out.push(sharingMenu(level), sharingChangedSenior(level), sharingChangedFamily(NAME, level));
    out.push(familyRedFlagAlert({ seniorName: NAME, sharing: level, ...RED_FLAG }));
    for (const outcome of OUTCOMES)
      for (const vitals of [undefined, { heartRate: 72, inUsualRange: true }, { heartRate: 104, inUsualRange: false }])
        out.push(familyDailyStatus({ seniorName: NAME, sharing: level, outcome, answers: ANSWERS, flags: [{ message: FLAG_MESSAGE }], vitals }));
  }
  return out;
}

describe("copy: style rules across every output", () => {
  const outputs = allOutputs();

  it("covers every exported function", () => {
    const fns = Object.entries(copy).filter(([, v]) => typeof v === "function").map(([k]) => k).sort();
    const sampled = [
      "checkinDone", "checkinGreeting", "didntUnderstand", "familyDailyStatus", "familyMissedAlert", "familyRedFlagAlert",
      "flagDetail", "flagNotedReply", "flagOffer", "notTodayReply", "recordLinkEndedFamily", "recordLinkEndedSenior",
      "redFlagAdvice", "sharingChangedFamily", "sharingChangedSenior", "sharingLevelFromButton", "sharingMenu",
    ].sort();
    expect(fns).toEqual(sampled);
  });

  it("the demo rules produce flags to word", () => {
    expect(ruleFlagMessages.length).toBeGreaterThan(0);
  });

  it("has no em or en dashes", () => {
    for (const text of outputs) expect(text, text).not.toMatch(EM_DASH);
    for (const label of [...Object.values(BUTTON), ...Object.values(SHARING_BUTTONS), SHARING_MENU_BUTTON]) expect(label).not.toMatch(EM_DASH);
  });

  it("never claims a diagnosis", () => {
    // Question texts are quoted back to the family ("Did you have trouble..."), so check only our own words.
    const quoted = [RED_FLAG.questionText, ...ANSWERS.map((a) => a.questionText), ...QUESTION_BANK.map((q) => q.text)];
    for (const text of outputs) {
      const own = quoted.reduce((t, q) => t.replaceAll(q, ""), text).toLowerCase();
      expect(own, text).not.toMatch(/you have|diagnos/);
    }
  });

  it("uses no more than one exclamation mark anywhere", () => {
    for (const text of outputs) expect((text.match(/!/g) ?? []).length, text).toBeLessThanOrEqual(1);
  });

  it("does not leave template holes", () => {
    for (const text of outputs) expect(text, text).not.toMatch(/undefined|NaN|\$\{|\[object/);
  });
});

describe("copy: buttons", () => {
  const sets: string[][] = [
    [BUTTON.start, BUTTON.notToday],
    [BUTTON.tellMeMore, BUTTON.later],
    [BUTTON.willAskDoctor],
    Object.values(SHARING_BUTTONS),
    ...QUESTION_BANK.map((q) => q.buttons),
  ];

  it("every label is 1 to 80 characters and every set has at most 5", () => {
    for (const set of sets) {
      expect(set.length).toBeGreaterThanOrEqual(1);
      expect(set.length).toBeLessThanOrEqual(5);
      for (const label of set) {
        expect(label.length).toBeGreaterThanOrEqual(1);
        expect(label.length).toBeLessThanOrEqual(80);
      }
    }
    expect(SHARING_MENU_BUTTON.length).toBeLessThanOrEqual(80);
  });

  it("labels in a set are distinct", () => {
    for (const set of sets) expect(new Set(set).size).toBe(set.length);
  });

  it("red-flag answers are real button labels", () => {
    for (const q of QUESTION_BANK) for (const a of q.redFlagAnswers) expect(q.buttons).toContain(a);
  });

  it("sharing buttons map back to their level", () => {
    for (const level of LEVELS) expect(sharingLevelFromButton(SHARING_BUTTONS[level])).toBe(level);
    expect(sharingLevelFromButton("Nope")).toBeUndefined();
  });
});

describe("copy: senior messages", () => {
  it("'Not today' carries no guilt", () => {
    const text = notTodayReply(NAME).toLowerCase();
    for (const word of ["should", "missed", "forgot", "please answer"]) expect(text).not.toContain(word);
  });

  it("every flag text points to the doctor", () => {
    for (const text of [flagOffer(), flagDetail(FLAG_MESSAGE), ...ruleFlagMessages.map(flagDetail), flagNotedReply()])
      expect(text.toLowerCase()).toContain("doctor");
  });

  it("flag detail never tells her to stop or change a medicine herself", () => {
    for (const text of [flagDetail(FLAG_MESSAGE), ...ruleFlagMessages.map(flagDetail)]) expect(text.toLowerCase()).not.toMatch(/you should (stop|start|take)|stop taking/);
  });

  it("red-flag advice tells her to call her doctor", () => {
    expect(redFlagAdvice(NAME)).toMatch(/call your doctor/);
  });

  it("the greeting says it is an assistant and offers 'Not today'", () => {
    const text = checkinGreeting(NAME, 3);
    expect(text).toContain("assistant");
    expect(text).toContain(BUTTON.notToday);
    expect(checkinGreeting(NAME, 1)).toContain("1 short question ");
  });

  it("didn't-understand lists the buttons", () => {
    expect(didntUnderstand(["Yes", "No"])).toContain('"Yes" and "No"');
  });
});

describe("copy: family messages by sharing level", () => {
  it("red-flag alert at status and status_vitals has no medical detail", () => {
    for (const sharing of ["status", "status_vitals"] as const) {
      const text = familyRedFlagAlert({ seniorName: NAME, sharing, ...RED_FLAG });
      expect(text).toBe("Harriet reported something she should call her doctor about today. Please check in with her.");
      expect(text).not.toContain(RED_FLAG.questionText);
      expect(text).not.toContain(`"${RED_FLAG.answer}"`);
      expect(text.toLowerCase()).not.toContain("breathing");
    }
  });

  it("red-flag alert at all includes the question and answer", () => {
    const text = familyRedFlagAlert({ seniorName: NAME, sharing: "all", ...RED_FLAG });
    expect(text).toContain(RED_FLAG.questionText);
    expect(text).toContain(`"${RED_FLAG.answer}"`);
  });

  it("daily status says checked in, not today or missed at every level", () => {
    for (const sharing of LEVELS) {
      const s = (outcome: DayOutcome) => familyDailyStatus({ seniorName: NAME, sharing, outcome, answers: [], flags: [] });
      expect(s("checked_in")).toContain("checked in today");
      expect(s("not_today")).toContain("not today");
      expect(s("missed")).toContain("didn't answer");
    }
  });

  it("status and status_vitals hide answers and flags; all shows them", () => {
    const input = { seniorName: NAME, outcome: "checked_in" as const, answers: ANSWERS, flags: [{ message: FLAG_MESSAGE }] };
    for (const sharing of ["status", "status_vitals"] as const) {
      const text = familyDailyStatus({ ...input, sharing });
      for (const a of ANSWERS) expect(text).not.toContain(a.questionText);
      expect(text).not.toContain(FLAG_MESSAGE);
    }
    const all = familyDailyStatus({ ...input, sharing: "all" });
    for (const a of ANSWERS) expect(all).toContain(`${a.questionText} ${a.answer}`);
    expect(all).toContain(FLAG_MESSAGE);
  });

  it("vitals show at status_vitals and all, never at status", () => {
    const input = { seniorName: NAME, outcome: "checked_in" as const, answers: [], flags: [], vitals: { heartRate: 104, inUsualRange: false } };
    expect(familyDailyStatus({ ...input, sharing: "status" })).toBe("Harriet checked in today.");
    expect(familyDailyStatus({ ...input, sharing: "status_vitals" })).toContain("outside Harriet's usual range");
    expect(familyDailyStatus({ ...input, sharing: "all" })).toContain("104");
    expect(familyDailyStatus({ ...input, sharing: "status_vitals", vitals: { heartRate: 72, inUsualRange: true } })).toContain("within Harriet's usual range");
  });

  it("without vitals the daily status is unchanged by level below all", () => {
    const input = { seniorName: NAME, outcome: "not_today" as const, answers: ANSWERS, flags: [] };
    expect(familyDailyStatus({ ...input, sharing: "status_vitals" })).toBe(familyDailyStatus({ ...input, sharing: "status" }));
  });

  it("sharing change tells the family what changed, not why", () => {
    for (const level of LEVELS) {
      const text = sharingChangedFamily(NAME, level);
      expect(text).toContain("Harriet changed what this group sees");
      expect(text.toLowerCase()).not.toMatch(/because|reason|why/);
    }
  });

  it("record link ended messages name no cause and no blame", () => {
    for (const text of [recordLinkEndedSenior(NAME), recordLinkEndedFamily(NAME)]) {
      expect(text).toContain("health record has ended");
      expect(text.toLowerCase()).not.toMatch(/because|revoked|you turned|fault|error/);
    }
  });
});
