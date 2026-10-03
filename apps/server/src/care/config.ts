import { DEFAULT_ANTHROPIC_MODEL } from "./claude-writer.ts";
import { DEFAULT_CONTACTS_PATH } from "./contacts.ts";

// Environment for the care summaries. Secrets (the Photon project secret, the Anthropic
// key) are non-enumerable so they never show up when the config is printed or serialized.

export type CareConfig = {
  /** CARE_CONTACTS_PATH, default care-contacts.json at the repo root. */
  contactsPath: string;
  /** SPECTRUM_PROJECT_ID and SPECTRUM_PROJECT_SECRET; undefined unless both are set. */
  photon: { projectId: string; projectSecret: string } | undefined;
  /** ANTHROPIC_API_KEY (and ANTHROPIC_MODEL); undefined without a key, so template replies are used. */
  anthropic: { apiKey: string; model: string } | undefined;
};

function secret<T extends object>(target: T, key: string, value: string): T {
  Object.defineProperty(target, key, { value, enumerable: false });
  return target;
}

export function loadCareConfig(env: Record<string, string | undefined> = process.env): CareConfig {
  const get = (name: string) => env[name]?.trim() || undefined;
  const projectId = get("SPECTRUM_PROJECT_ID");
  const projectSecret = get("SPECTRUM_PROJECT_SECRET");
  const apiKey = get("ANTHROPIC_API_KEY");
  return {
    contactsPath: get("CARE_CONTACTS_PATH") ?? DEFAULT_CONTACTS_PATH,
    photon: projectId && projectSecret ? secret({ projectId } as { projectId: string; projectSecret: string }, "projectSecret", projectSecret) : undefined,
    anthropic: apiKey ? secret({ model: get("ANTHROPIC_MODEL") ?? DEFAULT_ANTHROPIC_MODEL } as { apiKey: string; model: string }, "apiKey", apiKey) : undefined,
  };
}
