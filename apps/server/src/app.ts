import express from "express";
import type { ErrorRequestHandler, Express, RequestHandler } from "express";
import type { Config } from "./config.ts";
import { isCalendarDay } from "./days.ts";
import { errorSummary } from "./errors.ts";

// The HTTP app. Kept separate from src/server.ts so tests can start it on port 0.

export const SERVICE_NAME = "mhacks2026-server";

export type AppDeps = {
  config: Pick<Config, "finchnode">;
  /**
   * The doctor report page for a patient and the week ending on `day` (default her latest check-in date),
   * or undefined for an unknown patient (src/report). Without it, /report is not served.
   */
  doctorReport?: (patientId: string, day: string | undefined) => string | undefined;
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

  // The doctor report, the shareable link (docs/BRIEF.md feature 4). Local only, synthetic data: the
  // call tools' public tunnel forwards this port, so a request through a tunnel or proxy gets a 404.
  const doctorReport = deps.doctorReport;
  if (doctorReport)
    app.get("/report/:patientId", (req, res, next) => {
      if (["x-forwarded-for", "forwarded", "cf-connecting-ip"].some((h) => req.get(h) !== undefined)) {
        next();
        return;
      }
      const day = typeof req.query.day === "string" ? req.query.day : undefined;
      if (day !== undefined && !isCalendarDay(day)) {
        res.status(400).json({ error: "bad_request" });
        return;
      }
      try {
        const html = doctorReport(req.params.patientId, day);
        if (html === undefined) {
          res.status(404).json({ error: "not_found" });
          return;
        }
        res.set("Cache-Control", "no-store").type("html").send(html);
      } catch (error) {
        next(error);
      }
    });


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
