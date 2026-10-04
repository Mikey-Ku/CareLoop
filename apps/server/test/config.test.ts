import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { ConfigError, DEFAULT_GEMINI_MODELS, loadConfig, normalizeHandle, parseHandles, resolveCheckinDate } from "../src/config.ts";

const TOKEN = "relay_agent_tok_SECRET_123";

function errorOf(fn: () => unknown): Error {
  try {
    fn();
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected a throw");
}

describe("loadConfig defaults", () => {
  it("keeps the run 1 fields and fills the new ones", () => {
    const c = loadConfig({});
    expect(c.finchnode).toEqual({ baseUrl: "https://api.finchnode.com/demo/v1", apiKey: undefined });
    expect(c.port).toBe(3000);
    expect(c.databasePath).toBe("./data/app.db");
    expect(c.checkinTime).toBe("09:00");
    expect(c.missedCheckinTime).toBe("12:00");
    expect(c.clockDate).toBeUndefined();
    expect(c.relay.apiUrl).toBe("https://api.relayapp.im");
    expect(c.relay.agentToken).toBeUndefined();
    expect(c.patient).toEqual({
      finchnodeSubject: "patient-demo-polypharmacy",
      relayHandle: undefined,
      familyHandles: [],
      timezone: "America/Detroit",
    });
  });

  it("treats empty strings as unset, like a fresh .env", () => {
    const c = loadConfig({ RELAY_AGENT_TOKEN: "", PATIENT_RELAY_HANDLE: "", FAMILY_RELAY_HANDLES: "", CLOCK_DATE: "", PATIENT_TIMEZONE: "" });
    expect(c.relay.agentToken).toBeUndefined();
    expect(c.patient.relayHandle).toBeUndefined();
    expect(c.patient.familyHandles).toEqual([]);
    expect(c.patient.timezone).toBe("America/Detroit");
  });
});

describe("Relay handles", () => {
  it("strips @ and spaces from the patient handle", () => {
    expect(loadConfig({ PATIENT_RELAY_HANDLE: " @Harriet " }).patient.relayHandle).toBe("harriet");
    expect(loadConfig({ PATIENT_RELAY_HANDLE: "@" }).patient.relayHandle).toBeUndefined();
  });

  it("splits family handles on commas, trims, strips @, drops blanks and repeats", () => {
    const c = loadConfig({ FAMILY_RELAY_HANDLES: "@sarah, Tom ,, @SARAH,@@ann " });
    expect(c.patient.familyHandles).toEqual(["sarah", "tom", "ann"]);
    expect(parseHandles(undefined)).toEqual([]);
    expect(normalizeHandle("  @bob")).toBe("bob");
  });
});

describe("time zone", () => {
  it("accepts IANA zones", () => {
    expect(loadConfig({ PATIENT_TIMEZONE: "Europe/London" }).patient.timezone).toBe("Europe/London");
    expect(loadConfig({ PATIENT_TIMEZONE: "UTC" }).patient.timezone).toBe("UTC");
  });

  it("rejects a zone Intl doesn't know with a ConfigError", () => {
    const err = errorOf(() => loadConfig({ PATIENT_TIMEZONE: "America/Nowhere" }));
    expect(err).toBeInstanceOf(ConfigError);
    expect(err.message).toContain("PATIENT_TIMEZONE");
  });
});

describe("RELAY_API_URL", () => {
  it("keeps the origin and drops a trailing slash", () => {
    expect(loadConfig({ RELAY_API_URL: "https://api.relayapp.im/" }).relay.apiUrl).toBe("https://api.relayapp.im");
    expect(loadConfig({ RELAY_API_URL: "http://localhost:8787" }).relay.apiUrl).toBe("http://localhost:8787");
  });

  it("rejects a /v1 path because the SDK adds it", () => {
    const err = errorOf(() => loadConfig({ RELAY_API_URL: "https://api.relayapp.im/v1" }));
    expect(err).toBeInstanceOf(ConfigError);
    expect(err.message).toContain("origin only");
  });

  it("rejects something that isn't a URL, plain HTTP off localhost, and credentials", () => {
    expect(() => loadConfig({ RELAY_API_URL: "api.relayapp.im" })).toThrow(ConfigError);
    expect(() => loadConfig({ RELAY_API_URL: "http://api.relayapp.im" })).toThrow("HTTPS");
    expect(() => loadConfig({ RELAY_API_URL: "https://user:pw@api.relayapp.im" })).toThrow("credentials");
  });
});

describe("times and dates", () => {
  it("rejects CHECKIN_TIME and MISSED_CHECKIN_TIME that aren't HH:MM", () => {
    const err = errorOf(() => loadConfig({ CHECKIN_TIME: "9am", MISSED_CHECKIN_TIME: "25:00" }));
    expect(err).toBeInstanceOf(ConfigError);
    expect(err.message).toContain("CHECKIN_TIME");
    expect(err.message).toContain("MISSED_CHECKIN_TIME");
  });

  it("rejects a malformed CLOCK_DATE", () => {
    expect(() => loadConfig({ CLOCK_DATE: "10/03/2026" })).toThrow("CLOCK_DATE must be YYYY-MM-DD");
  });

  it("resolveCheckinDate prefers the demo clock, then data as-of, then today", () => {
    expect(resolveCheckinDate("2026-09-01", "2026-08-01")).toBe("2026-09-01");
    expect(resolveCheckinDate(undefined, "2026-08-01")).toBe("2026-08-01");
    expect(resolveCheckinDate(undefined, undefined, new Date("2026-10-03T12:00:00Z"))).toBe("2026-10-03");
  });
});

describe("the agent token never leaks", () => {
  it("is readable by code but not printed, serialized or spread", () => {
    const c = loadConfig({ RELAY_AGENT_TOKEN: ` ${TOKEN} ` });
    expect(c.relay.agentToken).toBe(TOKEN);
    expect(JSON.stringify(c)).not.toContain(TOKEN);
    expect(String(c)).not.toContain(TOKEN);
    expect(inspect(c, { depth: 10 })).not.toContain(TOKEN);
    expect(`${JSON.stringify({ ...c.relay })}`).not.toContain(TOKEN);
  });

  it("is not in any config error, whatever else is wrong", () => {
    const bad = [
      { PATIENT_TIMEZONE: "Not/AZone" },
      { RELAY_API_URL: "https://api.relayapp.im/v1" },
      { RELAY_API_URL: TOKEN },
      { PORT: "not-a-port" },
      { CHECKIN_TIME: TOKEN },
      { FINCHNODE_BASE_URL: "nope" },
    ];
    for (const env of bad) {
      const err = errorOf(() => loadConfig({ RELAY_AGENT_TOKEN: TOKEN, ...env }));
      expect(err.message).not.toContain(TOKEN);
      expect(String(err.stack)).not.toContain(TOKEN);
      expect(inspect(err)).not.toContain(TOKEN);
    }
  });
});

describe("LLM settings", () => {
  const KEY = "AIza_gemini_SECRET_456";

  it("defaults to gemini, the two measured models and a 12 s budget, with no key", () => {
    const c = loadConfig({});
    expect(c.llm).toEqual({ provider: "gemini", geminiModels: [...DEFAULT_GEMINI_MODELS], timeoutMs: 12_000, attemptTimeoutMs: 4_000 });
    expect(c.llm.geminiApiKey).toBeUndefined();
    expect(loadConfig({ GEMINI_API_KEY: "  " }).llm.geminiApiKey).toBeUndefined();
  });

  it("reads the provider in any case, the model list and the budget", () => {
    const c = loadConfig({ LLM_PROVIDER: " Gemini ", GEMINI_MODELS: " a , b,,a ", LLM_TIMEOUT_MS: "8000" });
    expect(c.llm.provider).toBe("gemini");
    expect(c.llm.geminiModels).toEqual(["a", "b"]);
    expect(c.llm.timeoutMs).toBe(8000);
    expect(loadConfig({ GEMINI_MODELS: " , " }).llm.geminiModels).toEqual([...DEFAULT_GEMINI_MODELS]);
  });

  it("rejects an unknown provider and a silly budget", () => {
    expect(() => loadConfig({ LLM_PROVIDER: "openai" })).toThrow("LLM_PROVIDER");
    expect(() => loadConfig({ LLM_TIMEOUT_MS: "5" })).toThrow("LLM_TIMEOUT_MS");
    expect(() => loadConfig({ LLM_TIMEOUT_MS: "soon" })).toThrow(ConfigError);
  });

  it("keeps GEMINI_API_KEY readable by code but out of JSON, inspect and spreads", () => {
    const c = loadConfig({ GEMINI_API_KEY: ` ${KEY} ` });
    expect(c.llm.geminiApiKey).toBe(KEY);
    expect(JSON.stringify(c)).not.toContain(KEY);
    expect(inspect(c, { depth: 10 })).not.toContain(KEY);
    expect(JSON.stringify({ ...c.llm })).not.toContain(KEY);
  });

  it("never puts GEMINI_API_KEY in a config error", () => {
    for (const env of [{ LLM_PROVIDER: KEY }, { LLM_TIMEOUT_MS: KEY }, { PORT: "x" }, { RELAY_API_URL: KEY }]) {
      const err = errorOf(() => loadConfig({ GEMINI_API_KEY: KEY, ...env }));
      expect(err).toBeInstanceOf(ConfigError);
      expect(err.message).not.toContain(KEY);
      expect(inspect(err)).not.toContain(KEY);
    }
  });
});
