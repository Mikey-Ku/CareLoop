import { afterEach, describe, expect, it, vi } from "vitest";
import { emptyCallVitals } from "../src/calls/screening.ts";
import { ConversationOrchestrator } from "../src/calls/orchestrator.ts";
import { loadSnapshot } from "../src/finchnode/fixtures.ts";
import { FakeLlmClient } from "../src/llm/fake.ts";
import type { CallTurnLlmOutput } from "../src/llm/types.ts";
import type { TranscriptTurn } from "../src/calls/types.ts";

const plan = (overrides: Partial<CallTurnLlmOutput> = {}): CallTurnLlmOutput => ({
  acknowledgment: "Thank you for telling me.",
  patientResponseText: "I appreciate you sharing that.",
  nextQuestion: null,
  nextAction: "complete_screening",
  informationCollected: [],
  missingInformation: [],
  evidence: [],
  uncertainty: [],
  ...overrides,
});

afterEach(() => vi.useRealTimers());

describe("ConversationOrchestrator", () => {
  it("asks one adaptive follow-up and passes transcript plus structured Finch context to Gemini", async () => {
    const llm = new FakeLlmClient({ callTurn: () => plan({ nextAction: "ask_follow_up", nextQuestion: "When did the dizziness begin?" }) });
    const transcript: TranscriptTurn[] = [];
    const spoken: string[] = [];
    const flow = new ConversationOrchestrator({
      callId: "call-a",
      patientId: "harriet",
      subject: "patient-demo-polypharmacy",
      firstName: "Harriet",
      transcript,
      initialContext: { firstName: "Harriet", questions: [], yesterday: [], memories: [], familyNames: [] },
      llm,
      loadSnapshot: async (subject) => loadSnapshot(subject),
      getVitals: emptyCallVitals,
      canMeasure: false,
      quietMeasurementMs: 30_000,
      speak: async (text) => { spoken.push(text); },
      recordAgentTurn: (text) => transcript.push({ speaker: "agent", text }),
      beginQuietMeasurement: () => {},
      onComplete: () => {},
    });
    flow.start();
    transcript.push({ speaker: "patient", text: "I have been dizzy since this morning." });
    await flow.handlePatientTurn("I have been dizzy since this morning.");
    expect(spoken.at(-1)).toContain("When did the dizziness begin?");
    expect(llm.calls[0]?.method).toBe("callTurn");
    if (llm.calls[0]?.method === "callTurn") {
      expect(llm.calls[0].input.transcript.at(-1)?.text).toContain("dizzy");
      expect(JSON.stringify(llm.calls[0].input.finchContext)).toContain("conditions");
    }
  });

  it("gets the final patient wording and caregiver summary from Gemini's structured screening operation", async () => {
    const approved = {
      symptoms: [],
      finchEvidence: [{ source: "patient_transcript", detail: "Patient reported a mild cough today." }],
      concernLevel: "low" as const,
      recommendedHumanAction: "monitor_and_document" as const,
      uncertainty: ["No usable camera reading was obtained."],
      patientResponseText: "Thank you for explaining. I have recorded the cough you described, and a member of your care team can review it.",
      caregiverSummary: "Patient reported a mild cough today. No usable camera reading was obtained.",
    };
    const llm = new FakeLlmClient({ callTurn: () => plan(), screenCall: () => approved });
    const spoken: string[] = [];
    const completion = vi.fn();
    const transcript: TranscriptTurn[] = [];
    const flow = new ConversationOrchestrator({
      callId: "call-a",
      patientId: "harriet",
      subject: "patient-demo-polypharmacy",
      firstName: "Harriet",
      transcript,
      initialContext: { firstName: "Harriet", questions: [], yesterday: [], memories: [], familyNames: [] },
      llm,
      loadSnapshot: async (subject) => loadSnapshot(subject),
      getVitals: emptyCallVitals,
      canMeasure: false,
      quietMeasurementMs: 30_000,
      speak: async (text) => { spoken.push(text); },
      recordAgentTurn: (text) => transcript.push({ speaker: "agent", text }),
      beginQuietMeasurement: () => {},
      onComplete: completion,
    });
    flow.start();
    transcript.push({ speaker: "patient", text: "I have had a mild cough today." });
    await flow.handlePatientTurn("I have had a mild cough today.");
    expect(spoken.at(-1)).toBe(approved.patientResponseText);
    expect(completion).toHaveBeenCalledWith(approved);
    expect(llm.calls.map((call) => call.method)).toEqual(["callTurn", "screenCall"]);
  });

  it("requires affirmative permission and observes the quiet measurement duration", async () => {
    vi.useFakeTimers();
    const llm = new FakeLlmClient({ callTurn: (input) => input.interviewPhase === "screening"
      ? plan({ nextAction: "complete_screening", patientResponseText: "Thank you. A care team member can review this." })
      : plan({ nextAction: "request_measurement_permission", nextQuestion: "Would you like a quiet camera estimate?" }) });
    const spoken: string[] = [];
    const beginQuietMeasurement = vi.fn();
    const onComplete = vi.fn();
    const transcript: TranscriptTurn[] = [];
    const flow = new ConversationOrchestrator({
      callId: "call-a",
      patientId: "harriet",
      subject: "patient-demo-polypharmacy",
      firstName: "Harriet",
      transcript,
      initialContext: { firstName: "Harriet", questions: [], yesterday: [], memories: [], familyNames: [] },
      llm,
      loadSnapshot: async (subject) => loadSnapshot(subject),
      getVitals: emptyCallVitals,
      canMeasure: true,
      quietMeasurementMs: 30_000,
      speak: async (text) => { spoken.push(text); },
      recordAgentTurn: (text) => transcript.push({ speaker: "agent", text }),
      beginQuietMeasurement,
      onComplete,
    });
    flow.start();
    transcript.push({ speaker: "patient", text: "I have had a cough." });
    await flow.handlePatientTurn("I have had a cough.");
    expect(beginQuietMeasurement).not.toHaveBeenCalled();
    transcript.push({ speaker: "patient", text: "Yes, please." });
    await flow.handlePatientTurn("Yes, please.");
    expect(beginQuietMeasurement).toHaveBeenCalledOnce();
    expect(spoken.at(-1)).toMatch(/face and upper chest.*30 seconds/i);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(llm.calls.filter((call) => call.method === "callTurn")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(501);
    await vi.waitFor(() => expect(llm.calls.filter((call) => call.method === "callTurn")).toHaveLength(2));
    expect(onComplete).toHaveBeenCalledOnce();
    flow.close();
  });
});

describe("ConversationOrchestrator: repeats and the end of the call", () => {
  function build(llm: FakeLlmClient) {
    const transcript: TranscriptTurn[] = [];
    const spoken: string[] = [];
    const flow = new ConversationOrchestrator({
      callId: "call-r",
      patientId: "harriet",
      subject: "patient-demo-polypharmacy",
      firstName: "Harriet",
      transcript,
      initialContext: { firstName: "Harriet", questions: [], yesterday: [], memories: [], familyNames: [] },
      llm,
      loadSnapshot: async (subject) => loadSnapshot(subject),
      getVitals: emptyCallVitals,
      canMeasure: false,
      quietMeasurementMs: 30_000,
      speak: async (text) => { spoken.push(text); },
      recordAgentTurn: (text) => transcript.push({ speaker: "agent", text }),
      beginQuietMeasurement: () => {},
      onComplete: () => {},
    });
    return { flow, spoken };
  }
  const asks = (question: string) => plan({ nextAction: "ask_follow_up", nextQuestion: question });
  const turns = (llm: FakeLlmClient) => llm.calls.filter((call) => call.method === "callTurn").length;

  it("repeats the last question when she asks to hear it again, without asking Gemini again", async () => {
    const llm = new FakeLlmClient({ callTurn: () => asks("How has your breathing been when you lie down?") });
    const { flow, spoken } = build(llm);
    flow.start();
    await flow.handlePatientTurn("I am a bit tired.");
    await flow.handlePatientTurn("Sorry, what did you ask?");
    expect(spoken.at(-1)).toBe("Of course. How has your breathing been when you lie down?");
    await flow.handlePatientTurn("Pardon?");
    expect(spoken.at(-1)).toBe("Of course. How has your breathing been when you lie down?");
    expect(turns(llm)).toBe(1);
  });

  it("repeats the greeting question when she asks before any question was planned", async () => {
    const llm = new FakeLlmClient({ callTurn: () => asks("When did it begin?") });
    const { flow, spoken } = build(llm);
    flow.start();
    await flow.handlePatientTurn("What?");
    expect(spoken.at(-1)).toBe("Of course. How are you feeling today?");
    expect(turns(llm)).toBe(0);
  });

  it("does not take a sentence that merely starts with sorry or what for a request to repeat", async () => {
    const llm = new FakeLlmClient({ callTurn: () => asks("When did it begin?") });
    const { flow } = build(llm);
    flow.start();
    await flow.handlePatientTurn("Sorry, my ankles hurt today.");
    await flow.handlePatientTurn("What changed is I got dizzy.");
    expect(turns(llm)).toBe(2);
  });

  it("says nothing if a planned turn finishes after the call has closed", async () => {
    let flow!: ConversationOrchestrator;
    const llm = new FakeLlmClient({ callTurn: () => { flow.close(); return asks("When did it begin?"); } });
    const built = build(llm);
    flow = built.flow;
    flow.start();
    const before = built.spoken.length;
    await flow.handlePatientTurn("I feel dizzy.");
    expect(built.spoken).toHaveLength(before);
  });
});
