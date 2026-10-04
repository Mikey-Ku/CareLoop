import { describe, expect, it } from "vitest";
import { BUTTON, smallTalkFallback } from "../src/checkin/copy.ts";
import { MAX_SMALL_TALK_REPLY, checkedSmallTalk, createCheckinEngine } from "../src/checkin/engine.ts";
import { guardSmallTalk } from "../src/context/guard.ts";
import { openDatabase, upsertPatient } from "../src/db/index.ts";
import { loadRxNavCache, loadSnapshot } from "../src/finchnode/fixtures.ts";
import { FakeLlmClient } from "../src/llm/fake.ts";
import { FakeMessenger } from "../src/relay/fake-messenger.ts";

// The reply guard for the model's small talk (src/context/guard.ts, used by checkedSmallTalk). The model
// sees the context digest; its reply goes out only when it states nothing about her health that the digest
// and her own message don't hold, tells her to do nothing medical, has no dosing words and no dash used as
// punctuation. Otherwise the fixed reply is sent. Synthetic data.

const DIGEST = [
  "HER: Harriet, 78.",
  "Conditions on her record: Heart failure, Atrial fibrillation, Type 2 diabetes mellitus.",
  'Her medicines: Apixaban 5 mg "Take 1 tablet by mouth twice daily"; Metformin hydrochloride 500 mg "Take 1 tablet by mouth once daily with the evening meal".',
  "TODAY (Tue Sep 1): Camera estimate today: heart rate about 72, not a medical test.",
].join("\n");
const known = { digest: DIGEST, message: "good afternoon" };
const EM = String.fromCharCode(0x2014);
const EN = String.fromCharCode(0x2013);

type Known = { digest?: string | undefined; message: string };
const passes = (text: string, k: Known = known) => expect(guardSmallTalk(text, k), text).toBe(text);
const rejects = (text: string, k: Known = known) => expect(guardSmallTalk(text, k), text).toBeUndefined();

describe("what passes", () => {
  it("friendly words, her own words back, and facts that are in the digest or in her message", () => {
    passes("Good afternoon, Harriet. I hope you're having a nice day.");
    passes("I'm an AI assistant, so I can't tell, but I hope the sunshine lasts.");
    passes("Sarah would love to hear that. Maybe tell her about the garden?");
    passes("I hope the apixaban is no trouble.");
    passes("Your heart failure and your diabetes are on my notes, and I'm glad you're out in the sun.");
    passes("About 72, was it?");
    passes("Ibuprofen? You mentioned it, I can't say anything about it.", { digest: DIGEST, message: "I took an ibuprofen for my knee" });
    passes("Hello again, Harriet.");
  });
});

describe("a dash used as punctuation", () => {
  it("rejects long dashes, a spaced hyphen and a double hyphen; a hyphen inside a word is fine", () => {
    rejects(`Lovely ${EM} enjoy it.`);
    rejects(`Lovely ${EN} enjoy it.`);
    rejects("Lovely - enjoy it.");
    rejects("Lovely -- enjoy it.");
    passes("What a well-known song, Harriet.");
  });
});

describe("dosing words", () => {
  it("rejects take more, skip, stop, double and the project's own dosing-advice patterns", () => {
    for (const bad of [
      "You could take more if it hurts.",
      "Maybe take an extra one tonight.",
      "Don't skip your pills, Harriet.",
      "You might stop the metformin for a day.",
      "Double the dose and see.",
      "You should take your apixaban with food.",
      "Stop taking the water pill.",
      "Is that dosage right for you?",
      "Try to halve the tablets.",
    ])
      rejects(bad);
  });
});

describe("something medical she should do", () => {
  it("rejects advice with a medical word in it, and instructions that are medical on their own", () => {
    for (const bad of [
      "You should call your doctor about that.",
      "Please ask your nurse about it.",
      "Call your doctor today.",
      "See a doctor if it continues.",
      "I suggest you talk to your pharmacist.",
      "Make sure you rest and drink water, for your health.",
      "Elevate your feet this afternoon.",
      "Monitor your blood pressure.",
      "Call 911 if it gets worse.",
      "It's important to take your medicine.",
      "It would be a good idea to let your family or doctor know right away.", // said live to "my heart has been fluttering"
      "It may be worth mentioning to your doctor.",
      "I would encourage you to talk to your nurse.",
      "Tell your doctor how you feel.",
      "Since I can't advise on that, it might be good to share this with your family or doctor.", // said live to "the water pill makes me tired"
      "I can't give medical advice, but your pharmacist would be great to ask.",
    ])
      rejects(bad);
  });

  it("lets advice that isn't medical through", () => {
    passes("You should tell Sarah about the garden, she'd love that.");
    passes("Please enjoy the sunshine, Harriet.");
    passes("Take your time, there's no hurry.");
    passes("Call Sarah when you feel like a chat.");
  });
});

describe("numbers, medicines and conditions", () => {
  it("a number in neither the digest nor her message is rejected; one in either is fine", () => {
    rejects("I hope the 88 on your reading is steady.");
    rejects("Have a lovely day, it's nearly 6.");
    rejects("Your reading of 7 was fine."); // 7 is only part of 72
    passes("That reading of 72 was a camera estimate.");
    passes("You said 3 pm, so enjoy the visit.", { digest: DIGEST, message: "Sarah comes at 3 pm" });
  });

  it("a medicine in neither is rejected, by name, by brand, or by a drug-like ending; her own list is fine", () => {
    for (const bad of ["How are you getting on with the ibuprofen?", "Is the Tylenol helping?", "Is the lisinopril helping?", "Has the amlodipine made a difference?", "Does the rivaroxaban upset you?", "I hope the fluconazole is working."]) rejects(bad);
    passes("How are you getting on with the metformin?");
    passes("Is the lisinopril helping?", { digest: `${DIGEST}\nMedicines: Lisinopril 10 mg`, message: "hi" });
    passes("Is the tylenol helping?", { digest: DIGEST, message: "my tylenol isn't helping" });
  });

  it("a condition in neither is rejected, and so is one the digest only names in other words", () => {
    for (const bad of ["I hope your asthma is quiet.", "How is the arthritis today?", "I hope your high blood pressure is steady.", "Any word on the stroke clinic?", "I hope the infection clears."]) rejects(bad);
    passes("I hope your heart failure is quiet.");
    passes("Your arthritis, you said. I'm sorry.", { digest: DIGEST, message: "my arthritis is bad today" });
  });

  it("with no digest at all (it couldn't be built), nothing health related may be named: only her own message counts", () => {
    rejects("I hope the apixaban is no trouble.", { message: "hello" });
    rejects("Your heart rate was 72.", { digest: undefined, message: "hello" });
    passes("I hope the apixaban is no trouble.", { digest: undefined, message: "my apixaban makes me tired" });
    passes("Good afternoon, Harriet.", { message: "hello" });
  });
});

describe("checkedSmallTalk keeps the checks it had, and adds the guard", () => {
  it("empty, over-long or long-dashed text is still undefined; text is tidied; the guard decides the rest", () => {
    expect(checkedSmallTalk("   ")).toBeUndefined();
    expect(checkedSmallTalk("word ".repeat(MAX_SMALL_TALK_REPLY))).toBeUndefined();
    expect(checkedSmallTalk(`Fine ${EM} thanks.`, known)).toBeUndefined();
    expect(checkedSmallTalk("  Good   afternoon, Harriet.  ", known)).toBe("Good afternoon, Harriet.");
    expect(checkedSmallTalk("You should call your doctor.", known)).toBeUndefined();
    expect(checkedSmallTalk("Hello, Harriet.")).toBe("Hello, Harriet.");
  });
});

// The engine sends the model's small talk only when it passes the guard; otherwise the fixed reply goes.
describe("small talk through the engine", () => {
  const P = "harriet";
  const ME = "chat_harriet";
  const NOW = "2026-09-01T15:00:00.000Z";

  async function chat(reply: string, beforeSay?: (engine: ReturnType<typeof createCheckinEngine>) => Promise<void>): Promise<string[]> {
    const db = openDatabase(":memory:");
    upsertPatient(db, { id: P, finchnodePatientId: "patient-demo-polypharmacy", preferredName: "Harriet", relayChatId: ME });
    const messenger = new FakeMessenger({ now: () => NOW });
    const llm = new FakeLlmClient({
      classifyMessage: () => ({ kind: "chat", confidence: "high", complaints: [], memories: [] }),
      smallTalk: () => ({ text: reply, memories: [], complaints: [] }),
    });
    const engine = createCheckinEngine({ db, messenger, clock: { now: () => NOW }, loadSnapshot: async (s) => loadSnapshot(s), llm }, { rxnav: loadRxNavCache() });
    await beforeSay?.(engine);
    const before = messenger.sent.length;
    await engine.handleInbound({ chatId: ME, messageId: "in_1", text: "good afternoon", at: NOW });
    return messenger.sent.slice(before).map((m) => m.text);
  }

  it("a plain friendly reply is sent as written", async () => {
    expect(await chat("Good afternoon, Harriet. I hope you're having a nice day.")).toEqual(["Good afternoon, Harriet. I hope you're having a nice day."]);
  });

  it("a reply that states a health fact the digest doesn't hold, or tells her to do something medical, falls back to the fixed reply", async () => {
    for (const bad of [
      "Good afternoon, Harriet. I hope your heart rate of 88 is steady.", // a number in neither
      "Good afternoon, Harriet. How are you getting on with the ibuprofen?", // a medicine in neither
      "Good afternoon, Harriet. I hope your asthma is quiet today.", // a condition in neither
      "Good afternoon, Harriet. You should call your doctor about that.", // something medical she should do
      "Good afternoon, Harriet. You could skip a dose if it bothers you.", // dosing
      `Good afternoon, Harriet. Hope the day is kind to you ${String.fromCharCode(0x2014)} take care.`, // a long dash
    ])
      expect(await chat(bad), bad).toEqual([smallTalkFallback("Harriet")]);
  });

  it("a reply that repeats what the digest holds is allowed, even in the middle of a question", async () => {
    const reply = "Good afternoon, Harriet. I hope the apixaban is no trouble, and that your heart failure is quiet.";
    const sent = await chat(reply, async (engine) => {
      await engine.startDay(P, "2026-09-01"); // stores her record, so the digest holds her medicines and conditions
      await engine.handleInbound({ chatId: ME, messageId: "tap_1", text: BUTTON.start, at: NOW });
    });
    expect(sent[0]).toBe(reply);
  });
});
