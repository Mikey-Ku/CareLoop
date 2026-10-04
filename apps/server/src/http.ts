// Small HTTP helpers shared by the API clients (FinchNode, Gemini).

/**
 * Retry-After as milliseconds: delay-seconds or an HTTP date (RFC 9110), never negative.
 * Undefined when the header is absent, blank or unreadable, so the caller uses its own backoff
 * (a blank header must not mean "retry now").
 */
export function retryAfterMs(header: string | null | undefined, nowMs = Date.now()): number | undefined {
  const value = header?.trim();
  if (!value) return undefined;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Math.max(0, Math.round(Number(value) * 1000));
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - nowMs);
}
