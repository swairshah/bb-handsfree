// Shared between the backend call ledger (server/call-ledger.ts) and the voice agent.
//
// Every call passes through one backend (createCall), and it is
// single-threaded, so it is where calls are tracked. The ledger holds every
// non-idle call nonce until it is removed by end evidence from the owner (idle
// presence, session.stopped), by an explicit End (forceStop: an override that
// stops on a best-effort basis, without the owner's confirmation), or by the
// release of a reservation whose start was abandoned. Missing or late evidence
// is "unknown", never idle.

/** Reported phase of a ledger entry that blocks a reserved start. */
export type CallLedgerPhase =
  /** Reserved or created, with no presence yet; not known to be live. */
  | "reserved"
  /** Positively reported by its owner in this backend process. */
  | "connecting" | "live" | "muted"
  /** Restored after a backend restart, or the ledger itself is unavailable. */
  | "unknown";

export const POSITIVE_CALL_PHASES: readonly CallLedgerPhase[] = ["connecting", "live", "muted"];

export interface CallConflict {
  /** Null when the ledger is unavailable, so no specific call can be named. */
  nonce: string | null;
  phase: CallLedgerPhase;
}

/** createCall's error message when a reserved start lost to another start. */
export const CALL_SUPERSEDED = "Another call started first.";
