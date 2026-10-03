import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp, SERVICE_NAME } from "../src/app.ts";

let server: Server;
let base: string;

beforeAll(async () => {
  const app = createApp({
    config: { finchnode: { baseUrl: "https://api.finchnode.com/demo/v1", apiKey: "ck_test_secret" } },
    logError: () => {},
  });
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("GET /health", () => {
  it("returns ok, the service name and the FinchNode host only", async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, service: SERVICE_NAME, finchnode: "api.finchnode.com" });
    expect(JSON.stringify(body)).not.toContain("ck_test_");
  });
});

describe("/webhooks/relay", () => {
  it("returns 501 for a JSON body", async () => {
    const res = await fetch(`${base}/webhooks/relay`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "message.created" }),
    });
    expect(res.status).toBe(501);
    expect(await res.json()).toMatchObject({ error: "not_implemented" });
  });

  it("accepts a non-JSON body without a parse error", async () => {
    const res = await fetch(`${base}/webhooks/relay`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "{not json",
    });
    expect(res.status).toBe(501);
  });

  it("accepts malformed JSON labelled as JSON, since the body stays raw", async () => {
    const res = await fetch(`${base}/webhooks/relay`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(501);
  });
});

describe("error handler", () => {
  it("answers a body-parser error with JSON and no stack trace", async () => {
    const res = await fetch(`${base}/webhooks/relay`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: new Uint8Array(1024 * 1024 + 1),
    });
    expect(res.status).toBe(413);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: "bad_request" });
    expect(text).not.toMatch(/at .*\.(ts|js)/);
  });
});

describe("unknown routes", () => {
  it("return a JSON 404", async () => {
    const res = await fetch(`${base}/nope`);
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
    expect(await res.json()).toEqual({ error: "not_found" });
  });
});
