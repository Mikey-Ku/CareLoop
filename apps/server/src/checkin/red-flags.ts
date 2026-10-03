import type { Question } from "../context/questions.ts";

// Red flags: level-3 answers on the severity ladder (src/checkin/severity.ts), decided
// by fixed rules, never by the LLM. Each question lists the answers that count
// (Question.redFlagAnswers: "Yes, it was hard", "Yes, bleeding"). A red flag tells her
// to call her doctor today and alerts the family at every sharing level. It skips the
// flag lifecycle.

export type RedFlag = { questionId: string; questionText: string; answer: string };

const norm = (s: string) => s.trim().toLowerCase();

/** The red flag this answer raises, or undefined. Matches case-insensitively, ignoring surrounding spaces. */
export function evaluateRedFlag(question: Pick<Question, "id" | "text" | "redFlagAnswers">, answer: string): RedFlag | undefined {
  const match = question.redFlagAnswers.find((a) => norm(a) === norm(answer));
  if (match === undefined) return undefined;
  return { questionId: question.id, questionText: question.text, answer: match };
}
