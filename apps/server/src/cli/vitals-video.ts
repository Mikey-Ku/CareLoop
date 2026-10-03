import { existsSync } from "node:fs";
import { parseArgs } from "node:util";
import { hasUsableVitals, runPresageVideo } from "../vitals/presage-file.ts";

const USAGE = "usage: npm run vitals:video -- <video.mp4> [--timeout-ms milliseconds]";

export async function main(argv: string[], env: Record<string, string | undefined> = process.env): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: { "timeout-ms": { type: "string" }, help: { type: "boolean", short: "h", default: false } },
    });
  } catch (error) {
    console.error(`error: ${error instanceof Error ? error.message : String(error)}\n${USAGE}`);
    return 2;
  }
  if (parsed.values.help) {
    console.log(USAGE);
    return 0;
  }
  const videoPath = parsed.positionals[0];
  if (!videoPath || parsed.positionals.length > 1) {
    console.error(USAGE);
    return 2;
  }
  const timeoutText = parsed.values["timeout-ms"];
  const timeoutMs = timeoutText === undefined ? undefined : Number(timeoutText);
  if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || timeoutMs <= 0)) {
    console.error("error: --timeout-ms must be a positive integer");
    return 2;
  }

  const result = !existsSync(videoPath)
    ? {
        heartRate: null,
        breathingRate: null,
        confidence: null,
        measuredAt: null,
        source: "video_file" as const,
        validation: [],
        errors: [{ code: "video_not_found", message: `Video file does not exist: ${videoPath}` }],
      }
    : await runPresageVideo({ videoPath, apiKey: env.PRESAGE_API_KEY, ...(timeoutMs === undefined ? {} : { timeoutMs }) });

  console.log(JSON.stringify(result, null, 2));
  return hasUsableVitals(result) && result.errors.length === 0 ? 0 : 1;
}

process.exitCode = await main(process.argv.slice(2));
