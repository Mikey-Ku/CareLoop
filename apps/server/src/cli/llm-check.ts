import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ConfigError, loadConfig, type Config } from "../config.ts";
import { formatAttempt, type AttemptLogEntry } from "../llm/fallback.ts";
import { createLlmClient, describeLlm, type CreateLlmDeps } from "../llm/index.ts";
import type {
  CheckinExtraction,
  ClassifyInput,
  ExtractCheckinInput,
  MapAnswerInput,
  MessageClassification,
  SymptomMention,
} from "../llm/types.ts";

// `npm run llm:check`: does free-text understanding work from this laptop?
// Maps three sample replies onto their questions' buttons, asks for one
// small-talk reply, sorts eight sample messages into kinds (two with symptoms)
// and extracts answers and symptoms from four replies to the open question,
// printing each result, the model that answered and the timings. The only
// script that calls the LLM on purpose. Prints no secrets.

type Sample = MapAnswerInput & { expect: string };

type Question = ExtractCheckinInput["questions"][number];

// Today's questions for the samples, with the graded button labels (docs/DESIGN.md "Severity ladder").
const ANKLES: Question = {
  id: "hf-ankle-swelling",
  question: "Have your ankles or feet been more swollen than usual?",
  options: ["No", "A little", "More than usual"],
};
const BREATHING: Question = {
  id: "hf-breathing-lying-flat",
  question: "How was your breathing last night when you lay down?",
  options: ["Fine", "A little hard", "Yes, it was hard"],
};
const DIZZY: Question = { id: "dizzy-on-standing", question: "Have you felt dizzy when standing up?", options: ["No", "Sometimes", "Often"] };

export const TODAY_QUESTIONS: Question[] = [ANKLES, BREATHING, DIZZY];

export const SAMPLES: Sample[] = [
  {
    question: ANKLES.question,
    options: ANKLES.options,
    reply: "my ankles are a bit puffy today and I slept badly",
    expect: "A little, not No (she names a symptom), with 'slept badly' as another complaint",
  },
  {
    question: BREATHING.question,
    options: BREATHING.options,
    reply: "nah I was fine, just had to prop myself up on a couple pillows",
    expect: "not Fine (needing pillows to breathe is the symptom, whatever she says first)",
  },
  {
    question: DIZZY.question,
    options: DIZZY.options,
    reply: "did the Tigers win last night?",
    expect: "unclear (she didn't answer)",
  },
];

export const SMALL_TALK_SAMPLE = { seniorName: "Harriet", message: "my granddaughter is visiting on Sunday, I'm baking" };

const BREATHING_QUESTION = { question: BREATHING.question, options: BREATHING.options };

/** One message per main kind; the last one answers a pending red-flag question. */
export const CLASSIFY_SAMPLES: (ClassifyInput & { expect: string })[] = [
  { seniorName: "Harriet", message: "Should I stop taking my aspirin?", expect: "medicine_question" },
  { seniorName: "Harriet", message: "I feel so lonely since Bob died", expect: "feeling_low" },
  { seniorName: "Harriet", message: "Tell Sarah I love her", expect: "family_message, with forFamily" },
  { seniorName: "Harriet", message: "Not really but I have more info", expect: "more_detail" },
  { seniorName: "Harriet", message: "did the Tigers win?", expect: "chat" },
  { seniorName: "Harriet", message: "Yes but it was weirder", pending: BREATHING_QUESTION, expect: "answer Yes, it was hard (an explicit yes)" },
];

/** Small-talk complaints that should get a level, not a blanket doctor/911 reply. */
export const CLASSIFY_SYMPTOM_SAMPLES: (ClassifyInput & { expect: string })[] = [
  { seniorName: "Harriet", message: "my knee really hurts today", expect: "a knee symptom, amount a_lot" },
  { seniorName: "Harriet", message: "I have a new cough that's getting worse", expect: "a cough symptom, change new or worse" },
];

/** Replies to "How are you feeling today?", read against TODAY_QUESTIONS. */
export const EXTRACT_SAMPLES: { message: string; expect: string }[] = [
  {
    message: "ankles a bit puffy, slept ok, little dizzy getting up this morning",
    expect: "ankles A little, dizziness Sometimes, breathing left out (slept ok is not about breathing); both symptoms a_little",
  },
  { message: "feeling good today, no problems", expect: "no answers (a general remark answers no question), no symptoms" },
  {
    message: "breathing was a little tight at times last night but mostly fine, and my knee aches",
    expect: "breathing A little hard (not Fine), ankles and dizziness left out; symptoms breathing a_little and knee (no question)",
  },
  {
    message: "terrible night, couldn't breathe lying down, had to sit up in the chair",
    expect: "breathing Yes, it was hard; symptom breathing a_lot",
  },
];

/** One symptom as `topic amount/change "her words"`. */
export function describeSymptom(s: SymptomMention): string {
  return `${s.topic} ${s.amount}/${s.change} ${JSON.stringify(s.words)}`;
}

/** answers, symptoms and memories on one line. */
export function describeExtraction(e: CheckinExtraction): string {
  const answers = e.answers.map((a) => `${a.questionId}=${JSON.stringify(a.answer)} (${a.confidence})`);
  const parts = [`answers={${answers.join(", ")}}`, `symptoms=[${e.symptoms.map(describeSymptom).join(", ")}]`];
  if (e.memories.length > 0) parts.push(`memories=${JSON.stringify(e.memories)}`);
  return parts.join(" ");
}

/** kind, answer, confidence, then whatever else came back. */
export function describeClassification(c: MessageClassification): string {
  const parts = [`kind=${c.kind}`];
  if (c.answer !== undefined) parts.push(`answer=${c.answer}`);
  parts.push(`confidence=${c.confidence}`);
  if (c.forFamily) parts.push(`forFamily=${JSON.stringify(c.forFamily)}`);
  if (c.complaints.length > 0) parts.push(`complaints=${JSON.stringify(c.complaints)}`);
  if (c.memories.length > 0) parts.push(`memories=${JSON.stringify(c.memories)}`);
  if (c.symptoms && c.symptoms.length > 0) parts.push(`symptoms=[${c.symptoms.map(describeSymptom).join(", ")}]`);
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
  for (const sample of [...CLASSIFY_SAMPLES, ...CLASSIFY_SYMPTOM_SAMPLES]) {
    const { expect, ...input } = sample;
    const pending = input.pending ? `\n  pending: ${input.pending.question} [${input.pending.options.join(" | ")}]` : "";
    await timed(`classifyMessage: "${input.message}"${pending}\n  expect: ${expect}`, () => llm.classifyMessage(input), describeClassification);
  }
  out("today's questions for extractCheckin:");
  for (const q of TODAY_QUESTIONS) out(`  ${q.id}: ${q.question} [${q.options.join(" | ")}]`);
  for (const sample of EXTRACT_SAMPLES) {
    await timed(
      `extractCheckin: "${sample.message}"\n  expect: ${sample.expect}`,
      () => llm.extractCheckin({ seniorName: "Harriet", message: sample.message, questions: TODAY_QUESTIONS }),
      describeExtraction,
    );
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
