// Records FinchNode demo API responses into fixtures/finchnode/ so tests run offline.
// Run from apps/server: `npm run record-fixtures`. Demo API only (synthetic data, no key).

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RxNavCache } from "../apps/server/src/finchnode/rxnav.ts";

const DEMO_BASE_URL = "https://api.finchnode.com/demo/v1";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "fixtures", "finchnode");
const KEPT_HEADERS = ["retry-after", "ratelimit-limit", "ratelimit-remaining", "ratelimit-reset", "x-finchnode-scenario"];

type Recorded = {
  request: { method: string; path: string; body?: unknown };
  status: number;
  headers: Record<string, string>;
  body: unknown;
};

async function record(method: string, path: string, body?: unknown): Promise<Recorded> {
  const response = await fetch(`${DEMO_BASE_URL}${path}`, {
    method,
    headers: { Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const headers: Record<string, string> = {};
  for (const name of KEPT_HEADERS) {
    const value = response.headers.get(name);
    if (value !== null) headers[name] = value;
  }
  const text = await response.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // keep raw text
  }
  return { request: { method, path, ...(body ? { body } : {}) }, status: response.status, headers, body: parsed };
}

function save(name: string, recorded: Recorded): void {
  const file = join(outDir, `${name}.json`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(recorded, null, 2) + "\n");
  console.log(`${recorded.status} ${recorded.request.method} ${recorded.request.path} -> fixtures/finchnode/${name}.json`);
}

const scenarios = await record("GET", "/scenarios");
save("scenarios", scenarios);
const list = (scenarios.body as { data: { id: string; kind: string; subject?: string | null }[] }).data;

for (const scenario of list) {
  if (scenario.kind === "session") {
    save(
      `connect/${scenario.id}`,
      await record("POST", "/connect/sessions", { external_user_id: "fixture-user", scenario: scenario.id }),
    );
    continue;
  }
  if (!scenario.subject) continue;
  save(`records/${scenario.subject}`, await record("GET", `/users/${scenario.subject}/records`));
}

// consent-partial: asking for an unshared category returns 403 consent_scope_exceeded.
save(
  "records/patient-demo-consent-partial.labs",
  await record("GET", "/users/patient-demo-consent-partial/records?categories=labs"),
);

// A completed session for the demo patient.
save(
  "connect/polypharmacy-senior",
  await record("POST", "/connect/sessions", { external_user_id: "fixture-user", scenario: "polypharmacy-senior" }),
);

// rate-limited: burst until the demo returns 429 (it uses short slots), then keep that response.
let limited: Recorded | undefined;
for (let i = 0; i < 20 && !limited; i++) {
  const r = await record("GET", "/users/patient-demo-rate-limited/records");
  if (r.status === 429) limited = r;
}
if (limited) save("records/patient-demo-rate-limited.429", limited);
else console.log("rate-limited: no 429 within 20 requests; tests use a synthetic 429 instead");

// RxNav: look up every free-text medication name that has no RxNorm code.
const rxnav = RxNavCache.load(join(root, "fixtures", "rxnav-cache.json"));
for (const scenario of list) {
  if (!scenario.subject) continue;
  const r = await record("GET", `/users/${scenario.subject}/records?categories=medications`);
  if (r.status !== 200) continue;
  const meds = (r.body as { data: { medications?: { name?: string; codes?: { system: string }[] }[] } }).data.medications ?? [];
  for (const med of meds) {
    const hasRxNorm = med.codes?.some((c) => c.system.includes("rxnorm"));
    if (!hasRxNorm && med.name) {
      const match = await rxnav.lookup(med.name);
      console.log(`rxnav: "${med.name}" -> ${match ? match.rxcui : "no match"}`);
    }
  }
}
rxnav.save();
console.log("rxnav cache -> fixtures/rxnav-cache.json");
