import type { Clock } from "../checkin/engine-types.ts";
import type { DayFinished } from "../checkin/engine.ts";
import type { Db } from "../db/index.ts";
import type { LlmClient } from "../llm/types.ts";
import { loadRxNavCache } from "../finchnode/fixtures.ts";
import type { CareInboundSource, CareMessenger } from "../photon/care-messenger.ts";
import { PhotonMessenger, connectPhoton } from "../photon/photon-messenger.ts";
import type { CareConfig } from "./config.ts";
import { loadCareContacts, type CareContacts } from "./contacts.ts";
import type { ReplyWriter } from "./replies.ts";
import { createCareService, type CareService } from "./service.ts";
import { GeminiCareWriter } from "./writer.ts";

// The care summaries as the agent runs them: the service, its Photon listener for replies,
// and the two hooks the agent calls (a check-in ended; the noon job ran). startCareRuntime
// takes a transport so tests and the simulator run it without Photon.

export type CareRuntime = {
  service: CareService;
  /** For EngineOptions.onDayFinished. */
  onDayFinished(event: DayFinished): Promise<void>;
  /** After the noon job: a summary for the day if none went out (check-in left unfinished). */
  afterMissedCheckin(day: string): Promise<void>;
  stop(): Promise<void>;
};

export type CareRuntimeDeps = {
  db: Db;
  patientId: string;
  contacts: CareContacts;
  clock: Clock;
  messenger: CareMessenger;
  /** Replies are only received when given. */
  inbound?: CareInboundSource;
  writer?: ReplyWriter;
  log?: (line: string) => void;
  /** Called with stop() of the transport, if it has one. */
  closeTransport?: () => Promise<void>;
};

export function startCareRuntime(deps: CareRuntimeDeps): CareRuntime {
  const log = deps.log ?? ((line: string) => console.log(line));
  let rxnav: ReturnType<typeof loadRxNavCache> | undefined;
  const service = createCareService({
    db: deps.db,
    patientId: deps.patientId,
    contacts: deps.contacts,
    messenger: deps.messenger,
    clock: deps.clock,
    rxnav: () => (rxnav ??= loadRxNavCache()),
    ...(deps.writer ? { writer: deps.writer } : {}),
    log,
  });

  const abort = new AbortController();
  const listening = deps.inbound
    ? deps.inbound
        .listen(async (m) => {
          await service.handleInbound(m);
        }, abort.signal)
        .catch((error: unknown) => log(`[care] Photon listener stopped: ${error instanceof Error ? error.message : String(error)}`))
    : Promise.resolve();

  async function guarded(what: string, fn: () => Promise<unknown>): Promise<void> {
    try {
      await fn();
    } catch (error) {
      log(`[care] ${what} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return {
    service,
    onDayFinished: (event) =>
      event.patientId === deps.patientId ? guarded(`summary for ${event.day}`, () => service.sendSummaries(event.day)) : Promise.resolve(),
    afterMissedCheckin: (day) => guarded(`noon summary for ${day}`, () => service.ensureDaySummary(day)),
    async stop() {
      abort.abort();
      await deps.closeTransport?.().catch(() => {});
      await listening;
    },
  };
}

/**
 * The real runtime for `npm run agent`: contacts file and Photon from CareConfig, and the
 * app's LlmClient (Gemini) to word the texts when there is one. Returns undefined, with a log line saying why, when the file or the Photon
 * credentials are missing or the file still holds the example numbers.
 */
export async function connectCareRuntime(input: {
  config: CareConfig;
  db: Db;
  patientId: string;
  clock: Clock;
  log: (line: string) => void;
  /** The app's LLM (Gemini). Without one, the fixed templates go out. */
  llm?: LlmClient | undefined;
}): Promise<CareRuntime | undefined> {
  const { config, log } = input;
  const loaded = loadCareContacts(config.contactsPath);
  if (loaded.kind === "missing") {
    log(`[care] no contacts file at ${loaded.path}; care summaries over Photon are off (copy care-contacts.example.json to care-contacts.json)`);
    return undefined;
  }
  if (loaded.kind === "placeholder") {
    log(`[care] ${loaded.path} still has the example 555-01xx numbers; put in the real doctor and emergency contact numbers to turn on care summaries`);
    return undefined;
  }
  if (!config.photon) {
    log("[care] SPECTRUM_PROJECT_ID / SPECTRUM_PROJECT_SECRET not set in .env; care summaries over Photon are off");
    return undefined;
  }
  const port = await connectPhoton(config.photon);
  const photon = new PhotonMessenger(port, log);
  const writer = input.llm ? new GeminiCareWriter(input.llm) : undefined;
  log(`[care] Photon connected; summaries go to the doctor and the emergency contact; texts ${writer ? `worded by ${input.llm?.provider ?? "the LLM"}, templates as the fallback` : "from templates (no LLM configured)"}`);
  return startCareRuntime({
    db: input.db,
    patientId: input.patientId,
    contacts: loaded.contacts,
    clock: input.clock,
    messenger: photon,
    inbound: photon,
    ...(writer ? { writer } : {}),
    log,
    closeTransport: () => photon.stop(),
  });
}
