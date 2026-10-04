import { beforeEach, describe, expect, it } from "vitest";
import { createCheckinEngine } from "../src/checkin/engine.ts";
import type { CheckinEngine } from "../src/checkin/engine-types.ts";
import { getCheckin } from "../src/db/checkins.ts";
import { linkFamilyMember, syncFamilyMembers } from "../src/db/family.ts";
import { openDatabase, upsertPatient, type Db } from "../src/db/index.ts";
import { observationsBetween } from "../src/db/observations.ts";
import { loadRxNavCache, loadSnapshot } from "../src/finchnode/fixtures.ts";
import { FakeLlmClient } from "../src/llm/fake.ts";
import type { CheckinExtraction } from "../src/llm/types.ts";
import { FakeMessenger } from "../src/relay/fake-messenger.ts";

// A spoken answer and a typed answer are recorded the same way (docs/BRIEF.md MVP feature 1): the same
// extraction, the same fixed rules and ladder, the same rows. Synthetic data only.

const P = "harriet";
const ME = "chat_harriet";
const SARAH = "chat_sarah";
const DAY = "2026-09-01"; // breathing, bleeding, dizziness
const NOW = `${DAY}T09:00:00.000Z`;
const rxnav = loadRxNavCache();

const WORDS = "I get a bit dizzy when I stand up sometimes, and my knee aches.";
const EXTRACTION: CheckinExtraction = {
  answers: [{ questionId: "dizzy-on-standing", answer: "Sometimes", confidence: "high" }],
  symptoms: [
    { topic: "dizzy-on-standing", questionId: "dizzy-on-standing", amount: "a_little", change: "same", words: "a bit dizzy when I stand up sometimes" },
    { topic: "knee pain", amount: "a_little", change: "same", words: "my knee aches" },
  ],
  memories: ["granddaughter visiting Sunday"],
};

function world(): { db: Db; messenger: FakeMessenger; engine: CheckinEngine } {
  const db = openDatabase(":memory:");
  upsertPatient(db, { id: P, finchnodePatientId: "patient-demo-polypharmacy", preferredName: "Harriet", relayChatId: ME });
  syncFamilyMembers(db, P, ["sarah"]);
  linkFamilyMember(db, "sarah", SARAH, "Sarah", `${DAY}T08:00:00.000Z`);
  const messenger = new FakeMessenger({ now: () => NOW });
  const llm = new FakeLlmClient({ extractCheckin: () => EXTRACTION, classifyMessage: () => ({ kind: "answer", confidence: "low", complaints: [], memories: [] }) });
  const engine = createCheckinEngine({ db, messenger, clock: { now: () => NOW }, loadSnapshot: async (s) => loadSnapshot(s), llm }, { rxnav });
  return { db, messenger, engine };
}

const rows = (db: Db) => ({
  answers: getCheckin(db, P, DAY)!.answers.map(({ questionId, answer, level }) => ({ questionId, answer, level })),
  observations: observationsBetween(db, P, DAY, DAY).map(({ topic, questionId, level, amount, change, source }) => ({ topic, questionId, level, amount, change, source })),
});

let typed: ReturnType<typeof world>;
let spoken: ReturnType<typeof world>;

beforeEach(() => {
  typed = world();
  spoken = world();
});

describe("spoken check-in", () => {
  it("spoken answers produce the same checkins and symptom_observations rows as typed ones, then ONE message to her chat", async () => {
    await typed.engine.startDay(P, DAY);
    await typed.engine.handleInbound({ chatId: ME, messageId: "in_1", text: WORDS, at: NOW });

    const context = await spoken.engine.callCheckinContext(P, DAY);
    expect(context.questions.map((q) => q.id)).toContain("dizzy-on-standing");
    expect(spoken.messenger.sent).toEqual([]); // no greeting: the call asks
    const result = await spoken.engine.recordSpokenCheckin(P, DAY, [{ id: "call:c1:turn:1", text: WORDS }], { callId: "c1", reading: { heartRate: 72, breathingRate: null } });

    expect(result.level).toBe(1);
    expect(rows(spoken.db)).toEqual(rows(typed.db));
    expect(rows(spoken.db).answers).toEqual([{ questionId: "dizzy-on-standing", answer: "Sometimes", level: 1 }]);
    expect(rows(spoken.db).observations.map((o) => [o.topic, o.level])).toEqual([
      ["dizzy-on-standing", 1],
      ["knee pain", 1],
    ]);
    expect(getCheckin(spoken.db, P, DAY)!.answers[0]).toMatchObject({ via: "voice" });

    const sent = spoken.messenger.inChat(ME);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toMatch(/^Here's what I noted from our call: /);
    expect(sent[0]!.text).toMatch(/72 beats a minute, a camera estimate/);
    expect(sent[0]!.text).not.toMatch(/911|[\u2013\u2014]/);
    expect(sent[0]!.buttons).toEqual(["That's right", "Something's wrong"]);
    expect(spoken.messenger.inChat(SARAH)).toEqual([]); // level 1: no alert
  });
});
