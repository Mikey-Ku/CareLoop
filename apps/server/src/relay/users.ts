import { createHash } from "node:crypto";
import { normalizeHandle } from "../config.ts";
import { nextSyntheticProfile } from "../finchnode/demo-profiles.ts";
import { upsertPatient, type Db } from "../db/index.ts";

export type DemoUserOptions = {
  chatId: string;
  handle: string;
  displayName?: string | null;
  checkinTime: string;
  timezone: string;
};

export type DemoUserResult = {
  patientId: string;
  created: boolean;
  profileSubject: string;
  profileName: string;
};

function localId(handle: string, chatId: string): string {
  const key = `${normalizeHandle(handle)}\0${chatId}`;
  return `relay-${createHash("sha256").update(key).digest("hex").slice(0, 24)}`;
}

/**
 * Resolve a Relay person to a local account. The local id is unique per Relay chat, while the
 * FinchNode subject is deliberately reusable synthetic data. Existing configured senior rows are
 * returned unchanged.
 */
export function ensureDemoUser(db: Db, options: DemoUserOptions): DemoUserResult {
  const handle = normalizeHandle(options.handle);
  const existing = db
    .prepare(
      `SELECT id, COALESCE(finchnode_subject, finchnode_patient_id) AS profileSubject, preferred_name AS profileName
       FROM patients WHERE relay_chat_id = ? OR relay_handle = ? ORDER BY CASE WHEN relay_chat_id = ? THEN 0 ELSE 1 END LIMIT 1`,
    )
    .get(options.chatId, handle, options.chatId) as { id: string; profileSubject: string; profileName: string } | undefined;
  if (existing) {
    db.prepare(`UPDATE patients SET relay_handle = ?, relay_chat_id = ? WHERE id = ?`).run(handle, options.chatId, existing.id);
    return { patientId: existing.id, created: false, profileSubject: existing.profileSubject, profileName: existing.profileName };
  }

  const profile = nextSyntheticProfile(db);
  const patientId = localId(handle, options.chatId);
  upsertPatient(db, {
    id: patientId,
    // Keep the legacy unique field unique even when this synthetic subject is reused.
    finchnodePatientId: `relay-binding:${patientId}`,
    finchnodeSubject: profile.subject,
    preferredName: profile.displayName,
    relayHandle: handle,
    relayChatId: options.chatId,
    checkinTime: options.checkinTime,
    timezone: options.timezone,
    onboardingStatus: "active",
  });
  return { patientId, created: true, profileSubject: profile.subject, profileName: profile.displayName };
}
