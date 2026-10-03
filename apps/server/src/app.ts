import express from "express";
import type { ErrorRequestHandler, Express, RequestHandler } from "express";
import type { Config } from "./config.ts";

// The HTTP app. Kept separate from src/server.ts so tests can start it on port 0.

export const SERVICE_NAME = "mhacks2026-server";

export type AppDeps = {
  config: Pick<Config, "finchnode">;
  /** Where server-side errors are reported. Never receives request bodies or secrets. */
  logError?: (line: string) => void;
};

export function createApp(deps: AppDeps): Express {
  const logError = deps.logError ?? ((line: string) => console.error(line));
  const finchnodeHost = hostOf(deps.config.finchnode.baseUrl);

  const app = express();
  app.disable("x-powered-by");

  app.get("/health", (_req, res) => {
    res.json({ ok: true, service: SERVICE_NAME, finchnode: finchnodeHost });
  });

  app.use("/webhooks/relay", relayWebhookRouter());

  const notFound: RequestHandler = (_req, res) => {
    res.status(404).json({ error: "not_found" });
  };
  app.use(notFound);

  const onError: ErrorRequestHandler = (err: unknown, _req, res, next) => {
    if (res.headersSent) return next(err);
    const status = statusOf(err);
    if (status >= 500) logError(`[app] ${errorSummary(err)}`);
    // Client errors (bad body, too large) get a generic code; nothing from the error object leaks.
    res.status(status).json({ error: status >= 500 ? "internal_error" : "bad_request" });
  };
  app.use(onError);

  return app;
}

/**
 * Placeholder for the Relay webhook (docs/DESIGN.md "Relay"). The body is kept raw
 * because the Standard Webhooks signature check in run 2 must run on the exact bytes.
 */
function relayWebhookRouter(): express.Router {
  const router = express.Router();
  router.use(express.raw({ type: "*/*", limit: "1mb" }));
  router.all("/", (_req, res) => {
    res.status(501).json({ error: "not_implemented", message: "not implemented until run 2" });
  });
  return router;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "invalid";
  }
}

function statusOf(err: unknown): number {
  if (typeof err === "object" && err !== null) {
    const s = (err as { status?: unknown; statusCode?: unknown }).status ?? (err as { statusCode?: unknown }).statusCode;
    if (typeof s === "number" && s >= 400 && s <= 599) return s;
  }
  return 500;
}

/** Error name and message only: no stack, no request data. */
function errorSummary(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return "non-error thrown";
}
