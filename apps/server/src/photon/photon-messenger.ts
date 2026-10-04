import { Spectrum } from "@spectrum-ts/core";
import { imessage } from "@spectrum-ts/imessage";
import type { CareInbound, CareInboundSource, CareMessenger, CareSent } from "./care-messenger.ts";

// CareMessenger and CareInboundSource over Photon's Spectrum SDK (iMessage cloud provider,
// https://photon.codes/docs/spectrum-ts/getting-started). Credentials are the Photon
// project's SPECTRUM_PROJECT_ID and SPECTRUM_PROJECT_SECRET from .env.
//
// Sending resolves the phone number to a Spectrum user, opens (or reuses) the DM space and
// sends plain text. Receiving reads the merged `app.messages` stream and keeps inbound DM
// text. Photon asks that people text the line first (Apple shows "Report Junk" on cold
// messages, docs "iMessage deliverability"), so the doctor and the emergency contact should
// each send the line one message before the first summary.

/** The few Spectrum operations used, so tests can stand in for Photon. */
export type PhotonPort = {
  sendDm(phone: string, text: string): Promise<{ id: string } | undefined>;
  messages(): AsyncIterable<PortMessage>;
  stop(): Promise<void>;
};

export type PortMessage = {
  id: string;
  direction: "inbound" | "outbound";
  isDm: boolean;
  fromPhone: string | undefined;
  text: string | undefined;
  at: Date;
};

export class PhotonMessenger implements CareMessenger, CareInboundSource {
  private readonly port: PhotonPort;
  private readonly log: (line: string) => void;

  constructor(port: PhotonPort, log: (line: string) => void = () => {}) {
    this.port = port;
    this.log = log;
  }

  async send(phone: string, text: string, _idempotencyKey: string): Promise<CareSent> {
    if (!text.trim()) throw new Error("Photon messages need text; got an empty message");
    const sent = await this.port.sendDm(phone, text);
    return { messageId: sent?.id ?? null };
  }

  async listen(onMessage: (message: CareInbound) => Promise<void>, signal: AbortSignal): Promise<void> {
    const stop = () => void this.port.stop().catch(() => {});
    signal.addEventListener("abort", stop, { once: true });
    try {
      for await (const m of this.port.messages()) {
        if (signal.aborted) break;
        if (m.direction !== "inbound" || !m.isDm || !m.fromPhone || !m.text?.trim()) continue;
        try {
          await onMessage({ messageId: m.id, fromPhone: m.fromPhone, text: m.text.trim(), at: m.at.toISOString() });
        } catch (error) {
          this.log(`[photon] handling message ${m.id} failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        if (signal.aborted) break;
      }
    } finally {
      signal.removeEventListener("abort", stop);
    }
  }

  stop(): Promise<void> {
    return this.port.stop();
  }
}

/** The real port: one Spectrum app with the cloud iMessage provider. */
export async function connectPhoton(options: { projectId: string; projectSecret: string }): Promise<PhotonPort> {
  const app = await Spectrum({ projectId: options.projectId, projectSecret: options.projectSecret, providers: [imessage.config()] });
  const im = imessage(app);
  const spaces = new Map<string, Awaited<ReturnType<typeof im.space.create>>>();

  return {
    async sendDm(phone, text) {
      let space = spaces.get(phone);
      if (!space) {
        const user = await im.user(phone);
        space = await im.space.create(user);
        spaces.set(phone, space);
      }
      const sent = await space.send(text);
      return sent ? { id: sent.id } : undefined;
    },
    async *messages() {
      for await (const [space, message] of app.messages) {
        if (message.platform !== "imessage") continue;
        const content = message.content;
        const sender = imessage(message).sender as { id?: string; address?: string } | undefined;
        yield {
          id: message.id,
          direction: message.direction,
          isDm: imessage(space).type === "dm",
          fromPhone: sender?.address ?? sender?.id,
          text: content.type === "text" ? content.text : undefined,
          at: message.timestamp,
        };
      }
    },
    stop: () => app.stop(),
  };
}
