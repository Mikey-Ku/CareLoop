import type { SharingLevel } from "../db/index.ts";

// Every word the senior and her family read, as fixed templates. No LLM here:
// run 4 may reword through Claude, but these are the safe defaults and the
// fallback. Rules from docs/BRIEF.md: "Not today" never gets a guilt message;
// red flags reach the family at every sharing level, with detail only at "all".
//
// Style for everything here: short sentences, plain words, no exclamation marks,
// no em dashes. The assistant says what it is and never acts like a friend or a
// clinician. Flags are always "something to ask your doctor", never advice to
// start, stop or change a medicine.
//
// CONTRACT: the signatures below are what the engine calls. The copy agent owns
// the wording and may add functions, but must not change these signatures.
//
// Severity ladder (docs/DESIGN.md, src/checkin/severity.ts): the words match the level.
// Levels 0 to 2 never mention 911, an emergency or an ambulance (test/copy.test.ts scans
// them); "if it gets much worse, call 911" starts at level 3, 911 now at level 4.

export const BUTTON = {
  /** On the greeting: today's questions with buttons, for when she'd rather tap than type. */
  start: "Quick questions",
  notToday: "Not today",
  tellMeMore: "Tell me more",
  later: "Later",
  willAskDoctor: "I'll ask my doctor",
} as const;

/** Older labels of BUTTON.start, still taken (typed or tapped) at the greeting so old messages and scripts work. */
export const START_ALIASES: readonly string[] = ["Let's start"];

export type DayOutcome = "checked_in" | "not_today" | "missed";

export type AnsweredQuestion = { questionId: string; questionText: string; answer: string };

/** "a", "a and b", "a, b and c" (or "a, b or c" with `or`). */
function listJoin(items: readonly string[], word: "and" | "or" = "and"): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} ${word} ${items.at(-1)}`;
}

/** The family members who were told (display names, blanks dropped): undefined means "your family", [] means no one. */
function whoWasTold(familyNames: string[] | undefined): string | undefined {
  const names = familyNames?.map((n) => n.trim()).filter((n) => n.length > 0);
  return names === undefined ? "your family" : names.length > 0 ? listJoin(names) : undefined;
}

// Senior-facing

/**
 * The greeting is the open question (docs/DESIGN.md "Open question first"): she answers in her own
 * words, and the questions she didn't cover come after with buttons. BUTTON.start is the way to tap
 * instead; "Not today" is the other button.
 */
export function checkinGreeting(name: string, questionCount: number): string {
  if (questionCount <= 0) return `Good morning, ${name}. This is your check-in assistant. There are no questions today. I just wanted to say hello.`;
  return `Good morning, ${name}. How are you feeling today? Just tell me in your own words, like a text to a friend. Or tap ${BUTTON.start} if you'd rather tap.`;
}

/** The hint under each question on her first check-ins (HINT_CHECKINS in the engine), so typing is obvious. */
export const TYPING_HINT = "(Tap an answer, or just tell me.)";

/** A question's text with the typing hint on its own line under it. */
export function withTypingHint(text: string): string {
  return `${text}\n${TYPING_HINT}`;
}

/** Her open reply was read and nothing in it needs a reaction; a question she didn't cover comes next. */
export function openReplyThanks(name: string): string {
  return `Thanks, ${name}.`;
}

/** She answered the open question, but typed replies can't be read right now (no LLM, or it is down). */
export function openReplyUnavailable(name: string): string {
  return `Thanks, ${name}. I'm having trouble reading typed replies right now, so let's do a few quick questions.`;
}

/** Level 1 from her open reply when it is about her mood ("Not great"): short and warm, at most two sentences. */
export function sorryNotGreat(name: string): string {
  return `I'm sorry you're not feeling great, ${name}. Thank you for telling me.`;
}

/** She tapped "Let me explain" on a question: her next message is her own words about it. No buttons. */
export function explainPrompt(name: string): string {
  return `Go ahead, ${name}. Tell me in your own words.`;
}

/** Reply to "Not today". Never implies she should have answered. */
export function notTodayReply(name: string): string {
  return `That's fine, ${name}. I'll check in again tomorrow. Have a good day.`;
}

/**
 * Level 3 (a red-flag answer, a typed symptom that bad, or "Worse" on a follow-up). Thanks her
 * first, calmly, then says who was told, then her doctor today, then 911 only if it gets much worse.
 * `familyNames` are the family members whose chats got the alert: left out, it says
 * "your family"; an empty list (nobody linked) says nothing about family, so she is
 * never told someone was alerted when no one was. No pronouns for family members:
 * the app doesn't know them. `moreQuestions` (the check-in's questions still to come) adds
 * a gentle line, so the next question doesn't arrive out of nowhere.
 */
export function redFlagAdvice(name: string, familyNames?: string[], moreQuestions = 0): string {
  const who = whoWasTold(familyNames);
  const lines = [`Thank you for telling me, ${name}.`];
  if (who) lines.push(`I've let ${who} know.`);
  lines.push("Please call your doctor today about this.", "If it gets much worse, call 911.");
  if (moreQuestions > 0) lines.push(`When you're ready, I have ${moreQuestions === 1 ? "one more question" : `${moreQuestions} more questions`} for you.`);
  return lines.join(" ");
}

export function flagOffer(): string {
  return "There's one thing in your health record that may be worth asking your doctor about. Would you like to hear it?";
}

/** `message` is the rule result's plain message. */
export function flagDetail(message: string): string {
  return `${message}\n\nThis isn't an emergency. It's something to ask your doctor about at your next visit. Please don't change how you take any medicine before talking with your doctor.`;
}

export function flagNotedReply(): string {
  return "Good. I've added it to your list of things to ask your doctor at your next visit.";
}

export function checkinDone(name: string): string {
  return `That's everything for today, ${name}. Thank you. I'll check in again tomorrow.`;
}

/** The closing on a day with a red flag or a safety hit: a follow-up check-in comes later today. */
export function checkinDoneAfterConcern(name: string): string {
  return `Thank you, ${name}. I'll check on you again this afternoon.`;
}

/** The model read her words but couldn't match them to an answer. `buttons`: the answers (not "Let me explain"). */
export function didntUnderstand(buttons: string[]): string {
  const quoted = buttons.map((b) => `"${b}"`);
  return `Sorry, I didn't quite catch that. You can tap one of these, or tell me in a few words: ${listJoin(quoted, "or")}.`;
}

/**
 * She typed while a question waits, and the assistant can't read typed replies (no LLM, or it is
 * down). Says it is the assistant's trouble, never hers, and offers the buttons.
 */
export function typedReplyUnavailable(buttons: string[]): string {
  const quoted = buttons.map((b) => `"${b}"`);
  return `I'm having trouble reading typed replies right now. You can tap one of these: ${listJoin(quoted, "or")}.`;
}

// Free text (src/checkin/engine.ts): what she types instead of tapping a button.

/** The activity label her chat shows while the assistant reads what she typed (Relay: 1 to 21 characters). */
export const READING_ACTIVITY = "Reading your message";

/** How much of her own words a confirm quotes back. */
export const QUOTE_MAX_CHARS = 120;

/** Her words on one line, cut at a word near QUOTE_MAX_CHARS. Double quotes and long dashes are softened. */
function quoteHerWords(reply: string): string {
  const one = reply.replace(/\s+/g, " ").replace(/"/g, "'").replace(/\s*[\u2013\u2014]\s*/g, " - ").trim();
  if (one.length <= QUOTE_MAX_CHARS) return one;
  const cut = one.slice(0, QUOTE_MAX_CHARS);
  const space = cut.lastIndexOf(" ");
  return `${(space > QUOTE_MAX_CHARS / 2 ? cut.slice(0, space) : cut).replace(/[\s.,;:]+$/, "")}...`;
}

/** Her words in full on one line (for her family), double quotes and long dashes softened, capped at 1000 characters. */
function herWordsInFull(text: string): string {
  const one = text.replace(/\s+/g, " ").replace(/"/g, "'").replace(/\s*[\u2013\u2014]\s*/g, " - ").trim();
  return one.length > 1000 ? `${one.slice(0, 1000).trimEnd()}...` : one;
}

/**
 * She typed an answer to a red-flag question that isn't an explicit yes. The app never records
 * that answer from what an AI made of her words (an AI never clears a red flag): it quotes them
 * back and asks the question again with its own buttons, so the red-flag rule acts on her tap.
 * An explicit yes in her own words ("Yes but it was weirder") counts as her "Yes" without this.
 */
export function freeTextConfirm(reply: string, questionText: string): string {
  return `You wrote: "${quoteHerWords(reply)}"\nJust to check: ${questionText}`;
}

/**
 * She mentioned a health complaint in chat, and the model didn't say which symptom or how much.
 * Level-1 wording (the fallback for symptomNotedReply): a fixed reply, not the model's words, no
 * advice, no 911, no family alert.
 */
export function complaintReply(name: string): string {
  return `Thank you for telling me, ${name}. I've made a note of that for your doctor.`;
}

// Severity ladder reactions (src/checkin/severity.ts). Level 1 and 2 lines are folded into the
// next message of the check-in (withLead), or sent on their own in chat.

/** A short line put before the next message of the check-in, on its own line. */
export function withLead(lead: string | undefined, text: string): string {
  return lead ? `${lead}\n\n${text}` : text;
}

/** Level 1 in a check-in, at most once per check-in: saved for her doctor, nothing more. */
export function notedForDoctor(): string {
  return "Thanks, I've made a note of that for your doctor.";
}

/** Level 2 in a check-in: worth watching. A follow-up comes later today. */
export function keepAnEye(name: string): string {
  return `Thanks for telling me, ${name}. Let's keep an eye on that.`;
}

/** Level 2 in chat: worth watching, and she hears that we'll ask again later. */
export function keepAnEyeReply(name: string): string {
  return `${keepAnEye(name)} I'll check on you again later today.`;
}

/** Words for a question's topic, in a sentence about her ("Sorry to hear about your ..."). */
const TOPIC_PLAIN: Record<string, string> = {
  "hf-ankle-swelling": "ankle swelling",
  "hf-breathing-lying-flat": "breathing",
  "anticoagulant-bleeding": "bruising or bleeding",
  "dizzy-on-standing": "dizziness",
  "morning-medicines": "medicines",
  mood: "mood",
};

/** Words for a question's topic, as the family reads it ("Harriet mentioned ..."). */
const TOPIC_FOR_FAMILY: Record<string, string> = {
  "hf-ankle-swelling": "some ankle swelling",
  "hf-breathing-lying-flat": "some trouble breathing",
  "anticoagulant-bleeding": "some bruising or bleeding",
  "dizzy-on-standing": "some dizziness",
  "morning-medicines": "missing some of her morning medicines",
  mood: "not feeling great",
};

/** Longest topic, in characters and in words, quoted from her (via the model) in a fixed sentence. */
const MAX_TOPIC_CHARS = 40;
const MAX_TOPIC_WORDS = 4;

/**
 * Her own topic words, fit to put in a fixed sentence ("knee pain"), else undefined: letters, spaces,
 * apostrophes and hyphens only, a few words, leading "my", "a little" and the like dropped.
 */
export function topicWords(topic: string): string | undefined {
  const bank = TOPIC_PLAIN[topic];
  if (bank) return bank;
  const words = topic
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .replace(/^(?:(?:a little|a bit of|a bit|a lot of|some|my|her|your|the|a|an)\s+)+/, "");
  if (!words || words.length > MAX_TOPIC_CHARS || words.split(" ").length > MAX_TOPIC_WORDS) return undefined;
  return /^[a-z][a-z' -]*$/.test(words) ? words : undefined;
}

/**
 * Level 1 in chat: she mentioned something small ("my knee aches"). Sorry, and noted for her doctor;
 * no advice, no 911. Her topic words when they fit, else a general line.
 */
export function symptomNotedReply(name: string, topics: string[]): string {
  const words = [...new Set(topics.map(topicWords).filter((w): w is string => w !== undefined))].slice(0, 2);
  const sorry = words.length > 0 ? `Sorry to hear about your ${listJoin(words)}, ${name}.` : `Sorry that's bothering you, ${name}.`;
  return `${sorry} I've made a note for your doctor.`;
}

// One understanding pass (src/checkin/engine.ts): what was understood from her typed words is said
// back in one fixed line before the next message. No LLM wording.

/** Her answer said back, by question and label ("Got it: ankles feeling fine."). */
export const ANSWER_PHRASES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  "hf-ankle-swelling": { No: "ankles feeling fine", "A little": "ankles a little swollen", "More than usual": "ankles more swollen than usual" },
  "hf-breathing-lying-flat": {
    Fine: "your breathing was fine",
    "A little hard": "your breathing was a little hard at times",
    "Yes, it was hard": "your breathing was hard",
  },
  "anticoagulant-bleeding": { No: "no unusual bruising or bleeding", "A little bruising": "a little bruising", "Yes, bleeding": "some bleeding" },
  "dizzy-on-standing": { No: "no dizziness", Sometimes: "a little dizzy at times", Often: "dizzy often" },
  "morning-medicines": { Yes: "medicines taken", "Not yet": "medicines not taken yet", "Some of them": "took some of your medicines" },
  mood: { Good: "feeling good", Okay: "feeling okay", "Not great": "not feeling great" },
};

/** Short names for a question's topic in that line ("Let's keep an eye on the dizziness."). */
export const ECHO_TOPICS: Readonly<Record<string, string>> = {
  "hf-ankle-swelling": "ankles",
  "hf-breathing-lying-flat": "breathing",
  "anticoagulant-bleeding": "bruising or bleeding",
  "dizzy-on-standing": "dizziness",
  "morning-medicines": "medicines",
  mood: "mood",
};

/** The phrase for one answer to one question (labels match case-insensitively), if there is one. */
export function answerPhrase(questionId: string, answer: string): string | undefined {
  const table = ANSWER_PHRASES[questionId] ?? {};
  const key = Object.keys(table).find((k) => k.toLowerCase() === answer.trim().toLowerCase());
  return key === undefined ? undefined : table[key];
}

/** One thing understood from her words: an answer recorded (`answer`, `topic` its question id), or a symptom on `topic`. */
export type UnderstoodItem = { topic: string; level: number; answer?: string };

/**
 * What one typed message told us, said back in at most two short sentences: the answers recorded from
 * her words ("Got it: ankles feeling fine."), then the ladder's line for the highest level, naming what
 * it is about (1: "I've noted the back pain for your doctor.", mood "Not great": "I'm sorry to hear
 * that.", 2: "Let's keep an eye on the dizziness."). Undefined when nothing was understood, and at
 * level 3 and up, whose own messages are sent instead. Never mentions 911.
 */
export function understoodLine(items: readonly UnderstoodItem[]): string | undefined {
  if (items.length === 0) return undefined;
  const top = Math.max(0, ...items.map((i) => i.level));
  if (top >= 3) return undefined;
  const answered = items.flatMap((i) => {
    const phrase = i.answer === undefined ? undefined : answerPhrase(i.topic, i.answer);
    return phrase === undefined ? [] : [phrase];
  });
  const sentences: string[] = [];
  if (answered.length > 0) sentences.push(`Got it: ${listJoin(answered)}.`);
  if (top >= 1) {
    const atTop = items.filter((i) => i.level === top);
    const names = [...new Set(atTop.map((i) => ECHO_TOPICS[i.topic] ?? topicWords(i.topic)).filter((n): n is string => n !== undefined))].slice(0, 2);
    const justSaid = atTop.every((i) => i.answer !== undefined) && answered.length === 1;
    const what = justSaid || names.length === 0 ? "that" : listJoin(names.map((n) => `the ${n}`));
    if (top === 2) sentences.push(`Let's keep an eye on ${what}.`);
    else if (atTop.every((i) => i.topic === "mood" && i.answer !== undefined)) sentences.push("I'm sorry to hear that.");
    else sentences.push(`I've noted ${what} for your doctor.`);
  }
  return sentences.length > 0 ? sentences.join(" ") : undefined;
}

/**
 * Her words on a red-flag question suggested an answer below level 3: she is asked to confirm it with
 * one tap ("Yes, that's right", the other answers, "Let me explain"), never recorded from the reading.
 * `phrase` comes from answerPhrase.
 */
export function suggestedConfirm(phrase: string): string {
  return `It sounds like ${phrase}. Is that right?`;
}

/** "Clarify" buttons: the one question that may follow a typed symptom whose amount is unclear. */
export const CLARIFY_BUTTONS = { a_little: "A little", a_lot: "A lot" } as const;

/** Asked at most once per symptom, only when the answer changes the level. */
export function clarifyAmount(name: string): string {
  return `Thanks, ${name}. Is it a little, or a lot?`;
}

/**
 * The reply to a message outside a check-in when the assistant can't read it (no LLM, or it is down).
 * It can't tell what she wrote, so it points to her doctor and 911 in case it was something worrying.
 */
export function smallTalkFallback(name: string): string {
  return `Thanks for your message, ${name}. I'll be back with your next check-in. If something is worrying you, please call your doctor. If it feels like an emergency, call 911.`;
}

// Typed messages, sorted by kind (src/checkin/engine.ts "Typed messages"). Fixed wording:
// the model's own words are used only for plain chat.

/** She added detail while a question waits. Her words are kept for her doctor; the buttons come with it. */
export function noteSaved(name: string): string {
  return `Thank you, ${name}. I've written that down for your doctor. You can keep telling me, or tap an answer below.`;
}

/** She asked about her medicines. Never answered here: it goes on her list for the next visit. */
export function medicineQuestionReply(name: string): string {
  return `That's a good question for your doctor or pharmacist, ${name}. I've added it to your list for your next visit. Please don't change any medicine before you ask them.`;
}

/** She sounds lonely, sad or worried. Warm and short, no alert. */
export function feelingLowReply(name: string): string {
  return `I'm sorry you're feeling this way, ${name}. Thank you for telling me. It might help to call someone you're close to today. A friend or family member would be glad to hear from you.`;
}

/**
 * Safety screen or model: thoughts of self-harm or not wanting to live. She matters, 988 now, 911 if
 * in danger. `familyNames` as in redFlagAdvice: the family line only when someone was told.
 */
export function crisisReply(name: string, familyNames?: string[]): string {
  const who = whoWasTold(familyNames);
  const lines = [
    `${name}, thank you for telling me. You matter, and you don't have to face this alone.`,
    "Please call or text 988 now. That's the Suicide & Crisis Lifeline, open day and night.",
    "If you're in danger right now, call 911.",
  ];
  if (who) lines.push(`I've let ${who} know.`);
  return lines.join(" ");
}

/** Safety screen or model: an urgent symptom (chest pain, a fall, can't breathe). 911 first, then her doctor. */
export function urgentReply(name: string, familyNames?: string[]): string {
  const who = whoWasTold(familyNames);
  const lines = [`${name}, if this is happening now, please call 911 right away.`, "After that, call your doctor."];
  if (who) lines.push(`I've let ${who} know so someone can check on you.`);
  return lines.join(" ");
}

/** She asked for something to be passed on to her family: what each family member reads. */
export function familyRelay(name: string, words: string): string {
  return `${name} asked me to pass this on: "${herWordsInFull(words)}"`;
}

/** Her reply once it went to her family (`familyNames` as in redFlagAdvice). */
export function familyRelayDone(name: string, familyNames?: string[]): string {
  return `Thank you, ${name}. I've passed that on to ${whoWasTold(familyNames) ?? "your family"}.`;
}

/** Her reply when no family member has connected yet; it is kept and passed on when one does. */
export function familyRelayWaiting(name: string): string {
  return `Thank you, ${name}. I'll pass it on when your family has connected with me.`;
}

/** She sent a photo. Until photos are read (the paper check), it's kind and points to her doctor. */
export function photoNotYet(name: string): string {
  return `Thanks for the photo, ${name}. I can't read photos yet. Please bring it to your doctor or pharmacist.`;
}

// Follow-up check-in, some hours after a red flag or a safety hit.

/** What a follow-up asks about: a question's topic, how she feels after a crisis, or in general. */
export type FollowUpTopic = "breathing" | "bleeding" | "ankles" | "dizziness" | "crisis" | "general";

/** The follow-up's buttons. Each is at most 80 characters (Relay limit). */
export const FOLLOW_UP_BUTTONS = { better: "Better", same: "About the same", worse: "Worse" } as const;

export type FollowUpAnswer = keyof typeof FOLLOW_UP_BUTTONS;

/** The follow-up's question on its own, as the family reads it. */
export function followUpAsk(topic: FollowUpTopic): string {
  switch (topic) {
    case "breathing":
      return "How is your breathing now?";
    case "bleeding":
      return "How is the bruising or bleeding now?";
    case "ankles":
      return "How are your ankles now?";
    case "dizziness":
      return "How is the dizziness now?";
    case "crisis":
    case "general":
      return "How are you feeling now?";
  }
}

export function followUpQuestion(name: string, topic: FollowUpTopic): string {
  return `Checking in again, ${name}. ${followUpAsk(topic)}`;
}

/**
 * Her reply to "Better" (level 0: a warm close) or "About the same" (level 2: keep an eye on it,
 * noted for her doctor). After a crisis it points to 988 whatever she answers.
 * "Worse" gets redFlagAdvice again (level 3; crisisReply after a crisis).
 */
export function followUpReply(name: string, answer: Exclude<FollowUpAnswer, "worse">, topic: FollowUpTopic = "general"): string {
  if (topic === "crisis") {
    const lifeline = "You can call or text 988 any time, day or night.";
    if (answer === "better") return `I'm glad to hear that, ${name}. ${lifeline}`;
    return `Thank you for letting me know, ${name}. ${lifeline} If you're in danger, call 911.`;
  }
  if (answer === "better") return `I'm glad to hear that, ${name}. Thank you for letting me know.`;
  return `Thank you for letting me know, ${name}. Let's keep an eye on that. I've made a note for your doctor.`;
}

// Hospital paper check (after the read-back)

/** After "No, something's off". */
export const PAPER_REJECTED_REPLY =
  "Thank you for checking. I won't use what I read. Please bring the papers to your doctor or pharmacist so they can go over them with you.";
/**
 * After "Later" on the paper result. She has heard it, so the flag is told and is not
 * offered again on its own (the same as "Later" after a check-in flag's detail).
 */
export const PAPER_LATER_REPLY =
  "That's fine. When you can, please bring the papers to your doctor or pharmacist and ask about this.";
/** No medicines were read off the papers. */
export const PAPER_NOTHING_TO_COMPARE =
  "There were no medicines on the papers to compare with your medication list, so there's nothing to check.";
/** Record consent ended between the read-back and her "Yes". */
export const PAPER_NO_RECORD_REPLY =
  "I can't compare the papers with your medication list, because the link to your health record has ended. Please bring the papers to your doctor or pharmacist.";

// Record consent (docs/DESIGN.md "Sharing levels and record consent")

/** Record consent ended (FinchNode 410). Plain words, no cause, no blame. */
export function recordLinkEndedSenior(name: string): string {
  return `${name}, the link to your health record has ended. I've stopped reading it and deleted my copy. Our chats are still here. You can ask to have them deleted too.`;
}

export function recordLinkEndedFamily(name: string): string {
  return `The link to ${name}'s health record has ended. The app has stopped reading it and deleted its copy.`;
}

// Sharing level (only the senior changes it)

/** Label of the button in the senior's chat that opens the sharing menu. */
export const SHARING_MENU_BUTTON = "Sharing";

/** One button per sharing level. Each is at most 80 characters (Relay limit). */
export const SHARING_BUTTONS: Record<SharingLevel, string> = {
  status: "Just check-ins",
  status_vitals: "Check-ins and heart rate",
  all: "Everything",
};

/** Maps a tapped sharing button back to its level. */
export function sharingLevelFromButton(label: string): SharingLevel | undefined {
  const match = (Object.keys(SHARING_BUTTONS) as SharingLevel[]).find((level) => SHARING_BUTTONS[level] === label.trim());
  return match;
}

/** What the family sees at each level, finishing the sentence "Your family sees ...". */
const SEES: Record<SharingLevel, string> = {
  status: "whether you checked in each day",
  status_vitals: "whether you checked in each day, and how your heart rate checks went",
  all: "whether you checked in, your heart rate readings, your answers, and the things to ask your doctor about",
};

export function sharingMenu(current?: SharingLevel): string {
  const lines = [
    "You decide how much your family sees. You can change this any time.",
    "",
    `"${SHARING_BUTTONS.status}": ${SEES.status}.`,
    `"${SHARING_BUTTONS.status_vitals}": ${SEES.status_vitals}.`,
    `"${SHARING_BUTTONS.all}": ${SEES.all}.`,
    "",
    "If you ever tell me something urgent, your family always hears about it, so someone can check on you.",
  ];
  if (current) lines.push(`Right now it's set to "${SHARING_BUTTONS[current]}".`);
  return lines.join("\n");
}

export function sharingChangedSenior(level: SharingLevel): string {
  return `Done. Your family now sees ${SEES[level]}. You can change this any time with the "${SHARING_MENU_BUTTON}" button.`;
}

/** The family is told it changed, not why. Sent to each family member in their own chat with the agent. */
export function sharingChangedFamily(name: string, level: SharingLevel): string {
  const sees: Record<SharingLevel, string> = {
    status: `whether ${name} checked in each day`,
    status_vitals: `whether ${name} checked in each day, and how ${name}'s heart rate checks went`,
    all: `${name}'s check-ins, heart rate readings, answers, and things to ask the doctor about`,
  };
  return `${name} changed what you see here. From now on: ${sees[level]}. Urgent alerts still come through as before.`;
}

// Family-facing. Each family member reads these in their own chat with the agent
// (a family chat), so they speak to one person, never to "the group".

export function familyDailyStatus(input: {
  seniorName: string;
  sharing: SharingLevel;
  outcome: DayOutcome;
  answers: AnsweredQuestion[];
  flags: { message: string }[];
  /**
   * Today's camera heart-rate reading, if any. Shown at "status_vitals" and "all" only.
   * `inUsualRange` is left out when the reading isn't compared with her usual range
   * (no usual range, or atrial fibrillation; see the packet's `usualRange.compareHeartRate`):
   * then it is shown as an estimate only, with the number at "all" and without it at
   * "status_vitals", which shows no numbers.
   */
  vitals?: { heartRate: number; inUsualRange?: boolean };
  /** Her own words about today's questions (checkin_notes). Shown at "all" only. */
  notes?: { questionText: string; text: string }[];
  /** The day's highest severity level and its topic (src/checkin/severity.ts). Said in words at "all" only, from level 1. */
  highest?: { level: number; topic: string };
}): string {
  const name = input.seniorName;
  const base =
    input.outcome === "checked_in"
      ? `${name} checked in today.`
      : input.outcome === "not_today"
        ? `${name} said "not today" to today's check-in.`
        : `${name} didn't answer today's check-in.`;

  let vitals = "";
  if (input.vitals && input.sharing !== "status") {
    const { heartRate, inUsualRange } = input.vitals;
    const estimate = "This is a camera estimate, not a medical test.";
    if (inUsualRange === undefined) {
      vitals = input.sharing === "all" ? `Heart rate today: about ${heartRate} beats a minute. ${estimate}` : `Heart rate checked today. ${estimate}`;
    } else {
      const where = inUsualRange ? `within ${name}'s usual range` : `outside ${name}'s usual range`;
      const reading = input.sharing === "all" ? `${heartRate} beats a minute, ${where}` : where;
      vitals = `Heart rate today: ${reading}. ${estimate}`;
    }
  }
  if (input.sharing !== "all") return [base, vitals].filter(Boolean).join("\n\n");

  const highest = input.highest ? levelInWords(name, input.highest) : "";
  const answers = input.answers.map((a) => `- ${a.questionText} ${a.answer}`).join("\n");
  const flags = input.flags.map((f) => `- ${f.message}`).join("\n");
  const notes = (input.notes ?? []).map((n) => `- ${n.questionText} "${herWordsInFull(n.text)}"`).join("\n");
  return [
    base,
    vitals,
    highest,
    answers && `${name}'s answers:\n${answers}`,
    notes && `${name} also wrote (kept for the doctor):\n${notes}`,
    flags && `Things for ${name} to ask the doctor about:\n${flags}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** The day's highest level in words, for the family at "all". Nothing for level 0. */
function levelInWords(name: string, highest: { level: number; topic: string }): string {
  const what = TOPIC_FOR_FAMILY[highest.topic] ?? topicWords(highest.topic) ?? "a symptom";
  if (highest.level >= 4) return `${name} told me about something urgent today.`;
  if (highest.level === 3) return `${name} reported ${what} and was asked to call the doctor today.`;
  if (highest.level === 2) return `${name} mentioned ${what} (we're keeping an eye on it).`;
  if (highest.level === 1) return `${name} mentioned ${what} (noted for the doctor).`;
  return "";
}

export function familyRedFlagAlert(input: {
  seniorName: string;
  sharing: SharingLevel;
  /** The question and her answer, when it came from a check-in question. Shown at "all" only. */
  questionText?: string;
  answer?: string;
  /** What she typed, when the answer came from her words. Shown at "all" only. */
  words?: string;
}): string {
  // No medical detail below "all" (docs/DESIGN.md "Sharing levels and record consent").
  // It asks for a call today, matching what the senior hears (redFlagAdvice).
  const base = `${input.seniorName} reported something she should call her doctor about. Please call ${input.seniorName} today to check on her.`;
  if (input.sharing !== "all") return base;
  const lines = [base, ""];
  if (input.questionText && input.answer) lines.push(`The question was: ${input.questionText}`, `${input.seniorName} answered: "${input.answer}"`);
  if (input.words) lines.push(`${input.seniorName} wrote: "${herWordsInFull(input.words)}"`);
  return lines.length > 2 ? lines.join("\n") : base;
}

/**
 * Safety screen or model found a crisis. Goes to the family at every sharing level; below "all"
 * with no detail at all, at "all" with her words and what she was told.
 */
export function familyCrisisAlert(input: { seniorName: string; sharing: SharingLevel; words?: string }): string {
  const name = input.seniorName;
  const base = `${name} may be going through a very hard time. Please call her now.`;
  if (input.sharing !== "all") return base;
  const wrote = input.words ? `\n\n${name} wrote: "${herWordsInFull(input.words)}"` : "";
  return `${base}${wrote}\n\nI asked ${name} to call or text 988, the Suicide & Crisis Lifeline, or 911 if in danger.`;
}

/** Safety screen or model found an urgent symptom. Every sharing level, like a red flag; detail at "all". */
export function familyUrgentAlert(input: { seniorName: string; sharing: SharingLevel; words?: string }): string {
  const name = input.seniorName;
  const base = `${name} told me about something that may be urgent. Please call ${name} now to check on her.`;
  if (input.sharing !== "all") return base;
  const wrote = input.words ? `\n\n${name} wrote: "${herWordsInFull(input.words)}"` : "";
  return `${base}${wrote}\n\nI asked ${name} to call 911 if it's happening now, and then her doctor.`;
}

/** She tapped "Worse" on a follow-up: an alert at every sharing level, the question and answer at "all". */
export function familyFollowUpWorse(input: { seniorName: string; sharing: SharingLevel; topic: FollowUpTopic }): string {
  const name = input.seniorName;
  const base = `${name} said she feels worse than earlier today. Please call ${name} now to check on her.`;
  if (input.sharing !== "all") return base;
  return `${base}\n\nI asked: ${followUpAsk(input.topic)}\n${name} answered: "${FOLLOW_UP_BUTTONS.worse}"`;
}

/** Her "Better" or "About the same" on a follow-up. Sent to the family at sharing "all" only. */
export function familyFollowUpUpdate(input: { seniorName: string; topic: FollowUpTopic; answer: Exclude<FollowUpAnswer, "worse"> }): string {
  const name = input.seniorName;
  return `I checked in with ${name} again and asked: ${followUpAsk(input.topic)}\n${name} answered: "${FOLLOW_UP_BUTTONS[input.answer]}"`;
}

/**
 * The reply a family member gets the first time they message the agent (or add it),
 * sent once when their family chat is linked.
 */
export function familyWelcome(seniorName: string): string {
  return [
    `Hello. I'm ${seniorName}'s check-in assistant. I'm an AI, not a person.`,
    `Each day I'll send you an update on ${seniorName}'s check-in here.`,
    `${seniorName} decides how much you see and can change it any time.`,
    `If ${seniorName} tells me something urgent, you'll always hear about it here.`,
  ].join(" ");
}

export function familyMissedAlert(seniorName: string, time: string): string {
  return `${seniorName} hasn't answered today's check-in yet (as of ${time}). You may want to give ${seniorName} a call.`;
}
