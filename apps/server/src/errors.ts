/** An error for a log line: its name and message only, no stack and no request data. */
export function errorSummary(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return "non-error thrown";
}
