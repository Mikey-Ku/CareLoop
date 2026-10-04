import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../config.ts";
import { FIXTURES_DIR, REPO_ROOT, loadSnapshot, loadRxNavCache } from "../finchnode/fixtures.ts";

export type Readiness = "ready" | "degraded" | "missing";
export type PreflightResult = { status: Readiness; exitCode: number; lines: string[] };
export type PreflightOptions = { nodeVersion?: string; fixturesDir?: string; engine?: string; packagePath?: string };

/** Presence and local assets only: never authenticates, sends messages, or opens a database. */
export function checkDemoSetup(env: Record<string, string | undefined>, options: PreflightOptions = {}): PreflightResult {
  const lines: string[] = [];
  let missing = false;
  let degraded = false;
  const fail = (text: string) => { missing = true; lines.push(`[missing] ${text}`); };
  const optional = (text: string) => { degraded = true; lines.push(`[optional] ${text}`); };
  const ok = (text: string) => lines.push(`[ok] ${text}`);
  const version = options.nodeVersion ?? process.versions.node;
  let engine: string;
  try {
    if (options.engine !== undefined) engine = options.engine;
    else {
      const metadata: unknown = JSON.parse(readFileSync(options.packagePath ?? join(REPO_ROOT, "apps/server/package.json"), "utf8"));
      if (typeof metadata !== "object" || metadata === null || !("engines" in metadata)) throw new Error("invalid metadata");
      const engines = metadata.engines;
      if (typeof engines !== "object" || engines === null || !("node" in engines) || typeof engines.node !== "string") throw new Error("invalid engine");
      engine = engines.node;
    }
  } catch {
    fail("Server package metadata is missing or invalid; restore apps/server/package.json");
    return result();
  }
  if (supportsNode(version, engine)) ok(`Node ${version} meets ${engine}`);
  else fail(`Node must satisfy ${engine}; install a supported Node version before running the demo`);

  let config;
  try { config = loadConfig(env); }
  catch {
    // Config errors may contain non-secret values such as a timezone. Keep this report value-free.
    fail("Configuration is invalid; check variable formats against .env.example and README.md");
    return result();
  }
  ok("Configuration parses");
  for (const [name, present] of [
    ["RELAY_AGENT_TOKEN", config.relay.agentToken],
    ["PATIENT_RELAY_HANDLE", config.patient.relayHandle],
    ["GEMINI_API_KEY", config.llm.geminiApiKey],
    ["ELEVENLABS_API_KEY", config.calls.elevenLabsApiKey],
    ["ELEVENLABS_VOICE_ID", config.calls.elevenLabsVoiceId],
  ] as const) {
    if (present) ok(`${name} is configured (not authenticated)`);
    else fail(`Set ${name} in the repo-root .env for the full voice demo`);
  }
  if (config.calls.presageApiKey) ok("Camera estimation enabled; PRESAGE_API_KEY is configured (not authenticated)");
  else optional("Camera estimation disabled: set PRESAGE_API_KEY to demonstrate camera readings; voice remains available");
  if (config.patient.familyHandles.length) ok("Family delivery handles are configured (not printed)");
  else optional("FAMILY_RELAY_HANDLES is empty; family updates will not be delivered");
  if (config.finchnode.apiKey?.trim()) ok("FINCHNODE_API_KEY is configured (not authenticated)");
  else optional("FINCHNODE_API_KEY is absent; use recorded synthetic data or verify the configured demo endpoint allows anonymous reads");

  const fixtures = options.fixturesDir ?? FIXTURES_DIR;
  for (const relative of ["finchnode/records/patient-demo-polypharmacy.json", "rxnav-cache.json", "labels/apixaban-5mg.png", "labels/apixaban-2-5mg.png", "labels/metformin-500mg.png", "labels/ibuprofen-200mg.png"]) {
    if (!existsSync(join(fixtures, relative))) fail(`Restore synthetic fixture: fixtures/${relative}`);
  }
  if (!options.fixturesDir) {
    try { loadSnapshot("patient-demo-polypharmacy"); loadRxNavCache(); ok("Synthetic record and medication cache parse"); }
    catch { fail("Restore valid synthetic record and medication cache fixtures"); }
  }
  lines.push("Live follow-up (explicit, separate commands from apps/server):",
    "  npm run relay:check — provider reads only; may migrate an existing local database and print configured handles",
    "  npm run llm:check — sends synthetic text and label fixtures to Gemini; consumes API quota",
    "  npm run content:eval — synthetic conversation evaluation; consumes API quota and overwrites docs/content-eval.md",
    "Voice and camera still require an authorized synthetic phone rehearsal; no live call is started by this check.");
  return result();

  function result(): PreflightResult {
    const status = missing ? "missing" : degraded ? "degraded" : "ready";
    return { status, exitCode: missing ? 1 : degraded ? 2 : 0, lines };
  }
}

/** Current package engine is a minimum version; reject unknown ranges instead of guessing. */
export function supportsNode(version: string, engine: string): boolean {
  const minimum = /^>=(\d+)\.(\d+)\.(\d+)$/.exec(engine);
  const actual = /^(\d+)\.(\d+)\.(\d+)(?:$|-)/.exec(version);
  if (!minimum || !actual || version.includes("-")) return false;
  for (let index = 1; index <= 3; index++) {
    const difference = Number(actual[index]) - Number(minimum[index]);
    if (difference) return difference > 0;
  }
  return true;
}
