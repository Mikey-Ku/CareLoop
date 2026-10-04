import type { CareMessenger, CareSent } from "./care-messenger.ts";

// In-memory CareMessenger for tests and the simulator. A repeated idempotency key returns
// the first result instead of sending again; `failFor` makes sends to a number throw.

export type FakeCareText = { phone: string; text: string; key: string; messageId: string };

export class FakeCareMessenger implements CareMessenger {
  readonly sent: FakeCareText[] = [];
  readonly failFor = new Set<string>();
  private readonly byKey = new Map<string, CareSent>();
  private readonly onSend: ((text: FakeCareText) => void) | undefined;
  private counter = 0;

  constructor(options: { onSend?: (text: FakeCareText) => void } = {}) {
    this.onSend = options.onSend;
  }

  async send(phone: string, text: string, idempotencyKey: string): Promise<CareSent> {
    const previous = this.byKey.get(idempotencyKey);
    if (previous) return previous;
    if (this.failFor.has(phone)) throw new Error(`fake Photon: sending to ${phone} failed`);
    if (!text.trim()) throw new Error("fake Photon: empty text");
    this.counter += 1;
    const sent: FakeCareText = { phone, text, key: idempotencyKey, messageId: `photon_${this.counter}` };
    this.byKey.set(idempotencyKey, { messageId: sent.messageId });
    this.sent.push(sent);
    this.onSend?.(sent);
    return { messageId: sent.messageId };
  }

  to(phone: string): FakeCareText[] {
    return this.sent.filter((s) => s.phone === phone);
  }
}
