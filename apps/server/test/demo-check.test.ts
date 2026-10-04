import { describe, expect, it } from "vitest";
import { checkDemoSetup, supportsNode } from "../src/demo/preflight.ts";
import { main } from "../src/cli/demo-check.ts";
const configured = { RELAY_AGENT_TOKEN: "synthetic-relay-secret", PATIENT_RELAY_HANDLE: "synthetic-patient", GEMINI_API_KEY: "synthetic-gemini-secret", ELEVENLABS_API_KEY: "synthetic-voice-secret", ELEVENLABS_VOICE_ID: "synthetic-voice-id", PRESAGE_API_KEY: "synthetic-camera-secret", FAMILY_RELAY_HANDLES: "synthetic-family", FINCHNODE_API_KEY: "synthetic-record-secret" };
const options = { nodeVersion: "22.22.3" };
describe("offline demo setup", () => {
  it("reports missing mandatory credentials", () => { const r = checkDemoSetup({}, options); expect(r.status).toBe("missing"); expect(r.exitCode).toBe(1); expect(r.lines.join("\n")).toContain("Set GEMINI_API_KEY"); });
  it("reports presence without printing secrets or handles", () => { const r = checkDemoSetup(configured, options); expect(r.status).toBe("ready"); expect(r.exitCode).toBe(0); for (const v of Object.values(configured)) expect(r.lines.join("\n")).not.toContain(v); expect(r.lines.join("\n")).toContain("not authenticated"); });
  it("distinguishes optional setup", () => { const r = checkDemoSetup({ ...configured, PRESAGE_API_KEY: undefined, FAMILY_RELAY_HANDLES: undefined, FINCHNODE_API_KEY: undefined }, options); expect(r.status).toBe("degraded"); expect(r.exitCode).toBe(2); expect(r.lines.join("\n")).toContain("Camera estimation disabled"); });
  it("sanitizes invalid config", () => { const r = checkDemoSetup({ ...configured, PATIENT_TIMEZONE: "private-invalid-value" }, options); expect(r.status).toBe("missing"); expect(r.lines.join("\n")).not.toContain("private-invalid-value"); });
  it("fails missing assets/runtime", () => { expect(checkDemoSetup(configured, { ...options, fixturesDir: "/nonexistent/synthetic-fixtures" }).status).toBe("missing"); expect(checkDemoSetup(configured, { nodeVersion: "22.21.0" }).status).toBe("missing"); });
  it("rejects live flags", () => { const output: string[] = []; expect(main(configured, (l) => output.push(l), options, ["--live"])).toBe(1); expect(output.join("\n")).toContain("offline only"); });
  it("orders runtime versions numerically", () => { expect(supportsNode("24.0.0", ">=22.22.3")).toBe(true); expect(supportsNode("22.22.2", ">=22.22.3")).toBe(false); expect(supportsNode("22.22.3-rc.1", ">=22.22.3")).toBe(false); expect(supportsNode("22.22.3", "^22")).toBe(false); });
});
