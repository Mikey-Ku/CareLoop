import { classifyInbound } from "../care/replies.ts";
import { familyCantPassOn, familyCrisisAbout, familyEmergencyAbout, familyPassedOn, familySays } from "../checkin/copy.ts";
import { getCheckinPatient } from "../db/checkins.ts";
import type { FamilyMember } from "../db/family.ts";
import type { Db } from "../db/index.ts";
import type { Messenger } from "./messenger.ts";

// A message from a linked family chat, passed on to the senior's own chat (build step 7, text only).
// Fixed rules, no LLM:
//   - The safety screen first, in the third person as for care replies (src/care/replies.ts
//     classifyInbound: "Mom fell" reads as "I fell"). An emergency happening to her gets the 911-now
//     reply, a crisis gets 988; neither is passed on to her (the family member is told so).
//   - A bare acknowledgement ("Thanks", "Ok") answers the agent's own update: nothing is passed on.
//   - Anything else goes to her chat as `Sarah says: "..."` (display name, else handle; their words
//     trimmed, capped at MAX_FAMILY_WORDS) and the family member hears "I've passed that on to Harriet."
// Their words are quoted as plain text, instruction-like text included (src/safety/injection.ts): never
// read by a model, never an answer to her check-in, never a sharing change (none of this reaches the
// engine). Her next typed message after a forward is plain chat (engine.ts "Latest prompt wins"). Sends use
// idempotency keys from the Relay message id, so a replayed event never sends twice. Only metadata is
// stored (family_messages, direction to_senior): never their words.

/** Longest family message passed on, in characters. */
export const MAX_FAMILY_WORDS = 500;

export type FamilyInboundOutcome = "passed_on" | "emergency" | "crisis" | "acknowledgement" | "no_senior_chat";

export type FamilyInboundDeps = { db: Db; messenger: Messenger; now: () => string };

/** When a family member's words last went to her chat, if ever. */
export function lastPassedOnAt(db: Db, patientId: string): string | undefined {
  const row = db.prepare(`SELECT MAX(created_at) AS at FROM family_messages WHERE patient_id = ? AND direction = 'to_senior'`).get(patientId) as { at: string | null };
  return row.at ?? undefined;
}

/** Their words as passed on: whitespace tidied, capped. */
export function familyWords(text: string): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > MAX_FAMILY_WORDS ? `${one.slice(0, MAX_FAMILY_WORDS).trimEnd()}...` : one;
}

/**
 * One family message, for each senior this family chat belongs to (`members`: familyMembersForChat).
 * Returns what happened per senior. Throws when a send fails (the inbox records the error).
 */
export async function passOnFamilyMessage(
  deps: FamilyInboundDeps,
  members: readonly FamilyMember[],
  msg: { chatId: string; messageId: string; text: string },
): Promise<FamilyInboundOutcome[]> {
  const outcomes: FamilyInboundOutcome[] = [];
  for (const member of members) {
    const patient = getCheckinPatient(deps.db, member.patientId);
    if (!patient) continue;
    const senior = patient.preferredName;
    const key = `family-in:${patient.id}:${msg.messageId}`;
    const reply = (text: string, step: string) => deps.messenger.send(msg.chatId, { text }, `${key}:${step}`);
    const intent = classifyInbound("family", msg.text, senior);
    if (intent === "family_crisis") {
      await reply(familyCrisisAbout(senior), "crisis");
      outcomes.push("crisis");
      continue;
    }
    if (intent === "family_emergency") {
      await reply(familyEmergencyAbout(senior), "emergency");
      outcomes.push("emergency");
      continue;
    }
    if (intent === "none") {
      outcomes.push("acknowledgement");
      continue;
    }
    if (!patient.relayChatId) {
      await reply(familyCantPassOn(senior), "no-chat");
      outcomes.push("no_senior_chat");
      continue;
    }
    const from = member.displayName?.trim() || member.handle;
    await deps.messenger.send(patient.relayChatId, { text: familySays(from, familyWords(msg.text)) }, `${key}:to-senior`);
    deps.db
      .prepare(
        `INSERT INTO family_messages (patient_id, direction, kind, from_name, relay_message_id, created_at) VALUES (?, 'to_senior', 'text', ?, ?, ?)
         ON CONFLICT (relay_message_id) DO NOTHING`,
      )
      .run(patient.id, from, `${msg.messageId}:${patient.id}`, deps.now());
    await reply(familyPassedOn(senior), "ack");
    outcomes.push("passed_on");
  }
  return outcomes;
}
