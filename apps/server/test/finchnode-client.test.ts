import { describe, expect, it } from "vitest";
import {
  ConsentInactiveError,
  ConsentScopeError,
  FinchNodeClient,
  FinchNodeError,
  RateLimitedError,
  SubjectNotFoundError,
  normalizeConnectSession,
} from "../src/finchnode/client.ts";
import { retryAfterMs } from "../src/http.ts";
import { loadRecorded, replayFetch, type RecordedResponse } from "../src/finchnode/fixtures.ts";

// Offline only: every response comes from fixtures/finchnode via replayFetch.

const BASE = "https://api.finchnode.test/demo/v1";

function clientWith(fetchImpl: typeof fetch, extra: { maxRetries?: number; maxRetryDelayMs?: number } = {}) {
  const sleeps: number[] = [];
  const client = new FinchNodeClient({
    baseUrl: `${BASE}/`,
    fetch: fetchImpl,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    ...extra,
  });
  return { client, sleeps };
}

function recordedError(status: number, code: string, headers: Record<string, string> = {}): RecordedResponse {
  return { request: { method: "GET", path: "/" }, status, headers, body: { error: { code, message: `${code} test` } } };
}

describe("retryAfterMs", () => {
  it("reads delta-seconds", () => {
    expect(retryAfterMs("1")).toBe(1000);
    expect(retryAfterMs("2")).toBe(2000);
    expect(retryAfterMs("0")).toBe(0);
  });

  it("reads an HTTP date relative to now", () => {
    const now = Date.parse("2026-10-03T12:00:00Z");
    expect(retryAfterMs("Sat, 03 Oct 2026 12:00:04 GMT", now)).toBe(4000);
  });

  it("never returns a negative delay", () => {
    expect(retryAfterMs("-5")).toBe(0);
    const now = Date.parse("2026-10-03T12:00:00Z");
    expect(retryAfterMs("Sat, 03 Oct 2026 11:59:00 GMT", now)).toBe(0);
  });

  it("reads fractional seconds to the millisecond, as the LLM chain did", () => {
    expect(retryAfterMs(" 1.5 ")).toBe(1500);
    expect(retryAfterMs("0.0004")).toBe(0);
  });

  it("returns undefined for missing, blank or unreadable headers", () => {
    expect(retryAfterMs(null)).toBeUndefined();
    expect(retryAfterMs("")).toBeUndefined();
    expect(retryAfterMs("   ")).toBeUndefined();
    expect(retryAfterMs("soon")).toBeUndefined();
  });
});

describe("FinchNodeClient.getHealthRecord", () => {
  it("requests the recorded path and parses the snapshot", async () => {
    const recorded = loadRecorded("records/patient-demo-polypharmacy");
    const fetchImpl = replayFetch(recorded);
    const { client } = clientWith(fetchImpl);

    const record = await client.getHealthRecord("patient-demo-polypharmacy");

    expect(fetchImpl.calls).toEqual([`${BASE}${recorded.request.path}`]);
    expect(record.id).toBe("patient-demo-polypharmacy");
    expect(record.object).toBe("health_record");
    expect(record.data.medications).toHaveLength(14);
  });

  it("sends the bearer key and Accept header", async () => {
    const seen: Headers[] = [];
    const recorded = loadRecorded("records/patient-demo-sparse");
    const inner = replayFetch(recorded);
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      seen.push(new Headers(init?.headers));
      return inner(input, init);
    }) as typeof fetch;
    const client = new FinchNodeClient({ baseUrl: BASE, apiKey: "ck_test_fake", fetch: fetchImpl });

    await client.getHealthRecord("patient-demo-sparse");

    expect(seen[0]?.get("authorization")).toBe("Bearer ck_test_fake");
    expect(seen[0]?.get("accept")).toBe("application/json");
  });

  it("omits Authorization when no key is set (demo API)", async () => {
    const seen: Headers[] = [];
    const inner = replayFetch(loadRecorded("records/patient-demo-sparse"));
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      seen.push(new Headers(init?.headers));
      return inner(input, init);
    }) as typeof fetch;
    const client = new FinchNodeClient({ baseUrl: BASE, apiKey: "", fetch: fetchImpl });

    await client.getHealthRecord("patient-demo-sparse");

    expect(seen[0]?.has("authorization")).toBe(false);
  });
});

describe("scenario: rate-limited", () => {
  const tooMany = loadRecorded("records/patient-demo-rate-limited.429");
  const ok = loadRecorded("records/patient-demo-rate-limited");

  it("the recorded 429 carries Retry-After", () => {
    expect(tooMany.status).toBe(429);
    expect(tooMany.headers["retry-after"]).toBe("1");
  });

  it("retries after the Retry-After delay, then returns the snapshot", async () => {
    const fetchImpl = replayFetch(tooMany, ok);
    const { client, sleeps } = clientWith(fetchImpl);

    const record = await client.getHealthRecord("patient-demo-rate-limited");

    expect(record.id).toBe("patient-demo-rate-limited");
    expect(fetchImpl.calls).toHaveLength(2);
    expect(sleeps).toEqual([1000]);
  });

  it("caps attempts and throws RateLimitedError when every response is 429", async () => {
    const fetchImpl = replayFetch(tooMany, tooMany, tooMany, tooMany, tooMany);
    const { client, sleeps } = clientWith(fetchImpl);

    const error = await client.getHealthRecord("patient-demo-rate-limited").catch((e: unknown) => e);

    expect(error).toBeInstanceOf(RateLimitedError);
    expect(error).toMatchObject({ status: 429, code: "rate_limited", requestId: "demo_req_aONFvzIABuGk" });
    // Default maxRetries is 3: one first try plus three retries.
    expect(fetchImpl.calls).toHaveLength(4);
    expect(sleeps).toEqual([1000, 1000, 1000]);
  });

  it("honors a custom maxRetries", async () => {
    const fetchImpl = replayFetch(tooMany, tooMany);
    const { client, sleeps } = clientWith(fetchImpl, { maxRetries: 1 });

    await expect(client.getHealthRecord("patient-demo-rate-limited")).rejects.toBeInstanceOf(RateLimitedError);
    expect(fetchImpl.calls).toHaveLength(2);
    expect(sleeps).toEqual([1000]);
  });

  it("caps a long Retry-After at maxRetryDelayMs", async () => {
    const slow: RecordedResponse = { ...tooMany, headers: { ...tooMany.headers, "retry-after": "600" } };
    const fetchImpl = replayFetch(slow, ok);
    const { client, sleeps } = clientWith(fetchImpl, { maxRetryDelayMs: 5000 });

    await client.getHealthRecord("patient-demo-rate-limited");
    expect(sleeps).toEqual([5000]);
  });

  it("backs off exponentially when Retry-After is missing", async () => {
    const bare = recordedError(429, "rate_limited");
    const fetchImpl = replayFetch(bare, bare, bare, ok);
    const { client, sleeps } = clientWith(fetchImpl);

    await client.getHealthRecord("patient-demo-rate-limited");
    expect(sleeps).toEqual([1000, 2000, 4000]);
  });
});

describe("scenario: consent-revoked", () => {
  it("410 becomes ConsentInactiveError with code consent_inactive, without retrying", async () => {
    const fetchImpl = replayFetch(loadRecorded("records/patient-demo-consent-revoked"));
    const { client, sleeps } = clientWith(fetchImpl);

    const error = await client.getHealthRecord("patient-demo-consent-revoked").catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ConsentInactiveError);
    expect(error).toBeInstanceOf(FinchNodeError);
    expect(error).toMatchObject({ status: 410, code: "consent_inactive", requestId: "demo_req_Q9ByuBZ2HI09" });
    expect(fetchImpl.calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });
});

describe("scenario: consent-partial", () => {
  it("asking for labs sends ?categories=labs and gets ConsentScopeError", async () => {
    const recorded = loadRecorded("records/patient-demo-consent-partial.labs");
    const fetchImpl = replayFetch(recorded);
    const { client } = clientWith(fetchImpl);

    const error = await client
      .getHealthRecord("patient-demo-consent-partial", { categories: ["labs"] })
      .catch((e: unknown) => e);

    expect(fetchImpl.calls).toEqual([`${BASE}${recorded.request.path}`]);
    expect(error).toBeInstanceOf(ConsentScopeError);
    expect(error).toMatchObject({ status: 403, code: "consent_scope_exceeded" });
  });

  it("without categories, the snapshot only holds the shared categories", async () => {
    const fetchImpl = replayFetch(loadRecorded("records/patient-demo-consent-partial"));
    const { client } = clientWith(fetchImpl);

    const record = await client.getHealthRecord("patient-demo-consent-partial");

    expect(record.consent?.receipts.flatMap((r) => r.categories)).toEqual(["medications", "allergies"]);
    expect(record.meta.availableCategories).toEqual(["medications", "allergies"]);
    expect(record.data.labs).toEqual([]);
  });

  it("a 403 that is not a scope error stays a plain FinchNodeError", async () => {
    const fetchImpl = replayFetch(recordedError(403, "forbidden"));
    const { client } = clientWith(fetchImpl);

    const error = await client.getHealthRecord("anyone").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FinchNodeError);
    expect(error).not.toBeInstanceOf(ConsentScopeError);
    expect(error).toMatchObject({ status: 403, code: "forbidden" });
  });
});

describe("other errors", () => {
  it("404 becomes SubjectNotFoundError", async () => {
    const { client } = clientWith(replayFetch(recordedError(404, "subject_not_found")));
    await expect(client.getHealthRecord("patient-demo-nobody")).rejects.toBeInstanceOf(SubjectNotFoundError);
  });

  it("a non-JSON error body keeps a status-based code", async () => {
    const fetchImpl = (async () => new Response("upstream exploded", { status: 502, statusText: "Bad Gateway" })) as unknown as typeof fetch;
    const { client } = clientWith(fetchImpl);

    const error = await client.getHealthRecord("anyone").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FinchNodeError);
    expect(error).toMatchObject({ status: 502, code: "http_502", message: "Bad Gateway" });
  });
});

describe("listScenarios", () => {
  it("parses the recorded scenario list", async () => {
    const fetchImpl = replayFetch(loadRecorded("scenarios"));
    const { client } = clientWith(fetchImpl);

    const list = await client.listScenarios();

    expect(fetchImpl.calls).toEqual([`${BASE}/scenarios`]);
    const byId = new Map(list.data.map((s) => [s.id, s]));
    expect(byId.get("polypharmacy-senior")?.subject).toBe("patient-demo-polypharmacy");
    expect(byId.get("rate-limited")?.kind).toBe("behavior");
    expect(byId.get("connect-failed")?.kind).toBe("session");
  });
});

describe("connect sessions", () => {
  it("connect-cancelled maps to canceled", () => {
    const session = normalizeConnectSession(loadRecorded("connect/connect-cancelled").body);
    expect(session).toMatchObject({ status: "canceled", subject: undefined, failureCode: undefined });
    expect(session.url).toBe("https://finchnode.com/tools/finchnode-visualizer");
  });

  it("connect-failed maps to failed with failureCode source_unavailable", () => {
    const session = normalizeConnectSession(loadRecorded("connect/connect-failed").body);
    expect(session).toMatchObject({ status: "failed", subject: undefined, failureCode: "source_unavailable" });
  });

  it("polypharmacy-senior maps to completed with Harriet's subject", () => {
    const session = normalizeConnectSession(loadRecorded("connect/polypharmacy-senior").body);
    expect(session).toMatchObject({
      id: "demo_cs_4L7K0QeAPddQ",
      status: "completed",
      subject: "patient-demo-polypharmacy",
      failureCode: undefined,
    });
  });

  it("reads the sandbox spelling too", () => {
    const session = normalizeConnectSession({
      id: "cs_1",
      status: "canceled",
      subject: "u_0123456789abcdef",
      failureCode: "user_closed",
      url: "https://connect.example/cs_1",
    });
    expect(session).toEqual({
      id: "cs_1",
      status: "canceled",
      subject: "u_0123456789abcdef",
      failureCode: "user_closed",
      url: "https://connect.example/cs_1",
    });
  });

  it("an unknown status is pending", () => {
    expect(normalizeConnectSession({ id: "cs_2", status: "awaiting_user" }).status).toBe("pending");
  });

  it("createConnectSession posts the recorded body and normalizes the 201", async () => {
    const recorded = loadRecorded("connect/connect-failed");
    const posted: { url: string; method: string | undefined; body: unknown }[] = [];
    const inner = replayFetch(recorded);
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      posted.push({ url: String(input), method: init?.method, body: JSON.parse(String(init?.body)) });
      return inner(input, init);
    }) as typeof fetch;
    const client = new FinchNodeClient({ baseUrl: BASE, fetch: fetchImpl });

    const session = await client.createConnectSession({ externalUserId: "fixture-user", scenario: "connect-failed" });

    expect(posted).toEqual([{ url: `${BASE}/connect/sessions`, method: "POST", body: recorded.request.body }]);
    expect(session.status).toBe("failed");
    expect(session.failureCode).toBe("source_unavailable");
  });
});
