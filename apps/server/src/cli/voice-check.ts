import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ConfigError, loadConfig } from "../config.ts";
import { checkVoice, type VoiceCheckDeps } from "../demo/voice-check.ts";

// `npm run voice:check`: tries ElevenLabs for real with the repo-root .env (see src/demo/voice-check.ts).

export async function main(env: Record<string, string | undefined> = process.env, out = (line: string) => console.log(line), deps: VoiceCheckDeps = {}): Promise<number> {
  let config;
  try {
    config = loadConfig(env);
  } catch (error) {
    out(`error: ${error instanceof ConfigError ? error.message : "invalid configuration"}`);
    return 1;
  }
  out("Voice check (ElevenLabs, live):");
  const { lines, exitCode } = await checkVoice(config, deps);
  for (const line of lines) out(line);
  return exitCode;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main();
