import { readdirSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, resolveCheckinDate } from "../config.ts";
import { buildContextPacket } from "../context/packet.ts";
import { ConsentInactiveError, FinchNodeClient, FinchNodeError, SubjectNotFoundError } from "../finchnode/client.ts";
import { FIXTURES_DIR, hasRecordedSnapshot, loadRecorded, loadRxNavCache, replayFetch } from "../finchnode/fixtures.ts";
import { normalizeHealthRecord } from "../finchnode/normalize.ts";
import type { HealthRecord } from "../finchnode/types.ts";
import { runRules } from "../rules/index.ts";

// npm run packet -- <subject> [--live]
// Prints the context packet for one FinchNode subject as JSON. Offline by
// default: replays the recorded fixture through the real client, so errors such
// as consent-revoked behave exactly as they would live.

const USAGE = "usage: npm run packet -- <subject> [--live]";

function recordedSubjects(): string[] {
  return readdirSync(join(FIXTURES_DIR, "finchnode", "records"))
    .filter((f) => /^[^.]+\.json$/.test(f))
    .map((f) => f.replace(/\.json$/, ""))
    .sort();
}

async function fetchRecord(subject: string, live: boolean, baseUrl: string, apiKey: string | undefined): Promise<HealthRecord> {
  if (live) return new FinchNodeClient({ baseUrl, apiKey }).getHealthRecord(subject);
  if (!hasRecordedSnapshot(subject)) {
    throw new UsageError(`no recorded fixture for "${subject}". Recorded: ${recordedSubjects().join(", ")}. Use --live to ask FinchNode.`);
  }
  const client = new FinchNodeClient({ baseUrl, fetch: replayFetch(loadRecorded(`records/${subject}`)), maxRetries: 0 });
  return client.getHealthRecord(subject);
}

class UsageError extends Error {}

async function main(argv: string[]): Promise<number> {
  const live = argv.includes("--live");
  const positional = argv.filter((a) => !a.startsWith("--"));
  const subject = positional[0];
  if (!subject || positional.length > 1 || argv.some((a) => a.startsWith("--") && a !== "--live")) {
    console.error(USAGE);
    return 2;
  }

  const config = loadConfig();
  try {
    const raw = await fetchRecord(subject, live, config.finchnode.baseUrl, config.finchnode.apiKey);
    const record = normalizeHealthRecord(raw, { rxnav: loadRxNavCache() });
    const checkinDate = resolveCheckinDate(config.clockDate, record.dataAsOf);
    const packet = buildContextPacket({ record, ruleResults: runRules({ record, checkinDate }), checkinDate });
    console.log(JSON.stringify(packet, null, 2));
    return 0;
  } catch (error) {
    if (error instanceof ConsentInactiveError) {
      console.error(`error: record consent for "${subject}" is no longer active (410 ${error.code}); stop reading this subject.`);
    } else if (error instanceof SubjectNotFoundError) {
      console.error(`error: FinchNode has no subject "${subject}" (404 ${error.code}).`);
    } else if (error instanceof FinchNodeError) {
      console.error(`error: FinchNode returned ${error.status} ${error.code} for "${subject}": ${error.message}`);
    } else if (error instanceof UsageError) {
      console.error(`error: ${error.message}`);
    } else {
      throw error;
    }
    return 1;
  }
}

process.exitCode = await main(process.argv.slice(2));
