import { afterEach, describe, expect, it, vi } from "vitest";
import { CAMERA_OFFER_AT_END, callClosing, callFirstMessage } from "../src/calls/copy.ts";
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
      getVitals: emptyCallVitals,
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

  it("emergency: she hears the text check-in's fixed 911 reply, never the model's words", async () => {
    const llm = new FakeLlmClient({ callTurn: () => plan({ nextAction: "emergency", patientResponseText: "Please lie down and rest, and keep an eye on it." }), screenCall: () => screening });
    const { spoken, onComplete, say } = buildFlow(llm, { initialContext: { firstName: "Harriet", questions: [], yesterday: [], memories: [], familyNames: ["Sarah"] } });
    await say("I feel a bit odd today.");
    expect(spoken).toEqual(["Harriet, if this is happening now, please call 911 right away. After that, call your doctor."]);
    expect(spoken).toEqual([urgentReply("Harriet", [])]);
    expect(spoken[0]).not.toMatch(/I've let|family|Sarah|lie down|keep an eye/); // nobody has been told yet: no claim that anyone was
    expect(onComplete).toHaveBeenCalledWith(screening);
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

  it.each(["complete_screening", "end_call"] as const)("%s: asks first, in fixed words, and does not hang up until she answers", async (nextAction) => {
    const llm = new FakeLlmClient({ callTurn: () => plan({ nextAction }) });
    const { spoken, onComplete, beginQuietMeasurement, say } = buildFlow(llm, { canMeasure: () => true });
    await say("I have had a bit of a cough.");
    expect(spoken).toEqual([CAMERA_OFFER_AT_END]);
    expect(onComplete).not.toHaveBeenCalled();
    expect(beginQuietMeasurement).not.toHaveBeenCalled(); // never without her yes
    expect(llm.calls.map((call) => call.method)).toEqual(["callTurn"]);
  });

  it("an answer that is neither yes nor no asks again and still does not hang up", async () => {
    const llm = new FakeLlmClient({ callTurn: () => plan() });
    const { spoken, onComplete, say } = buildFlow(llm, { canMeasure: () => true });
    await say("I have had a bit of a cough.");
    await say("What is it for?");
    expect(spoken).toEqual([CAMERA_OFFER_AT_END, ASK_AGAIN]);
    expect(onComplete).not.toHaveBeenCalled();
  });

  it("yes: runs the quiet measurement, reads it back, then the fixed goodbye; it is not offered a second time", async () => {
    vi.useFakeTimers();
    const llm = new FakeLlmClient({ callTurn: () => plan() });
    const { flow, spoken, onComplete, beginQuietMeasurement, say } = buildFlow(llm, { canMeasure: () => true });
    await say("I have had a bit of a cough.");
    await say("Yes, please.");
    expect(beginQuietMeasurement).toHaveBeenCalledOnce();
    expect(spoken.at(-1)).toMatch(/face and upper chest.*30 seconds/i);
    expect(onComplete).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30_500);
    await vi.waitFor(() => expect(onComplete).toHaveBeenCalledOnce());
    expect(spoken).toEqual([CAMERA_OFFER_AT_END, spoken[1], "I couldn't get a clear camera reading this time. That's okay.", callClosing("Harriet")]);
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
    const { flow, spoken, onComplete, say } = buildFlow(llm, { canMeasure: () => true });
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
    await say("I feel a bit odd today.");
    expect(spoken).toEqual([urgentReply("Harriet", [])]);
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
    const llm = new FakeLlmClient();
    llm.callTurn = (input) => new Promise<CallTurnLlmOutput>((resolve) => { inputs.push(input); releases.push(resolve); });
    return { llm, inputs, releases };
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

  it("speech before her turn is committed does not drop it: the turn is newer than the speech", async () => {
    const llm = new FakeLlmClient({ callTurn: () => asks("When did it start?") });
    const { flow, spoken, say } = buildFlow(llm);
    flow.noteSpeech();
    flow.noteSpeech();
    await say("My ankles are a bit swollen.");
    expect(spoken).toEqual(["Thank you for telling me. When did it start?"]);
  });
});
