// Cross-surface presence and control relay for the one live call. The realm
// that owns a call broadcasts coarse presence (on transitions + a heartbeat);
// every other realm mirrors it and relays stop/mute/unmute commands addressed
// by nonce. This channel owns the mirror, its expiry, and the relay RPCs —
// the VoiceAgent supplies local call state and applies relayed commands.
import { clientId, realmId } from "../shared/client-identity.ts";
import type { RpcClient } from "./tool-runner.ts";

export type VoiceState = "idle" | "connecting" | "live" | "muted";
/** A control intent relayed from a non-owning surface to the owning realm. */
export type VoiceCommandAction = "stop" | "mute" | "unmute";

/**
 * A live call owned by another surface's realm, mirrored here from the
 * `voice-presence` broadcast so this realm's controls reflect it. `receivedAt`
 * lets us expire a call whose owner realm vanished without a clean stop.
 */
export interface RemotePresence {
  nonce: string;
  phase: Exclude<VoiceState, "idle">;
  startedAt: number | null;
  receivedAt: number;
  /** Which client/realm owns the mirrored call (observability / future "live on X"). */
  ownerClient?: string;
  ownerRealm?: string;
}

/** A mirror is stale (owner realm likely gone) after two missed heartbeats. */
const PRESENCE_STALE_MS = 25_000;
/** How often the owning realm re-announces a live call, for the mirror above. */
const PRESENCE_HEARTBEAT_MS = 10_000;

/**
 * Detach a timer from the event loop where the runtime supports it (Node's
 * `unref`). No-op in the browser (timer ids have no `unref`), where it isn't
 * needed — this just keeps background presence timers from holding a process
 * (e.g. tests) open.
 */
function maybeUnref(timer: ReturnType<typeof setInterval>) {
  (timer as { unref?: () => void }).unref?.();
}

/** The local call state the channel reads from its owning VoiceAgent. */
export interface PresenceHost {
  rpc(): RpcClient | null;
  /** The active call nonce, or null when idle. */
  localNonce(): string | null;
  /** True while THIS realm owns (or is opening) a call. */
  hasLocalCall(): boolean;
  /** The local call state (only meaningful while hasLocalCall()). */
  localPhase(): VoiceState;
  /** Epoch ms when the local call went live, or null. */
  liveStartedAt(): number | null;
  /** Apply a relayed command addressed to the local call. */
  applyCommand(action: VoiceCommandAction): void;
  /** Notify subscribed UI that mirrored state changed. */
  emitChange(): void;
}

export class PresenceChannel {
  /** Non-null only when THIS realm does not own the call (see RemotePresence). */
  private remotePresence: RemotePresence | null = null;
  /** Re-announces our live call so other realms' mirrors don't go stale. */
  private presenceTimer: ReturnType<typeof setInterval> | null = null;
  /** Expires a stale mirror (owner realm gone) so we never show a ghost call. */
  private remoteExpiryTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly host: PresenceHost) {}

  /** The mirrored remote call if still fresh; null once its heartbeats lapse. */
  remoteLive(): RemotePresence | null {
    const remote = this.remotePresence;
    if (!remote) return null;
    if (Date.now() - remote.receivedAt > PRESENCE_STALE_MS) return null;
    return remote;
  }

  /**
   * Announce our own call so other realms mirror it. Fire-and-forget; presence
   * is cosmetic, so a failed publish must never touch the call. Only our own
   * transitions reach here, so `nonce` always identifies us.
   */
  broadcast(phase: VoiceState, nonce: string) {
    const rpc = this.host.rpc();
    if (!rpc) return;
    void rpc
      .call("publishPresence", { nonce, phase, startedAt: this.host.liveStartedAt(), client: clientId, realm: realmId })
      .catch(() => undefined);
  }

  /**
   * Ask any realm that owns a live call to re-announce it now. A surface calls
   * this on mount so it catches up immediately instead of waiting up to a full
   * heartbeat — the "briefly shows Talk to Aide over a live call" gap.
   */
  requestPresence() {
    const rpc = this.host.rpc();
    if (!rpc) return;
    void rpc.call("requestPresence", null).catch(() => undefined);
  }

  /** Re-announce our call in response to a peer's mount-time presence request. */
  answerQuery() {
    const nonce = this.host.localNonce();
    if (nonce && this.host.hasLocalCall()) this.broadcast(this.host.localPhase(), nonce);
  }

  /** Keep remote mirrors fresh while we own a live call (see PRESENCE_STALE_MS). */
  startHeartbeat() {
    this.stopHeartbeat();
    this.presenceTimer = setInterval(() => {
      const nonce = this.host.localNonce();
      if (nonce && this.host.hasLocalCall()) this.broadcast(this.host.localPhase(), nonce);
    }, PRESENCE_HEARTBEAT_MS);
    maybeUnref(this.presenceTimer);
  }

  stopHeartbeat() {
    if (this.presenceTimer) clearInterval(this.presenceTimer);
    this.presenceTimer = null;
  }

  /**
   * Ingest a `voice-presence` broadcast. Ignores our own echo and anything while
   * we own a call (our local state already drives the UI); otherwise mirrors the
   * remote call so this realm's controls reflect it.
   */
  ingest(payload: unknown) {
    const p = payload as
      | { nonce?: unknown; phase?: unknown; startedAt?: unknown; client?: unknown; realm?: unknown }
      | null;
    const nonce = typeof p?.nonce === "string" ? p.nonce : null;
    // Never mirror our own broadcast. Match on realm too, not just nonce: after
    // stop() nulls the nonce, a reordered trailing "live" frame from this realm
    // would otherwise slip past the nonce check and ghost as a remote call.
    if (!nonce || nonce === this.host.localNonce() || p?.realm === realmId || this.host.hasLocalCall()) return;
    const phase = p?.phase;
    if (phase === "idle") {
      // Only the call we're actually mirroring can clear it — a late idle for an
      // older, already-superseded call must not wipe a newer live mirror.
      if (this.remotePresence?.nonce === nonce) {
        this.remotePresence = null;
        this.disarmRemoteExpiry();
        this.host.emitChange();
      }
      return;
    }
    if (phase !== "connecting" && phase !== "live" && phase !== "muted") return;
    const startedAt = typeof p?.startedAt === "number" ? p.startedAt : null;
    const ownerClient = typeof p?.client === "string" ? p.client : undefined;
    const ownerRealm = typeof p?.realm === "string" ? p.realm : undefined;
    this.remotePresence = { nonce, phase, startedAt, receivedAt: Date.now(), ownerClient, ownerRealm };
    this.armRemoteExpiry();
    this.host.emitChange();
  }

  /** Poll a mirror to expiry so a vanished owner doesn't leave a ghost "live". */
  private armRemoteExpiry() {
    if (this.remoteExpiryTimer) return;
    this.remoteExpiryTimer = setInterval(() => {
      if (!this.remotePresence) {
        this.disarmRemoteExpiry();
        return;
      }
      if (this.remoteLive()) return; // still fresh
      this.remotePresence = null;
      this.disarmRemoteExpiry();
      this.host.emitChange();
    }, 5000);
    maybeUnref(this.remoteExpiryTimer);
  }

  private disarmRemoteExpiry() {
    if (this.remoteExpiryTimer) clearInterval(this.remoteExpiryTimer);
    this.remoteExpiryTimer = null;
  }

  /** Relay a control intent to whichever realm owns the call. */
  sendCommand(nonce: string, action: VoiceCommandAction) {
    const rpc = this.host.rpc();
    if (!rpc) return;
    void rpc
      .call("sendVoiceCommand", { nonce, action, client: clientId, realm: realmId })
      .catch(() => undefined);
  }

  /**
   * End a call server-authoritatively, so it works even when the owner realm is
   * a frozen/backgrounded mobile webview that can't receive commands — the fix
   * for the navigation zombie. Fire-and-forget; cosmetic on failure.
   */
  forceStop(nonce: string) {
    const rpc = this.host.rpc();
    if (!rpc) return;
    void rpc.call("forceStop", { nonce }).catch(() => undefined);
  }

  /** Stop a call we only mirror: force-stop on the server + drop the mirror now. */
  stopRemote(nonce: string) {
    this.forceStop(nonce);
    if (this.remotePresence?.nonce === nonce) {
      this.remotePresence = null;
      this.disarmRemoteExpiry();
      this.host.emitChange();
    }
  }

  /** Apply a relayed command — but only if THIS realm owns that call. */
  applyVoiceCommand(payload: unknown) {
    const p = payload as { nonce?: unknown; action?: unknown } | null;
    const nonce = typeof p?.nonce === "string" ? p.nonce : null;
    if (!nonce || nonce !== this.host.localNonce() || !this.host.hasLocalCall()) return;
    const action = p?.action;
    if (action === "stop" || action === "mute" || action === "unmute") this.host.applyCommand(action);
  }
}
