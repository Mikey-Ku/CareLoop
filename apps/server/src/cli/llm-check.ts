import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ConfigError, loadConfig, type Config } from "../config.ts";
import { formatAttempt, type AttemptLogEntry } from "../llm/fallback.ts";
import { createLlmClient, describeLlm, type CreateLlmDeps } from "../llm/index.ts";
import type { ClassifyInput, MapAnswerInput, MessageClassification } from "../llm/types.ts";

// `npm run llm:check`: does free-text understanding work from this laptop?
// Maps three sample replies onto their questions' buttons, asks for one
// small-talk reply and sorts six sample messages into kinds, printing each
// result, the model that answered and the timings. The only script that calls
// the LLM on purpose. Prints no secrets.

type Sample = MapAnswerInput & { expect: string };

export const SAMPLES: Sample[] = [
  {
    question: "Have your ankles or feet been more swollen than usual?",
    options: ["No", "A little", "Yes, more than usual"],
    reply: "my ankles are a bit puffy today and I slept badly",
    expect: "not No (she names a symptom), with 'slept badly' as another complaint",
  },
  {
    question: "Did you have trouble breathing when lying flat last night?",
    options: ["No", "Yes"],
    reply: "nah I was fine, just had to prop myself up on a couple pillows",
    expect: "Yes (needing pillows to breathe is the symptom, whatever she says first)",
  },
  {
    question: "Have you felt dizzy when standing up?",
    options: ["No", "Sometimes", "Yes, often"],
    reply: "did the Tigers win last night?",
    expect: "unclear (she didn't answer)",
  },
];

export const SMALL_TALK_SAMPLE = { seniorName: "Harriet", message: "my granddaughter is visiting on Sunday, I'm baking" };

const BREATHING_QUESTION = { question: SAMPLES[1]!.question, options: SAMPLES[1]!.options };

/** One message per main kind; the last one answers a pending red-flag question. */
export const CLASSIFY_SAMPLES: (ClassifyInput & { expect: string })[] = [
  { seniorName: "Harriet", message: "Should I stop taking my aspirin?", expect: "medicine_question" },
  { seniorName: "Harriet", message: "I feel so lonely since Bob died", expect: "feeling_low" },
  { seniorName: "Harriet", message: "Tell Sarah I love her", expect: "family_message, with forFamily" },
  { seniorName: "Harriet", message: "Not really but I have more info", expect: "more_detail" },
  { seniorName: "Harriet", message: "did the Tigers win?", expect: "chat" },
  { seniorName: "Harriet", message: "Yes but it was weirder", pending: BREATHING_QUESTION, expect: "answer Yes (an explicit yes)" },
];

/** kind, answer, confidence, then whatever else came back. */
export function describeClassification(c: MessageClassification): string {
  const parts = [`kind=${c.kind}`];
  if (c.answer !== undefined) parts.push(`answer=${c.answer}`);
  parts.push(`confidence=${c.confidence}`);
  if (c.forFamily) parts.push(`forFamily=${JSON.stringify(c.forFamily)}`);
  if (c.complaints.length > 0) parts.push(`complaints=${JSON.stringify(c.complaints)}`);
  if (c.memories.length > 0) parts.push(`memories=${JSON.stringify(c.memories)}`);
  return parts.join(" ");
}

/** What .env needs before the check can call anything. Empty when ready. */
export function missingSetup(config: Config): string[] {
  const missing: string[] = [];
  if (config.llm.provider !== "gemini") missing.push(`LLM_PROVIDER=gemini (it is ${config.llm.provider}, which has no adapter yet)`);
  if (!config.llm.geminiApiKey) missing.push("GEMINI_API_KEY (a free key from https://aistudio.google.com/apikey, in the repo-root .env)");
  if (config.llm.geminiModels.length === 0) missing.push("GEMINI_MODELS (or leave it unset for the defaults)");
  return missing;
}

export async function main(
  env: Record<string, string | undefined> = process.env,
  out = (line: string) => console.log(line),
  deps: CreateLlmDeps = {},
): Promise<number> {
  let config: Config;
  try {
    config = loadConfig(env);
  } catch (error) {
    out(`error: ${error instanceof ConfigError ? error.message : messageOf(error)}`);
    return 1;
  }

  const missing = missingSetup(config);
  const attempts: AttemptLogEntry[] = [];
  const llm = createLlmClient(config, {
    ...deps,
    logger: (entry) => {
      attempts.push(entry);
      out(`    ${formatAttempt(entry)}`);
    },
  });
  if (missing.length > 0 || !llm) {
    out("LLM check: .env is missing:");
    for (const m of missing) out(`  - ${m}`);
    return 1;
  }

  out(`LLM check: ${describeLlm(config)}`);
  let failures = 0;
  const timed = async <T>(label: string, run: () => Promise<T>, show: (value: T) => string) => {
    out(label);
    const before = attempts.length;
    const started = performance.now();
    try {
      const value = await run();
      const answered = attempts.slice(before).find((a) => a.status === 200);
      out(`  -> ${show(value)}`);
      out(`  model ${answered?.model ?? "unknown"}, ${Math.round(performance.now() - started)} ms in all`);
    } catch (error) {
      failures += 1;
      out(`  [FAIL] ${messageOf(error)} after ${Math.round(performance.now() - started)} ms`);
    }
  };

  for (const sample of SAMPLES) {
    const { expect, ...input } = sample;
    await timed(
      `mapAnswer: "${input.reply}"\n  question: ${input.question} [${input.options.join(" | ")}]\n  expect: ${expect}`,
      () => llm.mapAnswer(input),
      (m) => JSON.stringify(m),
    );
  }
  await timed(`smallTalk: "${SMALL_TALK_SAMPLE.message}"`, () => llm.smallTalk(SMALL_TALK_SAMPLE), (r) => JSON.stringify(r));
  for (const sample of CLASSIFY_SAMPLES) {
    const { expect, ...input } = sample;
    const pending = input.pending ? `\n  pending: ${input.pending.question} [${input.pending.options.join(" | ")}]` : "";
    await timed(`classifyMessage: "${input.message}"${pending}\n  expect: ${expect}`, () => llm.classifyMessage(input), describeClassification);
  }

  out(failures === 0 ? "LLM check: every call answered" : `LLM check: ${failures} call(s) got no answer; the app would fall back to buttons or a template`);
  return failures === 0 ? 0 : 1;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
