import { createHash, timingSafeEqual } from "node:crypto";
import express from "express";
import type { ErrorRequestHandler, Express, RequestHandler } from "express";
import type { Config } from "./config.ts";

// The HTTP app. Kept separate from src/server.ts so tests can start it on port 0.

export const SERVICE_NAME = "mhacks2026-server";

export type AppDeps = {
  config: Pick<Config, "finchnode">;
  /** Narrow server-tool surface exposed to ElevenLabs. It accepts identifiers and structured state only, never media. */
  calls?: {
    screen(callId: string): Promise<unknown>;
    beginQuietMeasurement(callId: string, permissionGranted: boolean): Promise<unknown>;
    /** After the quiet minute: the heart rate as a camera estimate and the ladder's line, as fixed copy. */
    vitalsReadback?(callId: string): Promise<{ status: string; patientResponseText: string }>;
    toolSecret?: string | undefined;
  };
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

  if (deps.calls) app.use("/integrations/elevenlabs", callToolRouter(deps.calls));

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

function callToolRouter(calls: NonNullable<AppDeps["calls"]>): express.Router {
  const router = express.Router();
  router.use(express.json({ limit: "32kb" }));
  router.use((req, res, next) => {
    const expected = calls.toolSecret;
    const received = req.header("authorization")?.replace(/^Bearer\s+/i, "");
    if (!expected || received === undefined || !sameSecret(received, expected)) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    next();
  });
  router.post("/screen-symptoms", async (req, res, next) => {
    const callId = typeof req.body?.callId === "string" ? req.body.callId.trim() : "";
    if (!callId) {
      res.status(400).json({ error: "callId_required" });
      return;
    }
    try {
      // Only the fixed words she hears; the level and everything else stay on the server.
      const result = (await calls.screen(callId)) as { patientResponseText?: unknown };
      res.json({ patientResponseText: typeof result.patientResponseText === "string" && result.patientResponseText ? result.patientResponseText : "Thank you for telling me." });
    } catch (error) {
      next(error);
    }
  });
  router.post("/quiet-measurement", async (req, res, next) => {
    const callId = typeof req.body?.callId === "string" ? req.body.callId.trim() : "";
    const permissionGranted = req.body?.permissionGranted === true;
    if (!callId) {
      res.status(400).json({ error: "callId_required" });
      return;
    }
    try {
      res.json(await calls.beginQuietMeasurement(callId, permissionGranted));
    } catch (error) {
      next(error);
    }
  });
  router.post("/vitals-result", async (req, res, next) => {
    const callId = typeof req.body?.callId === "string" ? req.body.callId.trim() : "";
    if (!callId) {
      res.status(400).json({ error: "callId_required" });
      return;
    }
    if (!calls.vitalsReadback) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    try {
      const result = await calls.vitalsReadback(callId);
      res.json({ status: result.status, patientResponseText: result.patientResponseText });
    } catch (error) {
      next(error);
    }
  });
  return router;
}

/** Constant-time comparison of the tool secret (hashed first, so lengths never leak through timing). */
function sameSecret(received: string, expected: string): boolean {
  const digest = (s: string) => createHash("sha256").update(s, "utf8").digest();
  return timingSafeEqual(digest(received), digest(expected));
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
