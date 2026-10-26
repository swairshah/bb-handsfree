// The call ledger: every call nonce not yet ended or explicitly cleared, in the plugin's
// SQLite database (table `active_calls`, see store.ts MIGRATIONS). Writes are
// synchronous, so each change is durable and serialized before the next RPC
// runs. Entries restored from a previous backend process report "unknown"
// until their owner renews them. Any ledger read or write failure makes
// reservations fail closed for the rest of this process.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { CallConflict, CallLedgerPhase } from "../shared/call-reservation.ts";
import type { Db } from "./store.ts";

export interface CallLedger {
  /** Record a reported phase. True when the write is durable. */
  set(nonce: string, phase: CallLedgerPhase): boolean;
  /** Record a start without downgrading a phase its owner already reported. */
  reserve(nonce: string): boolean;
  /** Remove a call that ended, was force-stopped, or whose reservation was released. */
  end(nonce: string): boolean;
  /** The blocking entry for `nonce`, or null when it is the sole entry. */
  conflict(nonce: string): CallConflict | null;
  /** A reserved call may proceed only while it is the ledger's sole entry. */
  held(nonce: string): boolean;
  healthy(): boolean;
}

export const UNKNOWN_CONFLICT: CallConflict = { nonce: null, phase: "unknown" };
// Prefer a call positively known to be running: its transcript can open.
const CONFLICT_ORDER: CallLedgerPhase[] = ["live", "muted", "connecting", "reserved", "unknown"];

export function createCallLedger(db: Db, log: BbPluginApi["log"]): CallLedger {
  const renewed = new Set<string>();
  let healthy = true;
  const fault = (cause: unknown) => {
    if (healthy) log.error(`call ledger unavailable; reserved starts disabled: ${cause instanceof Error ? cause.message : String(cause)}`);
    healthy = false;
  };
  try {
    db.prepare("SELECT COUNT(*) AS n FROM active_calls").get();
  } catch (cause) {
    fault(cause);
  }
  type Row = { nonce: string; phase: CallLedgerPhase };
  const rows = (): Row[] => (db.prepare("SELECT nonce, phase FROM active_calls ORDER BY updated_at").all() as Row[])
    .map(row => ({ nonce: row.nonce, phase: renewed.has(row.nonce) ? row.phase : "unknown" }));
  const write = (run: () => void): boolean => {
    try { run(); return true; } catch (cause) { fault(cause); return false; }
  };
  const conflict = (nonce: string): CallConflict | null => {
    if (!healthy) return UNKNOWN_CONFLICT;
    try {
      const others = rows().filter(row => row.nonce !== nonce);
      others.sort((a, b) => CONFLICT_ORDER.indexOf(a.phase) - CONFLICT_ORDER.indexOf(b.phase));
      return others[0] ? { nonce: others[0].nonce, phase: others[0].phase } : null;
    } catch (cause) {
      fault(cause);
      return UNKNOWN_CONFLICT;
    }
  };
  return {
    set: (nonce, phase) => write(() => {
      db.prepare(
        "INSERT INTO active_calls (nonce, phase, updated_at) VALUES (?, ?, ?) ON CONFLICT(nonce) DO UPDATE SET phase = excluded.phase, updated_at = excluded.updated_at",
      ).run(nonce, phase, Date.now());
      renewed.add(nonce);
    }),
    reserve: (nonce) => write(() => {
      db.prepare("INSERT OR IGNORE INTO active_calls (nonce, phase, updated_at) VALUES (?, 'reserved', ?)").run(nonce, Date.now());
      renewed.add(nonce);
    }),
    end: (nonce) => write(() => {
      db.prepare("DELETE FROM active_calls WHERE nonce = ?").run(nonce);
      renewed.delete(nonce);
    }),
    conflict,
    held(nonce) {
      if (conflict(nonce)) return false;
      try {
        return Boolean(db.prepare("SELECT 1 FROM active_calls WHERE nonce = ?").get(nonce));
      } catch (cause) {
        fault(cause);
        return false;
      }
    },
    healthy: () => healthy,
  };
}
