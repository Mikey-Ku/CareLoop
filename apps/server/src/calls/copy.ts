import type { ContextPacket } from "../context/packet.ts";
import { ANSWER_PHRASES, ECHO_TOPICS, answerPhrase, crisisReply, keepAnEye, notedForDoctor, redFlagAdvice, topicWords, urgentReply, type UnderstoodItem } from "../checkin/copy.ts";

// Every word the call says to her (or texts her about the call) that the server decides: fixed
// templates, no model text. The ElevenLabs voice holds the conversation, but what it reads back
// about her health comes from here, chosen by the severity ladder (src/checkin/severity.ts):
//   0 nothing extra, 1 noted for her doctor, 2 keep an eye on it, 3 her doctor today (911 only "if it
//   gets much worse"), 4 911 now, 5 988. The same functions as the text check-in where they exist.
// House rules (test/calls.test.ts scans these): short sentences, no long dashes, no dosing, no
// diagnosis, no 911 below level 3. The voice always says it is an AI and ends by pointing to family.

/** "a", "a and b", "a, b and c". */
export function listJoin(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/** The call's first sentence (ElevenLabs first_message): it is an AI, the call is short, then the open question. */
export function callFirstMessage(name: string): string {
  return `Hi ${name}, I'm an AI check-in assistant. This will take about three minutes. How are you feeling today?`;
}

/** Before the Presage reading: she rests the phone and the voice stays quiet. */
export const QUIET_MINUTE_PROMPT = "Rest your phone so I can see your face, and I'll stay quiet for half a minute.";

/** The goodbye: points her to her family, by name when we know them. */
export function callClosing(name: string, familyNames: readonly string[] = []): string {
  const names = familyNames.map((n) => n.trim()).filter(Boolean);
  const who = names.length > 0 ? listJoin(names) : "someone you're close to";
  return `Thank you for talking with me, ${name}. Maybe give ${who} a call today. Take care.`;
}

/** The voice's fixed answer to a medicine question; her question is added to her list for the next visit after the call. */
export const MEDICINE_QUESTION_REPLY = "That's one for your doctor or pharmacist. I'll add it to your list.";

/** A call from anyone but her: short, polite, and nothing from her record. */
export function wrongCallerDecline(): string {
  return "Sorry, I can only take check-in calls from the person I'm set up for. Goodbye.";
}

type Reading = { heartRate: number | null; breathingRate?: number | null };

/**
 * The heart rate said back as a camera estimate. An in or out of usual range phrase only when her
 * packet says readings are compared (usualRange.compareHeartRate); with AFib they never are. Breathing
 * rate is said back, never compared.
 */
export function heartRateReadback(reading: Reading, usualRange?: Pick<ContextPacket["usualRange"], "compareHeartRate" | "heartRate"> | null): string {
  const lines: string[] = [];
  if (reading.heartRate !== null) {
    const bpm = Math.round(reading.heartRate);
    lines.push(`Your heart rate is about ${bpm} beats a minute. This is a camera estimate, not a medical test.`);
    const range = usualRange?.compareHeartRate === true ? usualRange.heartRate : undefined;
    if (range) {
      lines.push(bpm >= range.low && bpm <= range.high ? "That's in your usual range." : "That's outside your usual range, so you could mention it to your doctor.");
    }
  }
  if (reading.breathingRate !== null && reading.breathingRate !== undefined) lines.push(`Your breathing was about ${Math.round(reading.breathingRate)} breaths a minute.`);
  return lines.length > 0 ? lines.join(" ") : noReadingReadback();
}

export function noReadingReadback(): string {
  return "I couldn't get a clear reading this time. That's okay, we can try again another day.";
}

export function stillMeasuring(): string {
  return "Almost done. Please stay still and quiet a little longer.";
}

export function noVideoReadback(): string {
  return "I can't see your camera right now, so we'll skip the reading today.";
}

/** The ladder's line for what she said: the highest level, naming what it is about. Empty at level 0. */
function notedLine(items: readonly UnderstoodItem[]): string {
  const top = Math.max(0, ...items.map((i) => i.level));
  if (top === 0) return "";
  const names = [
    ...new Set(items.filter((i) => i.level === top).map((i) => ECHO_TOPICS[i.topic] ?? topicWords(i.topic)).filter((n): n is string => n !== undefined)),
  ].slice(0, 2);
  const what = names.length === 0 ? "that" : listJoin(names.map((n) => `the ${n}`));
  return top === 2 ? `Let's keep an eye on ${what}.` : `I've noted ${what} for your doctor.`;
}

/**
 * What the voice says back about her health, by ladder level. 5 and 4: the text check-in's crisis and
 * urgent replies (her family was alerted before this is spoken). 3: her doctor today, 911 only if it
 * gets much worse; the family alert goes out after the call, so it isn't promised here. 0 to 2: one
 * "I've noted ... for your doctor" or "Let's keep an eye on ..." line, empty when there is nothing.
 */
export function spokenReaction(level: number, name: string, items: readonly UnderstoodItem[], alertedFamily: readonly string[] = []): string {
  if (level >= 5) return crisisReply(name, [...alertedFamily]);
  if (level === 4) return urgentReply(name, [...alertedFamily]);
  if (level === 3) return redFlagAdvice(name, []);
  const line = notedLine(items);
  if (line) return line;
  if (level === 2) return keepAnEye(name);
  if (level === 1) return notedForDoctor();
  return "";
}

/** The post-call message's buttons. "Something's wrong" opens the Let me explain path. */
export const CALL_SUMMARY_BUTTONS = { right: "That's right", wrong: "Something's wrong" } as const;

/**
 * ONE message to her chat after the call: what was recorded, the ladder's line, the heart rate as a
 * camera estimate. No 911 below level 3.
 */
export function callSummary(input: { name: string; level: number; items: readonly UnderstoodItem[]; reading?: Reading | undefined }): string {
  const answered = input.items.flatMap((i) => {
    const phrase = i.answer === undefined ? undefined : answerPhrase(i.topic, i.answer);
    return phrase === undefined ? [] : [phrase];
  });
  const sentences = [answered.length > 0 ? `Here's what I noted from our call: ${listJoin(answered)}.` : "Here's what I noted from our call."];
  if (input.level >= 5) sentences.push("You can call or text 988 any time, day or night.");
  else if (input.level === 4) sentences.push("If it's happening now, please call 911.");
  else if (input.level === 3) sentences.push("Please call your doctor today about this. If it gets much worse, call 911.");
  else {
    const line = notedLine(input.items);
    if (line) sentences.push(line);
    else if (answered.length === 0) sentences.push("Nothing new for your doctor today.");
  }
  if (input.reading && input.reading.heartRate !== null) sentences.push(`Heart rate about ${Math.round(input.reading.heartRate)} beats a minute, a camera estimate.`);
  sentences.push("Is that right?");
  return sentences.join(" ");
}

/** After "That's right" when nothing more is waiting. */
export function callSummaryThanks(name: string): string {
  return `Thank you, ${name}. I'll check in again tomorrow.`;
}

/** Every fixed call text, for the copy scan (test/calls.test.ts), with the level each belongs to. */
export function callCopySamples(name = "Harriet"): { level: number; text: string }[] {
  const items: UnderstoodItem[] = [
    { topic: "hf-ankle-swelling", level: 1, answer: "A little" },
    { topic: "knee pain", level: 2 },
  ];
  const samples: { level: number; text: string }[] = [
    { level: 0, text: callFirstMessage(name) },
    { level: 0, text: QUIET_MINUTE_PROMPT },
    { level: 0, text: MEDICINE_QUESTION_REPLY },
    { level: 0, text: callClosing(name, ["Sarah"]) },
    { level: 0, text: callClosing(name) },
    { level: 0, text: wrongCallerDecline() },
    { level: 0, text: heartRateReadback({ heartRate: 72, breathingRate: 14 }, { compareHeartRate: true, heartRate: { low: 65, high: 91, readings: 10 } }) },
    { level: 0, text: heartRateReadback({ heartRate: 120 }, { compareHeartRate: true, heartRate: { low: 65, high: 91, readings: 10 } }) },
    { level: 0, text: noReadingReadback() },
    { level: 0, text: stillMeasuring() },
    { level: 0, text: noVideoReadback() },
    { level: 0, text: callSummaryThanks(name) },
  ];
  for (const level of [0, 1, 2, 3, 4, 5]) {
    const leveled = items.map((i) => ({ ...i, level: Math.min(i.level, level) }));
    samples.push({ level, text: spokenReaction(level, name, leveled, ["Sarah"]) });
    samples.push({ level, text: callSummary({ name, level, items: leveled, reading: { heartRate: 72 } }) });
  }
  for (const [questionId, answers] of Object.entries(ANSWER_PHRASES))
    for (const answer of Object.keys(answers)) samples.push({ level: 0, text: callSummary({ name, level: 0, items: [{ topic: questionId, level: 0, answer }] }) });
  return samples.filter((s) => s.text !== "");
}
