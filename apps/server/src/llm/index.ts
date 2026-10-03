import type { Config, LlmConfig } from "../config.ts";
import { formatAttempt, type LlmLogger } from "./fallback.ts";
import { GeminiLlmClient, type GeminiDeps } from "./gemini.ts";
import type { LlmClient } from "./types.ts";

// The one place the app gets an LLM. No key (or a provider with no adapter
// yet) means no client: the check-in then runs on buttons alone, as before.

export { FakeLlmClient, type FakeLlmCall, type FakeLlmScript } from "./fake.ts";
export { formatAttempt, type AttemptLogEntry, type LlmLogger } from "./fallback.ts";
export { GeminiLlmClient } from "./gemini.ts";
export * from "./types.ts";

export type CreateLlmDeps = GeminiDeps;

/** Logs each attempt as one console line; pass `logger` to route it elsewhere. */
export const consoleLlmLogger: LlmLogger = (entry) => console.log(formatAttempt(entry));

/**
 * The configured client, or undefined when free text is off: no GEMINI_API_KEY,
 * no models, or LLM_PROVIDER=anthropic (no adapter yet). Accepts the whole
 * Config or just its `llm` section. Spreading `config.llm` drops the key (it is
 * non-enumerable), so pass the object itself.
 */
export function createLlmClient(config: Pick<Config, "llm"> | LlmConfig, deps: CreateLlmDeps = {}): LlmClient | undefined {
  const llm = "llm" in config ? config.llm : config;
  if (llm.provider !== "gemini" || !llm.geminiApiKey || llm.geminiModels.length === 0) return undefined;
  return new GeminiLlmClient(
    { apiKey: llm.geminiApiKey, models: llm.geminiModels, timeoutMs: llm.timeoutMs, attemptTimeoutMs: llm.attemptTimeoutMs },
    { ...deps, logger: deps.logger ?? consoleLlmLogger },
  );
}

/** One line for startup logs: what free-text understanding will use, or why it is off. Never includes the key. */
export function describeLlm(config: Pick<Config, "llm"> | LlmConfig): string {
  const llm = "llm" in config ? config.llm : config;
  if (llm.provider !== "gemini") return `free text off: LLM_PROVIDER=${llm.provider} has no adapter yet (buttons only)`;
  if (!llm.geminiApiKey) return "free text off: GEMINI_API_KEY is not set (buttons only)";
  if (llm.geminiModels.length === 0) return "free text off: GEMINI_MODELS is empty (buttons only)";
  return `free text on: gemini ${llm.geminiModels.join(", ")} (${llm.timeoutMs} ms budget per call, ${llm.attemptTimeoutMs} ms per try)`;
}
