import { createApp } from "./app.ts";
import { loadConfig } from "./config.ts";

// Entry point for `npm run dev`. Reads config from the environment (.env via --env-file-if-exists).

const config = loadConfig();
const app = createApp({ config });

const server = app.listen(config.port, (err?: Error) => {
  if (err) {
    console.error(`[server] could not listen on port ${config.port}: ${err.message}`);
    process.exit(1);
  }
  console.log(`[server] listening on http://localhost:${config.port}`);
});

let stopping = false;
function shutdown(signal: NodeJS.Signals): void {
  if (stopping) return;
  stopping = true;
  console.log(`[server] ${signal} received, shutting down`);
  server.close(() => process.exit(0));
  server.closeIdleConnections();
  // Do not hang forever on open keep-alive connections.
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
