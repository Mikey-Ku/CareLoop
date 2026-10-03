import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { REPO_ROOT } from "../finchnode/fixtures.ts";

// Who gets the care summaries over Photon (iMessage): her doctor and one emergency
// contact. The numbers live in care-contacts.json at the repo root (gitignored; copy
// care-contacts.example.json). Phone numbers are personal data, not secrets, so they
// sit in this file rather than .env, but they still never go into git or a log line.

export const DEFAULT_CONTACTS_PATH = join(REPO_ROOT, "care-contacts.json");
export const EXAMPLE_CONTACTS_PATH = join(REPO_ROOT, "care-contacts.example.json");

export type CareAudience = "doctor" | "family";

export type CareContact = {
  audience: CareAudience;
  name: string;
  /** E.164, e.g. +15551234567. */
  phone: string;
  /** Emergency contact only: "daughter", "son", "neighbor". */
  relationship?: string;
};

export type CareContacts = { doctor: CareContact; emergencyContact: CareContact };

export type LoadedContacts =
  | { kind: "ok"; contacts: CareContacts; path: string }
  | { kind: "missing"; path: string }
  /** The file still holds the example's fictional 555-01xx numbers. */
  | { kind: "placeholder"; contacts: CareContacts; path: string };

export class CareContactsError extends Error {
  override name = "CareContactsError";
}

/**
 * A phone number as E.164. Accepts the usual ways of writing one: "+1 (555) 123-4567",
 * "555.123.4567", "15551234567". A 10-digit number without a country code is taken as
 * US/Canada (+1). Returns undefined for anything else.
 */
export function normalizePhone(input: string): string | undefined {
  const trimmed = input.trim();
  if (!/^[+\d\s().-]+$/.test(trimmed)) return undefined;
  const digits = trimmed.replace(/\D/g, "");
  if (trimmed.startsWith("+")) return digits.length >= 8 && digits.length <= 15 && digits[0] !== "0" ? `+${digits}` : undefined;
  if (digits.length === 10 && digits[0] !== "0" && digits[0] !== "1") return `+1${digits}`;
  if (digits.length === 11 && digits[0] === "1") return `+${digits}`;
  return undefined;
}

/** The fictional range (555-0100 to 555-0199) the example file uses. */
export function isPlaceholderPhone(e164: string): boolean {
  return /^\+1\d{3}55501\d{2}$/.test(e164);
}

const phone = z.string().transform((value, ctx) => {
  const e164 = normalizePhone(value);
  if (!e164) {
    ctx.addIssue({ code: "custom", message: "is not a phone number (use +15551234567 or (555) 123-4567)" });
    return z.NEVER;
  }
  return e164;
});
const name = z.string().trim().min(1, "is empty");

const FileSchema = z.object({
  doctor: z.object({ name, phone }),
  emergencyContact: z.object({ name, phone, relationship: z.string().trim().min(1).optional() }),
});

/** Parse the file's JSON text. Throws CareContactsError naming the field, never the value. */
export function parseCareContacts(text: string, path = "care-contacts.json"): CareContacts {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new CareContactsError(`${path} is not valid JSON`);
  }
  const parsed = FileSchema.safeParse(json);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join(".") || "file"} ${i.message}`);
    throw new CareContactsError(`${path}: ${problems.join("; ")}`);
  }
  const { doctor, emergencyContact } = parsed.data;
  if (doctor.phone === emergencyContact.phone) throw new CareContactsError(`${path}: doctor and emergencyContact have the same phone number`);
  return {
    doctor: { audience: "doctor", name: doctor.name, phone: doctor.phone },
    emergencyContact: {
      audience: "family",
      name: emergencyContact.name,
      phone: emergencyContact.phone,
      ...(emergencyContact.relationship ? { relationship: emergencyContact.relationship } : {}),
    },
  };
}

/** Read the contacts file. A missing file is not an error: the Photon step is skipped. */
export function loadCareContacts(path: string = DEFAULT_CONTACTS_PATH): LoadedContacts {
  if (!existsSync(path)) return { kind: "missing", path };
  const contacts = parseCareContacts(readFileSync(path, "utf8"), path);
  if (isPlaceholderPhone(contacts.doctor.phone) || isPlaceholderPhone(contacts.emergencyContact.phone))
    return { kind: "placeholder", contacts, path };
  return { kind: "ok", contacts, path };
}

/** Which contact a phone number belongs to, if any. */
export function contactForPhone(contacts: CareContacts, fromPhone: string): CareContact | undefined {
  const e164 = normalizePhone(fromPhone);
  if (!e164) return undefined;
  if (e164 === contacts.doctor.phone) return contacts.doctor;
  if (e164 === contacts.emergencyContact.phone) return contacts.emergencyContact;
  return undefined;
}

/** "+1 ***-***-0100": enough to tell numbers apart in a log line. */
export function maskPhone(e164: string): string {
  return `${e164.slice(0, 2)} ***-***-${e164.slice(-4)}`;
}
