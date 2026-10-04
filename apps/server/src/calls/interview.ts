import type { TranscriptTurn } from "./types.ts";

export type InterviewPhase = "interview" | "quiet_measurement" | "complete" | "emergency";

const QUESTIONS = [
  "What is bothering you most today?",
  "When did that start, and is it changing?",
  "How severe is it right now, from mild to severe?",
  "Are you having any other symptoms that feel important to mention?",
] as const;

export class ShortInterview {
  #asked = 0;
  #phase: InterviewPhase = "interview";
  readonly #turns: TranscriptTurn[] = [];

  get phase(): InterviewPhase {
    return this.#phase;
  }

  get turns(): readonly TranscriptTurn[] {
    return this.#turns;
  }

  nextQuestion(): string | undefined {
    if (this.#phase !== "interview") return undefined;
    return QUESTIONS[this.#asked];
  }

  addPatientTurn(text: string): { emergency: boolean; nextQuestion?: string; complete: boolean } {
    const turn = text.trim();
    if (!turn) return { emergency: false, nextQuestion: this.nextQuestion(), complete: false };
    this.#turns.push({ speaker: "patient", text: turn });
    if (this.#turns.some((candidate) => candidate.speaker === "patient" && candidate.text)) this.#asked = Math.min(this.#asked + 1, QUESTIONS.length);
    if (this.#asked >= QUESTIONS.length) this.#phase = "quiet_measurement";
    return { emergency: false, nextQuestion: this.nextQuestion(), complete: this.#phase === "quiet_measurement" };
  }

  addAgentTurn(text: string): void {
    if (text.trim()) this.#turns.push({ speaker: "agent", text: text.trim() });
  }

  beginQuietMeasurement(): void {
    if (this.#phase === "interview") this.#phase = "quiet_measurement";
  }

  finish(): void {
    this.#phase = "complete";
  }

  emergency(): void {
    this.#phase = "emergency";
  }
}

export const interviewQuestions = QUESTIONS;
