import { existsSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { loadConfig, parseHandles } from "../config.ts";
import { ConsentInactiveError, FinchNodeError, SubjectNotFoundError } from "../finchnode/client.ts";
import { painter, useColor } from "./sim-render.ts";
import {
  DEFAULT_DB_PATH,
  DEFAULT_SUBJECT,
  SHARING_LEVELS,
  SimUsageError,
  createSimulator,
  isDay,
  isSharingLevel,
  parseScript,
  runSimulation,
} from "./simulator.ts";

// npm run simulate -- [subject] [--day YYYY-MM-DD] [--db path] [--reset] [--live]
//                     [--script file] [--sharing status|status_vitals|all] [--family sarah,tom]
// Runs the daily check-in in the terminal: Harriet's phone and each family
// member's own chat with the agent as separate panes, her replies typed at the
// prompt. See src/cli/simulator.ts.

const USAGE =
  "usage: npm run simulate -- [subject] [--day YYYY-MM-DD] [--db path] [--reset] [--live] [--script file] [--sharing status|status_vitals|all] [--family sarah,tom]";

/** Delete the simulator DB file (and its WAL siblings). Refuses the app database. */
function resetDatabase(dbPath: string, appDbPath: string): void {
  if (dbPath === ":memory:" || dbPath === "") return;
  const target = resolve(dbPath);
  if (target === resolve(appDbPath)) throw new SimUsageError(`--reset will not delete the app database (${appDbPath}).`);
  for (const file of [target, `${target}-wal`, `${target}-shm`]) if (existsSync(file)) rmSync(file);
}

async function main(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        day: { type: "string" },
        db: { type: "string" },
        reset: { type: "boolean", default: false },
        live: { type: "boolean", default: false },
        script: { type: "string" },
        sharing: { type: "string" },
        family: { type: "string" },
        help: { type: "boolean", short: "h", default: false },
      },
    });
  } catch (error) {
    console.error(`error: ${error instanceof Error ? error.message : String(error)}\n${USAGE}`);
    return 2;
  }
  const { values, positionals } = parsed;
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  if (positionals.length > 1) {
    console.error(USAGE);
    return 2;
  }
  if (values.day !== undefined && !isDay(values.day)) {
    console.error(`error: --day must be YYYY-MM-DD, got "${values.day}"\n${USAGE}`);
    return 2;
  }
  if (values.sharing !== undefined && !isSharingLevel(values.sharing)) {
    console.error(`error: --sharing must be one of ${SHARING_LEVELS.join(", ")}\n${USAGE}`);
    return 2;
  }

  const config = loadConfig();
  const subject = positionals[0] ?? DEFAULT_SUBJECT;
  const dbPath = values.db ?? DEFAULT_DB_PATH;
  const color = useColor(process.stdout);
  const output = (line: string) => process.stdout.write(`${line}\n`);
  const common = {
    subject,
    dbPath,
    live: values.live,
    output,
    color,
    config,
    ...(values.day ? { day: values.day } : {}),
    ...(values.sharing && isSharingLevel(values.sharing) ? { sharing: values.sharing } : {}),
    // Comma separated handles; "--family ''" means no family members.
    ...(values.family !== undefined ? { family: parseHandles(values.family) } : {}),
  };

  try {
    if (values.reset) resetDatabase(dbPath, config.databasePath);

    if (values.script) {
      const inputs = parseScript(readFileSync(values.script, "utf8"));
      return await runSimulation({ ...common, inputs });
    }

    const sim = await createSimulator(common);
    const paint = painter(color);
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      await sim.start();
      rl.setPrompt(paint(`${sim.seniorName}> `, "bold", "green"));
      output("");
      rl.prompt();
      // Ends on /quit or when stdin closes (Ctrl-D).
      for await (const line of rl) {
        if ((await sim.handle(line)) === "quit") break;
        output("");
        rl.prompt();
      }
    } finally {
      rl.close();
      sim.close();
    }
    return 0;
  } catch (error) {
    if (error instanceof ConsentInactiveError) {
      console.error(`error: record consent for "${subject}" is no longer active (410 ${error.code}).`);
    } else if (error instanceof SubjectNotFoundError) {
      console.error(`error: FinchNode has no subject "${subject}" (404 ${error.code}).`);
    } else if (error instanceof FinchNodeError) {
      console.error(`error: FinchNode returned ${error.status} ${error.code} for "${subject}": ${error.message}`);
    } else if (error instanceof SimUsageError) {
      console.error(`error: ${error.message}`);
    } else if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      console.error(`error: ${error.message}`);
    } else {
      throw error;
    }
    return 1;
  }
}

process.exitCode = await main(process.argv.slice(2));
