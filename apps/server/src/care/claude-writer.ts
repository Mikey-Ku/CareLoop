import Anthropic from "@anthropic-ai/sdk";
import { displayPhone } from "./copy.ts";
import type { ReplyRequest, ReplyWriter } from "./replies.ts";

// Claude words follow-up answers to the doctor and the emergency contact. It sees only
// the facts the summary was built from, the summary as sent, and the thread; it decides
// nothing medical (urgent messages and dosing questions never reach it, see replies.ts),
// and its text goes through guardReply before it is sent.

export const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-4-5";
export const NO_REPLY = "NO_REPLY";

type CreateMessage = (params: {
  model: string;
  max_tokens: number;
  system: string;
  messages: { role: "user" | "assistant"; content: string }[];
}) => Promise<{ content: { type: string; text?: string }[] }>;

const SHARED_RULES = [
  "Answer only from FACTS and SUMMARY below. If the answer isn't there, say plainly that you don't have that information. Never guess or invent a value, date or event.",
  "Never diagnose, never interpret symptoms, never recommend starting, stopping or changing any medicine or dose.",
  "Flags in FACTS were decided by fixed rules; describe them, don't add to them or downplay them.",
  "Plain text only: no markdown, no bullet symbols other than '-', no em dashes.",
  `If the message needs no reply (an acknowledgment, a thank-you, a goodbye), answer with exactly ${NO_REPLY}.`,
];

export function systemPrompt(request: ReplyRequest): string {
  const { contact, contacts, facts } = request;
  const name = facts.patient.preferredName;
  if (contact.audience === "doctor")
    return [
      `You are an automated check-in assistant (an AI, not a person) texting with ${contact.name}, the physician of ${facts.patient.fullName ?? name}, a synthetic demo patient.`,
      "Tone: professional, concise and informative, as in a clinical handoff. Lead with the data: values, units, dates, sources. At most 5 short sentences or a short '-' list.",
      ...SHARED_RULES,
      `Her emergency contact is ${contacts.emergencyContact.name} at ${displayPhone(contacts.emergencyContact.phone)}.`,
    ].join("\n");
  const ec = contact;
  return [
    `You are an automated check-in assistant (an AI, not a person) texting with ${ec.name}${ec.relationship ? `, ${name}'s ${ec.relationship}` : ""}, about ${name}'s daily check-in.`,
    "Tone: warm, friendly and supportive, in everyday words a worried family member can follow. Be honest: never reassure beyond what the data shows, never minimize a red flag, no exaggerated cheer, no exclamation marks. Explain any medical term in a few plain words. At most 4 short sentences.",
    ...SHARED_RULES,
    `For anything medical, point them to ${name}'s doctor, ${contacts.doctor.name}, at ${displayPhone(contacts.doctor.phone)}.`,
  ].join("\n");
}

export function userPrompt(request: ReplyRequest): string {
  const thread = request.thread.map((t) => `${t.from === "assistant" ? "ASSISTANT" : request.contact.name.toUpperCase()}: ${t.text}`).join("\n\n");
  return [
    `FACTS (JSON):\n${JSON.stringify(request.facts)}`,
    `SUMMARY (as ${request.contact.name} received it):\n${request.summaryText}`,
    thread ? `CONVERSATION SO FAR:\n${thread}` : "",
    `NEW MESSAGE FROM ${request.contact.name.toUpperCase()}:\n${request.message}`,
    "Write the reply text only.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

export class ClaudeReplyWriter implements ReplyWriter {
  private readonly create: CreateMessage;
  private readonly model: string;

  constructor(options: { apiKey?: string; model?: string; create?: CreateMessage }) {
    this.model = options.model ?? DEFAULT_ANTHROPIC_MODEL;
    if (options.create) this.create = options.create;
    else {
      if (!options.apiKey) throw new Error("ClaudeReplyWriter needs ANTHROPIC_API_KEY");
      const client = new Anthropic({ apiKey: options.apiKey });
      this.create = (params) => client.messages.create(params);
    }
  }

  async write(request: ReplyRequest): Promise<string | null> {
    const response = await this.create({
      model: this.model,
      max_tokens: 400,
      system: systemPrompt(request),
      messages: [{ role: "user", content: userPrompt(request) }],
    });
    const text = response.content
      .flatMap((block) => (block.type === "text" && block.text ? [block.text] : []))
      .join("\n")
      .trim();
    if (!text || text === NO_REPLY) return null;
    return text;
  }
}
