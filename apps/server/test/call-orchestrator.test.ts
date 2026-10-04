import { afterEach, describe, expect, it, vi } from "vitest";
import { CAMERA_GUIDANCE, CAMERA_OFFER_AT_END, CAMERA_STILL_OFF, QUIET_RETRY_OFFER, callClosing, callFirstMessage, quietCountdown } from "../src/calls/copy.ts";
import { emptyCallVitals } from "../src/calls/screening.ts";
import { ConversationOrchestrator, type ConversationOrchestratorOptions } from "../src/calls/orchestrator.ts";
import { crisisReply, urgentReply } from "../src/checkin/copy.ts";
import { loadSnapshot } from "../src/finchnode/fixtures.ts";
import { FakeLlmClient } from "../src/llm/fake.ts";
import type { CallScreeningLlmOutput, CallTurnLlmInput, CallTurnLlmOutput } from "../src/llm/types.ts";
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
      canMeasure: () => false,
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

  it("stores Gemini's structured screening and caregiver summary but speaks only the fixed goodbye", async () => {
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
      canMeasure: () => false,
      quietMeasurementMs: 30_000,
      speak: async (text) => { spoken.push(text); },
      recordAgentTurn: (text) => transcript.push({ speaker: "agent", text }),
      beginQuietMeasurement: () => {},
      onComplete: completion,
    });
    flow.start();
    transcript.push({ speaker: "patient", text: "I have had a mild cough today." });
    await flow.handlePatientTurn("I have had a mild cough today.");
    expect(spoken.at(-1)).toBe(callClosing("Harriet"));
    expect(spoken).not.toContain(approved.patientResponseText);
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
      getVitals: () => ({ ...emptyCallVitals(), heartRate: 72 }),
      canMeasure: () => true,
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
      canMeasure: () => false,
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

/** A flow with the fakes wired; `say` records her turn in the transcript (as the call service does) and hands it over. */
function buildFlow(llm: FakeLlmClient, overrides: Partial<ConversationOrchestratorOptions> = {}) {
  const transcript: TranscriptTurn[] = [];
  const spoken: string[] = [];
  const onComplete = vi.fn();
  const beginQuietMeasurement = vi.fn();
  const flow = new ConversationOrchestrator({
    callId: "call-f",
    patientId: "harriet",
    subject: "patient-demo-polypharmacy",
    firstName: "Harriet",
    transcript,
    initialContext: { firstName: "Harriet", questions: [], yesterday: [], memories: [], familyNames: [] },
    llm,
    loadSnapshot: async (subject) => loadSnapshot(subject),
    getVitals: emptyCallVitals,
    canMeasure: () => false,
    quietMeasurementMs: 30_000,
    speak: async (text) => { spoken.push(text); },
    recordAgentTurn: (text) => transcript.push({ speaker: "agent", text }),
    beginQuietMeasurement,
    onComplete,
    ...overrides,
  });
  const say = (text: string) => {
    transcript.push({ speaker: "patient", text });
    return flow.handlePatientTurn(text);
  };
  return { flow, spoken, transcript, onComplete, beginQuietMeasurement, say };
}

describe("ConversationOrchestrator: the end of the call is fixed words", () => {
  // Advice and a question, as Gemini worded a closing on a real call: the ladder had recorded only level 1.
  const MODEL_WORDS = "Because you have a history of heart failure, it would be wise to contact your clinician or care team today. If you experience severe symptoms, call 911. Do you have any other symptoms?";
  const screening: CallScreeningLlmOutput = {
    symptoms: [],
    finchEvidence: [],
    concernLevel: "moderate",
    recommendedHumanAction: "contact_clinician_today",
    uncertainty: [],
    patientResponseText: "Your care team will review this today. Is there anything you would like to add?",
    caregiverSummary: "Patient reported a mild cough.",
  };
  const MODEL_FRAGMENTS = [/clinician|care team|heart failure|911|988/i, /\?/];

  it.each(["complete_screening", "end_call"] as const)("%s: she hears the fixed goodbye and nothing the model wrote, not even a question", async (nextAction) => {
    const llm = new FakeLlmClient({ callTurn: () => plan({ nextAction, patientResponseText: MODEL_WORDS }), screenCall: () => screening });
    const { spoken, onComplete, say } = buildFlow(llm, { initialContext: { firstName: "Harriet", questions: [], yesterday: [], memories: [], familyNames: ["Sarah"] } });
    await say("I have had a bit of a cough.");
    expect(spoken).toEqual([callClosing("Harriet", ["Sarah"])]);
    for (const fragment of MODEL_FRAGMENTS) expect(spoken.join(" ")).not.toMatch(fragment);
    expect(onComplete).toHaveBeenCalledWith(screening); // still stored with the call
    expect(llm.calls.map((call) => call.method)).toEqual(["callTurn", "screenCall"]);
  });

  it("speaks the goodbye without waiting for the screening, which is still stored when it ends", async () => {
    let finish!: (value: CallScreeningLlmOutput) => void;
    const llm = new FakeLlmClient({ callTurn: () => plan() });
    llm.screenCall = () => new Promise<CallScreeningLlmOutput>((resolve) => { finish = resolve; });
    const { spoken, onComplete, say } = buildFlow(llm);
    const turn = say("I have had a bit of a cough.");
    await vi.waitFor(() => expect(spoken).toEqual([callClosing("Harriet")]));
    expect(onComplete).not.toHaveBeenCalled();
    finish(screening);
    await turn;
    expect(onComplete).toHaveBeenCalledWith(screening);
  });

  it("a screening that fails still ends the call with the fixed goodbye", async () => {
    const llm = new FakeLlmClient({ callTurn: () => plan() }); // screenCall unscripted: Gemini unavailable
    const { spoken, onComplete, say } = buildFlow(llm);
    await say("I have had a bit of a cough.");
    expect(spoken).toEqual([callClosing("Harriet")]);
    expect(onComplete).toHaveBeenCalledWith(undefined);
  });

  it("emergency, and the fixed screen agrees: she hears the text check-in's fixed 911 reply, never the model's words", async () => {
    const llm = new FakeLlmClient({ callTurn: () => plan({ nextAction: "emergency", patientResponseText: "Please lie down and rest, and keep an eye on it." }), screenCall: () => screening });
    const { spoken, onComplete, say } = buildFlow(llm, { initialContext: { firstName: "Harriet", questions: [], yesterday: [], memories: [], familyNames: ["Sarah"] } });
    await say("I have chest pain right now.");
    expect(spoken).toEqual(["Harriet, if this is happening now, please call 911 right away. After that, call your doctor."]);
    expect(spoken).toEqual([urgentReply("Harriet", [])]);
    expect(spoken[0]).not.toMatch(/I've let|family|Sarah|lie down|keep an eye/); // nobody has been told yet: no claim that anyone was
    expect(onComplete).toHaveBeenCalledWith(screening);
  });

  it("emergency declared by Gemini alone: no 911, no 988; the fixed goodbye, the screening kept, and it is logged", async () => {
    const events: string[] = [];
    const llm = new FakeLlmClient({ callTurn: () => plan({ nextAction: "emergency", patientResponseText: "Please call 911 now." }), screenCall: () => screening });
    const { spoken, onComplete, say } = buildFlow(llm, { log: (event) => events.push(event), initialContext: { firstName: "Harriet", questions: [], yesterday: [], memories: [], familyNames: ["Sarah"] } });
    await say("I feel a bit odd today.");
    expect(spoken).toEqual([callClosing("Harriet", ["Sarah"])]);
    expect(spoken[0]).not.toMatch(/911|988/);
    expect(onComplete).toHaveBeenCalledWith(screening); // what the model read is still stored, for the ladder after the call
    expect(events).toContain("call_model_emergency_unconfirmed");
  });

  it("emergency after a crisis phrase: the fixed 988 reply, chosen by the fixed screen and not by the model", async () => {
    const llm = new FakeLlmClient({ callTurn: () => plan({ nextAction: "emergency", patientResponseText: "That sounds hard." }), screenCall: () => screening });
    const { spoken, say } = buildFlow(llm);
    await say("I don't want to live anymore.");
    expect(spoken).toEqual([crisisReply("Harriet", [])]);
    expect(spoken[0]).toMatch(/988/);
    expect(spoken[0]).not.toMatch(/I've let|family/);
  });
});

describe("ConversationOrchestrator: the camera reading is offered before the goodbye", () => {
  const DECLINE = "Of course. We can skip the camera measurement.";
  const ASK_AGAIN = "Would you like to try the quiet camera measurement? You can say yes or no.";
  const offers = (spoken: string[]) => spoken.filter((text) => text === CAMERA_OFFER_AT_END).length;
  const turnInputs = (llm: FakeLlmClient) => llm.calls.flatMap((call) => (call.method === "callTurn" ? [call.input] : []));

  it("complete_screening: asks first, in fixed words, and does not hang up until she answers", async () => {
    const llm = new FakeLlmClient({ callTurn: () => plan({ nextAction: "complete_screening" }) });
    const { spoken, onComplete, beginQuietMeasurement, say } = buildFlow(llm, { canMeasure: () => true });
    await say("I have had a bit of a cough.");
    expect(spoken).toEqual([CAMERA_OFFER_AT_END]);
    expect(onComplete).not.toHaveBeenCalled();
    expect(beginQuietMeasurement).not.toHaveBeenCalled(); // never without her yes
    expect(llm.calls.map((call) => call.method)).toEqual(["callTurn"]);
  });

  it("end_call: she said she has to go, so she gets the fixed goodbye and no camera question", async () => {
    const llm = new FakeLlmClient({ callTurn: () => plan({ nextAction: "end_call" }) });
    const { spoken, onComplete, beginQuietMeasurement, say } = buildFlow(llm, { canMeasure: () => true });
    await say("I have to go now, my daughter is here.");
    expect(spoken).toEqual([callClosing("Harriet")]);
    expect(offers(spoken)).toBe(0);
    expect(onComplete).toHaveBeenCalledOnce();
    expect(beginQuietMeasurement).not.toHaveBeenCalled();
  });

  it("an answer that is neither yes nor no asks again and still does not hang up", async () => {
    const llm = new FakeLlmClient({ callTurn: () => plan() });
    const { spoken, onComplete, say } = buildFlow(llm, { canMeasure: () => true });
    await say("I have had a bit of a cough.");
    await say("What is it for?");
    expect(spoken).toEqual([CAMERA_OFFER_AT_END, ASK_AGAIN]);
    expect(onComplete).not.toHaveBeenCalled();
  });

  it("a second answer that is neither yes nor no is taken as no: the decline line, then the goodbye", async () => {
    const llm = new FakeLlmClient({ callTurn: () => plan() });
    const { spoken, onComplete, beginQuietMeasurement, say } = buildFlow(llm, { canMeasure: () => true });
    await say("I have had a bit of a cough.");
    await say("What is it for?");
    await say("My daughter calls on Sundays.");
    expect(beginQuietMeasurement).not.toHaveBeenCalled();
    expect(spoken).toEqual([CAMERA_OFFER_AT_END, ASK_AGAIN, DECLINE, callClosing("Harriet")]);
    expect(onComplete).toHaveBeenCalledOnce();
  });

  it.each(["Alright.", "All right, go on.", "Sounds good.", "Let's do it.", "Yup.", "Why not."])("%s is a yes", async (answer) => {
    vi.useFakeTimers();
    const llm = new FakeLlmClient({ callTurn: () => plan() });
    const { flow, spoken, beginQuietMeasurement, say } = buildFlow(llm, { canMeasure: () => true });
    await say("I have had a bit of a cough.");
    await say(answer);
    expect(beginQuietMeasurement).toHaveBeenCalledOnce();
    expect(spoken).not.toContain(ASK_AGAIN);
    flow.close();
  });

  it.each(["I do not.", "I don't think so.", "Not today, thank you.", "Maybe later.", "Nah.", "Skip it."])("%s is a no", async (answer) => {
    const llm = new FakeLlmClient({ callTurn: () => plan() });
    const { spoken, beginQuietMeasurement, say } = buildFlow(llm, { canMeasure: () => true });
    await say("I have had a bit of a cough.");
    await say(answer);
    expect(beginQuietMeasurement).not.toHaveBeenCalled();
    expect(spoken.slice(0, 2)).toEqual([CAMERA_OFFER_AT_END, DECLINE]);
  });

  it("yes: runs the quiet measurement, reads it back, then the fixed goodbye; it is not offered a second time", async () => {
    vi.useFakeTimers();
    const llm = new FakeLlmClient({ callTurn: () => plan() });
    const { flow, spoken, onComplete, beginQuietMeasurement, say } = buildFlow(llm, { canMeasure: () => true, getVitals: () => ({ ...emptyCallVitals(), heartRate: 72 }) });
    await say("I have had a bit of a cough.");
    await say("Yes, please.");
    expect(beginQuietMeasurement).toHaveBeenCalledOnce();
    expect(spoken.at(-1)).toMatch(/face and upper chest.*30 seconds/i);
    expect(onComplete).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30_500);
    await vi.waitFor(() => expect(onComplete).toHaveBeenCalledOnce());
    expect(spoken).toEqual([CAMERA_OFFER_AT_END, spoken[1], quietCountdown(20), quietCountdown(10), "The camera estimate is about 72 beats a minute for your heart rate. This is an estimate, not a medical test.", callClosing("Harriet")]);
    expect(offers(spoken)).toBe(1);
    expect(turnInputs(llm).map((input) => input.canMeasure)).toEqual([true, false]); // Gemini is told it is taken
    flow.close();
  });

  it("no: says the decline line, takes no measurement, and the next turn that ends the call says the fixed goodbye", async () => {
    const llm = new FakeLlmClient({ callTurn: () => plan() });
    const { spoken, onComplete, beginQuietMeasurement, say } = buildFlow(llm, { canMeasure: () => true });
    await say("I have had a bit of a cough.");
    await say("No thanks.");
    expect(beginQuietMeasurement).not.toHaveBeenCalled();
    expect(spoken).toEqual([CAMERA_OFFER_AT_END, DECLINE, callClosing("Harriet")]);
    expect(onComplete).toHaveBeenCalledOnce();
    expect(turnInputs(llm).map((input) => input.canMeasure)).toEqual([true, false]);
  });

  it("asks whether the reading is possible afresh on every turn: a camera turned off before the goodbye gets no offer", async () => {
    let videoOn = true;
    const llm = new FakeLlmClient({ callTurn: (input) => (input.canMeasure ? plan({ nextAction: "ask_follow_up", nextQuestion: "When did it start?" }) : plan()) });
    const { spoken, onComplete, say } = buildFlow(llm, { canMeasure: () => videoOn });
    await say("My ankles are a bit swollen.");
    expect(spoken).toEqual(["Thank you for telling me. When did it start?"]);
    videoOn = false;
    await say("Since Monday.");
    expect(spoken.at(-1)).toBe(callClosing("Harriet"));
    expect(offers(spoken)).toBe(0);
    expect(onComplete).toHaveBeenCalledOnce();
    expect(turnInputs(llm).map((input) => input.canMeasure)).toEqual([true, false]);
  });

  it("is not offered when the camera reading is not possible", async () => {
    const llm = new FakeLlmClient({ callTurn: () => plan() });
    const { spoken, onComplete, say } = buildFlow(llm, { canMeasure: () => false });
    await say("I have had a bit of a cough.");
    expect(spoken).toEqual([callClosing("Harriet")]);
    expect(onComplete).toHaveBeenCalledOnce();
  });

  it("is not offered when she already said no to Gemini's own request for it", async () => {
    const llm = new FakeLlmClient({ callTurn: (input) => (input.canMeasure ? plan({ nextAction: "request_measurement_permission", nextQuestion: "Would you like a quiet camera estimate?" }) : plan()) });
    const { spoken, onComplete, say } = buildFlow(llm, { canMeasure: () => true });
    await say("I have had a bit of a cough.");
    await say("No.");
    expect(spoken).toEqual(["Thank you for telling me. Would you like a quiet camera estimate?", DECLINE, callClosing("Harriet")]);
    expect(offers(spoken)).toBe(0);
    expect(onComplete).toHaveBeenCalledOnce();
  });

  it("is not offered when the reading was already taken at Gemini's own request", async () => {
    vi.useFakeTimers();
    const llm = new FakeLlmClient({ callTurn: (input) => (input.interviewPhase === "screening" ? plan() : plan({ nextAction: "request_measurement_permission", nextQuestion: "Would you like a quiet camera estimate?" })) });
    const { flow, spoken, onComplete, say } = buildFlow(llm, { canMeasure: () => true, getVitals: () => ({ ...emptyCallVitals(), heartRate: 72 }) });
    await say("I have had a bit of a cough.");
    await say("Yes.");
    await vi.advanceTimersByTimeAsync(30_500);
    await vi.waitFor(() => expect(onComplete).toHaveBeenCalledOnce());
    expect(offers(spoken)).toBe(0);
    expect(spoken.at(-1)).toBe(callClosing("Harriet"));
    flow.close();
  });

  it("is never offered in an emergency: she hears the fixed reply and the call ends", async () => {
    const llm = new FakeLlmClient({ callTurn: () => plan({ nextAction: "emergency" }) });
    const { spoken, onComplete, say } = buildFlow(llm, { canMeasure: () => true });
    await say("I have chest pain right now.");
    expect(spoken).toEqual([urgentReply("Harriet", [])]);
    expect(onComplete).toHaveBeenCalledOnce();
  });

  it("nor after an emergency only Gemini declared: the goodbye, without the offer", async () => {
    const llm = new FakeLlmClient({ callTurn: () => plan({ nextAction: "emergency" }) });
    const { spoken, onComplete, say } = buildFlow(llm, { canMeasure: () => true });
    await say("I feel a bit odd today.");
    expect(spoken).toEqual([callClosing("Harriet")]);
    expect(onComplete).toHaveBeenCalledOnce();
  });
});

describe("ConversationOrchestrator: the start of the call", () => {
  const llm = () => new FakeLlmClient({ callTurn: () => plan({ nextAction: "ask_follow_up", nextQuestion: "When did it begin?" }) });
  const settle = () => new Promise((resolve) => setImmediate(resolve));

  it("waits for the lead-in before it greets", async () => {
    let release!: () => void;
    const beforeGreeting = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    const { flow, spoken } = buildFlow(llm(), { beforeGreeting });
    flow.start();
    await settle();
    expect(beforeGreeting).toHaveBeenCalledOnce();
    expect(spoken).toEqual([]);
    release();
    await vi.waitFor(() => expect(spoken).toEqual([callFirstMessage("Harriet")]));
  });

  it("still greets, and does not end the call, when the lead-in fails", async () => {
    const beforeGreeting = vi.fn(async () => { throw new Error("Relay Call transport is closed."); });
    const { flow, spoken, onComplete } = buildFlow(llm(), { beforeGreeting });
    flow.start();
    await vi.waitFor(() => expect(spoken).toEqual([callFirstMessage("Harriet")]));
    expect(onComplete).not.toHaveBeenCalled();
  });

  it.each([
    ["resolves", (release: () => void) => release()],
    ["rejects", (_release: () => void, reject: (error: Error) => void) => reject(new Error("Relay Call ended before the person's audio arrived."))],
  ])("says nothing when the call ends while the lead-in is pending and it then %s", async (_how, settleHook) => {
    let release!: () => void;
    let reject!: (error: Error) => void;
    const beforeGreeting = () => new Promise<void>((resolve, rejectHook) => { release = resolve; reject = rejectHook; });
    const { flow, spoken, onComplete } = buildFlow(llm(), { beforeGreeting });
    flow.start();
    await settle();
    flow.close();
    settleHook(release, reject);
    await settle();
    expect(spoken).toEqual([]);
    expect(onComplete).not.toHaveBeenCalled();
  });

  it("knows when the greeting has been spoken, so nothing is let to cut it off until then", async () => {
    let finish!: () => void;
    const speak = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const { flow } = buildFlow(llm(), { speak });
    expect(flow.greeted).toBe(false);
    flow.start();
    await settle();
    expect(flow.greeted).toBe(false); // still playing
    finish();
    await vi.waitFor(() => expect(flow.greeted).toBe(true));
  });

  it("counts the greeting as over when it failed, or when the call ended before it", async () => {
    const failed = buildFlow(llm(), { speak: async () => { throw new Error("ElevenLabs TTS returned HTTP 500"); } });
    failed.flow.start();
    await vi.waitFor(() => expect(failed.flow.greeted).toBe(true));
    const dropped = buildFlow(llm(), { beforeGreeting: () => new Promise<void>(() => {}) });
    dropped.flow.start();
    await settle();
    expect(dropped.flow.greeted).toBe(false);
  });

  it("is for the greeting only: started twice or followed by turns, the hook runs once", async () => {
    const beforeGreeting = vi.fn(async () => {});
    const { flow, spoken, say } = buildFlow(llm(), { beforeGreeting });
    flow.start();
    flow.start();
    await vi.waitFor(() => expect(spoken).toHaveLength(1));
    await say("I have been dizzy since this morning.");
    expect(spoken.at(-1)).toContain("When did it begin?");
    expect(beforeGreeting).toHaveBeenCalledOnce();
  });
});

describe("ConversationOrchestrator: her record is read once per call", () => {
  const asks = () => {
    let n = 0;
    return new FakeLlmClient({ callTurn: () => plan({ nextAction: "ask_follow_up", nextQuestion: `Question number ${(n += 1)}?` }) });
  };
  const contexts = (llm: FakeLlmClient) => llm.calls.flatMap((call) => (call.method === "callTurn" ? [call.input.finchContext] : []));

  it("fetches it on the first turn that needs it and reuses it on every later turn and for the final screening", async () => {
    const readRecord = vi.fn(async (subject: string) => loadSnapshot(subject));
    const llm = asks();
    const { say } = buildFlow(llm, { loadSnapshot: readRecord });
    expect(readRecord).not.toHaveBeenCalled();
    await say("My ankles are a bit swollen.");
    await say("It started on Monday.");
    await say("About the same on both sides.");
    expect(readRecord).toHaveBeenCalledOnce();
    expect(readRecord).toHaveBeenCalledWith("patient-demo-polypharmacy");
    for (const context of contexts(llm)) expect(JSON.stringify(context)).toContain("conditions"); // every turn still had it
    expect(contexts(llm)).toHaveLength(3);
  });

  it("the end of the call reuses it too", async () => {
    const readRecord = vi.fn(async (subject: string) => loadSnapshot(subject));
    const turn = vi.fn((input: { transcript: unknown[] }) => (input.transcript.length > 2 ? plan() : plan({ nextAction: "ask_follow_up", nextQuestion: "When did it start?" })));
    const llm = new FakeLlmClient({ callTurn: turn, screenCall: () => ({ symptoms: [], finchEvidence: [], concernLevel: "low", recommendedHumanAction: "none", uncertainty: [], patientResponseText: "x", caregiverSummary: "y" }) });
    const { say } = buildFlow(llm, { loadSnapshot: readRecord });
    await say("My ankles are a bit swollen.");
    await say("Since Monday.");
    expect(llm.calls.map((call) => call.method)).toEqual(["callTurn", "callTurn", "screenCall"]);
    expect(readRecord).toHaveBeenCalledOnce();
    const screen = llm.calls.find((call) => call.method === "screenCall");
    expect(JSON.stringify(screen?.input.finchContext)).toContain("conditions");
  });

  it("a read that failed is not kept: the turn goes on as unavailable and the next turn reads it again", async () => {
    const readRecord = vi.fn(async (subject: string) => loadSnapshot(subject));
    readRecord.mockRejectedValueOnce(new Error("FinchNode is down"));
    const llm = asks();
    const { say } = buildFlow(llm, { loadSnapshot: readRecord });
    await say("My ankles are a bit swollen.");
    await say("It started on Monday.");
    await say("About the same on both sides.");
    expect(readRecord).toHaveBeenCalledTimes(2);
    const [first, second, third] = contexts(llm);
    expect(first).toEqual({ unavailable: true });
    expect(JSON.stringify(second)).toContain("conditions");
    expect(third).toEqual(second);
  });
});

describe("ConversationOrchestrator: a reply is dropped when she has added to what she said", () => {
  /** Gemini's planning is held until the test releases each call; the inputs it was asked with are kept. */
  function slowGemini() {
    const inputs: CallTurnLlmInput[] = [];
    const releases: ((output: CallTurnLlmOutput) => void)[] = [];
    const rejects: ((error: Error) => void)[] = [];
    const llm = new FakeLlmClient();
    llm.callTurn = (input) => new Promise<CallTurnLlmOutput>((resolve, reject) => { inputs.push(input); releases.push(resolve); rejects.push(reject); });
    return { llm, inputs, releases, rejects };
  }
  const asks = (question: string, extra: Partial<CallTurnLlmOutput> = {}) => plan({ nextAction: "ask_follow_up", nextQuestion: question, ...extra });
  const patientWords = (input: CallTurnLlmInput) => input.transcript.filter((turn) => turn.speaker === "patient").map((turn) => turn.text);

  it("a newer transcript queued while Gemini plans the first: its reply is dropped, nothing of it is kept, and the newer turn answers both", async () => {
    const { llm, inputs, releases } = slowGemini();
    const { spoken, say } = buildFlow(llm);
    const first = say("My ankles are a bit swollen.");
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    const second = say("And I have been very tired lately.");
    releases[0]!(asks("When did the swelling start?", { informationCollected: ["ankle swelling"] }));
    await first;
    expect(spoken).toEqual([]);
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    releases[1]!(asks("How long have you felt tired?"));
    await second;
    expect(spoken).toEqual(["Thank you for telling me. How long have you felt tired?"]);
    expect(patientWords(inputs[1]!)).toEqual(["My ankles are a bit swollen.", "And I have been very tired lately."]);
    expect(inputs[1]!.lastQuestionAsked).toBeUndefined(); // the dropped reply's question was not remembered
    expect(inputs[1]!.conversationSummary).not.toContain("ankle swelling"); // nor what it collected
  });

  it("she starts speaking again while Gemini plans: that reply is dropped and her next turn answers everything", async () => {
    const { llm, inputs, releases } = slowGemini();
    const { flow, spoken, say } = buildFlow(llm);
    const first = say("My ankles are a bit swollen.");
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    flow.noteSpeech();
    releases[0]!(asks("When did the swelling start?"));
    await first;
    expect(spoken).toEqual([]);
    const second = say("and my back hurts too");
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    releases[1]!(asks("Where in your back?"));
    await second;
    expect(spoken).toEqual(["Thank you for telling me. Where in your back?"]);
    expect(patientWords(inputs[1]!)).toEqual(["My ankles are a bit swollen.", "and my back hurts too"]);
  });

  it("a queued turn made stale before Gemini was asked is skipped, so the newest one is not kept waiting", async () => {
    const { llm, inputs, releases } = slowGemini();
    const { flow, spoken, say } = buildFlow(llm);
    const first = say("My ankles are a bit swollen.");
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    const second = say("It started on Monday.");
    flow.noteSpeech(); // and she is talking again
    releases[0]!(asks("When did the swelling start?"));
    await first;
    await second;
    expect(releases).toHaveLength(1); // Gemini was not asked for the second turn
    const third = say("and it is worse today");
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    releases[1]!(asks("Is it worse in the evening?"));
    await third;
    expect(spoken).toEqual(["Thank you for telling me. Is it worse in the evening?"]);
    expect(patientWords(inputs[1]!)).toEqual(["My ankles are a bit swollen.", "It started on Monday.", "and it is worse today"]);
  });

  const APOLOGY = "I am sorry, I did not catch that clearly. Please tell me once more.";

  it("a Gemini call that fails after she started speaking again does not apologise: her next turn answers", async () => {
    const { llm, releases, rejects } = slowGemini();
    const { flow, spoken, say } = buildFlow(llm);
    const first = say("My ankles are a bit swollen.");
    await vi.waitFor(() => expect(rejects).toHaveLength(1));
    flow.noteSpeech();
    rejects[0]!(new Error("Gemini timed out"));
    await first;
    expect(spoken).toEqual([]);
    const second = say("and my back hurts too");
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    releases[1]!(asks("Where in your back?"));
    await second;
    expect(spoken).toEqual(["Thank you for telling me. Where in your back?"]);
  });

  it("a Gemini call that fails while a newer transcript is queued does not apologise for the old one", async () => {
    const { llm, releases, rejects } = slowGemini();
    const { spoken, say } = buildFlow(llm);
    const first = say("My ankles are a bit swollen.");
    await vi.waitFor(() => expect(rejects).toHaveLength(1));
    const second = say("It started on Monday.");
    rejects[0]!(new Error("Gemini timed out"));
    await first;
    expect(spoken).toEqual([]);
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    releases[1]!(asks("Is it worse in the evening?"));
    await second;
    expect(spoken).toEqual(["Thank you for telling me. Is it worse in the evening?"]);
  });

  it("a Gemini call that fails with nothing newer still apologises, once", async () => {
    const { llm, rejects } = slowGemini();
    const { spoken, onComplete, say } = buildFlow(llm);
    const first = say("My ankles are a bit swollen.");
    await vi.waitFor(() => expect(rejects).toHaveLength(1));
    rejects[0]!(new Error("Gemini timed out"));
    await first;
    expect(spoken).toEqual([APOLOGY]);
    expect(onComplete).not.toHaveBeenCalled();
  });

  it("speech before her turn is committed does not drop it: the turn is newer than the speech", async () => {
    const llm = new FakeLlmClient({ callTurn: () => asks("When did it start?") });
    const { flow, spoken, say } = buildFlow(llm);
    flow.noteSpeech();
    flow.noteSpeech();
    await say("My ankles are a bit swollen.");
    expect(spoken).toEqual(["Thank you for telling me. When did it start?"]);
  });
});

describe("ConversationOrchestrator: what the model writes is checked before it is said", () => {
  const OPEN = "Is there anything else you would like to tell me about how you are feeling?";
  const BREATHING = "How was your breathing last night when you lay down?";
  const asks = (question: string, extra: Partial<CallTurnLlmOutput> = {}) => plan({ nextAction: "ask_follow_up", nextQuestion: question, ...extra });
  const withQuestions = (...questions: string[]) => ({ firstName: "Harriet", questions: questions.map((text, i) => ({ id: `q${i}`, text })), yesterday: [], memories: [], familyNames: [] });

  it("says a clean acknowledgment and question as written", async () => {
    const llm = new FakeLlmClient({ callTurn: () => asks("When did the swelling start?", { acknowledgment: "I am sorry the swelling is bothering you." }) });
    const { spoken, say } = buildFlow(llm);
    await say("My ankles are swollen.");
    expect(spoken).toEqual(["I am sorry the swelling is bothering you. When did the swelling start?"]);
  });

  it.each([
    "That is nothing to worry about.",
    "You should take your pills with food.",
    "It sounds like heart failure.",
    "If it gets worse, call 911.",
    "It would be wise to contact your clinician today.",
    "That could be a sign of fluid in your lungs.",
  ])("an acknowledgment that gives advice, reassurance or a diagnosis is replaced: %s", async (acknowledgment) => {
    const llm = new FakeLlmClient({ callTurn: () => asks("When did the swelling start?", { acknowledgment }) });
    const { spoken, say } = buildFlow(llm);
    await say("My ankles are swollen.");
    expect(spoken).toEqual(["Thank you for telling me. When did the swelling start?"]);
  });

  it("a question that gives advice is replaced by the next unanswered check-in question, and 'what did you ask?' says that one", async () => {
    const llm = new FakeLlmClient({ callTurn: () => asks("Have you thought about talking to your doctor about the swelling?") });
    const { spoken, say } = buildFlow(llm, { initialContext: withQuestions(BREATHING) });
    await say("My ankles are swollen.");
    expect(spoken).toEqual([`Thank you for telling me. ${BREATHING}`]);
    await say("Sorry, what did you ask?");
    expect(spoken.at(-1)).toBe(`Of course. ${BREATHING}`);
    expect(spoken.join(" ")).not.toMatch(/doctor/);
  });

  it("with no unanswered question left, or one already asked, it asks the open question", async () => {
    const llm = new FakeLlmClient({ callTurn: () => asks("You should call your nurse. Do you agree?") });
    const none = buildFlow(llm);
    await none.say("My ankles are swollen.");
    expect(none.spoken).toEqual([`Thank you for telling me. ${OPEN}`]);

    const asked = buildFlow(llm, { initialContext: withQuestions(BREATHING) });
    asked.transcript.push({ speaker: "agent", text: BREATHING });
    await asked.say("My ankles are swollen.");
    expect(asked.spoken).toEqual([`Thank you for telling me. ${OPEN}`]);
  });

  it("a reply that gives reassurance is not said: a thank-you and a question instead; a clean one is said as written", async () => {
    const reassuring = new FakeLlmClient({ callTurn: () => plan({ nextAction: "start_quiet_measurement", patientResponseText: "Don't worry, it's nothing serious. Let's keep going." }) });
    const a = buildFlow(reassuring, { initialContext: withQuestions(BREATHING) });
    await a.say("My ankles are swollen.");
    expect(a.spoken).toEqual([`Thank you for telling me. ${BREATHING}`]);

    const clean = new FakeLlmClient({ callTurn: () => plan({ nextAction: "start_quiet_measurement", patientResponseText: "Let's keep going. Tell me a little more." }) });
    const b = buildFlow(clean);
    await b.say("My ankles are swollen.");
    expect(b.spoken).toEqual(["Let's keep going. Tell me a little more."]);
  });

  it("the camera request: the model's question must pass too, else the fixed one is asked", async () => {
    const unsafe = new FakeLlmClient({ callTurn: () => plan({ nextAction: "request_measurement_permission", nextQuestion: "May I check your heart rate to see whether you have atrial fibrillation? It is probably an infection." }) });
    const a = buildFlow(unsafe, { canMeasure: () => true });
    await a.say("My heart feels fluttery.");
    expect(a.spoken).toEqual(["Thank you for telling me. Would you be comfortable taking a quiet camera measurement?"]);

    const clean = new FakeLlmClient({ callTurn: () => plan({ nextAction: "request_measurement_permission", nextQuestion: "Would you like to try a quiet camera measurement now?" }) });
    const b = buildFlow(clean, { canMeasure: () => true });
    await b.say("My heart feels fluttery.");
    expect(b.spoken).toEqual(["Thank you for telling me. Would you like to try a quiet camera measurement now?"]);
  });
});

describe("ConversationOrchestrator: her camera is off, so she is told how to turn it on", () => {
  const DECLINE = "Of course. We can skip the camera measurement.";
  /** The camera reading is set up (Presage); `cameraOn` is her video. */
  function offCamera(nextAction: "complete_screening" | "end_call" = "complete_screening") {
    const state = { on: false, configured: true, vitals: emptyCallVitals() };
    const llm = new FakeLlmClient({ callTurn: () => plan({ nextAction }) });
    const flow = buildFlow(llm, { canMeasure: () => state.configured && state.on, cameraNeedsVideo: () => state.configured && !state.on, getVitals: () => state.vitals });
    return { ...flow, state, llm };
  }

  it("says how to turn the camera on, in fixed words, once, and waits for her answer", async () => {
    const { spoken, onComplete, beginQuietMeasurement, say } = offCamera();
    await say("I have had a bit of a cough.");
    expect(spoken).toEqual([CAMERA_GUIDANCE]);
    expect(spoken[0]).not.toMatch(/911|988/);
    expect(onComplete).not.toHaveBeenCalled();
    expect(beginQuietMeasurement).not.toHaveBeenCalled(); // never without her ready
  });

  it("ready with her camera now on starts the quiet reading", async () => {
    vi.useFakeTimers();
    const { flow, spoken, state, onComplete, beginQuietMeasurement, say } = offCamera();
    await say("I have had a bit of a cough.");
    state.on = true;
    state.vitals = { ...emptyCallVitals(), heartRate: 72 };
    await say("Ready.");
    expect(beginQuietMeasurement).toHaveBeenCalledOnce();
    expect(spoken.at(-1)).toMatch(/face and upper chest.*30 seconds/i);
    await vi.advanceTimersByTimeAsync(30_500);
    await vi.waitFor(() => expect(onComplete).toHaveBeenCalledOnce());
    expect(spoken.at(-1)).toBe(callClosing("Harriet"));
    flow.close();
  });

  it("no thanks: the decline line, no reading, then the goodbye, and the guidance is not said again", async () => {
    const { spoken, onComplete, beginQuietMeasurement, say } = offCamera();
    await say("I have had a bit of a cough.");
    await say("No thanks.");
    expect(spoken).toEqual([CAMERA_GUIDANCE, DECLINE, callClosing("Harriet")]);
    expect(beginQuietMeasurement).not.toHaveBeenCalled();
    expect(onComplete).toHaveBeenCalledOnce();
  });

  it("ready but the camera is still off: told once more, then a second ready ends it without a reading", async () => {
    vi.useFakeTimers();
    const { spoken, onComplete, beginQuietMeasurement, say } = offCamera();
    await say("I have had a bit of a cough.");
    await say("Ready.");
    expect(spoken).toEqual([CAMERA_GUIDANCE, CAMERA_STILL_OFF]);
    expect(onComplete).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(6_000); // she hears the reminder before she answers it
    await say("Ready!");
    expect(spoken).toEqual([CAMERA_GUIDANCE, CAMERA_STILL_OFF, DECLINE, callClosing("Harriet")]);
    expect(beginQuietMeasurement).not.toHaveBeenCalled();
    expect(onComplete).toHaveBeenCalledOnce();
  });

  it("the same short answer committed twice is one answer: the second does not decline the guidance", async () => {
    vi.useFakeTimers();
    const { flow, spoken, onComplete, say } = offCamera();
    await say("No."); // her answer to the last question: the model finishes and the guidance is said
    await say("No."); // the speech-to-text committed it a second time
    expect(spoken).toEqual([CAMERA_GUIDANCE]);
    expect(onComplete).not.toHaveBeenCalled(); // still waiting for her answer to the guidance
    await vi.advanceTimersByTimeAsync(4_000);
    await say("No."); // her real answer, seconds later
    expect(spoken).toEqual([CAMERA_GUIDANCE, DECLINE, callClosing("Harriet")]);
    expect(onComplete).toHaveBeenCalledOnce();
    flow.close();
  });

  it("an answer that is neither is told once more, and the camera coming on in between lets the next ready start it", async () => {
    vi.useFakeTimers();
    const { flow, spoken, state, beginQuietMeasurement, say } = offCamera();
    await say("I have had a bit of a cough.");
    await say("What camera?");
    expect(spoken).toEqual([CAMERA_GUIDANCE, CAMERA_STILL_OFF]);
    state.on = true;
    await say("Okay, it's on.");
    expect(beginQuietMeasurement).toHaveBeenCalledOnce();
    flow.close();
  });

  it("is not said when she says she has to go (end_call), or when the camera reading is not set up", async () => {
    const goes = offCamera("end_call");
    await goes.say("I have to go now.");
    expect(goes.spoken).toEqual([callClosing("Harriet")]);

    const unconfigured = offCamera();
    unconfigured.state.configured = false;
    await unconfigured.say("I have had a bit of a cough.");
    expect(unconfigured.spoken).toEqual([callClosing("Harriet")]);
  });

  it("with her camera already on it is the offer, not the guidance", async () => {
    const { spoken, state, say } = offCamera();
    state.on = true;
    await say("I have had a bit of a cough.");
    expect(spoken).toEqual([CAMERA_OFFER_AT_END]);
  });

  it("never when the reading was already taken or declined", async () => {
    const declined = offCamera();
    await declined.say("I have had a bit of a cough.");
    await declined.say("No thanks.");
    expect(declined.spoken.filter((text) => text === CAMERA_GUIDANCE)).toHaveLength(1);
  });
});

describe("ConversationOrchestrator: the quiet window counts down", () => {
  const READBACK = "The camera estimate is about 72 beats a minute for your heart rate. This is an estimate, not a medical test.";
  function window(extra: Partial<ConversationOrchestratorOptions> = {}) {
    vi.useFakeTimers();
    const llm = new FakeLlmClient({ callTurn: () => plan() });
    const flow = buildFlow(llm, { canMeasure: () => true, ...extra });
    return { ...flow, llm };
  }
  const started = async (f: ReturnType<typeof window>) => {
    await f.say("I have had a bit of a cough.");
    await f.say("Yes, please.");
    expect(f.beginQuietMeasurement).toHaveBeenCalledOnce();
  };

  it("says how many seconds are left at 20 and at 10, and nothing in between", async () => {
    const f = window({ getVitals: () => ({ ...emptyCallVitals(), heartRate: 72 }) });
    await started(f);
    const before = f.spoken.length;
    await vi.advanceTimersByTimeAsync(9_000);
    expect(f.spoken.length).toBe(before);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(f.spoken.at(-1)).toBe("Twenty seconds left.");
    await vi.advanceTimersByTimeAsync(9_000);
    expect(f.spoken.at(-1)).toBe("Twenty seconds left.");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(f.spoken.at(-1)).toBe("Ten seconds left.");
    await vi.advanceTimersByTimeAsync(20_500);
    await vi.waitFor(() => expect(f.onComplete).toHaveBeenCalledOnce());
    expect(f.spoken.slice(before)).toEqual([quietCountdown(20), quietCountdown(10), READBACK, callClosing("Harriet")]);
    f.flow.close();
  });

  it("a window cut short ends at the next second with the offer to try again, with no countdown over nothing", async () => {
    let active = true;
    const f = window({ measurementActive: () => active });
    await started(f);
    const before = f.spoken.length;
    await vi.advanceTimersByTimeAsync(4_000);
    active = false; // the camera stalled
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(f.spoken.at(-1)).toBe(QUIET_RETRY_OFFER));
    await vi.advanceTimersByTimeAsync(40_000);
    expect(f.spoken.slice(before)).toEqual([QUIET_RETRY_OFFER]); // nothing more, and the end timer did not fire a second readback
    f.flow.close();
  });

  it("stops when the call is closed", async () => {
    const f = window();
    await started(f);
    const before = f.spoken.length;
    f.flow.close();
    await vi.advanceTimersByTimeAsync(45_000);
    expect(f.spoken.length).toBe(before);
  });

  it("the prompt says how long the window is and that she will hear the time counted down", async () => {
    const f = window({ quietMeasurementMs: 30_000 });
    await started(f);
    expect(f.spoken.at(-1)).toMatch(/30 seconds once I stop talking.*count down/i);
    f.flow.close();
  });
});

describe("ConversationOrchestrator: she hangs up while the reading is being finished", () => {
  it("a call that can no longer be ended is logged, and nothing is thrown out of the timer", async () => {
    vi.useFakeTimers();
    const logged: string[] = [];
    const llm = new FakeLlmClient({ callTurn: () => plan() });
    const f = buildFlow(llm, {
      canMeasure: () => true,
      getVitals: () => ({ ...emptyCallVitals(), heartRate: 72 }),
      onComplete: () => { throw new Error("Relay Call room is not connected."); },
      log: (event) => logged.push(event),
    });
    await f.say("I have had a bit of a cough.");
    await f.say("Yes, please.");
    await vi.advanceTimersByTimeAsync(30_500); // a rejection nobody awaits would fail the whole run here
    await vi.waitFor(() => expect(logged).toContain("call_turn_failed"));
    f.flow.close();
  });
});

describe("ConversationOrchestrator: a reading with nothing usable is offered once more", () => {
  const NO_READING = "I couldn't get a clear camera reading this time. That's okay.";
  const DECLINE = "Of course. We can skip the camera measurement.";
  /** She said yes to the reading; `state.active` is false once her video stalls, `state.camera` is her video. */
  function retryFlow() {
    vi.useFakeTimers();
    const state = { active: true, camera: true, vitals: emptyCallVitals() };
    const llm = new FakeLlmClient({ callTurn: () => plan() });
    const flow = buildFlow(llm, { canMeasure: () => state.camera, measurementActive: () => state.active, getVitals: () => state.vitals });
    return { ...flow, state };
  }
  type Retry = ReturnType<typeof retryFlow>;
  const stall = async (f: Retry) => {
    f.state.active = false; // the camera stalled
    await vi.advanceTimersByTimeAsync(1_000);
    f.state.active = true;
  };
  const firstTryFails = async (f: Retry) => {
    await f.say("I have had a bit of a cough.");
    await f.say("Yes, please.");
    await stall(f);
    await vi.waitFor(() => expect(f.spoken.at(-1)).toBe(QUIET_RETRY_OFFER));
    expect(f.onComplete).not.toHaveBeenCalled();
  };
  const offers = (f: Retry) => f.spoken.filter((text) => text === QUIET_RETRY_OFFER).length;

  it("yes: takes the reading again and reads it back, and the offer is not made twice", async () => {
    const f = retryFlow();
    await firstTryFails(f);
    await f.say("Yes.");
    expect(f.beginQuietMeasurement).toHaveBeenCalledTimes(2);
    expect(f.spoken.at(-1)).toMatch(/face and upper chest.*30 seconds/i);
    f.state.vitals = { ...emptyCallVitals(), heartRate: 72, breathingRate: 14 };
    await vi.advanceTimersByTimeAsync(30_500);
    await vi.waitFor(() => expect(f.onComplete).toHaveBeenCalledOnce());
    expect(f.spoken.slice(-2)).toEqual(["The camera estimate is about 72 beats a minute for your heart rate and 14 breaths a minute for your breathing. This is an estimate, not a medical test.", callClosing("Harriet")]);
    expect(offers(f)).toBe(1);
    f.flow.close();
  });

  it("'try again' is a yes", async () => {
    const f = retryFlow();
    await firstTryFails(f);
    await f.say("Let's try again.");
    expect(f.beginQuietMeasurement).toHaveBeenCalledTimes(2);
    f.flow.close();
  });

  it("no: the decline line, no second reading, then the goodbye", async () => {
    const f = retryFlow();
    await firstTryFails(f);
    await f.say("No thanks.");
    expect(f.spoken.slice(-2)).toEqual([DECLINE, callClosing("Harriet")]);
    expect(f.beginQuietMeasurement).toHaveBeenCalledOnce();
    expect(f.onComplete).toHaveBeenCalledOnce();
  });

  it("a second failure ends with the no-reading words and the goodbye, with no third try offered", async () => {
    const f = retryFlow();
    await firstTryFails(f);
    await f.say("Yes.");
    await stall(f);
    await vi.waitFor(() => expect(f.onComplete).toHaveBeenCalledOnce());
    expect(f.spoken.slice(-2)).toEqual([NO_READING, callClosing("Harriet")]);
    expect(offers(f)).toBe(1);
    expect(f.beginQuietMeasurement).toHaveBeenCalledTimes(2);
  });

  it("is not offered when her camera has gone off meanwhile", async () => {
    const f = retryFlow();
    await f.say("I have had a bit of a cough.");
    await f.say("Yes, please.");
    f.state.camera = false;
    await stall(f);
    await vi.waitFor(() => expect(f.onComplete).toHaveBeenCalledOnce());
    expect(f.spoken.slice(-2)).toEqual([NO_READING, callClosing("Harriet")]);
    expect(offers(f)).toBe(0);
  });
});
