// The seam between the care service (src/care/service.ts) and Photon. PhotonMessenger
// implements it over Spectrum (iMessage); FakeCareMessenger backs the tests and the
// simulator. The care service never imports spectrum-ts directly.

/** A text from the doctor or the emergency contact. */
export type CareInbound = {
  /** Photon's message id; each one is handled once. */
  messageId: string;
  /** The sender's phone number as Photon reports it. */
  fromPhone: string;
  text: string;
  /** ISO timestamp. */
  at: string;
};

export type CareSent = { messageId: string | null };

export interface CareMessenger {
  /**
   * Send one text to a phone number (E.164). `idempotencyKey` names the logical send; the
   * care service also records it, so a retry after a sent message is skipped before it gets here.
   */
  send(phone: string, text: string, idempotencyKey: string): Promise<CareSent>;
}

export interface CareInboundSource {
  /** Deliver each inbound text to `onMessage`, one at a time, until `signal` aborts. */
  listen(onMessage: (message: CareInbound) => Promise<void>, signal: AbortSignal): Promise<void>;
}
