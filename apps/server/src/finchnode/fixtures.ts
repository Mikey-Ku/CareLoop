import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RxNavCache } from "./rxnav.ts";
import { HealthRecordSchema, type HealthRecord } from "./types.ts";

// Recorded FinchNode demo responses (scripts/record-fixtures.ts). Tests and the
// offline packet CLI read these instead of the live API.

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
export const FIXTURES_DIR = join(REPO_ROOT, "fixtures");

export type RecordedResponse = {
  request: { method: string; path: string; body?: unknown };
  status: number;
  headers: Record<string, string>;
  body: unknown;
};

/** `name` is relative to fixtures/finchnode without .json, e.g. "records/patient-demo-polypharmacy". */
export function loadRecorded(name: string): RecordedResponse {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, "finchnode", `${name}.json`), "utf8")) as RecordedResponse;
}

export function hasRecordedSnapshot(subject: string): boolean {
  return existsSync(join(FIXTURES_DIR, "finchnode", "records", `${subject}.json`));
}

/** A recorded 200 snapshot, parsed. Throws for subjects recorded as errors (e.g. consent-revoked). */
export function loadSnapshot(subject: string): HealthRecord {
  const recorded = loadRecorded(`records/${subject}`);
  if (recorded.status !== 200) throw new Error(`fixture for ${subject} is a ${recorded.status}, not a snapshot`);
  return HealthRecordSchema.parse(recorded.body);
}

export function loadRxNavCache(): RxNavCache {
  return RxNavCache.load(join(FIXTURES_DIR, "rxnav-cache.json"));
}

/** A fetch that replays a recorded response, for client tests. */
export function replayFetch(...responses: RecordedResponse[]): typeof fetch & { calls: string[] } {
  const queue = [...responses];
  const calls: string[] = [];
  const fn = (async (input: string | URL | Request) => {
    calls.push(String(input));
    const next = queue.shift();
    if (!next) throw new Error(`replayFetch: no recorded response left for ${String(input)}`);
    return new Response(JSON.stringify(next.body), {
      status: next.status,
      headers: { "content-type": "application/json", ...next.headers },
    });
  }) as typeof fetch & { calls: string[] };
  fn.calls = calls;
  return fn;
}
