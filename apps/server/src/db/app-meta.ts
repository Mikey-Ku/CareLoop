import { randomBytes } from "node:crypto";
import type { Db } from "./index.ts";

// Facts about this database itself (migration 15). Today one: its instance id.

/**
 * This database's random id (11 URL-safe characters): made on first use, the same every time after,
 * and different for every new database. The Relay adapter mixes it into message idempotency keys
 * (src/relay/relay-messenger.ts).
 */
export function getInstanceId(db: Db): string {
  const read = () => (db.prepare(`SELECT value FROM app_meta WHERE key = 'instance_id'`).get() as { value: string } | undefined)?.value;
  const existing = read();
  if (existing) return existing;
  // OR IGNORE: if another process made one first, theirs stays and we read it back.
  db.prepare(`INSERT OR IGNORE INTO app_meta (key, value) VALUES ('instance_id', ?)`).run(randomBytes(8).toString("base64url"));
  return read()!;
}
