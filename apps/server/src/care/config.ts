import { DEFAULT_CONTACTS_PATH } from "./contacts.ts";

// Environment for the care summaries. The Photon project secret is non-enumerable so it never
// shows up when the config is printed or serialized. Their wording uses the app's LLM (Gemini,
// GEMINI_API_KEY in src/config.ts), not a key of its own.

export type CareConfig = {
  /** CARE_CONTACTS_PATH, default care-contacts.json at the repo root. */
  contactsPath: string;
  /** SPECTRUM_PROJECT_ID and SPECTRUM_PROJECT_SECRET; undefined unless both are set. */
  photon: { projectId: string; projectSecret: string } | undefined;
};

function secret<T extends object>(target: T, key: string, value: string): T {
  Object.defineProperty(target, key, { value, enumerable: false });
  return target;
}

export function loadCareConfig(env: Record<string, string | undefined> = process.env): CareConfig {
  const get = (name: string) => env[name]?.trim() || undefined;
  const projectId = get("SPECTRUM_PROJECT_ID");
  const projectSecret = get("SPECTRUM_PROJECT_SECRET");
  return {
    contactsPath: get("CARE_CONTACTS_PATH") ?? DEFAULT_CONTACTS_PATH,
    photon: projectId && projectSecret ? secret({ projectId } as { projectId: string; projectSecret: string }, "projectSecret", projectSecret) : undefined,
  };
}
