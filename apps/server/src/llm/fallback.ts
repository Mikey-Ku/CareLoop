import { LlmUnavailableError } from "./types.ts";

// Runs one LLM request across a chain of models under one time budget.
// Each model gets one retry for a passing problem (503, 429, 5xx, network,
// per-attempt timeout) after a short jittered pause; a request the model can
// never answer (400, 401, 403, 404: wrong request, bad key, model gone) moves
// straight to the next model. When nothing answers in time the call throws
// LlmUnavailableError naming what each attempt got, never the key, and the
// caller falls back to buttons or a template.

/** What one attempt ended with: an HTTP status, or what went wrong before a usable one. */
export type AttemptStatus = number | "network" | "timeout" | "aborted" | "empty";

export type AttemptLogEntry = {
  /** "mapAnswer" or "smallTalk". */
  operation: string;
  model: string;
  /** 1 for the first try at this model, 2 for its retry. */
  attempt: number;
  status: AttemptStatus;
  ms: number;
};

export type LlmLogger = (entry: AttemptLogEntry) => void;

/** One line for a log file: `[llm] mapAnswer gemini-flash-latest #1 503 412ms`. */
export function formatAttempt(entry: AttemptLogEntry): string {
  return `[llm] ${entry.operation} ${entry.model} #${entry.attempt} ${entry.status} ${Math.round(entry.ms)}ms`;
}

/**
 * What an attempt function returns. `empty` is a 200 with nothing usable in it
 * (no candidates, a blocked prompt): another model may do better, the same one won't.
 */
export type AttemptResult<T> =
  | { ok: true; value: T }
  | { ok: false; status: number | "empty"; retryAfterMs?: number | undefined };

export type ChainDeps = {
  logger?: LlmLogger | undefined;
  /** Waits before a retry; must reject when the signal aborts. */
  sleep?: ((ms: number, signal: AbortSignal) => Promise<void>) | undefined;
  /** 0 to 1, for the retry jitter. */
  random?: (() => number) | undefined;
  /** Milliseconds, for timings. */
  now?: (() => number) | undefined;
};

export type ChainRequest<T> = {
  operation: string;
  models: readonly string[];
  /** The whole call: every attempt, pause and fallback. */
  budgetMs: number;
  /** Cap on a single attempt, so a hung model leaves time for the next. Defaults to the whole budget. */
  attemptTimeoutMs?: number | undefined;
  /** The caller's signal: aborting it ends the call at once. */
  signal?: AbortSignal | undefined;
  /** Make one request to `model`. Throwing means a network failure; `signal` must be passed to fetch. */
  attempt: (model: string, signal: AbortSignal) => Promise<AttemptResult<T>>;
};

export type ChainResult<T> = { value: T; model: string };

/** Longest Retry-After we honour; anything longer is cut to this. */
export const MAX_RETRY_AFTER_MS = 2_000;
const RETRY_BASE_MS = 250;
const RETRY_JITTER_MS = 500;

export async function callWithFallback<T>(request: ChainRequest<T>, deps: ChainDeps = {}): Promise<ChainResult<T>> {
  const { operation, models, budgetMs } = request;
  const now = deps.now ?? (() => performance.now());
  const sleep = deps.sleep ?? abortableSleep;
  const random = deps.random ?? Math.random;
  const log = deps.logger ?? (() => {});

  if (request.signal?.aborted) throw new LlmUnavailableError(`${operation}: aborted before any model was tried`);
  if (models.length === 0) throw new LlmUnavailableError(`${operation}: no models configured`);

  // One controller for the whole call: the budget timer and the caller's signal both abort it.
  const call = new AbortController();
  let callerAborted = false;
  const onCallerAbort = () => {
    callerAborted = true;
    call.abort(new Error("aborted by caller"));
  };
  request.signal?.addEventListener("abort", onCallerAbort, { once: true });
  const budgetTimer = setTimeout(() => call.abort(new Error("time budget used up")), budgetMs);
  const deadline = now() + budgetMs;
  const failures: string[] = [];

  try {
    for (const model of models) {
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        if (call.signal.aborted) break;
        const started = now();
        const attemptSignal = request.attemptTimeoutMs
          ? AbortSignal.any([call.signal, AbortSignal.timeout(request.attemptTimeoutMs)])
          : call.signal;
        let status: AttemptStatus;
        let retryAfterMs: number | undefined;
        try {
          const result = await raceAbort(request.attempt(model, attemptSignal), attemptSignal);
          if (result.ok) {
            log({ operation, model, attempt, status: 200, ms: now() - started });
            return { value: result.value, model };
          }
          status = result.status;
          retryAfterMs = result.retryAfterMs;
        } catch {
          if (callerAborted) status = "aborted";
          else if (attemptSignal.aborted) status = "timeout";
          else status = "network";
        }
        log({ operation, model, attempt, status, ms: now() - started });
        failures.push(`${model} ${status}`);
        // A busy model (503, 429, timeout) stays busy for a while: try the next model now instead of waiting on this one.
        if (call.signal.aborted || !isRetryable(status) || isBusy(status) || attempt === 2) break;

        const pause = retryAfterMs !== undefined ? Math.min(retryAfterMs, MAX_RETRY_AFTER_MS) : RETRY_BASE_MS + random() * RETRY_JITTER_MS;
        if (now() + pause >= deadline) break; // no time to retry this one; try the next model
        try {
          await sleep(pause, call.signal);
        } catch {
          break;
        }
      }
      if (call.signal.aborted) break;
    }
  } finally {
    clearTimeout(budgetTimer);
    request.signal?.removeEventListener("abort", onCallerAbort);
  }

  const tried = failures.length > 0 ? failures.join(", ") : "nothing tried";
  if (callerAborted) throw new LlmUnavailableError(`${operation}: aborted (${tried})`);
  const budgetNote = call.signal.aborted ? `; the ${budgetMs} ms budget ran out` : "";
  throw new LlmUnavailableError(`${operation}: no model answered (${tried})${budgetNote}`);
}

/** The model is overloaded or slow right now; on 2026-10-03 the free tier's 503s lasted minutes per model while others answered. */
export function isBusy(status: AttemptStatus): boolean {
  return status === 503 || status === 429 || status === "timeout";
}

/** A passing problem worth one more try at the same model. */
export function isRetryable(status: AttemptStatus): boolean {
  if (status === "network" || status === "timeout") return true;
  if (typeof status !== "number") return false;
  return status === 408 || status === 429 || status >= 500;
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Settles with `promise`, or rejects as soon as `signal` aborts, even if the promise ignores it. */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    promise.catch(() => {});
    return Promise.reject(signal.reason);
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}
