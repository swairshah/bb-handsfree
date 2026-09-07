// Incoming-call UI for Tier-0 autonomous invocation: renders the ringing
// `voice-invite` with Accept / Snooze / Dismiss. Accept starts a normal voice
// session (the click is the user gesture mic + playback need); snooze re-rings
// locally after N minutes; dismiss or expiry just goes quiet.
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { HTMLAttributes, PointerEvent as ReactPointerEvent } from "react";
import {
  experimental_useSidebarThreadActions,
  useBbContext,
  useRealtime,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "./server";
import { clientDescriptor } from "./client-identity";
import { voiceAgent } from "./voice-agent";
import { LiveCallControls, useCallElapsed } from "./voice-chrome";
import {
  DEFAULT_SNOOZE_MINUTES,
  INVITE_CHANNEL,
  INVITE_RESOLVED_CHANNEL,
  inviteStore,
} from "./voice-invite.ts";
import { cn } from "@/lib/utils";

/** Double-beep ringtone while an invite is ringing. Best-effort: before the
 * user has ever interacted with the tab, autoplay policy keeps the context
 * suspended and only the visual card + vibration ring. */
function useRingtone(ringing: boolean) {
  useEffect(() => {
    if (!ringing || typeof window === "undefined") return;
    let ctx: AudioContext | null = null;
    let stopped = false;
    let interval: ReturnType<typeof setInterval> | null = null;
    try {
      const AC =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AC) return;
      ctx = new AC();
      void ctx.resume().catch(() => undefined);
      const beep = (freq: number, at: number, dur = 0.18) => {
        if (!ctx || stopped) return;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.frequency.value = freq;
        osc.type = "sine";
        gain.gain.setValueAtTime(0.0001, at);
        gain.gain.exponentialRampToValueAtTime(0.2, at + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, at + dur);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(at);
        osc.stop(at + dur + 0.05);
      };
      const pattern = () => {
        if (!ctx || stopped) return;
        const t = ctx.currentTime + 0.05;
        beep(880, t);
        beep(880, t + 0.28);
      };
      pattern();
      interval = setInterval(pattern, 2000);
      try {
        navigator.vibrate?.([200, 100, 200]);
      } catch {
        /* vibration is a nicety */
      }
    } catch {
      /* audio unavailable — the visual card still rings */
    }
    return () => {
      stopped = true;
      if (interval) clearInterval(interval);
      ctx?.close().catch(() => undefined);
    };
  }, [ringing]);
}
function InviteBody({ onAccept, onDismiss, snoozeMinutes, dragHandleProps }: {
  onAccept: () => void;
  onDismiss: () => void;
  snoozeMinutes: number;
  dragHandleProps: HTMLAttributes<HTMLDivElement>;
}) {
  const invite = useSyncExternalStore(inviteStore.subscribe, inviteStore.getSnapshot);
  if (!invite) return null;
  return (
    <div className="w-full">
      <div className="flex cursor-grab touch-none select-none items-center gap-2 active:cursor-grabbing" {...dragHandleProps}>
        <span className="size-2.5 shrink-0 animate-pulse rounded-full bg-primary" aria-hidden />
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Incoming call
        </span>
      </div>
      <p className="mt-1.5 text-sm font-medium text-foreground">{invite.title}</p>
      {invite.briefing ? (
        <p className="mt-0.5 line-clamp-3 text-xs text-muted-foreground">{invite.briefing}</p>
      ) : null}
      <div className="mt-3 flex items-center gap-2">
        <button
          type="button"
          onClick={onAccept}
          autoFocus
          className="flex-1 rounded-full bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
        >
          Accept
        </button>
        <button
          type="button"
          onClick={() => inviteStore.snooze(snoozeMinutes)}
          title={`Ring again in ${snoozeMinutes} minutes`}
          className="rounded-full border border-border px-3 py-2 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          Snooze {snoozeMinutes}m
        </button>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss invite"
          title="Dismiss"
          className="rounded-full border border-border px-3 py-2 text-xs text-muted-foreground transition-colors hover:bg-destructive/15 hover:text-destructive"
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}

/**
 * This surface's incoming-call preferences (Settings → Plugins → Handsfree →
 * Incoming calls), live-refreshed like every other settings consumer. Server
 * defaults apply until the first fetch lands, so a slow backend still rings.
 */
interface InvitePrefs {
  incomingCalls: boolean;
  ringtone: boolean;
  snoozeMinutes: number;
  greetFirst: boolean;
}

const INVITE_PREF_DEFAULTS: InvitePrefs = {
  incomingCalls: true,
  ringtone: true,
  snoozeMinutes: DEFAULT_SNOOZE_MINUTES,
  greetFirst: true,
};

function useInvitePrefs(): { prefs: InvitePrefs; loaded: boolean } {
  const rpc = useRpc<typeof rpcContract>();
  const [prefs, setPrefs] = useState<InvitePrefs | null>(null);
  const [loaded, setLoaded] = useState(false);
  const refetch = useCallback(() => {
    rpc.call("getConfig", null).then(
      // Per-field coercion, not a blind spread: an older server answers
      // without these fields, and a failure must never yield undefined prefs.
      (raw: unknown) => {
        const config = (raw ?? {}) as Partial<InvitePrefs>;
        setPrefs({
          incomingCalls: typeof config.incomingCalls === "boolean" ? config.incomingCalls : true,
          ringtone: typeof config.ringtone === "boolean" ? config.ringtone : true,
          snoozeMinutes:
            typeof config.snoozeMinutes === "number" && Number.isInteger(config.snoozeMinutes)
              ? Math.min(Math.max(config.snoozeMinutes, 1), 120)
              : DEFAULT_SNOOZE_MINUTES,
          greetFirst: typeof config.greetFirst === "boolean" ? config.greetFirst : true,
        });
        setLoaded(true);
      },
      () => setLoaded(true), // backend unreachable: fail open on defaults
    );
  }, [rpc]);
  useEffect(refetch, [refetch]);
  useRealtime("config-changed", refetch);
  // Fail open on a timer: if the backend never answers, ring on defaults
  // after 3s rather than staying silent forever. A hanging getConfig must
  // degrade to a possibly-unwanted ring, never to a missed call.
  useEffect(() => {
    const fallback = setTimeout(() => setLoaded(true), 3000);
    return () => clearTimeout(fallback);
  }, []);
  return { prefs: prefs ?? INVITE_PREF_DEFAULTS, loaded };
}

/**
 * Draggable overlay position, persisted per browser. The whole toast follows
 * a drag from any header; a press without movement still counts as a click
 * (expand/minimize), told apart by a small movement threshold.
 */
const OVERLAY_POS_KEY = "bb-handsfree.invite-pos";

function useOverlayPos() {
  const [offset, setOffset] = useState<{ x: number; y: number }>(() => {
    try {
      const raw = typeof window === "undefined" ? null : window.localStorage.getItem(OVERLAY_POS_KEY);
      const parsed = raw ? (JSON.parse(raw) as unknown) : null;
      if (
        parsed && typeof parsed === "object" &&
        typeof (parsed as { x?: unknown }).x === "number" &&
        typeof (parsed as { y?: unknown }).y === "number" &&
        Math.abs((parsed as { x: number }).x) < 2000 &&
        Math.abs((parsed as { y: number }).y) < 2000
      ) {
        return { x: (parsed as { x: number }).x, y: (parsed as { y: number }).y };
      }
    } catch {
      /* fall through to the default corner */
    }
    return { x: 0, y: 0 };
  });
  const offsetRef = useRef(offset);
  offsetRef.current = offset;
  const drag = useRef<{ px: number; py: number; ox: number; oy: number; moved: boolean } | null>(null);
  const suppressClick = useRef(false);

  const onPointerDown = (event: ReactPointerEvent) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
    drag.current = { px: event.clientX, py: event.clientY, ox: offsetRef.current.x, oy: offsetRef.current.y, moved: false };
  };
  const onPointerMove = (event: ReactPointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const next = { x: Math.round(d.ox + event.clientX - d.px), y: Math.round(d.oy + event.clientY - d.py) };
    if (Math.abs(next.x - d.ox) + Math.abs(next.y - d.oy) > 4) d.moved = true;
    if (d.moved) setOffset(next);
  };
  const onPointerUp = (event: ReactPointerEvent) => {
    const d = drag.current;
    drag.current = null;
    suppressClick.current = !!d?.moved;
    if (d?.moved) {
      const next = { x: Math.round(d.ox + event.clientX - d.px), y: Math.round(d.oy + event.clientY - d.py) };
      setOffset(next);
      try {
        window.localStorage.setItem(OVERLAY_POS_KEY, JSON.stringify(next));
      } catch {
        /* position is a nicety */
      }
    }
  };
  /** False when the press turned into a drag — callers skip their click action. */
  const clickAllowed = () => {
    const allowed = !suppressClick.current;
    suppressClick.current = false;
    return allowed;
  };
  return {
    offset,
    dragHandleProps: { onPointerDown, onPointerMove, onPointerUp } as HTMLAttributes<HTMLDivElement>,
    chipHandleProps: { onPointerDown, onPointerMove, onPointerUp } as HTMLAttributes<HTMLButtonElement>,
    clickAllowed,
  };
}

/**
 * App-wide incoming-call overlay (registered as `experimental_appOverlay`, so
 * it mounts on every page — thread views, the Handsfree page, settings, other
 * plugins' pages). Top-right toast placement keeps it clear of the composer.
 * While already in a call the invite is moot, so it steps aside (and drops
 * the invite — whoever is talking already has the floor).
 *
 * Answering/dismissing here resolves through the server, so every other
 * surface stops ringing too; snooze stays local to this surface by design.
 * Mobile stays silent for now: the native webview cannot reliably start a
 * call (see HF-2), and the phone path waits on Expo push (HF-12).
 */
export function GlobalInviteOverlay() {
  const rpc = useRpc<typeof rpcContract>();
  const { threadId, projectId } = useBbContext();
  const sidebarActions = experimental_useSidebarThreadActions();
  const { prefs, loaded: prefsLoaded } = useInvitePrefs();
  // TEMP-DEBUG: remote visibility into overlay lifecycle. Removed before merge.
  const diag = (kind: string, payload: Record<string, unknown> = {}) => {
    void rpc.call("logEvent", { sessionId: "invite-diag", kind, payload }).catch(() => undefined);
  };
  useEffect(() => {
    diag("overlay.mounted", { mobile: clientDescriptor.mobile });
  }, []);
  useRealtime(INVITE_CHANNEL, (payload) => {
    diag("invite.received", { ok: inviteStore.ingestInvite(payload) });
  });
  useRealtime(INVITE_RESOLVED_CHANNEL, (payload) => {
    inviteStore.resolveInvite((payload as { inviteId?: unknown } | null)?.inviteId);
  });

  // Fallback voice binding so Accept can start a call from pages with no
  // composer of their own. Thread views keep their richer composer binding —
  // fallbacks never win over those (see registerBindings).
  useEffect(() => {
    return voiceAgent.bindFallback({
      rpc,
      context: { threadId: threadId ?? null, projectId: projectId ?? null, onNewThreadScreen: false },
      openNewThread: (targetProjectId) =>
        sidebarActions.openNewThread({
          ...(targetProjectId ? { projectId: targetProjectId } : {}),
          focusPrompt: true,
        }),
    });
  }, [rpc, threadId, projectId, sidebarActions]);

  const invite = useSyncExternalStore(inviteStore.subscribe, inviteStore.getSnapshot);
  const state = useSyncExternalStore(voiceAgent.subscribe, voiceAgent.getState);
  const inCall = state !== "idle";
  const mobile = clientDescriptor.mobile;
  // The surface that accepted keeps a live-call card (mute/stop + status) so
  // Accepting from a page with no voice UI of its own never strands the call
  // without controls. Cleared when the call ends.
  const [accepted, setAccepted] = useState<{ inviteId: string; title: string } | null>(null);
  // Mini-chip policy (option C): after Accept this surface keeps only a small
  // floating chip (presence + elapsed); tap to expand full controls. Quiet
  // next to the composer pill and console, sufficient where nothing else is.
  const [expanded, setExpanded] = useState(false);
  // prefsLoaded gates the ring (never ring on unconfirmed defaults when the
  // user disabled calls), but never the live-call card: controls for a call
  // you already accepted must not vanish on a slow backend.
  const mayRing = prefsLoaded && prefs.incomingCalls;
  const showInvite = !!invite && !inCall && mayRing;
  const showLive = !!accepted && inCall;
  // TEMP-DEBUG: reports why a received invite isn't rendering.
  useEffect(() => {
    if (invite) {
      diag("invite.gated", {
        inviteId: invite.inviteId,
        inCall,
        prefsLoaded,
        incomingCalls: prefs.incomingCalls,
        mobile,
        showInvite,
      });
    }
  }, [invite, inCall, prefsLoaded]);
  useRingtone(showInvite && prefs.ringtone);
  useEffect(() => {
    // A call went live while this invite was still ringing here (started
    // manually mid-ring, or accepted on a surface whose resolve hasn't
    // arrived yet): stand down locally and tell the rest to do the same.
    // The normal accept path already dismissed + resolved, so this is a no-op
    // there (invite is null by the time the call goes live).
    if (invite && inCall) {
      inviteStore.dismiss();
      void rpc
        .call("resolveInvite", { inviteId: invite.inviteId, action: "dismissed" })
        .catch(() => undefined);
    }
  }, [invite, inCall, rpc]);
  useEffect(() => {
    if (state === "idle") {
      setAccepted(null);
      setExpanded(false);
    }
  }, [state]);
  // Hooks below run on EVERY render: useCallElapsed must stay above the early
  // returns, or React (fewer-hooks-than-expected) unmounts the overlay and
  // nothing rings anywhere — the overlay is the only ringer. Same for
  // useOverlayPos: its state refs must mount on the very first render.
  const elapsed = useCallElapsed();
  const { offset, dragHandleProps, chipHandleProps, clickAllowed } = useOverlayPos();
  const muted = state === "muted";
  if (mobile) return null;
  if (!showInvite && !showLive) return null;
  const resolve = (action: "answered" | "dismissed") => {
    const id = invite?.inviteId ?? accepted?.inviteId;
    if (!id) return;
    void rpc
      .call("resolveInvite", { inviteId: id, action })
      .catch(() => undefined);
  };
  const accept = () => {
    // Re-check at click time: a call may have started in the beat between
    // render and click, and acceptInvite would otherwise stop that live call.
    if (!showInvite || !invite || voiceAgent.getState() !== "idle") {
      inviteStore.dismiss();
      if (invite) toast.info("Already in a call — invite dismissed.");
      return;
    }
    setAccepted({ inviteId: invite.inviteId, title: invite.title });
    setExpanded(false); // start as a chip; tap to expand
    inviteStore.dismiss();
    resolve("answered");
    voiceAgent.acceptInvite(invite.title, invite.briefing, { greet: prefs.greetFirst });
  };
  const dismiss = () => {
    inviteStore.dismiss();
    resolve("dismissed");
  };
  // Inline z-index (not a class): side panels and drawers have beaten the
  // themed z-50 scale before, and a ringing phone must win stacking fights.
  const frameStyle = { top: 16, right: 16, transform: `translate(${offset.x}px, ${offset.y}px)`, zIndex: 100 } as const;
  if (!showInvite && showLive && !expanded) {
    return (
      <button
        type="button"
        onClick={() => {
          if (clickAllowed()) setExpanded(true);
        }}
        {...chipHandleProps}
        title={accepted?.title ? `On call — ${accepted.title}. Show controls.` : "On call. Show controls."}
        aria-label={accepted?.title ? `On call — ${accepted.title}. Show controls.` : "On call. Show controls."}
        style={frameStyle}
        className={cn(
          "fixed flex cursor-grab touch-none select-none items-center gap-1.5 active:cursor-grabbing",
          "rounded-full border border-primary/40 bg-card px-3 py-1.5 shadow-xl",
          "text-xs tabular-nums text-muted-foreground transition-colors hover:text-foreground",
          muted && "border-destructive/50 text-destructive hover:text-destructive",
        )}
      >
        <span className={cn("size-2 rounded-full", muted ? "bg-destructive" : "bg-primary animate-pulse")} aria-hidden />
        {muted ? "Muted" : "On call"}
        {elapsed ? ` · ${elapsed}` : null}
      </button>
    );
  }
  return (
    <div
      role="alertdialog"
      aria-label={showInvite && invite ? `Incoming call: ${invite.title}` : `On call: ${accepted?.title ?? "Aide"}`}
      onKeyDown={(event) => {
        if (event.key === "Escape" && showInvite) dismiss();
      }}
      style={frameStyle}
      className="fixed w-80 max-w-[calc(100vw-2rem)] rounded-xl border border-primary/40 bg-card p-3.5 shadow-xl"
    >
      {showInvite && invite ? (
        <InviteBody onAccept={accept} onDismiss={dismiss} snoozeMinutes={prefs.snoozeMinutes} dragHandleProps={dragHandleProps} />
      ) : (
        // Bare controls, no box-in-box: the LiveCallControls pill already
        // carries its own chrome. The header drags and minimizes on click —
        // a whole row beats a 12px chevron next to stacked panels.
        <div className="w-full">
          <div
            className="flex cursor-grab touch-none select-none items-center gap-2 rounded-md px-1 py-0.5 transition-colors hover:bg-accent active:cursor-grabbing"
            onClick={() => {
              if (clickAllowed()) setExpanded(false);
            }}
            title="Minimize call controls"
            {...dragHandleProps}
          >
            <span className="size-2.5 shrink-0 rounded-full bg-primary" aria-hidden />
            <span className="truncate text-xs font-medium uppercase tracking-wide text-muted-foreground">
              On call{accepted?.title ? ` — ${accepted.title}` : ""}
            </span>
            <span className="ml-auto flex size-6 shrink-0 items-center justify-center text-muted-foreground" aria-hidden>
              <svg viewBox="0 0 16 16" className="size-3" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
                <path d="M4 10l4-4 4 4" />
              </svg>
            </span>
          </div>
          <div className="mt-2 flex justify-center">
            <LiveCallControls />
          </div>
        </div>
      )}
    </div>
  );
}
