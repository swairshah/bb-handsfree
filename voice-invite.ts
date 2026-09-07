// Tier-0 autonomous invocation ("the call"): the server publishes a
// `voice-invite` when an automation (or `bb handsfree ring`) wants to talk.
// Every connected surface rings until the user accepts, snoozes, dismisses,
// or the invite expires. Accepting is the user gesture that lets mic capture
// and audio playback succeed — the server never starts audio itself.
//
// The human is the arbiter here, so no mic-busy / idle detection is needed:
// in a meeting, just snooze or ignore it and it goes away on its own.

export interface VoiceInvite {
  inviteId: string;
  title: string;
  briefing: string;
  createdAt: number;
  expiresAt: number;
}

export const INVITE_CHANNEL = "voice-invite";
/** Broadcast when any surface answers/dismisses; all others drop the invite. */
export const INVITE_RESOLVED_CHANNEL = "voice-invite-resolved";
/** How long a re-shown (snoozed) invite rings before expiring on its own. */
export const RESHOW_TTL_MS = 60_000;
export const DEFAULT_SNOOZE_MINUTES = 10;

const listeners = new Set<() => void>();
let current: VoiceInvite | null = null;
/** Snoozed invite waiting to re-ring; cancelled if another surface resolves it. */
let snoozed: VoiceInvite | null = null;
let expiryTimer: ReturnType<typeof setTimeout> | null = null;
let snoozeTimer: ReturnType<typeof setTimeout> | null = null;

function emit() {
  for (const listener of listeners) listener();
}

function clearExpiry() {
  if (expiryTimer) clearTimeout(expiryTimer);
  expiryTimer = null;
}

function clearSnooze() {
  if (snoozeTimer) clearTimeout(snoozeTimer);
  snoozeTimer = null;
}

function armExpiry() {
  clearExpiry();
  if (!current) return;
  const delay = current.expiresAt - Date.now();
  if (delay <= 0) {
    current = null;
    emit();
    return;
  }
  expiryTimer = setTimeout(() => {
    expiryTimer = null;
    current = null;
    emit();
  }, delay);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Latest invite wins; an already-ringing invite is replaced, not stacked. */
export const inviteStore = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },

  getSnapshot(): VoiceInvite | null {
    return current;
  },

  /** Returns true when the payload was a live invite worth ringing for. */
  ingestInvite(payload: unknown): boolean {
    if (!isRecord(payload)) return false;
    const { inviteId, title, briefing, createdAt, expiresAt } = payload;
    if (typeof inviteId !== "string" || !inviteId) return false;
    if (typeof title !== "string" || !title) return false;
    if (typeof expiresAt !== "number" || expiresAt <= Date.now()) return false;
    clearSnooze();
    snoozed = null; // a new ring replaces any pending re-ring, not just its timer
    current = {
      inviteId,
      title,
      briefing: typeof briefing === "string" ? briefing : "",
      createdAt: typeof createdAt === "number" ? createdAt : Date.now(),
      expiresAt,
    };
    armExpiry();
    emit();
    return true;
  },

  dismiss() {
    clearExpiry();
    clearSnooze();
    snoozed = null;
    if (current === null) return;
    current = null;
    emit();
  },

  /** Hide now, ring again in `minutes`. Snooze is local to this surface; an
   * answer/dismiss from anywhere (see resolveInvite) still wins everywhere. */
  snooze(minutes: number = DEFAULT_SNOOZE_MINUTES) {
    const invite = current;
    if (!invite) return;
    clearExpiry();
    clearSnooze();
    current = null;
    snoozed = invite;
    emit();
    const delayMs = Math.max(0, minutes) * 60_000;
    snoozeTimer = setTimeout(() => {
      snoozeTimer = null;
      const pending = snoozed;
      snoozed = null;
      if (!pending || current) return; // resolved elsewhere, or a newer invite arrived
      current = { ...pending, expiresAt: Math.max(pending.expiresAt, Date.now() + RESHOW_TTL_MS) };
      armExpiry();
      emit();
    }, delayMs);
  },

  /**
   * Drop an invite answered/dismissed on any surface (via the server's
   * `voice-invite-resolved` broadcast). Only the matching invite is
   * affected — a newer ring is never collateral. Returns true when
   * something was actually cleared.
   */
  resolveInvite(inviteId: unknown): boolean {
    if (typeof inviteId !== "string" || !inviteId) return false;
    let changed = false;
    if (current?.inviteId === inviteId) {
      clearExpiry();
      current = null;
      changed = true;
    }
    if (snoozed?.inviteId === inviteId) {
      clearSnooze();
      snoozed = null;
      changed = true;
    }
    if (changed) emit();
    return changed;
  },

  /** Test-only: drop all state and timers. */
  reset() {
    clearExpiry();
    clearSnooze();
    current = null;
    snoozed = null;
    emit();
  },
};
