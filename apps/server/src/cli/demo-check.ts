import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ENV_FILE, checkDemoSetup, type PreflightOptions } from "../demo/preflight.ts";

export function main(env: Record<string, string | undefined> = process.env, out = (line: string) => console.log(line), options: PreflightOptions = { envFile: ENV_FILE }, args: string[] = process.argv.slice(2)): number {
  if (args.length) {
    out("Usage: npm run demo:check (offline only). Run the printed provider commands explicitly for live verification.");
    return 1;
  }
  const report = checkDemoSetup(env, options);
  out("Demo setup: offline presence checks only; credentials and live device quality are not verified.");
  for (const line of report.lines) out(line);
  out(`Setup status: ${report.status}; exit ${report.exitCode}`);
  return report.exitCode;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main();
