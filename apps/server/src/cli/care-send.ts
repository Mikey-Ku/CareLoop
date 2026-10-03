import { parseArgs } from "node:util";
import { loadCareConfig } from "../care/config.ts";
import { EXAMPLE_CONTACTS_PATH, CareContactsError, loadCareContacts, parseCareContacts } from "../care/contacts.ts";
import { doctorSummary, familySummary } from "../care/copy.ts";
import { buildCareFacts } from "../care/facts.ts";
import { connectCareRuntime } from "../care/runtime.ts";
import { DAY_TRIGGER } from "../care/service.ts";
import { loadConfig } from "../config.ts";
import { openDatabase } from "../db/index.ts";
import { loadRxNavCache } from "../finchnode/fixtures.ts";
import { readFileSync } from "node:fs";

// npm run care:send -- [--day YYYY-MM-DD] [--patient id] [--db path] [--dry-run]
// Texts a day's care summary to the doctor and the emergency contact over Photon, from
// what the app database holds for that day (the agent does this on its own when a
// check-in ends). Sending twice for a day is a no-op. --dry-run prints both texts and
// sends and stores nothing; it uses the example contacts when care-contacts.json is absent.

const USAGE = "usage: npm run care:send -- [--day YYYY-MM-DD] [--patient id] [--db path] [--dry-run]";

async function main(argv: string[]): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        day: { type: "string" },
        patient: { type: "string" },
        db: { type: "string" },
        "dry-run": { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
    }));
  } catch (error) {
    console.error(`error: ${error instanceof Error ? error.message : String(error)}\n${USAGE}`);
    return 2;
  }
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  if (values.day !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(values.day)) {
    console.error(`error: --day must be YYYY-MM-DD\n${USAGE}`);
    return 2;
  }

  const config = loadConfig();
  const careConfig = loadCareConfig();
  const db = openDatabase(values.db ?? config.databasePath);
  try {
    const patients = db.prepare("SELECT id FROM patients ORDER BY id").all() as { id: string }[];
    const patientId = values.patient ?? (patients.length === 1 ? patients[0]?.id : undefined);
    if (!patientId || !patients.some((p) => p.id === patientId)) {
      console.error(
        patients.length === 0
          ? "error: no patients in the database yet (run the agent or the simulator first)"
          : `error: pass --patient, one of: ${patients.map((p) => p.id).join(", ")}`,
      );
      return 1;
    }
    const day = values.day ?? config.clockDate ?? new Date().toISOString().slice(0, 10);

    if (values["dry-run"]) {
      const loaded = loadCareContacts(careConfig.contactsPath);
      const contacts = loaded.kind === "missing" ? parseCareContacts(readFileSync(EXAMPLE_CONTACTS_PATH, "utf8"), EXAMPLE_CONTACTS_PATH) : loaded.contacts;
      const facts = buildCareFacts(db, { patientId, day, trigger: DAY_TRIGGER, rxnav: loadRxNavCache() });
      console.log(`--- to ${contacts.doctor.name} (doctor) ---\n${doctorSummary(facts, contacts)}\n`);
      console.log(`--- to ${contacts.emergencyContact.name} (emergency contact) ---\n${familySummary(facts, contacts)}`);
      return 0;
    }

    const clock = { now: () => new Date().toISOString() };
    const care = await connectCareRuntime({ config: careConfig, db, patientId, clock, log: (line) => console.log(line) });
    if (!care) return 1;
    try {
      const result = await care.service.sendSummaries(day);
      console.log(`care summary ${result.summaryId} for ${day}: doctor ${result.doctor}, emergency contact ${result.family}`);
      return result.doctor === "failed" || result.family === "failed" ? 1 : 0;
    } finally {
      await care.stop();
    }
  } catch (error) {
    if (error instanceof CareContactsError) {
      console.error(`error: ${error.message}`);
      return 1;
    }
    throw error;
  } finally {
    db.close();
  }
}

process.exitCode = await main(process.argv.slice(2));
