import { parseArgs } from "node:util";
import { runCameraCallback } from "../calls/camera-callback.ts";
import { loadConfig } from "../config.ts";
import { openDatabase } from "../db/index.ts";
import { createRelayClient } from "../relay/relay-client.ts";
import { onDay } from "../scheduler.ts";

// npm run camera:check -- [--patient id] [--db path]
// The camera check call-back on demand: texts her, calls her phone through the Python recorder
// (apps/camera-check; set it up once with `uv sync --project ../camera-check`), reads the recording with
// Presage and texts her the result. Needs RELAY_AGENT_TOKEN and PRESAGE_API_KEY. Stop the agent's own
// camera work first: two calls at once would compete for her phone.

const USAGE = "usage: npm run camera:check -- [--patient id] [--db path]";

export async function main(argv: string[]): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({ args: argv, options: { patient: { type: "string" }, db: { type: "string" }, help: { type: "boolean", short: "h", default: false } } }));
  } catch (error) {
    console.error(`error: ${error instanceof Error ? error.message : String(error)}\n${USAGE}`);
    return 2;
  }
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  const config = loadConfig();
  const token = config.relay.agentToken;
  const presageApiKey = config.calls.presageApiKey;
  if (!token || !presageApiKey) {
    console.error("error: RELAY_AGENT_TOKEN and PRESAGE_API_KEY must be set in .env");
    return 2;
  }
  const db = openDatabase(values.db ?? config.databasePath);
  try {
    const rows = db.prepare("SELECT id, relay_handle AS handle, relay_chat_id AS chatId FROM patients ORDER BY id").all() as { id: string; handle: string | null; chatId: string | null }[];
    const patient = values.patient ? rows.find((r) => r.id === values.patient) : rows.length === 1 ? rows[0] : undefined;
    if (!patient?.handle || !patient.chatId) {
      console.error(rows.length === 0 ? "error: no patients in the database yet" : "error: pick a linked patient with --patient (her Relay chat must be linked)");
      return 2;
    }
    const relay = createRelayClient({ agentToken: token, apiUrl: config.relay.apiUrl });
    const outcome = await runCameraCallback(
      {
        db,
        send: async (chatId, text, key) => {
          await relay.chats.messages.send(chatId, { message: { parts: [{ type: "text", value: text }], idempotency_key: key } });
        },
        minConfidence: config.calls.vitalsMinConfidence,
        presageApiKey,
        // With CLOCK_DATE (demos) the reading lands on the pinned day, as the agent's records do.
        now: () => (config.clockDate ? onDay(config.clockDate, new Date(), config.patient.timezone) : new Date()).toISOString(),
        log: (event, fields) => console.log(`[camera-check] ${event}${fields ? ` ${JSON.stringify(fields)}` : ""}`),
      },
      { id: patient.id, chatId: patient.chatId, handle: patient.handle },
    );
    console.log(`camera check: ${outcome}`);
    return outcome === "reading" ? 0 : 1;
  } finally {
    db.close();
  }
}

process.exitCode = await main(process.argv.slice(2));
