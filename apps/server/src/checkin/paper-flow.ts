import { latestCheckin } from "../db/checkins.ts";
import { deletePatientSnapshots, markNoted, markOffered, saveSnapshot, syncFlags, type Db } from "../db/index.ts";
import {
  confirmPaperScan,
  latestPaperScan,
  openFlagIdByFingerprint,
  rejectPaperScan,
  updatePaperOutcome,
  type PaperOutcome,
  type PaperScanRow,
} from "../db/paper-scans.ts";
import { normalizeHealthRecord } from "../finchnode/normalize.ts";
import type { RxNavCache } from "../finchnode/rxnav.ts";
import type { HealthRecord } from "../finchnode/types.ts";
import type { OutboundMessage } from "../relay/messenger.ts";
import { fingerprint } from "../rules/index.ts";
import { diffPaper } from "../rules/paper-diff.ts";
import {
  BUTTON,
  PAPER_NO_RECORD_REPLY,
  PAPER_NOTHING_TO_COMPARE,
  PAPER_LATER_REPLY,
  PAPER_REJECTED_REPLY,
  flagDetail,
  flagNotedReply,
} from "./copy.ts";
import type { Clock } from "./engine-types.ts";
import { PAPER_CONFIRM_BUTTONS } from "./paper-check.ts";

// Hospital paper check inside the engine (docs/DESIGN.md "Rules engine", R6):
//   read-back with "Yes, that's right" / "No, something's off"
//   -> Yes: compare with a fresh snapshot, store the result; an R6 flag enters the
//      flag lifecycle and she hears it in plain words with "I'll ask my doctor" / "Later"
//   -> No: nothing is confirmed or compared; she is pointed to her doctor or pharmacist.
// A paper check is not a check-in and never touches the checkins row. Planning is
// synchronous (inside the engine's inbound transaction); the snapshot is loaded
// before the transaction starts, so a failed load leaves the message unhandled.

export const PAPER_YES = PAPER_CONFIRM_BUTTONS[0] ?? "Yes, that's right";
export const PAPER_NO = PAPER_CONFIRM_BUTTONS[1] ?? "No, something's off";

// Wording lives in copy.ts; re-exported here for the paper-flow tests.
export { PAPER_LATER_REPLY, PAPER_NO_RECORD_REPLY, PAPER_NOTHING_TO_COMPARE, PAPER_REJECTED_REPLY } from "./copy.ts";

const norm = (s: string) => s.trim().toLowerCase();
const is = (text: string, label: string) => norm(text) === norm(label);

export const isPaperConfirm = (text: string) => is(text, PAPER_YES);
export const isPaperReject = (text: string) => is(text, PAPER_NO);
export const isPaperFollowUp = (text: string) => is(text, BUTTON.willAskDoctor) || is(text, BUTTON.later);

export type PaperSend = { message: OutboundMessage; key: string };

/** The fresh snapshot for a "Yes", loaded before the transaction. */
export type FreshRecord = { kind: "record"; raw: HealthRecord } | { kind: "consent_ended" };

/** Is this patient's latest read-back still waiting for "Yes" / "No"? */
export function pendingReadback(db: Db, patientId: string): PaperScanRow | undefined {
  const scan = latestPaperScan(db, patientId);
  return scan?.phase === "awaiting_confirm" ? scan : undefined;
}

/** The latest scan whose R6 message still waits for "I'll ask my doctor" / "Later". */
export function pendingFollowUp(db: Db, patientId: string): PaperScanRow | undefined {
  const scan = latestPaperScan(db, patientId);
  return scan?.outcome && scan.outcome.outcome === "flag" && scan.outcome.followUp === "pending" ? scan : undefined;
}

const key = (patientId: string, scanId: number, step: string) => `${patientId}:paper:${scanId}:${step}`;

export function createPaperFlow(deps: { db: Db; clock: Clock; rxnav: () => RxNavCache }) {
  const { db, clock } = deps;

  return {
    /** "Yes, that's right": confirm, compare (R6), store, and plan what she hears. */
    confirm(patientId: string, scan: PaperScanRow, fresh: FreshRecord): { sends: PaperSend[]; done: boolean } {
      const now = clock.now();
      if (fresh.kind === "consent_ended") {
        deletePatientSnapshots(db, patientId);
        confirmPaperScan(db, scan.id, now, {
          outcome: "skipped",
          discrepancies: [],
          flagId: null,
          followUp: null,
          reason: "record_consent_ended",
        });
        return { sends: [{ message: { text: PAPER_NO_RECORD_REPLY }, key: key(patientId, scan.id, "result") }], done: true };
      }

      saveSnapshot(db, { patientId, fetchedAt: now, syncStatus: fresh.raw.meta.syncStatus, raw: fresh.raw });
      const record = normalizeHealthRecord(fresh.raw, { rxnav: deps.rxnav() });
      const r6 = diffPaper(record, scan.paper);
      const discrepancies = (r6.details?.discrepancies as unknown[] | undefined) ?? [];

      if (r6.status !== "flag") {
        confirmPaperScan(db, scan.id, now, { outcome: r6.status, discrepancies, flagId: null, followUp: null });
        const text = r6.status === "checked" ? r6.message : PAPER_NOTHING_TO_COMPARE;
        return { sends: [{ message: { text }, key: key(patientId, scan.id, "result") }], done: true };
      }

      // Only R6 is synced, so R1 to R5 flags are left alone (see syncFlags).
      syncFlags(db, patientId, [r6], now);
      const flagId = openFlagIdByFingerprint(db, patientId, "R6", fingerprint(r6)) ?? null;
      // She hears it now, so no other flag is offered on this check-in date. It stays new
      // until she taps "I'll ask my doctor"; "Later" lets a later check-in offer it again.
      if (flagId !== null) markOffered(db, flagId, latestCheckin(db, patientId)?.date ?? now.slice(0, 10));
      const outcome: PaperOutcome = { outcome: "flag", discrepancies, flagId, followUp: "pending" };
      confirmPaperScan(db, scan.id, now, outcome);
      return {
        sends: [
          {
            message: { text: flagDetail(r6.message), buttons: [BUTTON.willAskDoctor, BUTTON.later] },
            key: key(patientId, scan.id, "result"),
          },
        ],
        done: false,
      };
    },

    /** "No, something's off": nothing confirmed, nothing compared. */
    reject(patientId: string, scan: PaperScanRow): PaperSend[] {
      rejectPaperScan(db, scan.id, clock.now());
      return [{ message: { text: PAPER_REJECTED_REPLY }, key: key(patientId, scan.id, "rejected") }];
    },

    /** "I'll ask my doctor" or "Later" on the R6 message. */
    followUp(patientId: string, scan: PaperScanRow, text: string): PaperSend[] {
      const outcome = scan.outcome;
      if (!outcome || outcome.outcome === "rejected") return [];
      if (is(text, BUTTON.willAskDoctor)) {
        if (outcome.flagId !== null) markNoted(db, outcome.flagId, clock.now());
        updatePaperOutcome(db, scan.id, { ...outcome, followUp: "noted" });
        return [{ message: { text: flagNotedReply() }, key: key(patientId, scan.id, "noted") }];
      }
      updatePaperOutcome(db, scan.id, { ...outcome, followUp: "later" });
      return [{ message: { text: PAPER_LATER_REPLY }, key: key(patientId, scan.id, "later") }];
    },
  };
}

export type PaperFlow = ReturnType<typeof createPaperFlow>;
