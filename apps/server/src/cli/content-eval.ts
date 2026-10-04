import { readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { ConfigError, loadConfig, type Config } from "../config.ts";
import { QUESTION_BANK } from "../context/questions.ts";
import { FIXTURES_DIR, REPO_ROOT } from "../finchnode/fixtures.ts";
import type { AttemptLogEntry } from "../llm/fallback.ts";
import { createLlmClient, describeLlm, type CreateLlmDeps } from "../llm/index.ts";
import { HISTORY_TOPICS, MESSAGE_KINDS, type ClassifyInput, type HistoryTopic, type MessageClassification, type MessageKind } from "../llm/types.ts";
import { screenMessage, type SafetyHit } from "../safety/screen.ts";
import { missingSetup } from "./llm-check.ts";

// `npm run content:eval`: how well do the safety screen and the model read what
// she types? Runs every message in fixtures/content/messages.json through the
// fixed phrase screen, then through the live classifyMessage (for messages the
// screen let through, and for every safety case, to measure the model as the
// backup), and writes docs/content-eval.md with the safety cases first. A report,
// not a gate: exits 0 once it has run, 1 only when .env can't call the model.
// About one lite-model call per case. Prints no secrets.

export const CATALOGUE_PATH = join(FIXTURES_DIR, "content", "messages.json");
export const REPORT_PATH = join(REPO_ROOT, "docs", "content-eval.md");

/** Why a case is hard. Every case with one of these counts as a hard case. */
export const HARD_TAGS = [
  "typo",
  "dictation",
  "punctuation",
  "caps",
  "emoji",
  "spanish",
  "long",
  "idiom",
  "negation",
  "manipulation",
  "past_event",
  "third_person",
  "implicit",
] as const;
export type HardTag = (typeof HARD_TAGS)[number];

const SAFETY_KINDS = ["crisis", "urgent_symptom"] as const;

const CaseSchema = z
  .object({
    id: z.string().min(1),
    text: z.string().min(1),
    /** A QUESTION_BANK id waiting for an answer. */
    pending: z.string().optional(),
    expectKind: z.enum(MESSAGE_KINDS),
    /** One of the pending question's buttons, or "unclear". */
    expectAnswer: z.string().optional(),
    /** kind history_question only: the topic the model should pick. */
    expectTopic: z.enum(HISTORY_TOPICS).optional(),
    /** A key of the catalogue's `digests`: the context digest (src/context/digest.ts) the message is read with, as in the agent. */
    digest: z.string().optional(),
    /** The fixed phrase screen must catch it as this kind. */
    mustScreen: z.enum(SAFETY_KINDS).optional(),
    /** The fixed phrase screen must leave it alone (idioms, negations). */
    mustNotScreen: z.literal(true).optional(),
    hard: z.enum(HARD_TAGS).optional(),
    note: z.string().optional(),
  })
  .strict();

const CatalogueSchema = z
  .object({
    description: z.string(),
    seniorName: z.string().min(1),
    /** Rendered context digests (synthetic) that cases refer to by name. */
    digests: z.record(z.string(), z.string()).optional(),
    cases: z.array(CaseSchema),
  })
  .strict();

export type Catalogue = z.infer<typeof CatalogueSchema>;
export type ContentCase = Catalogue["cases"][number];

export function loadCatalogue(path = CATALOGUE_PATH): Catalogue {
  const catalogue = CatalogueSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  for (const c of catalogue.cases)
    if (c.digest !== undefined && catalogue.digests?.[c.digest] === undefined) throw new Error(`content eval: case ${c.id} names unknown digest "${c.digest}"`);
  return catalogue;
}

export function isSafetyKind(kind: string): kind is (typeof SAFETY_KINDS)[number] {
  return (SAFETY_KINDS as readonly string[]).includes(kind);
}

/** The pending question as classifyMessage gets it: her question text and its buttons. */
export function pendingFor(c: ContentCase): ClassifyInput["pending"] {
  if (c.pending === undefined) return undefined;
  const q = QUESTION_BANK.find((entry) => entry.id === c.pending);
  if (!q) throw new Error(`content eval: case ${c.id} names unknown question "${c.pending}"`);
  return { question: q.text, options: [...q.buttons] };
}

// ---------------------------------------------------------------- running

export type Classify = (input: ClassifyInput) => Promise<{ value: MessageClassification; model?: string | undefined }>;

export type ModelOutcome =
  /** The screen caught a non-safety case, so the engine would never ask the model. */
  | { status: "skipped" }
  | { status: "ok"; value: MessageClassification; model: string | undefined; ms: number; tries: number }
  | { status: "error"; error: string; ms: number; tries: number };

export type CaseResult = {
  c: ContentCase;
  screen: SafetyHit | undefined;
  model: ModelOutcome;
  /** What the engine acts on: the screen's kind on a hit (a hit wins), else the model's, else "error". */
  final: MessageKind | "error";
  finalBy: "screen" | "model" | "none";
};

export type EvalDeps = {
  classify: Classify;
  screen?: ((text: string) => SafetyHit | undefined) | undefined;
  /** Calls in flight at once. Default 4. */
  concurrency?: number | undefined;
  /** Least time between two call starts; doubles (up to 4 s) after a call that got no answer. Default 400 ms. */
  spacingMs?: number | undefined;
  /** Pauses before each retry of a call that got no answer. Default 5 s, then 15 s. */
  retryDelaysMs?: readonly number[] | undefined;
  /** After this many calls in a row get no answer, stop calling the model. Default 10. */
  giveUpAfter?: number | undefined;
  sleep?: ((ms: number) => Promise<void>) | undefined;
  now?: (() => number) | undefined;
  onResult?: ((result: CaseResult, done: number, total: number) => void) | undefined;
};

const defaultSleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

/** Every case through the screen and, where the engine would (or where safety is measured), the model. Catalogue order. */
export async function evaluate(catalogue: Catalogue, deps: EvalDeps): Promise<CaseResult[]> {
  const screen = deps.screen ?? screenMessage;
  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.now ?? Date.now;
  const retryDelays = deps.retryDelaysMs ?? [5_000, 15_000];
  const giveUpAfter = deps.giveUpAfter ?? 10;
  let spacing = deps.spacingMs ?? 400;
  let nextStart = 0;
  let failuresInARow = 0;

  // Polite pacing: call starts are spread out across all workers.
  const gate = async () => {
    const t = now();
    const wait = Math.max(0, nextStart - t);
    nextStart = Math.max(t, nextStart) + spacing;
    if (wait > 0) await sleep(wait);
  };

  const callModel = async (c: ContentCase): Promise<ModelOutcome> => {
    const context = c.digest === undefined ? undefined : catalogue.digests?.[c.digest];
    const input: ClassifyInput = { seniorName: catalogue.seniorName, message: c.text, pending: pendingFor(c), ...(context ? { context } : {}) };
    const started = now();
    let lastError = "unknown error";
    for (let tries = 1; tries <= retryDelays.length + 1; tries++) {
      if (failuresInARow >= giveUpAfter) return { status: "error", error: `not called: ${giveUpAfter} calls in a row got no answer`, ms: 0, tries: 0 };
      await gate();
      try {
        const { value, model } = await deps.classify(input);
        failuresInARow = 0;
        return { status: "ok", value, model, ms: now() - started, tries };
      } catch (error) {
        lastError = messageOf(error);
        spacing = Math.min(spacing * 2, 4_000);
        const delay = retryDelays[tries - 1];
        if (delay === undefined) break;
        await sleep(delay);
      }
    }
    failuresInARow += 1;
    return { status: "error", error: lastError, ms: now() - started, tries: retryDelays.length + 1 };
  };

  const cases = catalogue.cases;
  const results: CaseResult[] = new Array(cases.length);
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < cases.length) {
      const index = next++;
      const c = cases[index]!;
      const hit = screen(c.text);
      const model: ModelOutcome = !hit || isSafetyKind(c.expectKind) ? await callModel(c) : { status: "skipped" };
      const result: CaseResult = hit
        ? { c, screen: hit, model, final: hit.kind, finalBy: "screen" }
        : model.status === "ok"
          ? { c, screen: undefined, model, final: model.value.kind, finalBy: "model" }
          : { c, screen: undefined, model, final: "error", finalBy: "none" };
      results[index] = result;
      done += 1;
      deps.onResult?.(result, done, cases.length);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(deps.concurrency ?? 4, cases.length)) }, worker));
  return results;
}

// ---------------------------------------------------------------- scoring

/** The button the model picked, when it called the message an answer. */
export function answerOf(r: CaseResult): string | undefined {
  return r.model.status === "ok" && r.model.value.kind === "answer" ? (r.model.value.answer ?? "unclear") : undefined;
}

/** The topic the model picked, when it called the message a history question. */
export function topicOf(r: CaseResult): HistoryTopic | undefined {
  return r.model.status === "ok" && r.model.value.kind === "history_question" ? (r.model.value.historyTopic ?? "other") : undefined;
}

export function isMismatch(r: CaseResult): boolean {
  if (r.final !== r.c.expectKind) return true;
  if (r.c.expectTopic !== undefined && topicOf(r) !== r.c.expectTopic) return true;
  return r.c.expectAnswer !== undefined && answerOf(r) !== r.c.expectAnswer;
}

const modelKind = (r: CaseResult) => (r.model.status === "ok" ? r.model.value.kind : undefined);
const modelCaught = (r: CaseResult) => {
  const kind = modelKind(r);
  return kind !== undefined && isSafetyKind(kind);
};

type KindScore = { cases: number; finalRight: number; modelSeen: number; modelRight: number };

export type Summary = {
  total: number;
  finalRight: number;
  modelCalls: number;
  modelAnswered: number;
  modelRight: number;
  modelErrors: CaseResult[];
  byKind: Map<MessageKind, KindScore>;
  /** got kind counts per expected kind, "error" included. */
  confusion: Map<MessageKind, Map<MessageKind | "error", number>>;
  answers: { cases: number; right: number; byQuestion: Map<string, { cases: number; right: number }> };
  /** History questions with an expected topic. */
  topics: { cases: number; right: number };
  /** Cases read with a context digest, and how many of them are fully right. */
  withDigest: { cases: number; right: number };
  safety: { cases: CaseResult[]; screenCaught: number; modelCalls: number; modelCaught: number; neither: CaseResult[] };
  /** Non-safety messages that got a safety kind from the screen or the model. */
  falseAlarms: CaseResult[];
  screenMisses: CaseResult[];
  screenFalseHits: CaseResult[];
  mismatches: CaseResult[];
  hard: { cases: number; right: number };
  modelsAnswered: Map<string, number>;
};

export function summarize(results: readonly CaseResult[]): Summary {
  const byKind = new Map<MessageKind, KindScore>(MESSAGE_KINDS.map((k) => [k, { cases: 0, finalRight: 0, modelSeen: 0, modelRight: 0 }]));
  const confusion = new Map<MessageKind, Map<MessageKind | "error", number>>(MESSAGE_KINDS.map((k) => [k, new Map()]));
  const byQuestion = new Map<string, { cases: number; right: number }>();
  const modelsAnswered = new Map<string, number>();
  let finalRight = 0;
  let modelCalls = 0;
  let modelAnswered = 0;
  let modelRight = 0;
  let answerCases = 0;
  let answerRight = 0;
  let hardCases = 0;
  let hardRight = 0;
  const topics = { cases: 0, right: 0 };
  const withDigest = { cases: 0, right: 0 };

  for (const r of results) {
    const score = byKind.get(r.c.expectKind)!;
    score.cases += 1;
    const row = confusion.get(r.c.expectKind)!;
    row.set(r.final, (row.get(r.final) ?? 0) + 1);
    if (r.final === r.c.expectKind) {
      score.finalRight += 1;
      finalRight += 1;
    }
    if (r.model.status !== "skipped") modelCalls += 1;
    if (r.model.status === "ok") {
      modelAnswered += 1;
      score.modelSeen += 1;
      if (r.model.value.kind === r.c.expectKind) {
        score.modelRight += 1;
        modelRight += 1;
      }
      const name = r.model.model ?? "unknown";
      modelsAnswered.set(name, (modelsAnswered.get(name) ?? 0) + 1);
    }
    if (r.c.expectAnswer !== undefined) {
      const q = r.c.pending ?? "none";
      const entry = byQuestion.get(q) ?? { cases: 0, right: 0 };
      entry.cases += 1;
      answerCases += 1;
      if (r.final === "answer" && answerOf(r) === r.c.expectAnswer) {
        entry.right += 1;
        answerRight += 1;
      }
      byQuestion.set(q, entry);
    }
    if (r.c.hard !== undefined) {
      hardCases += 1;
      if (!isMismatch(r)) hardRight += 1;
    }
    if (r.c.expectTopic !== undefined) {
      topics.cases += 1;
      if (r.final === "history_question" && topicOf(r) === r.c.expectTopic) topics.right += 1;
    }
    if (r.c.digest !== undefined) {
      withDigest.cases += 1;
      if (!isMismatch(r)) withDigest.right += 1;
    }
  }

  const safetyCases = results.filter((r) => isSafetyKind(r.c.expectKind));
  return {
    total: results.length,
    finalRight,
    modelCalls,
    modelAnswered,
    modelRight,
    modelErrors: results.filter((r) => r.model.status === "error"),
    byKind,
    confusion,
    answers: { cases: answerCases, right: answerRight, byQuestion },
    topics,
    withDigest,
    safety: {
      cases: safetyCases,
      screenCaught: safetyCases.filter((r) => r.screen !== undefined).length,
      modelCalls: safetyCases.filter((r) => r.model.status !== "skipped").length,
      modelCaught: safetyCases.filter(modelCaught).length,
      neither: safetyCases.filter((r) => r.screen === undefined && !modelCaught(r)),
    },
    falseAlarms: results.filter((r) => !isSafetyKind(r.c.expectKind) && (r.screen !== undefined || modelCaught(r))),
    screenMisses: results.filter((r) => r.c.mustScreen !== undefined && r.screen?.kind !== r.c.mustScreen),
    screenFalseHits: results.filter((r) => r.c.mustNotScreen === true && r.screen !== undefined),
    mismatches: results.filter(isMismatch),
    hard: { cases: hardCases, right: hardRight },
    modelsAnswered,
  };
}

// ---------------------------------------------------------------- report

export type ReportMeta = {
  /** ISO timestamp. */
  generatedAt: string;
  /** The configured model chain, in order. */
  chain: readonly string[];
  /** Every HTTP attempt the LLM client logged, when known. */
  attempts?: readonly AttemptLogEntry[] | undefined;
  /** Catalogue path as shown in the report. */
  cataloguePath?: string | undefined;
};

const pct = (right: number, of: number) => (of === 0 ? "n/a" : `${right} of ${of} (${Math.round((100 * right) / of)}%)`);

function cell(text: string, max = 160): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const cut = flat.length > max ? `${flat.slice(0, max - 3)}...` : flat;
  return cut.replace(/\|/g, "\\|");
}

function expectedLabel(c: ContentCase): string {
  if (c.expectTopic !== undefined) return `${c.expectKind}: ${c.expectTopic}`;
  return c.expectAnswer !== undefined ? `answer: ${c.expectAnswer}` : c.expectKind;
}

function screenLabel(r: CaseResult): string {
  return r.screen ? `${r.screen.kind} ("${r.screen.matched}")` : "missed";
}

function modelLabel(r: CaseResult): string {
  switch (r.model.status) {
    case "skipped":
      return "not called (screen hit)";
    case "error":
      return `no answer (${r.model.error})`;
    case "ok": {
      const v = r.model.value;
      if (v.kind === "history_question") return `history_question: ${v.historyTopic ?? "other"} (${v.confidence})`;
      return v.kind === "answer" ? `answer: ${v.answer ?? "unclear"} (${v.confidence})` : `${v.kind} (${v.confidence})`;
    }
  }
}

/** What the engine would act on, and who decided. */
export function gotLabel(r: CaseResult): string {
  if (r.finalBy === "screen") return `${r.final} (screen: "${r.screen?.matched ?? ""}")`;
  return modelLabel(r);
}

function questionLabel(c: ContentCase): string {
  return c.pending ?? "none";
}

export function renderReport(results: readonly CaseResult[], meta: ReportMeta): string {
  const s = summarize(results);
  const lines: string[] = [];
  const push = (...more: string[]) => lines.push(...more);
  const table = (header: string[], rows: string[][]) => {
    push(`| ${header.join(" | ")} |`, `| ${header.map(() => "---").join(" | ")} |`);
    for (const row of rows) push(`| ${row.join(" | ")} |`);
  };

  const kindCounts = MESSAGE_KINDS.map((k) => `${k} ${s.byKind.get(k)?.cases ?? 0}`).join(", ");
  const attempts = meta.attempts ?? [];
  const busy = attempts.filter((a) => a.status !== 200).length;
  const answeredBy = [...s.modelsAnswered.entries()].sort((a, b) => b[1] - a[1]).map(([m, n]) => `${m} (${n})`);

  push(
    "# Content eval",
    "",
    `Written by \`npm run content:eval\` (apps/server/src/cli/content-eval.ts) on ${meta.generatedAt.slice(0, 16).replace("T", " ")} UTC from \`${meta.cataloguePath ?? "fixtures/content/messages.json"}\`. Rerun to refresh; do not edit by hand.`,
    "",
    "Each message goes through the fixed phrase screen (src/safety/screen.ts), then the live classifyMessage when the screen lets it through, and always for crisis and urgent cases (to measure the model as the backup). \"Final\" is what the engine acts on: a screen hit wins, else the model's kind. A case with a digest is read with that context digest (src/context/digest.ts), as in the agent.",
    "",
    `- Cases: ${s.total} (${kindCounts}); hard cases ${s.hard.cases}`,
    `- Models configured: ${meta.chain.join(", ") || "none"}`,
    `- Answered by: ${answeredBy.join(", ") || "none"}`,
    `- Model calls: ${s.modelCalls} classifyMessage calls, ${s.modelAnswered} answered, ${s.modelErrors.length} got no answer; ${attempts.length} HTTP attempts, ${busy} of them busy or failed`,
    `- Final kind right: ${pct(s.finalRight, s.total)}; model alone right: ${pct(s.modelRight, s.modelAnswered)}`,
    `- Answers mapped to the right button: ${pct(s.answers.right, s.answers.cases)}`,
    `- History topic picked right: ${pct(s.topics.right, s.topics.cases)}; cases read with a context digest fully right: ${pct(s.withDigest.right, s.withDigest.cases)}`,
    `- Hard cases fully right: ${pct(s.hard.right, s.hard.cases)}`,
    "",
  );

  // Safety first.
  push(
    "## Safety (crisis and urgent symptom)",
    "",
    `${s.safety.cases.length} safety cases. Screen caught ${pct(s.safety.screenCaught, s.safety.cases.length)}; model caught ${pct(s.safety.modelCaught, s.safety.modelCalls)} (any safety kind counts as caught); caught by neither: ${s.safety.neither.length}.`,
    "",
    "### Critical: caught by neither",
    "",
  );
  if (s.safety.neither.length === 0) push("None. Every crisis and urgent case was caught by the screen, the model, or both.", "");
  else {
    table(
      ["id", "text", "expected", "model said"],
      s.safety.neither.map((r) => [r.c.id, cell(r.c.text), r.c.expectKind, cell(modelLabel(r))]),
    );
    push("");
  }

  push("### Every safety case", "");
  table(
    ["id", "text", "expected", "mustScreen", "screen", "model", "caught by"],
    s.safety.cases.map((r) => {
      const by = [r.screen ? "screen" : "", modelCaught(r) ? "model" : ""].filter(Boolean).join(" + ") || "**NEITHER**";
      return [r.c.id, cell(r.c.text, 100), r.c.expectKind, r.c.mustScreen ? "yes" : "", cell(screenLabel(r)), cell(modelLabel(r)), by];
    }),
  );
  push("");

  push("### Screen contract", "");
  if (s.screenMisses.length === 0 && s.screenFalseHits.length === 0) push("Every mustScreen case was caught with its kind, and no mustNotScreen case was caught.", "");
  else {
    table(
      ["id", "text", "catalogue says", "screen got"],
      [
        ...s.screenMisses.map((r) => [r.c.id, cell(r.c.text), `mustScreen ${r.c.mustScreen ?? ""}`, cell(screenLabel(r))]),
        ...s.screenFalseHits.map((r) => [r.c.id, cell(r.c.text), "mustNotScreen", cell(screenLabel(r))]),
      ],
    );
    push("");
  }

  push("### False alarms (a safety kind on a message that is not one)", "");
  if (s.falseAlarms.length === 0) push("None.", "");
  else {
    table(
      ["id", "text", "expected", "screen", "model"],
      s.falseAlarms.map((r) => [r.c.id, cell(r.c.text), expectedLabel(r.c), cell(r.screen ? screenLabel(r) : ""), cell(modelLabel(r))]),
    );
    push("");
  }

  push("## Accuracy by kind", "");
  table(
    ["expected kind", "cases", "final right", "model alone right"],
    MESSAGE_KINDS.map((k) => {
      const score = s.byKind.get(k)!;
      return [k, String(score.cases), pct(score.finalRight, score.cases), pct(score.modelRight, score.modelSeen)];
    }),
  );
  push("", "Final kind by expected kind (rows expected, columns got):", "");
  const columns: (MessageKind | "error")[] = [...MESSAGE_KINDS, "error"];
  table(
    ["expected \\ got", ...columns],
    MESSAGE_KINDS.map((k) => {
      const row = s.confusion.get(k)!;
      return [k, ...columns.map((g) => {
        const n = row.get(g) ?? 0;
        return n === 0 ? "" : g === k ? `**${n}**` : String(n);
      })];
    }),
  );
  push("");

  push(
    "## Answer mapping",
    "",
    `Cases with an expected button (or "unclear"): ${pct(s.answers.right, s.answers.cases)} right (kind answer and the same button).`,
    "",
  );
  table(
    ["pending question", "cases", "right"],
    [...s.answers.byQuestion.entries()].map(([q, v]) => [q, String(v.cases), pct(v.right, v.cases)]),
  );
  push("");

  push("## Mismatches", "");
  if (s.mismatches.length === 0) push("None.", "");
  else {
    table(
      ["id", "text", "pending", "expected", "got", "hard", "note"],
      s.mismatches.map((r) => [
        r.c.id,
        cell(r.c.text),
        questionLabel(r.c),
        expectedLabel(r.c),
        cell(gotLabel(r)),
        r.c.hard ?? "",
        cell(r.c.note ?? "", 120),
      ]),
    );
    push("");
  }

  if (s.modelErrors.length > 0) {
    push("## Calls that got no answer", "");
    table(
      ["id", "error"],
      s.modelErrors.map((r) => [r.c.id, cell(r.model.status === "error" ? r.model.error : "")]),
    );
    push("");
  }

  return `${lines.join("\n").replace(/\n+$/, "")}\n`;
}

/** The few lines printed at the end of a run. */
export function summaryLines(results: readonly CaseResult[]): string[] {
  const s = summarize(results);
  return [
    `Safety: ${s.safety.cases.length} cases; screen caught ${s.safety.screenCaught}, model caught ${s.safety.modelCaught} of ${s.safety.modelCalls}, caught by neither ${s.safety.neither.length}${s.safety.neither.length > 0 ? ` (${s.safety.neither.map((r) => r.c.id).join(", ")})` : ""}`,
    `Screen contract: ${s.screenMisses.length} mustScreen missed, ${s.screenFalseHits.length} mustNotScreen caught; false alarms ${s.falseAlarms.length}`,
    `Kinds: final right ${pct(s.finalRight, s.total)}, model alone ${pct(s.modelRight, s.modelAnswered)}`,
    `Answers: ${pct(s.answers.right, s.answers.cases)} mapped right; history topics ${pct(s.topics.right, s.topics.cases)}; with a digest ${pct(s.withDigest.right, s.withDigest.cases)}`,
    `Mismatches: ${s.mismatches.length}; calls with no answer: ${s.modelErrors.length}`,
  ];
}

// ---------------------------------------------------------------- CLI

export type MainDeps = CreateLlmDeps & {
  reportPath?: string | undefined;
  catalogue?: Catalogue | undefined;
  evalDeps?: Omit<EvalDeps, "classify"> | undefined;
};

export async function main(
  env: Record<string, string | undefined> = process.env,
  out = (line: string) => console.log(line),
  deps: MainDeps = {},
): Promise<number> {
  const { reportPath = REPORT_PATH, catalogue: given, evalDeps, ...llmDeps } = deps;
  let config: Config;
  try {
    config = loadConfig(env);
  } catch (error) {
    out(`error: ${error instanceof ConfigError ? error.message : messageOf(error)}`);
    return 1;
  }
  const missing = missingSetup(config);
  const probe = createLlmClient(config, llmDeps);
  if (missing.length > 0 || !probe) {
    out("Content eval: .env is missing:");
    for (const m of missing) out(`  - ${m}`);
    out("Nothing was called; the report was not changed.");
    return 1;
  }
  if (typeof probe.classifyMessage !== "function") {
    out(`Content eval: the ${probe.provider} client has no classifyMessage yet. Nothing was called; the report was not changed.`);
    return 1;
  }

  const catalogue = given ?? loadCatalogue();
  const attempts: AttemptLogEntry[] = [];
  const classify: Classify = async (input) => {
    // One client per call, so each call's attempts (and the model that answered) stay its own.
    const mine: AttemptLogEntry[] = [];
    const client = createLlmClient(config, {
      ...llmDeps,
      logger: (entry) => {
        mine.push(entry);
        attempts.push(entry);
      },
    });
    if (!client) throw new Error("no LLM client");
    const value = await client.classifyMessage(input);
    return { value, model: mine.find((a) => a.status === 200)?.model };
  };

  out(`Content eval: ${catalogue.cases.length} messages; ${describeLlm(config)}`);
  const results = await evaluate(catalogue, {
    ...evalDeps,
    classify,
    onResult: (r, done, total) => {
      const mark = isMismatch(r) ? "MISS" : "ok  ";
      const detail = isMismatch(r) ? `expected ${expectedLabel(r.c)}, got ${gotLabel(r)}` : gotLabel(r);
      out(`  [${String(done).padStart(3)}/${total}] ${mark} ${r.c.id}: ${detail}`);
    },
  });

  writeFileSync(
    reportPath,
    renderReport(results, {
      generatedAt: new Date().toISOString(),
      chain: config.llm.geminiModels,
      attempts,
      cataloguePath: relative(REPO_ROOT, CATALOGUE_PATH),
    }),
  );
  for (const line of summaryLines(results)) out(line);
  const shown = relative(REPO_ROOT, reportPath);
  out(`Report: ${shown.startsWith("..") ? reportPath : shown}`);
  return 0;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
