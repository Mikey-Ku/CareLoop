import { describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { checkDemoSetup, supportsNode } from "../src/demo/preflight.ts";
import { main } from "../src/cli/demo-check.ts";
const configured = { RELAY_AGENT_TOKEN: "synthetic-relay-secret", PATIENT_RELAY_HANDLE: "synthetic-patient", GEMINI_API_KEY: "synthetic-gemini-secret", ELEVENLABS_API_KEY: "synthetic-voice-secret", ELEVENLABS_VOICE_ID: "synthetic-voice-id", PRESAGE_API_KEY: "synthetic-camera-secret", FAMILY_RELAY_HANDLES: "synthetic-family", FINCHNODE_API_KEY: "synthetic-record-secret" };
const options = { nodeVersion: "22.22.3" };
describe("offline demo setup", () => {
  it("reports missing mandatory credentials", () => { const r = checkDemoSetup({}, options); expect(r.status).toBe("missing"); expect(r.exitCode).toBe(1); expect(r.lines.join("\n")).toContain("Set GEMINI_API_KEY"); });
  it("reports presence without printing secrets or handles", () => { const r = checkDemoSetup(configured, options); expect(r.status).toBe("ready"); expect(r.exitCode).toBe(0); for (const v of Object.values(configured)) expect(r.lines.join("\n")).not.toContain(v); expect(r.lines.join("\n")).toContain("not authenticated"); });
  it("distinguishes optional setup", () => { const r = checkDemoSetup({ ...configured, PRESAGE_API_KEY: undefined, FAMILY_RELAY_HANDLES: undefined, FINCHNODE_API_KEY: undefined }, options); expect(r.status).toBe("degraded"); expect(r.exitCode).toBe(2); expect(r.lines.join("\n")).toContain("Camera estimation disabled"); });
  it("says the FinchNode demo API needs no key, and asks for one only on another endpoint", () => { const demo = checkDemoSetup({ ...configured, FINCHNODE_API_KEY: undefined }, options).lines.join("\n"); expect(demo).toContain("the demo API is open and needs no key"); const other = checkDemoSetup({ ...configured, FINCHNODE_API_KEY: undefined, FINCHNODE_BASE_URL: "https://finchnode.example.test/v1" }, options).lines.join("\n"); expect(other).toContain("set it if this endpoint is authenticated"); });
  it("sanitizes invalid config", () => { const r = checkDemoSetup({ ...configured, PATIENT_TIMEZONE: "private-invalid-value" }, options); expect(r.status).toBe("missing"); expect(r.lines.join("\n")).not.toContain("private-invalid-value"); });
  it("fails missing assets/runtime", () => { expect(checkDemoSetup(configured, { ...options, fixturesDir: "/nonexistent/synthetic-fixtures" }).status).toBe("missing"); expect(checkDemoSetup(configured, { nodeVersion: "22.21.0" }).status).toBe("missing"); });
  it("rejects live flags", () => { const output: string[] = []; expect(main(configured, (l) => output.push(l), options, ["--live"])).toBe(1); expect(output.join("\n")).toContain("offline only"); });
  it("reports missing, malformed and invalid package metadata without throwing or exposing paths", () => {
    const directory = mkdtempSync(join(tmpdir(), "preflight-metadata-"));
    const packagePath = join(directory, "private-metadata.json");
    try {
      for (const contents of [undefined, "{malformed", "null", '{}', '{"engines":{"node":22}}']) {
        if (contents !== undefined) writeFileSync(packagePath, contents);
        const report = checkDemoSetup(configured, { ...options, packagePath });
        expect(report.status).toBe("missing");
        expect(report.exitCode).toBe(1);
        expect(report.lines.join("\n")).toContain("metadata is missing or invalid");
        expect(report.lines.join("\n")).not.toContain(packagePath);
      }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
  it("fails a required key that is still a placeholder, without printing it", () => {
    const names = ["RELAY_AGENT_TOKEN", "PATIENT_RELAY_HANDLE", "GEMINI_API_KEY", "ELEVENLABS_API_KEY", "ELEVENLABS_VOICE_ID"];
    for (const value of ["your_api_key_here", "YourKey", "changeme", "change_me", "xxxx", "TODO", "example-key", "placeholder", "<paste the key>", "key>", "\"\"", "''", "..."]) {
      for (const name of names) {
        const r = checkDemoSetup({ ...configured, [name]: value }, options);
        expect([name, value, r.exitCode]).toEqual([name, value, 1]);
        expect(r.lines).toContain(`[missing] ${name} looks like a placeholder; put the real value in the repo-root .env`);
        expect(r.lines.join("\n")).not.toContain(`${name} is configured`);
      }
    }
    expect(checkDemoSetup({ ...configured, GEMINI_API_KEY: "your_secret_value_1" }, options).lines.join("\n")).not.toContain("your_secret_value_1");
  });
  it("does not take a real-looking value for a placeholder", () => {
    const real = { ...configured, GEMINI_API_KEY: "AIzaSy-my-example-key", ELEVENLABS_VOICE_ID: "21m00Tcm4TlvDq8ikWAM", PATIENT_RELAY_HANDLE: "harriet_demo" };
    expect(checkDemoSetup(real, options).exitCode).toBe(0);
  });
  it("makes a placeholder in an optional key an optional note, not a configured key", () => {
    for (const [name, value, note, configuredLine] of [["PRESAGE_API_KEY", "xxxxxxxx", "PRESAGE_API_KEY looks like a placeholder", "Camera estimation enabled"], ["FAMILY_RELAY_HANDLES", "<sarah>", "FAMILY_RELAY_HANDLES looks like a placeholder", "Family delivery handles are configured"], ["FINCHNODE_API_KEY", "your_key", "FINCHNODE_API_KEY looks like a placeholder", "FINCHNODE_API_KEY is configured"]] as const) {
      const r = checkDemoSetup({ ...configured, [name]: value }, options);
      expect([name, r.status, r.exitCode]).toEqual([name, "degraded", 2]);
      expect(r.lines.some((l) => l.startsWith("[optional]") && l.includes(note))).toBe(true);
      expect(r.lines.join("\n")).not.toContain(configuredLine);
    }
  });
  it("notes a pinned CLOCK_DATE as optional, and says nothing when it is unset or empty", () => {
    const pinned = checkDemoSetup({ ...configured, CLOCK_DATE: "2026-09-01" }, options);
    expect([pinned.status, pinned.exitCode]).toEqual(["degraded", 2]);
    expect(pinned.lines.find((l) => l.includes("CLOCK_DATE"))).toMatch(/^\[optional\] CLOCK_DATE pins the demo day; a fresh database on the same day makes Relay refuse repeated message keys, so use a new date for each fresh database or leave CLOCK_DATE empty$/);
    for (const clockDate of [undefined, ""]) expect(checkDemoSetup({ ...configured, CLOCK_DATE: clockDate }, options).lines.join("\n")).not.toContain("CLOCK_DATE");
  });
  it("lists voice:check with the other live checks", () => { const lines = checkDemoSetup(configured, options).lines; expect(lines.filter((l) => /npm run (relay|llm|voice):check/.test(l)).map((l) => l.trim().split(" ")[2])).toEqual(["relay:check", "llm:check", "voice:check"]); });
  describe("the .env file", () => {
    const withEnvFile = (contents: string, mode: number, check: (envFile: string) => void) => {
      const directory = mkdtempSync(join(tmpdir(), "preflight-env-"));
      const envFile = join(directory, ".env");
      try { writeFileSync(envFile, contents); chmodSync(envFile, mode); check(envFile); } finally { rmSync(directory, { recursive: true, force: true }); }
    };
    const known = "RELAY_AGENT_TOKEN=a-secret\nELEVENLABS_API_KEY=b-secret\n# comment\n\nPORT=3000\n";
    const optionalLines = (envFile: string) => checkDemoSetup(configured, { ...options, envFile }).lines.filter((l) => l.startsWith("[optional] .env"));
    it("recommends chmod 600 when group or other can read it, and not when only the owner can", () => {
      for (const mode of [0o644, 0o640, 0o604, 0o660, 0o666]) withEnvFile(known, mode, (envFile) => {
        const r = checkDemoSetup(configured, { ...options, envFile });
        expect([r.status, r.exitCode]).toEqual(["degraded", 2]);
        expect(optionalLines(envFile)).toEqual([`[optional] .env can be read by other users on this computer (mode ${mode.toString(8)}); from apps/server run chmod 600 ../../.env`]);
      });
      for (const mode of [0o600, 0o400]) withEnvFile(known, mode, (envFile) => { expect(optionalLines(envFile)).toEqual([]); expect(checkDemoSetup(configured, { ...options, envFile }).exitCode).toBe(0); });
    });
    it("lists names nothing reads, as one line, never their values", () => {
      const contents = `${known}ELEVENLABS_API_KY=typo-secret-1\nexport GEMINI_API_KY = typo-secret-2\nelevenlabs_api_key=typo-secret-3\nELEVENLABS_API_KY=again\n#ELEVENLABS_VOICE_IDD=commented\nNO_COLOR=1\nFOLLOW_UP_DELAY_MINUTES=2\n`;
      withEnvFile(contents, 0o600, (envFile) => {
        expect(optionalLines(envFile)).toEqual([".env sets names nothing reads (typos?): ELEVENLABS_API_KY, GEMINI_API_KY, elevenlabs_api_key"].map((l) => `[optional] ${l}`));
        const r = checkDemoSetup(configured, { ...options, envFile });
        expect(r.exitCode).toBe(2);
        expect(r.lines.join("\n")).not.toMatch(/typo-secret|again|commented/);
      });
    });
    it("checks nothing when the file is absent or no path is given, and the command passes the path on", () => {
      expect(optionalLines(join(tmpdir(), "no-such-dir", ".env"))).toEqual([]);
      withEnvFile("TYPO_NAME=x\n", 0o644, (envFile) => {
        expect(checkDemoSetup(configured, options).exitCode).toBe(0);
        const output: string[] = [];
        expect(main(configured, (l) => output.push(l), { ...options, envFile }, [])).toBe(2);
        expect(output.join("\n")).toContain("chmod 600");
        expect(output.join("\n")).toContain("TYPO_NAME");
      });
    });
  });
  it("orders runtime versions numerically", () => { expect(supportsNode("24.0.0", ">=22.22.3")).toBe(true); expect(supportsNode("22.22.2", ">=22.22.3")).toBe(false); expect(supportsNode("22.22.3-rc.1", ">=22.22.3")).toBe(false); expect(supportsNode("22.22.3", "^22")).toBe(false); });
});
