import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadCareConfig } from "../src/care/config.ts";
import {
  CareContactsError,
  DEFAULT_CONTACTS_PATH,
  EXAMPLE_CONTACTS_PATH,
  contactForPhone,
  isPlaceholderPhone,
  loadCareContacts,
  maskPhone,
  normalizePhone,
  parseCareContacts,
} from "../src/care/contacts.ts";
import { connectCareRuntime } from "../src/care/runtime.ts";
import { openDatabase } from "../src/db/index.ts";
import { REPO_ROOT } from "../src/finchnode/fixtures.ts";

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

/** A contacts file in a temp dir, written the way someone would fill in the example. */
function contactsFile(json: unknown): string {
  dir ??= mkdtempSync(join(tmpdir(), "care-contacts-"));
  const path = join(dir, "care-contacts.json");
  writeFileSync(path, typeof json === "string" ? json : JSON.stringify(json, null, 2));
  return path;
}

/** The example file with its two numbers replaced, as the team will do. */
function filledIn(doctorPhone: string, familyPhone: string): unknown {
  const example = JSON.parse(readFileSync(EXAMPLE_CONTACTS_PATH, "utf8")) as {
    doctor: { phone: string };
    emergencyContact: { phone: string };
  };
  example.doctor.phone = doctorPhone;
  example.emergencyContact.phone = familyPhone;
  return example;
}

describe("normalizePhone", () => {
  it("takes the usual ways of writing a number to E.164", () => {
    expect(normalizePhone("+1 (734) 555-1234")).toBe("+17345551234");
    expect(normalizePhone("734-555-1234")).toBe("+17345551234");
    expect(normalizePhone("734.555.1234")).toBe("+17345551234");
    expect(normalizePhone("(734) 555 1234")).toBe("+17345551234");
    expect(normalizePhone("17345551234")).toBe("+17345551234");
    expect(normalizePhone(" +44 20 7946 0958 ")).toBe("+442079460958");
  });

  it("rejects what isn't a phone number", () => {
    for (const bad of ["", "555-1234", "call me", "+0 123 456 789", "07700 900123", "734555123456789012", "+1 734 555 1234 ext 5"])
      expect(normalizePhone(bad), bad).toBeUndefined();
  });
});

describe("the contacts file", () => {
  it("the example file is in the repo, parses, and is recognised as still holding the example numbers", () => {
    const loaded = loadCareContacts(EXAMPLE_CONTACTS_PATH);
    expect(loaded.kind).toBe("placeholder");
    if (loaded.kind !== "placeholder") return;
    expect(loaded.contacts.doctor).toEqual({ audience: "doctor", name: "Dr. Patel", phone: "+15555550100" });
    expect(loaded.contacts.emergencyContact).toEqual({ audience: "family", name: "Sarah", relationship: "daughter", phone: "+15555550101" });
    expect(isPlaceholderPhone("+15555550100")).toBe(true);
    expect(isPlaceholderPhone("+17345551234")).toBe(false);
  });

  it("works once the two numbers are filled in, in any common format", () => {
    const path = contactsFile(filledIn("(734) 555-1234", "+1 313 555 9876"));
    const loaded = loadCareContacts(path);
    expect(loaded.kind).toBe("ok");
    if (loaded.kind !== "ok") return;
    expect(loaded.contacts.doctor.phone).toBe("+17345551234");
    expect(loaded.contacts.emergencyContact.phone).toBe("+13135559876");
    expect(loaded.contacts.emergencyContact.relationship).toBe("daughter");
  });

  it("is still a placeholder when only one of the two numbers was changed", () => {
    expect(loadCareContacts(contactsFile(filledIn("(734) 555-1234", "+1 555 555 0101"))).kind).toBe("placeholder");
  });

  it("a missing file is not an error", () => {
    expect(loadCareContacts(join(tmpdir(), "no-such-dir", "care-contacts.json"))).toMatchObject({ kind: "missing" });
  });

  it("the real file lives at the repo root and is gitignored", () => {
    expect(DEFAULT_CONTACTS_PATH).toBe(join(REPO_ROOT, "care-contacts.json"));
    expect(readFileSync(join(REPO_ROOT, ".gitignore"), "utf8").split("\n")).toContain("care-contacts.json");
  });

  it("names the field that's wrong, never the value", () => {
    const path = contactsFile(filledIn("not-a-number-734", "+1 313 555 9876"));
    const error = (() => {
      try {
        loadCareContacts(path);
      } catch (e) {
        return e;
      }
    })();
    expect(error).toBeInstanceOf(CareContactsError);
    expect((error as Error).message).toContain("doctor.phone");
    expect((error as Error).message).not.toContain("not-a-number-734");
  });

  it("rejects bad JSON, missing names, and the same number for both", () => {
    expect(() => parseCareContacts("{ doctor: ")).toThrow(/not valid JSON/);
    expect(() => parseCareContacts(JSON.stringify({ doctor: { name: " ", phone: "7345551234" }, emergencyContact: { name: "Sarah", phone: "3135559876" } }))).toThrow(
      /doctor.name is empty/,
    );
    expect(() => parseCareContacts(JSON.stringify({ doctor: { name: "Dr. A", phone: "7345551234" } }))).toThrow(/emergencyContact/);
    expect(() =>
      parseCareContacts(JSON.stringify({ doctor: { name: "Dr. A", phone: "734-555-1234" }, emergencyContact: { name: "Sarah", phone: "+17345551234" } })),
    ).toThrow(/same phone number/);
  });

  it("matches a sender to a contact whatever the format Photon gives", () => {
    const contacts = parseCareContacts(JSON.stringify(filledIn("(734) 555-1234", "313-555-9876")));
    expect(contactForPhone(contacts, "+17345551234")?.audience).toBe("doctor");
    expect(contactForPhone(contacts, "7345551234")?.audience).toBe("doctor");
    expect(contactForPhone(contacts, "+1 (313) 555-9876")?.audience).toBe("family");
    expect(contactForPhone(contacts, "+12025550123")).toBeUndefined();
    expect(contactForPhone(contacts, "someone@icloud.com")).toBeUndefined();
    expect(maskPhone("+17345551234")).toBe("+1 ***-***-1234");
  });
});

describe("care config and the runtime's preconditions", () => {
  it("reads Photon settings, keeping the secret out of printed config", () => {
    const config = loadCareConfig({
      SPECTRUM_PROJECT_ID: "proj_1",
      SPECTRUM_PROJECT_SECRET: "spectrum_SECRET",
      CARE_CONTACTS_PATH: "/tmp/x.json",
    });
    expect(config.photon?.projectId).toBe("proj_1");
    expect(config.photon?.projectSecret).toBe("spectrum_SECRET");
    expect(config.contactsPath).toBe("/tmp/x.json");
    expect(JSON.stringify(config)).not.toMatch(/SECRET/);
    expect(Object.keys(config)).toEqual(["contactsPath", "photon"]); // no provider key of its own: the app's LLM words the texts
  });

  it("is off without both Photon variables", () => {
    const config = loadCareConfig({ SPECTRUM_PROJECT_ID: "proj_1", SPECTRUM_PROJECT_SECRET: "" });
    expect(config.photon).toBeUndefined();
    expect(config.contactsPath).toBe(DEFAULT_CONTACTS_PATH);
  });

  it("connectCareRuntime turns itself off, saying why, until the file and credentials are in place", async () => {
    const db = openDatabase(":memory:");
    const lines: string[] = [];
    const clock = { now: () => "2026-09-01T13:00:00.000Z" };
    const run = (env: Record<string, string>) =>
      connectCareRuntime({ config: loadCareConfig(env), db, patientId: "harriet", clock, log: (l) => lines.push(l) });
    try {
      expect(await run({ CARE_CONTACTS_PATH: join(tmpdir(), "missing-care-contacts.json") })).toBeUndefined();
      expect(lines.at(-1)).toMatch(/no contacts file/);

      expect(await run({ CARE_CONTACTS_PATH: EXAMPLE_CONTACTS_PATH, SPECTRUM_PROJECT_ID: "p", SPECTRUM_PROJECT_SECRET: "s" })).toBeUndefined();
      expect(lines.at(-1)).toMatch(/example 555-01xx numbers/);

      // Real numbers but no Photon credentials: off, without contacting Photon.
      expect(await run({ CARE_CONTACTS_PATH: contactsFile(filledIn("(734) 555-1234", "313-555-9876")) })).toBeUndefined();
      expect(lines.at(-1)).toMatch(/SPECTRUM_PROJECT_ID/);
      expect(lines.join("\n")).not.toMatch(/7345551234|3135559876/);
    } finally {
      db.close();
    }
  });
});
