import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ConfigError, loadConfig, type Config } from "../config.ts";
import { openDatabase, type Db } from "../db/index.ts";
import { assertNoWebhookSubscriptions } from "../relay/inbox.ts";
import { createRelayClient, sameHandle, verifyRelayAccess, type RelayClient } from "../relay/relay-client.ts";

// `npm run relay:check`: is this laptop ready to run `npm run agent`? Checks the
// Agent Token, the zero-webhook rule for WebSocket delivery, and whether the
// senior and each family member have messaged the agent. There is no family
// group (a Relay chat holds at most one person): each family member's own direct
// chat with the agent is their family chat, and it exists once they message it.
// Read-only: it never creates, deletes or sends anything.

type Status = "ok" | "todo" | "fail";
export type CheckLine = { status: Status; text: string };

const MARK: Record<Status, string> = { ok: "[ok]  ", todo: "[todo]", fail: "[FAIL]" };

export type RelayCheckDeps = {
  config: Config;
  relay: RelayClient;
  /** The app database, if it exists yet. */
  db?: Db | undefined;
};

/** Run every check. Never throws; failures become lines. */
export async function runRelayCheck(deps: RelayCheckDeps): Promise<CheckLine[]> {
  const { config, relay, db } = deps;
  const { relayHandle, familyHandles, finchnodeSubject } = config.patient;
  const lines: CheckLine[] = [];
  const add = (status: Status, text: string) => lines.push({ status, text });

  try {
    const access = await verifyRelayAccess(relay);
    add("ok", `Agent Token works: agent @${access.agentHandle}${access.ownerHandle ? `, owned by @${access.ownerHandle}` : ""} (${config.relay.apiUrl})`);
  } catch (error) {
    add("fail", `Agent Token: ${messageOf(error)}`);
    return lines; // Nothing else can be checked without a working token.
  }

  try {
    await assertNoWebhookSubscriptions(relay);
    add("ok", "No webhook subscriptions, so Relay delivers over the WebSocket");
  } catch (error) {
    add("fail", messageOf(error));
  }

  // Who has a direct chat with the agent (they wrote to it first, so it can message them).
  let directChats: { id: string; handles: string[] }[] = [];
  try {
    const page = await relay.chats.listChats({ limit: 100 });
    for await (const chat of page) {
      if (!chat.is_group) directChats.push({ id: chat.id, handles: chat.handles.filter((h) => h.kind === "user").map((h) => h.handle) });
    }
  } catch (error) {
    add("fail", `Listing the agent's chats: ${messageOf(error)}`);
    directChats = [];
  }
  const chatWith = (handle: string) => directChats.find((c) => c.handles.some((h) => sameHandle(h, handle)));

  const patient = db
    ? (db.prepare(`SELECT id, relay_chat_id AS relayChatId FROM patients WHERE finchnode_patient_id = ?`).get(finchnodeSubject) as
        | { id: string; relayChatId: string | null }
        | undefined)
    : undefined;

  if (!relayHandle) {
    add("fail", "PATIENT_RELAY_HANDLE is not set in .env");
  } else {
    const chat = chatWith(relayHandle);
    if (!chat) add("todo", `Senior @${relayHandle} has not written to the agent yet: send it a message from her phone`);
    else if (patient?.relayChatId === chat.id) add("ok", `Senior @${relayHandle} is linked (chat ${chat.id})`);
    else add("todo", `Senior @${relayHandle} has written to the agent; npm run agent links her chat on start`);
  }

  // One line per family member: their family chat exists once they've messaged the agent.
  if (familyHandles.length === 0) add("todo", "FAMILY_RELAY_HANDLES is empty: no family member will get updates");
  for (const handle of familyHandles) {
    const chat = chatWith(handle);
    if (chat) add("ok", `Family @${handle} is linked (chat ${chat.id})`);
    else add("todo", `Family @${handle} hasn't messaged the agent yet: send it any message from their phone`);
  }
  return lines;
}

/** Lines naming what .env is missing before any Relay call can be made. */
export function missingSetup(config: Config): string[] {
  const missing: string[] = [];
  if (!config.relay.agentToken) missing.push("RELAY_AGENT_TOKEN (the agent's Agent Token from Relay Console)");
  if (!config.patient.relayHandle) missing.push("PATIENT_RELAY_HANDLE (the senior's Relay handle)");
  if (config.patient.familyHandles.length === 0) missing.push("FAMILY_RELAY_HANDLES (comma separated; optional, but no family updates without it)");
  return missing;
}

export function formatLine(line: CheckLine): string {
  return `${MARK[line.status]} ${line.text}`;
}

export async function main(env: Record<string, string | undefined> = process.env, out = (l: string) => console.log(l)): Promise<number> {
  let config: Config;
  try {
    config = loadConfig(env);
  } catch (error) {
    out(`error: ${error instanceof ConfigError ? error.message : messageOf(error)}`);
    return 1;
  }

  const token = config.relay.agentToken;
  if (!token) {
    out("Relay check: .env is missing:");
    for (const m of missingSetup(config)) out(`  - ${m}`);
    out('See FEEDBACK.md "Relay setup" (and README.md) for where each one comes from.');
    return 1;
  }

  const dbPath = resolve(config.databasePath);
  const db = existsSync(dbPath) ? openDatabase(dbPath) : undefined;
  try {
    const lines = await runRelayCheck({ config, relay: createRelayClient({ agentToken: token, apiUrl: config.relay.apiUrl }), db });
    out("Relay check:");
    for (const line of lines) out(formatLine(line));
    return lines.some((l) => l.status === "fail") ? 1 : 0;
  } finally {
    db?.close();
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
