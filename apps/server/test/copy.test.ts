import { describe, expect, it } from "vitest";
import * as copy from "../src/checkin/copy.ts";
import {
  BUTTON,
  CLARIFY_BUTTONS,
  FOLLOW_UP_BUTTONS,
  SHARING_BUTTONS,
  SHARING_MENU_BUTTON,
  QUOTE_MAX_CHARS,
  READING_ACTIVITY,
  checkinDone,
  checkinDoneAfterConcern,
  checkinGreeting,
  clarifyAmount,
  complaintReply,
  crisisReply,
  didntUnderstand,
  explainPrompt,
  familyCrisisAlert,
  familyDailyStatus,
  familyFollowUpUpdate,
  familyFollowUpWorse,
  familyMissedAlert,
  familyRedFlagAlert,
  familyRelay,
  familyRelayDone,
  familyRelayWaiting,
  familyUrgentAlert,
  familyWelcome,
  feelingLowReply,
  flagDetail,
  flagNotedReply,
  flagOffer,
  followUpAsk,
  followUpQuestion,
  followUpReply,
  freeTextConfirm,
  keepAnEye,
  keepAnEyeReply,
  medicineQuestionReply,
  noteSaved,
  notedForDoctor,
  notTodayReply,
  openReplyThanks,
  openReplyUnavailable,
  photoNotYet,
  recordLinkEndedFamily,
  recordLinkEndedSenior,
  redFlagAdvice,
  sharingChangedFamily,
  sharingChangedSenior,
  sharingLevelFromButton,
  sharingMenu,
  smallTalkFallback,
  sorryNotGreat,
  START_ALIASES,
  symptomNotedReply,
  TYPING_HINT,
  topicWords,
  typedReplyUnavailable,
  urgentReply,
  withLead,
  withTypingHint,
  type AnsweredQuestion,
  type DayOutcome,
  type FollowUpTopic,
} from "../src/checkin/copy.ts";
import type { SharingLevel } from "../src/db/index.ts";
import { LET_ME_EXPLAIN, QUESTION_BANK, promptButtons } from "../src/context/questions.ts";
import { MAX_ACTIVITY_LABEL, assertValidActivityLabel } from "../src/relay/messenger.ts";
import { loadRxNavCache, loadSnapshot } from "../src/finchnode/fixtures.ts";
import { normalizeHealthRecord } from "../src/finchnode/normalize.ts";
import { runRules } from "../src/rules/index.ts";

const NAME = "Harriet";
const LEVELS: SharingLevel[] = ["status", "status_vitals", "all"];
const TOPICS: FollowUpTopic[] = ["breathing", "bleeding", "ankles", "dizziness", "crisis", "general"];
/** Symptom topics as the engine passes them: question ids and her own words (synthetic). */
const SYMPTOM_TOPICS = ["hf-ankle-swelling", "dizzy-on-standing", "hf-breathing-lying-flat", "anticoagulant-bleeding", "morning-medicines", "mood", "knee pain", "a little cough", "my sore feet", "other", ""];
const CRISIS_WORDS = "I want to end my life"; // synthetic
const OUTCOMES: DayOutcome[] = ["checked_in", "not_today", "missed"];
const EM_DASH = /[—–]/; // em and en dash

const ANSWERS: AnsweredQuestion[] = [
  { questionId: "hf-ankle-swelling", questionText: "Have your ankles or feet been more swollen than usual?", answer: "A little" },
  { questionId: "mood", questionText: "How are you feeling today?", answer: "Okay" },
];
const FLAG_MESSAGE = "You take apixaban, aspirin and sertraline. Taken together, they can raise the chance of bleeding.";
const RED_FLAG = { questionText: "How was your breathing last night when you lay down?", answer: "Yes, it was hard" };
// What she might type instead of tapping (synthetic).
const HER_WORDS = [
  "nah fine, had to prop myself up on pillows",
  "a bit puffy",
  'my "good" knee hurts \u2014 again',
  "I slept in the chair again last night because lying down felt tight and I could not catch my breath until I sat up and opened the window wide",
];

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
  out.push(notTodayReply(NAME), flagOffer(), flagNotedReply(), checkinDone(NAME));
  out.push(redFlagAdvice(NAME), redFlagAdvice(NAME, ["Sarah"]), redFlagAdvice(NAME, ["Sarah", "Tom"]), redFlagAdvice(NAME, []));
  out.push(redFlagAdvice(NAME, ["Sarah"], 1), redFlagAdvice(NAME, [], 2), checkinDoneAfterConcern(NAME));
  out.push(typedReplyUnavailable(["No", "Yes"]), typedReplyUnavailable([BUTTON.start, BUTTON.notToday]), noteSaved(NAME));
  out.push(medicineQuestionReply(NAME), feelingLowReply(NAME), photoNotYet(NAME));
  for (const names of [undefined, [], ["Sarah"], ["Sarah", "Tom"]]) {
    out.push(crisisReply(NAME, names), urgentReply(NAME, names), familyRelayDone(NAME, names));
  }
  out.push(familyRelay(NAME, "Tell Sarah I love her"), familyRelay(NAME, 'say "hi" \u2014 to Tom'), familyRelayWaiting(NAME));
  for (const topic of TOPICS) {
    out.push(followUpAsk(topic), followUpQuestion(NAME, topic));
    for (const answer of ["better", "same"] as const) out.push(familyFollowUpUpdate({ seniorName: NAME, topic, answer }));
  }
  for (const topic of TOPICS) out.push(followUpReply(NAME, "better", topic), followUpReply(NAME, "same", topic));
  out.push(familyWelcome(NAME));
  out.push(flagDetail(FLAG_MESSAGE), ...ruleFlagMessages.map(flagDetail));
  out.push(didntUnderstand([BUTTON.start, BUTTON.notToday]), didntUnderstand(["Yes"]));
  out.push(explainPrompt(NAME), openReplyUnavailable(NAME));
  out.push(recordLinkEndedSenior(NAME), recordLinkEndedFamily(NAME), familyMissedAlert(NAME, "12:00 PM"));
  out.push(sharingMenu());
  out.push(complaintReply(NAME), smallTalkFallback(NAME));
  out.push(...levelZeroToTwoOutputs());
  for (const words of HER_WORDS) for (const q of QUESTION_BANK) out.push(freeTextConfirm(words, q.text));
  out.push(copy.PAPER_REJECTED_REPLY, copy.PAPER_LATER_REPLY, copy.PAPER_NOTHING_TO_COMPARE, copy.PAPER_NO_RECORD_REPLY);
  for (const level of LEVELS) {
    out.push(sharingMenu(level), sharingChangedSenior(level), sharingChangedFamily(NAME, level));
    out.push(familyRedFlagAlert({ seniorName: NAME, sharing: level, ...RED_FLAG }));
    out.push(familyRedFlagAlert({ seniorName: NAME, sharing: level, ...RED_FLAG, words: "Yes but it was weirder" }));
    for (const words of [undefined, CRISIS_WORDS]) {
      out.push(familyCrisisAlert({ seniorName: NAME, sharing: level, ...(words ? { words } : {}) }));
      out.push(familyUrgentAlert({ seniorName: NAME, sharing: level, ...(words ? { words } : {}) }));
    }
    for (const topic of TOPICS) out.push(familyFollowUpWorse({ seniorName: NAME, sharing: level, topic }));
    for (const outcome of OUTCOMES)
      for (const vitals of [undefined, { heartRate: 72, inUsualRange: true }, { heartRate: 104, inUsualRange: false }, { heartRate: 78 }])
        out.push(familyDailyStatus({ seniorName: NAME, sharing: level, outcome, answers: ANSWERS, flags: [{ message: FLAG_MESSAGE }], vitals }));
    for (const highest of [0, 1, 2, 3, 4, 5].flatMap((l) => SYMPTOM_TOPICS.map((topic) => ({ level: l, topic }))))
      out.push(familyDailyStatus({ seniorName: NAME, sharing: level, outcome: "checked_in", answers: ANSWERS, flags: [], highest }));
    out.push(familyRedFlagAlert({ seniorName: NAME, sharing: level, words: "my gums keep bleeding a lot" }));
  }
  return out;
}

/** Every understood line from a spread of answers and symptoms at levels 0 to 2 (synthetic). */
function understoodLines(): string[] {
  const answers = QUESTION_BANK.flatMap((q) => q.buttons.map((answer) => ({ topic: q.id, answer })));
  const out: string[] = [];
  for (const level of [0, 1, 2])
    for (const a of answers) {
      for (const topic of SYMPTOM_TOPICS) {
        const lines = [
          copy.understoodLine([{ ...a, level }]),
          copy.understoodLine([{ topic, level }]),
          copy.understoodLine([{ ...a, level: 0 }, { topic, level }]),
          copy.understoodLine([{ ...a, level }, { topic, level }, { topic: "knee pain", level }]),
        ];
        for (const line of lines) if (line !== undefined) out.push(line);
      }
    }
  return [...new Set(out)];
}

/**
 * Everything she or her family can read at levels 0 to 2 of the severity ladder (src/checkin/severity.ts):
 * the level-1 and level-2 lines, alone and folded into each next message, the chat replies, the one
 * clarifying question, Better and About the same on a follow-up (not after a crisis), the question
 * texts, the closings, and the family status at levels 0 to 2.
 */
function levelZeroToTwoOutputs(): string[] {
  const out: string[] = [];
  const questions = QUESTION_BANK.flatMap((q) => [q.text, withTypingHint(q.text)]);
  const next = [...questions, flagOffer(), checkinDone(NAME), checkinDoneAfterConcern(NAME)];
  // The leads a check-in folds before its next message, the open reply's included.
  const leads = [undefined, notedForDoctor(), keepAnEye(NAME), feelingLowReply(NAME), sorryNotGreat(NAME), openReplyThanks(NAME), openReplyUnavailable(NAME)];
  for (const lead of leads) for (const text of next) out.push(withLead(lead, text));
  for (const n of [1, 3]) out.push(checkinGreeting(NAME, n));
  out.push(explainPrompt(NAME), noteSaved(NAME), TYPING_HINT, LET_ME_EXPLAIN, ...START_ALIASES);
  for (const q of QUESTION_BANK) out.push(didntUnderstand(q.buttons), ...promptButtons(q));
  out.push(keepAnEyeReply(NAME), complaintReply(NAME), clarifyAmount(NAME), ...Object.values(CLARIFY_BUTTONS));
  for (const topic of SYMPTOM_TOPICS) out.push(symptomNotedReply(NAME, [topic]), symptomNotedReply(NAME, [topic, "knee pain"]));
  out.push(symptomNotedReply(NAME, []));
  for (const topic of TOPICS.filter((t) => t !== "crisis")) {
    out.push(followUpQuestion(NAME, topic), followUpReply(NAME, "better", topic), followUpReply(NAME, "same", topic));
    out.push(familyFollowUpUpdate({ seniorName: NAME, topic, answer: "better" }), familyFollowUpUpdate({ seniorName: NAME, topic, answer: "same" }));
  }
  for (const q of QUESTION_BANK) out.push(...q.buttons);
  // What was understood from her words, said back before the next message (levels 0 to 2), and the
  // suggested confirm on a red-flag question.
  for (const line of understoodLines()) for (const text of [line, ...next.map((n) => withLead(line, n))]) out.push(text);
  for (const q of QUESTION_BANK)
    for (const answer of q.buttons) {
      const phrase = copy.answerPhrase(q.id, answer);
      if (phrase) out.push(copy.suggestedConfirm(phrase));
    }
  for (const sharing of LEVELS)
    for (const highest of [0, 1, 2].flatMap((level) => SYMPTOM_TOPICS.map((topic) => ({ level, topic }))))
      out.push(familyDailyStatus({ seniorName: NAME, sharing, outcome: "checked_in", answers: ANSWERS, flags: [], highest }));
  return out;
}

describe("copy: style rules across every output", () => {
  const outputs = allOutputs();

  it("covers every exported function", () => {
    const fns = Object.entries(copy).filter(([, v]) => typeof v === "function").map(([k]) => k).sort();
    const sampled = [
      "checkinDone", "checkinDoneAfterConcern", "checkinGreeting", "clarifyAmount", "complaintReply", "crisisReply", "didntUnderstand",
      "explainPrompt", "familyCrisisAlert", "familyDailyStatus", "familyFollowUpUpdate", "familyFollowUpWorse", "familyMissedAlert", "familyRedFlagAlert",
      "familyRelay", "familyRelayDone", "familyRelayWaiting", "familyUrgentAlert", "familyWelcome", "feelingLowReply", "flagDetail",
      "flagNotedReply", "flagOffer", "followUpAsk", "followUpQuestion", "followUpReply", "freeTextConfirm", "keepAnEye", "keepAnEyeReply",
      "medicineQuestionReply", "noteSaved", "notedForDoctor", "notTodayReply", "openReplyThanks", "openReplyUnavailable", "photoNotYet",
      "recordLinkEndedFamily", "recordLinkEndedSenior", "redFlagAdvice", "sharingChangedFamily", "sharingChangedSenior", "sharingLevelFromButton",
      "sharingMenu", "smallTalkFallback", "sorryNotGreat", "symptomNotedReply", "topicWords", "typedReplyUnavailable", "urgentReply", "withLead",
      "withTypingHint", "answerPhrase", "suggestedConfirm", "understoodLine",
    ].sort();
    expect(fns).toEqual(sampled);
  });

  it("the demo rules produce flags to word", () => {
    expect(ruleFlagMessages.length).toBeGreaterThan(0);
  });

  it("has no em or en dashes", () => {
    for (const text of outputs) expect(text, text).not.toMatch(EM_DASH);
    for (const label of [...Object.values(BUTTON), ...START_ALIASES, LET_ME_EXPLAIN, ...Object.values(SHARING_BUTTONS), SHARING_MENU_BUTTON])
      expect(label).not.toMatch(EM_DASH);
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
    Object.values(FOLLOW_UP_BUTTONS),
    ...QUESTION_BANK.map((q) => q.buttons),
    ...QUESTION_BANK.map((q) => promptButtons(q)),
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

  it("red-flag advice (level 3) thanks her calmly first, then who was told, then her doctor today, then 911 only if much worse", () => {
    expect(redFlagAdvice(NAME, ["Sarah"])).toBe(
      "Thank you for telling me, Harriet. I've let Sarah know. Please call your doctor today about this. If it gets much worse, call 911.",
    );
    expect(redFlagAdvice(NAME, ["Sarah", "Tom", "Ann"])).toMatch(/^Thank you for telling me, Harriet\. I've let Sarah, Tom and Ann know\. /);
    for (const text of [redFlagAdvice(NAME), redFlagAdvice(NAME, ["Sarah"]), redFlagAdvice(NAME, []), redFlagAdvice(NAME, ["Sarah"], 2)]) {
      expect(text).not.toMatch(/emergency|ambulance|uncomfortable/i);
      const thanks = text.indexOf("Thank you for telling me");
      const family = text.indexOf(" know.");
      const doctor = text.indexOf("call your doctor today");
      const emergency = text.indexOf("call 911");
      expect(thanks, text).toBe(0);
      if (family >= 0) expect(doctor, text).toBeGreaterThan(family);
      expect(emergency, text).toBeGreaterThan(doctor);
      // Short sentences.
      for (const sentence of text.split(/(?<=\.) /)) expect(sentence.split(" ").length, sentence).toBeLessThanOrEqual(12);
    }
  });

  it("red-flag advice without names says 'your family'; with no one linked it claims no one was told", () => {
    expect(redFlagAdvice(NAME)).toMatch(/I've let your family know\. Please call your doctor/);
    expect(redFlagAdvice(NAME, [])).toBe("Thank you for telling me, Harriet. Please call your doctor today about this. If it gets much worse, call 911.");
    expect(redFlagAdvice(NAME, [" ", ""])).toBe(redFlagAdvice(NAME, []));
  });

  it("red-flag advice mentions the questions still to come, so the next one doesn't arrive out of nowhere", () => {
    expect(redFlagAdvice(NAME, ["Sarah"], 1)).toMatch(/call 911\. When you're ready, I have one more question for you\.$/);
    expect(redFlagAdvice(NAME, ["Sarah"], 2)).toMatch(/I have 2 more questions for you\.$/);
    expect(redFlagAdvice(NAME, ["Sarah"], 0)).toBe(redFlagAdvice(NAME, ["Sarah"]));
  });

  it("after a concern, the closing says we'll check on her again this afternoon, not tomorrow", () => {
    expect(checkinDoneAfterConcern(NAME)).toBe("Thank you, Harriet. I'll check on you again this afternoon.");
    expect(checkinDoneAfterConcern(NAME)).not.toMatch(/tomorrow/);
  });

  it("red-flag advice uses no pronoun for family members", () => {
    for (const text of [redFlagAdvice(NAME, ["Sarah"]), redFlagAdvice(NAME, ["Tom"])]) expect(text).not.toMatch(/\b(she|he|her|his)\b/i);
  });

  it("the greeting is the open question: her own words first, Quick questions if she'd rather tap", () => {
    const text =
      "Good morning, Harriet. How are you feeling today? Just tell me in your own words, like a text to a friend. Or tap Quick questions if you'd rather tap.";
    expect(checkinGreeting(NAME, 3)).toBe(text);
    expect(checkinGreeting(NAME, 1)).toBe(text);
    expect(BUTTON.start).toBe("Quick questions");
    expect(START_ALIASES).toEqual(["Let's start"]);
    expect(checkinGreeting(NAME, 0)).toContain("assistant");
  });

  it("didn't-understand lists the answers and says she can tell it in a few words", () => {
    expect(didntUnderstand(["Yes", "No"])).toBe(`Sorry, I didn't quite catch that. You can tap one of these, or tell me in a few words: "Yes" or "No".`);
    expect(didntUnderstand(["No", "A little", "More than usual"])).toContain('"No", "A little" or "More than usual"');
  });

  it("the open reply's own lines: thanks, the honest LLM-down line, and the short mood line", () => {
    expect(openReplyThanks(NAME)).toBe("Thanks, Harriet.");
    expect(openReplyUnavailable(NAME)).toBe("Thanks, Harriet. I'm having trouble reading typed replies right now, so let's do a few quick questions.");
    expect(openReplyUnavailable(NAME)).not.toMatch(/didn't|sorry/i);
    expect(sorryNotGreat(NAME)).toBe("I'm sorry you're not feeling great, Harriet. Thank you for telling me.");
    // At most two short sentences.
    for (const line of [notedForDoctor(), keepAnEye(NAME), sorryNotGreat(NAME)]) expect(line.split(/[.?]\s/).length).toBeLessThanOrEqual(2);
  });

  it("Let me explain: an invitation to type; the hint makes typing obvious under a question", () => {
    expect(explainPrompt(NAME)).toBe("Go ahead, Harriet. Tell me in your own words.");
    expect(TYPING_HINT).toBe("(Tap an answer, or just tell me.)");
    expect(withTypingHint("Any unusual bruising or bleeding?")).toBe("Any unusual bruising or bleeding?\n(Tap an answer, or just tell me.)");
  });
});

describe("copy: typed messages", () => {
  it("when typed replies can't be read, it's the assistant's trouble, not hers, and the buttons are offered", () => {
    expect(typedReplyUnavailable(["No", "Yes"])).toBe(`I'm having trouble reading typed replies right now. You can tap one of these: "No" or "Yes".`);
    expect(typedReplyUnavailable(["No", "Yes"])).not.toMatch(/didn't understand|sorry/i);
    expect(typedReplyUnavailable(["Good", "Okay", "Not great"])).toContain('"Good", "Okay" or "Not great"');
  });

  it("detail she adds is written down for her doctor, and the buttons stay offered", () => {
    expect(noteSaved(NAME)).toBe("Thank you, Harriet. I've written that down for your doctor. You can keep telling me, or tap an answer below.");
  });

  it("a medicine question goes to her doctor or pharmacist and she is told not to change anything first", () => {
    const text = medicineQuestionReply(NAME);
    expect(text).toContain("doctor or pharmacist");
    expect(text).toContain("added it to your list for your next visit");
    expect(text).toContain("Please don't change any medicine before you ask them.");
  });

  it("feeling low: warm and short, suggests calling someone close, no alarm", () => {
    const text = feelingLowReply(NAME);
    expect(text).toMatch(/^I'm sorry you're feeling this way, Harriet\./);
    expect(text).toContain("call someone you're close to");
    expect(text).not.toMatch(/911|988|emergency|doctor/);
  });

  it("crisis: she matters, 988 now, 911 if in danger; family only when someone was told", () => {
    const text = crisisReply(NAME, ["Sarah"]);
    expect(text).toContain("You matter");
    expect(text).toContain("Please call or text 988 now");
    expect(text).toContain("Suicide & Crisis Lifeline");
    expect(text).toContain("If you're in danger right now, call 911.");
    expect(text.indexOf("988")).toBeLessThan(text.indexOf("911"));
    expect(text).toMatch(/I've let Sarah know\.$/);
    expect(crisisReply(NAME)).toMatch(/I've let your family know\.$/);
    expect(crisisReply(NAME, [])).not.toMatch(/family|know\.$/);
    for (const sentence of text.split(/(?<=\.) /)) expect(sentence.split(" ").length, sentence).toBeLessThanOrEqual(12);
  });

  it("urgent symptom: 911 now if it's happening, then her doctor; family only when someone was told", () => {
    const text = urgentReply(NAME, ["Sarah", "Tom"]);
    expect(text).toMatch(/^Harriet, if this is happening now, please call 911 right away\./);
    expect(text.indexOf("911")).toBeLessThan(text.indexOf("doctor"));
    expect(text).toContain("I've let Sarah and Tom know");
    expect(urgentReply(NAME, [])).toBe("Harriet, if this is happening now, please call 911 right away. After that, call your doctor.");
  });

  it("a family message passes on her own words; her reply names who got it, or says it waits", () => {
    expect(familyRelay(NAME, "  Tell Sarah I love her ")).toBe('Harriet asked me to pass this on: "Tell Sarah I love her"');
    expect(familyRelay(NAME, 'say "hi"\nto Tom')).toBe(`Harriet asked me to pass this on: "say 'hi' to Tom"`);
    expect(familyRelayDone(NAME, ["Sarah"])).toBe("Thank you, Harriet. I've passed that on to Sarah.");
    expect(familyRelayDone(NAME, [])).toBe("Thank you, Harriet. I've passed that on to your family.");
    expect(familyRelayWaiting(NAME)).toBe("Thank you, Harriet. I'll pass it on when your family has connected with me.");
  });

  it("a photo gets a kind reply pointing to her doctor or pharmacist", () => {
    expect(photoNotYet(NAME)).toBe("Thanks for the photo, Harriet. I can't read photos yet. Please bring it to your doctor or pharmacist.");
  });
});

describe("copy: severity ladder", () => {
  it("nothing she or her family reads at levels 0 to 2 mentions 911, an emergency or an ambulance", () => {
    const outputs = levelZeroToTwoOutputs();
    expect(outputs.length).toBeGreaterThan(100);
    for (const text of outputs) expect(text, text).not.toMatch(/911|emergenc|ambulance/i);
  });

  it("the understood line never mentions 911, is at most two sentences, and is left out at level 3 or with nothing understood", () => {
    const lines = understoodLines();
    expect(lines.length).toBeGreaterThan(50);
    for (const line of lines) {
      expect(line, line).not.toMatch(/911|emergenc|ambulance/i);
      expect(line.split(/(?<=[.?])\s/).length, line).toBeLessThanOrEqual(2);
    }
    expect(copy.understoodLine([])).toBeUndefined();
    expect(copy.understoodLine([{ topic: "hf-breathing-lying-flat", answer: "Yes, it was hard", level: 3 }, { topic: "mood", answer: "Good", level: 0 }])).toBeUndefined();
    expect(copy.understoodLine([{ topic: "hf-ankle-swelling", answer: "No", level: 0 }, { topic: "back pain", level: 1 }])).toBe(
      "Got it: ankles feeling fine. I've noted the back pain for your doctor.",
    );
  });

  it("911 starts at level 3 (only if it gets much worse) and is the main instruction at 4; 988 at 5", () => {
    expect(redFlagAdvice(NAME, ["Sarah"])).toContain("If it gets much worse, call 911.");
    expect(urgentReply(NAME, ["Sarah"])).toMatch(/^Harriet, if this is happening now, please call 911 right away\./);
    expect(crisisReply(NAME, ["Sarah"])).toContain("Please call or text 988 now.");
  });

  it("level 1 in a check-in: one short line, noted for her doctor, folded before the next message", () => {
    expect(notedForDoctor()).toBe("Thanks, I've made a note of that for your doctor.");
    expect(withLead(notedForDoctor(), "Any unusual bruising or bleeding?")).toBe(
      "Thanks, I've made a note of that for your doctor.\n\nAny unusual bruising or bleeding?",
    );
    expect(withLead(undefined, "Any unusual bruising or bleeding?")).toBe("Any unusual bruising or bleeding?");
  });

  it("level 2: keep an eye on it; in chat she also hears we'll check on her later", () => {
    expect(keepAnEye(NAME)).toBe("Thanks for telling me, Harriet. Let's keep an eye on that.");
    expect(keepAnEyeReply(NAME)).toBe("Thanks for telling me, Harriet. Let's keep an eye on that. I'll check on you again later today.");
  });

  it("level 1 in chat: sorry, with her topic words when they fit, and noted for her doctor", () => {
    expect(symptomNotedReply(NAME, ["knee pain"])).toBe("Sorry to hear about your knee pain, Harriet. I've made a note for your doctor.");
    expect(symptomNotedReply(NAME, ["hf-ankle-swelling"])).toBe("Sorry to hear about your ankle swelling, Harriet. I've made a note for your doctor.");
    expect(symptomNotedReply(NAME, ["my knee", "a little cough", "my knee"])).toBe(
      "Sorry to hear about your knee and cough, Harriet. I've made a note for your doctor.",
    );
    expect(symptomNotedReply(NAME, ['knee "pain" <b>'])).toBe("Sorry that's bothering you, Harriet. I've made a note for your doctor.");
    expect(symptomNotedReply(NAME, [])).toBe("Sorry that's bothering you, Harriet. I've made a note for your doctor.");
  });

  it("topic words: bank topics in plain words, her words tidied, anything odd left out", () => {
    expect(topicWords("dizzy-on-standing")).toBe("dizziness");
    expect(topicWords("  My  Sore   Feet ")).toBe("sore feet");
    expect(topicWords("a bit of a headache")).toBe("headache");
    expect(topicWords("pain in my left knee when I climb the stairs")).toBeUndefined();
    expect(topicWords("knee\u2014pain")).toBeUndefined();
    expect(topicWords("")).toBeUndefined();
  });

  it("the one clarifying question: a little, or a lot, with two buttons", () => {
    expect(clarifyAmount(NAME)).toBe("Thanks, Harriet. Is it a little, or a lot?");
    expect(Object.values(CLARIFY_BUTTONS)).toEqual(["A little", "A lot"]);
  });
});

describe("copy: follow-up check-in", () => {
  it("asks about the topic of the concern, or how she feels", () => {
    expect(followUpQuestion(NAME, "breathing")).toBe("Checking in again, Harriet. How is your breathing now?");
    expect(followUpQuestion(NAME, "bleeding")).toBe("Checking in again, Harriet. How is the bruising or bleeding now?");
    expect(followUpQuestion(NAME, "general")).toBe("Checking in again, Harriet. How are you feeling now?");
    expect(Object.values(FOLLOW_UP_BUTTONS)).toEqual(["Better", "About the same", "Worse"]);
  });

  it("asks about ankles and dizziness after something worth watching there", () => {
    expect(followUpQuestion(NAME, "ankles")).toBe("Checking in again, Harriet. How are your ankles now?");
    expect(followUpQuestion(NAME, "dizziness")).toBe("Checking in again, Harriet. How is the dizziness now?");
  });

  it("Better is a warm close (level 0); About the same keeps an eye on it (level 2); neither mentions 911", () => {
    expect(followUpReply(NAME, "better")).toBe("I'm glad to hear that, Harriet. Thank you for letting me know.");
    expect(followUpReply(NAME, "same", "breathing")).toBe(
      "Thank you for letting me know, Harriet. Let's keep an eye on that. I've made a note for your doctor.",
    );
    for (const topic of TOPICS.filter((t) => t !== "crisis"))
      for (const answer of ["better", "same"] as const) expect(followUpReply(NAME, answer, topic)).not.toMatch(/911|emergency|ambulance/i);
  });

  it("after a crisis the follow-up asks how she feels, and its replies point to 988, not the doctor", () => {
    expect(followUpQuestion(NAME, "crisis")).toBe("Checking in again, Harriet. How are you feeling now?");
    for (const answer of ["better", "same"] as const) {
      const text = followUpReply(NAME, answer, "crisis");
      expect(text).toContain("call or text 988 any time");
      expect(text).not.toContain("doctor");
    }
    expect(followUpReply(NAME, "same", "crisis")).toContain("If you're in danger, call 911.");
  });

  it("Worse alerts the family at every level, with the question and answer only at all", () => {
    for (const sharing of ["status", "status_vitals"] as const) {
      const text = familyFollowUpWorse({ seniorName: NAME, sharing, topic: "breathing" });
      expect(text).toBe("Harriet said she feels worse than earlier today. Please call Harriet now to check on her.");
    }
    expect(familyFollowUpWorse({ seniorName: NAME, sharing: "all", topic: "breathing" })).toContain('How is your breathing now?\nHarriet answered: "Worse"');
  });

  it("the family update at all says what she answered", () => {
    expect(familyFollowUpUpdate({ seniorName: NAME, topic: "bleeding", answer: "same" })).toBe(
      'I checked in with Harriet again and asked: How is the bruising or bleeding now?\nHarriet answered: "About the same"',
    );
  });
});

describe("copy: free text", () => {
  const breathing = QUESTION_BANK.find((q) => q.id === "hf-breathing-lying-flat")!;

  it("the confirm quotes her words, then asks the question again", () => {
    expect(freeTextConfirm("nah fine, had to prop myself up on pillows", breathing.text)).toBe(
      'You wrote: "nah fine, had to prop myself up on pillows"\nJust to check: How was your breathing last night when you lay down?',
    );
  });

  it("the confirm keeps her words on one line, softens quotes and long dashes, and cuts long ones at a word", () => {
    expect(freeTextConfirm('  my "good" knee\n hurts \u2014 again ', breathing.text)).toMatch(/^You wrote: "my 'good' knee hurts - again"\n/);
    const long = freeTextConfirm(HER_WORDS[3]!, breathing.text);
    const quote = /^You wrote: "(.*)"\n/.exec(long)?.[1] ?? "";
    expect(quote.endsWith("...")).toBe(true);
    expect(quote.length).toBeLessThanOrEqual(QUOTE_MAX_CHARS + 3);
    expect(HER_WORDS[3]!.startsWith(quote.slice(0, -3))).toBe(true);
    expect(quote.slice(0, -3)).not.toMatch(/\s$/);
  });

  it("the complaint reply (no symptom read) is level-1 wording: noted for her doctor, no advice, no 911, nothing about family", () => {
    expect(complaintReply(NAME)).toBe("Thank you for telling me, Harriet. I've made a note of that for your doctor.");
    expect(complaintReply(NAME)).not.toMatch(/family|told|alert|911|emergency/i);
  });

  it("the small-talk fallback thanks her, says when it's back, and still points to her doctor and 911", () => {
    const text = smallTalkFallback(NAME);
    expect(text).toMatch(/^Thanks for your message, Harriet\. /);
    expect(text).toContain("next check-in");
    expect(text).toContain("call your doctor");
    expect(text).toContain("call 911");
  });

  it("the reading label fits Relay's activity limit", () => {
    expect(() => assertValidActivityLabel(READING_ACTIVITY)).not.toThrow();
    expect(READING_ACTIVITY.length).toBeLessThanOrEqual(MAX_ACTIVITY_LABEL);
    expect(READING_ACTIVITY).not.toMatch(EM_DASH);
  });
});

describe("copy: family messages by sharing level", () => {
  it("red-flag alert at status and status_vitals has no medical detail", () => {
    for (const sharing of ["status", "status_vitals"] as const) {
      const text = familyRedFlagAlert({ seniorName: NAME, sharing, ...RED_FLAG });
      expect(text).toBe("Harriet reported something she should call her doctor about. Please call Harriet today to check on her.");
      expect(text).not.toContain(RED_FLAG.questionText);
      expect(text).not.toContain(`"${RED_FLAG.answer}"`);
      expect(text.toLowerCase()).not.toContain("breathing");
    }
  });

  it("red-flag alert at all includes the question and answer, and still asks for a call today", () => {
    const text = familyRedFlagAlert({ seniorName: NAME, sharing: "all", ...RED_FLAG });
    expect(text).toContain(RED_FLAG.questionText);
    expect(text).toContain(`"${RED_FLAG.answer}"`);
    expect(text).toContain("Please call Harriet today to check on her.");
  });

  it("a red flag she typed carries her words at all only", () => {
    const words = "Yes but it was weirder";
    expect(familyRedFlagAlert({ seniorName: NAME, sharing: "all", ...RED_FLAG, words })).toMatch(/answered: "Yes, it was hard"\nHarriet wrote: "Yes but it was weirder"$/);
    expect(familyRedFlagAlert({ seniorName: NAME, sharing: "status", ...RED_FLAG, words })).not.toContain(words);
  });

  it("a level 3 from her words in chat (no question) carries only her words at all", () => {
    const words = "my gums keep bleeding a lot";
    expect(familyRedFlagAlert({ seniorName: NAME, sharing: "all", words })).toBe(
      `Harriet reported something she should call her doctor about. Please call Harriet today to check on her.\n\nHarriet wrote: "${words}"`,
    );
    expect(familyRedFlagAlert({ seniorName: NAME, sharing: "status", words })).not.toContain(words);
    expect(familyRedFlagAlert({ seniorName: NAME, sharing: "all" })).toBe(familyRedFlagAlert({ seniorName: NAME, sharing: "status" }));
  });

  it("the daily status says the day's highest level in words at all only, from level 1", () => {
    const status = (sharing: SharingLevel, level: number, topic: string) =>
      familyDailyStatus({ seniorName: NAME, sharing, outcome: "checked_in", answers: [], flags: [], highest: { level, topic } });
    expect(status("all", 2, "hf-ankle-swelling")).toBe("Harriet checked in today.\n\nHarriet mentioned some ankle swelling (we're keeping an eye on it).");
    expect(status("all", 1, "dizzy-on-standing")).toContain("Harriet mentioned some dizziness (noted for the doctor).");
    expect(status("all", 1, "knee pain")).toContain("Harriet mentioned knee pain (noted for the doctor).");
    expect(status("all", 2, "a little cough")).toContain("Harriet mentioned cough (we're keeping an eye on it).");
    expect(status("all", 3, "hf-breathing-lying-flat")).toContain("Harriet reported some trouble breathing and was asked to call the doctor today.");
    expect(status("all", 4, "urgent_symptom")).toContain("Harriet told me about something urgent today.");
    expect(status("all", 1, "!!??")).toContain("Harriet mentioned a symptom (noted for the doctor).");
    expect(status("all", 0, "hf-ankle-swelling")).toBe("Harriet checked in today.");
    for (const sharing of ["status", "status_vitals"] as const)
      for (const level of [0, 1, 2, 3]) expect(status(sharing, level, "hf-ankle-swelling")).toBe("Harriet checked in today.");
  });

  it("crisis and urgent alerts reach every level; below all with no detail, at all with her words", () => {
    for (const sharing of ["status", "status_vitals"] as const) {
      expect(familyCrisisAlert({ seniorName: NAME, sharing, words: CRISIS_WORDS })).toBe(
        "Harriet may be going through a very hard time. Please call her now.",
      );
      const urgent = familyUrgentAlert({ seniorName: NAME, sharing, words: "I have chest pain" });
      expect(urgent).toBe("Harriet told me about something that may be urgent. Please call Harriet now to check on her.");
    }
    const crisis = familyCrisisAlert({ seniorName: NAME, sharing: "all", words: CRISIS_WORDS });
    expect(crisis).toContain(`Harriet wrote: "${CRISIS_WORDS}"`);
    expect(crisis).toContain("988");
    expect(familyUrgentAlert({ seniorName: NAME, sharing: "all", words: "I have chest pain" })).toContain('Harriet wrote: "I have chest pain"');
  });

  it("her notes show in the daily status at all only", () => {
    const notes = [{ questionText: RED_FLAG.questionText, text: "Not really but I have more info" }];
    const input = { seniorName: NAME, outcome: "checked_in" as const, answers: ANSWERS, flags: [], notes };
    expect(familyDailyStatus({ ...input, sharing: "all" })).toContain(
      `Harriet also wrote (kept for the doctor):\n- ${RED_FLAG.questionText} "Not really but I have more info"`,
    );
    for (const sharing of ["status", "status_vitals"] as const) expect(familyDailyStatus({ ...input, sharing })).not.toContain("more info");
  });

  it("the family welcome says it's an AI assistant, daily updates come here, she decides what they see, urgent alerts always come", () => {
    const text = familyWelcome(NAME);
    expect(text).toMatch(/assistant/);
    expect(text).toMatch(/AI, not a person/);
    expect(text).toMatch(/Each day I'll send you an update on Harriet's check-in here/);
    expect(text).toMatch(/Harriet decides how much you see/);
    expect(text).toMatch(/something urgent, you'll always hear about it/);
    expect(familyWelcome("Rosa")).toContain("Rosa's check-in assistant");
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

  it("a reading not compared with her usual range (atrial fibrillation) is only an estimate: number at all, none at status_vitals", () => {
    const input = { seniorName: NAME, outcome: "checked_in" as const, answers: [], flags: [], vitals: { heartRate: 78 } };
    expect(familyDailyStatus({ ...input, sharing: "status" })).toBe("Harriet checked in today.");
    expect(familyDailyStatus({ ...input, sharing: "status_vitals" })).toBe(
      "Harriet checked in today.\n\nHeart rate checked today. This is a camera estimate, not a medical test.",
    );
    expect(familyDailyStatus({ ...input, sharing: "all" })).toBe(
      "Harriet checked in today.\n\nHeart rate today: about 78 beats a minute. This is a camera estimate, not a medical test.",
    );
    for (const sharing of LEVELS) expect(familyDailyStatus({ ...input, sharing })).not.toMatch(/usual range|within|outside/);
  });

  it("without vitals the daily status is unchanged by level below all", () => {
    const input = { seniorName: NAME, outcome: "not_today" as const, answers: ANSWERS, flags: [] };
    expect(familyDailyStatus({ ...input, sharing: "status_vitals" })).toBe(familyDailyStatus({ ...input, sharing: "status" }));
  });

  it("sharing change tells the family member what changed, not why", () => {
    for (const level of LEVELS) {
      const text = sharingChangedFamily(NAME, level);
      expect(text).toContain("Harriet changed what you see here.");
      expect(text.toLowerCase()).not.toMatch(/because|reason|why/);
    }
  });

  it("speaks to one family member in their own chat, never to a group", () => {
    const family: string[] = [recordLinkEndedFamily(NAME), familyMissedAlert(NAME, "12:00"), familyWelcome(NAME)];
    for (const sharing of LEVELS) {
      family.push(sharingChangedFamily(NAME, sharing), familyRedFlagAlert({ seniorName: NAME, sharing, ...RED_FLAG }));
      for (const outcome of OUTCOMES)
        family.push(familyDailyStatus({ seniorName: NAME, sharing, outcome, answers: ANSWERS, flags: [{ message: FLAG_MESSAGE }] }));
    }
    for (const text of family) expect(text.toLowerCase(), text).not.toMatch(/\bgroup\b|everyone|all of you|you all/);
  });

  it("record link ended messages name no cause and no blame", () => {
    for (const text of [recordLinkEndedSenior(NAME), recordLinkEndedFamily(NAME)]) {
      expect(text).toContain("health record has ended");
      expect(text.toLowerCase()).not.toMatch(/because|revoked|you turned|fault|error/);
    }
  });
});
