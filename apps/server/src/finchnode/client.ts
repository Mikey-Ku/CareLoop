import {
  ConnectSessionWireSchema,
  ErrorBodySchema,
  HealthRecordSchema,
  ScenarioListSchema,
  type Category,
  type HealthRecord,
  type ScenarioList,
} from "./types.ts";
import { retryAfterMs } from "../http.ts";

export class FinchNodeError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId: string | undefined;

  constructor(status: number, code: string, message: string, requestId?: string) {
    super(message);
    this.name = "FinchNodeError";
    this.status = status;
    this.code = code;
    this.requestId = requestId;
  }
}

/** 410 consent_inactive: the patient revoked sharing or it expired. Stop reading this subject. */
export class ConsentInactiveError extends FinchNodeError {}
/** 403 consent_scope_exceeded: the patient didn't share a category we asked for. */
export class ConsentScopeError extends FinchNodeError {}
/** 404: unknown subject, or deleted at the patient's request. */
export class SubjectNotFoundError extends FinchNodeError {}
/** 429 after every retry was used. */
export class RateLimitedError extends FinchNodeError {}

export type ConnectSession = {
  id: string;
  status: "completed" | "canceled" | "failed" | "pending";
  subject: string | undefined;
  failureCode: string | undefined;
  url: string | undefined;
};

export type FinchNodeClientOptions = {
  baseUrl: string;
  apiKey?: string | undefined;
  fetch?: typeof fetch;
  maxRetries?: number;
  maxRetryDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
};

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class FinchNodeClient {
  readonly #baseUrl: string;
  readonly #apiKey: string | undefined;
  readonly #fetch: typeof fetch;
  readonly #maxRetries: number;
  readonly #maxRetryDelayMs: number;
  readonly #sleep: (ms: number) => Promise<void>;

  constructor(options: FinchNodeClientOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.#apiKey = options.apiKey || undefined;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#maxRetries = options.maxRetries ?? 3;
    this.#maxRetryDelayMs = options.maxRetryDelayMs ?? 10_000;
    this.#sleep = options.sleep ?? defaultSleep;
  }

  /** One snapshot. Without `categories`, FinchNode returns every category the patient shared. */
  async getHealthRecord(subject: string, options: { categories?: Category[] } = {}): Promise<HealthRecord> {
    const query = options.categories?.length ? `?categories=${options.categories.join(",")}` : "";
    const body = await this.#request("GET", `/users/${encodeURIComponent(subject)}/records${query}`);
    return HealthRecordSchema.parse(body);
  }

  async listScenarios(): Promise<ScenarioList> {
    return ScenarioListSchema.parse(await this.#request("GET", "/scenarios"));
  }

  async createConnectSession(input: {
    externalUserId: string;
    categories?: Category[];
    scenario?: string;
  }): Promise<ConnectSession> {
    const body = await this.#request("POST", "/connect/sessions", {
      external_user_id: input.externalUserId,
      ...(input.categories ? { categories: input.categories } : {}),
      ...(input.scenario ? { scenario: input.scenario } : {}),
    });
    return normalizeConnectSession(body);
  }

  async #request(method: string, path: string, json?: unknown): Promise<unknown> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (json !== undefined) headers["Content-Type"] = "application/json";
    if (this.#apiKey) headers["Authorization"] = `Bearer ${this.#apiKey}`;

    for (let attempt = 0; ; attempt++) {
      const response = await this.#fetch(`${this.#baseUrl}${path}`, {
        method,
        headers,
        ...(json !== undefined ? { body: JSON.stringify(json) } : {}),
      });
      if (response.ok) return response.json();

      if (response.status === 429 && attempt < this.#maxRetries) {
        const wait = retryAfterMs(response.headers.get("retry-after")) ?? 1000 * 2 ** attempt;
        await this.#sleep(Math.min(wait, this.#maxRetryDelayMs));
        continue;
      }
      throw await toError(response);
    }
  }
}

async function toError(response: Response): Promise<FinchNodeError> {
  let code = `http_${response.status}`;
  let message = response.statusText || code;
  let requestId = response.headers.get("x-request-id") ?? undefined;
  try {
    const parsed = ErrorBodySchema.safeParse(await response.json());
    if (parsed.success) {
      code = parsed.data.error.code;
      message = parsed.data.error.message ?? message;
      requestId = parsed.data.error.requestId ?? requestId;
    }
  } catch {
    // Non-JSON error body; keep the status-based code.
  }
  if (response.status === 410) return new ConsentInactiveError(410, code, message, requestId);
  if (response.status === 403 && code === "consent_scope_exceeded")
    return new ConsentScopeError(403, code, message, requestId);
  if (response.status === 404) return new SubjectNotFoundError(404, code, message, requestId);
  if (response.status === 429) return new RateLimitedError(429, code, message, requestId);
  return new FinchNodeError(response.status, code, message, requestId);
}

const SESSION_STATUS: Record<string, ConnectSession["status"]> = {
  complete: "completed",
  completed: "completed",
  cancelled: "canceled",
  canceled: "canceled",
  failed: "failed",
};

export function normalizeConnectSession(body: unknown): ConnectSession {
  const wire = ConnectSessionWireSchema.parse(body);
  return {
    id: wire.id,
    status: SESSION_STATUS[wire.status] ?? "pending",
    subject: wire.subject ?? wire.patient_id ?? undefined,
    failureCode: wire.failureCode ?? wire.failure_code ?? undefined,
    url: wire.url ?? wire.connect_url ?? undefined,
  };
}
