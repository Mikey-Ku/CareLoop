import type { Call, CallWebhookEvent } from "@relaymessenger/sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@relaymessenger/elevenlabs", () => ({
  ElevenLabsCall: {
    connect: vi.fn(async () => {
      throw new Error("ElevenLabs websocket unavailable");
    }),
  },
}));

import { CallService } from "../src/calls/service.ts";
import { createCallSession, getCallSession } from "../src/db/calls.ts";
import { openDatabase, upsertPatient } from "../src/db/index.ts";
import { loadConfig } from "../src/config.ts";

const call = {
  id: "call-service-1",
  chat_id: "chat-1",
  from: { id: "person-1", handle: "harriet", kind: "user" },
  to: [{ id: "agent-1", handle: "agent", kind: "agent" }],
  status: "ringing",
  revision: 1,
  created_at: "2026-10-03T12:00:00.000Z",
  ringing_at: "2026-10-03T12:00:00.000Z",
  answered_at: null,
  ended_at: null,
} as Call;

function event(): CallWebhookEvent {
  return { event_type: "call.created", event_id: "event-1", data: { call } } as CallWebhookEvent;
}

describe("CallService failure and cleanup paths", () => {
  beforeEach(() => vi.clearAllMocks());

  it("records an ElevenLabs connection failure without blocking the inbox caller", async () => {
    const db = openDatabase(":memory:");
    upsertPatient(db, { id: "p1", finchnodePatientId: "subject", preferredName: "Harriet", relayHandle: "harriet" });
    const config = loadConfig({ ELEVENLABS_API_KEY: "test", ELEVENLABS_AGENT_ID: "agent", PATIENT_TIMEZONE: "America/Detroit" });
    const service = new CallService({ db, config, relay: {} as never, loadSnapshot: async () => { throw new Error("not used"); } });
    const started = Date.now();
    await service.handle(event());
    expect(Date.now() - started).toBeLessThan(1000);
    await vi.waitFor(() => expect(getCallSession(db, call.id)?.status).toBe("failed"));
    expect(getCallSession(db, call.id)?.error).toMatch(/ElevenLabs websocket unavailable/);
  });

  it("returns a bounded human-review result when FinchNode lookup fails", async () => {
    const db = openDatabase(":memory:");
    upsertPatient(db, { id: "p1", finchnodePatientId: "subject", preferredName: "Harriet", relayHandle: "harriet" });
    createCallSession(db, { callId: "call-finchnode", patientId: "p1", relayChatId: "chat-1", at: "2026-10-03T12:00:00.000Z" });
    const config = loadConfig({ PATIENT_TIMEZONE: "America/Detroit" });
    const service = new CallService({ db, config, relay: {} as never, loadSnapshot: async () => { throw new Error("FinchNode unavailable"); } });
    const result = await service.screen("call-finchnode");
    expect(result.recommendedHumanAction).toBe("contact_clinician_today");
    expect(result.patientResponseText).toMatch(/Thank you|sharing/i);
    expect(result.uncertainty.join(" ")).toMatch(/FinchNode lookup failed/);
  });

  it("marks an interrupted or already-ended call complete without media persistence", async () => {
    const db = openDatabase(":memory:");
    upsertPatient(db, { id: "p1", finchnodePatientId: "subject", preferredName: "Harriet", relayHandle: "harriet" });
    createCallSession(db, { callId: "call-ended", patientId: "p1", relayChatId: "chat-1", at: "2026-10-03T12:00:00.000Z" });
    const service = new CallService({ db, config: loadConfig({ PATIENT_TIMEZONE: "America/Detroit" }), relay: {} as never, loadSnapshot: async () => { throw new Error("not used"); } });
    await service.end("call-ended");
    expect(getCallSession(db, "call-ended")?.status).toBe("ended");
    expect(db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '%audio%' OR name LIKE '%video%'`).all()).toEqual([]);
  });
});
