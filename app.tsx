// bb-plugin-handsfree — frontend: a voice-agent toggle in the composer.
//
// A circular waveform button rendered beside the native mic/submit controls.
// Clicking it opens a WebRTC session with the OpenAI Realtime API (mic capture
// and audio playback happen right here in the bb app); the backend performs
// the SDP exchange (it holds the API key) and executes bb tools via bb.sdk.
// The session itself lives in voice-agent.ts and outlives any component.
import { useEffect, useSyncExternalStore } from "react";
import {
  definePluginApp,
  experimental_useSidebarThreadActions,
  useBbContext,
  useComposer,
  useComposerView,
  useRealtime,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { PluginThreadListProps } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import { voiceAgent } from "./voice-agent";
import { SessionsPanel } from "./sessions-panel";
import { AudioSettings, BehaviorSettings, ModelsSettings } from "./settings-sections";
import { cn } from "@/lib/utils";
import { AUDIO_DEVICE_STORAGE_KEY } from "./audio-devices";
import { MicIcon, StopIcon, WaveformIcon, useCallElapsed } from "./voice-chrome";
import "./app.css";

function AideVoiceButton() {
  const rpc = useRpc<typeof rpcContract>();
  const composer = useComposer();
  const { threadId, projectId } = useBbContext();
  // The route has no thread/project on the New thread screen, but the
  // composer scope knows we're composing a new thread and which project is
  // selected — without this the agent sees an empty context there.
  const { scope } = useComposerView();
  const onNewThreadScreen = scope.kind === "new-thread";
  const scopeProjectId =
    scope.kind === "new-thread" || scope.kind === "side-chat" ? scope.projectId : null;
  const effectiveProjectId = projectId ?? scopeProjectId;
  const sidebarActions = experimental_useSidebarThreadActions();
  const state = useSyncExternalStore(voiceAgent.subscribe, voiceAgent.getState);
  const activity = useSyncExternalStore(voiceAgent.subscribe, voiceAgent.getActivity);
  const micSuspended = useSyncExternalStore(voiceAgent.subscribe, voiceAgent.getMicSuspended);

  // Global exclusivity: when any window starts a call, all others stop theirs.
  useRealtime("voice-call", (payload) => {
    const nonce = (payload as { nonce?: unknown } | null)?.nonce;
    if (typeof nonce === "string") voiceAgent.onCallStarted(nonce);
  });

  // CLI mute control: bb handsfree mute|unmute broadcasts on this channel.
  useRealtime("voice-mute", (payload) => {
    const muted = (payload as { muted?: unknown } | null)?.muted;
    if (typeof muted === "boolean") voiceAgent.setMuted(muted);
  });

  // Cross-surface presence: mirror a call owned by another realm so this pill
  // reflects it, and relay stop/mute back to whichever realm owns the call.
  useRealtime("voice-presence", (payload) => voiceAgent.ingestPresence(payload));
  useRealtime("voice-command", (payload) => voiceAgent.applyVoiceCommand(payload));
  useRealtime("voice-presence-query", () => voiceAgent.answerPresenceQuery());

  // Catch up immediately when this surface mounts (e.g. a realm rebuilt after
  // navigation), rather than waiting up to a heartbeat to learn a call is live.
  useEffect(() => voiceAgent.requestPresence(), []);

  // Thread-event notifications (digested; disabled via `notifications` setting).
  useRealtime("aide-thread-event", (payload) => {
    const event = payload as {
      kind?: unknown;
      threadId?: unknown;
      title?: unknown;
      detail?: unknown;
    } | null;
    if (typeof event?.kind === "string" && typeof event.threadId === "string" && typeof event.title === "string") {
      voiceAgent.enqueueThreadEvent({
        kind: event.kind,
        threadId: event.threadId,
        title: event.title,
        detail: typeof event.detail === "string" ? event.detail : null,
      });
    }
  });

  // Keep the singleton pointed at the freshest surface: after navigation the
  // new composer's button mounts and rebinds, so "this thread" and composer
  // edits follow the user while the call keeps running.
  useEffect(() => {
    voiceAgent.bind({
      rpc,
      context: { threadId, projectId: effectiveProjectId, onNewThreadScreen },
      composer: {
        setText: (text) => composer.setText(text),
        updateText: (updater) => composer.updateText(updater),
      },
      openNewThread: (targetProjectId) =>
        sidebarActions.openNewThread({
          ...(targetProjectId ? { projectId: targetProjectId } : {}),
          focusPrompt: true,
        }),
    });
  }, [rpc, composer, threadId, effectiveProjectId, onNewThreadScreen, sidebarActions]);

  const live = state === "live";
  const muted = state === "muted";

  // During a call, one segmented pill with NEUTRAL chrome (border/icons use
  // theme-neutral tokens so it reads well on any theme regardless of how bold
  // its primary is). Color appears only on the middle waveform to signal who
  // has the floor: you (bright foreground) vs Aide (primary). Driven purely by
  // data-channel activity signals — no audio analysis.
  if (live || muted) {
    // Aide can still be talking while your mic is muted, so the middle
    // indicator tracks conversation activity independent of mute. Mute is shown
    // by the slashed mic on the left button, not by graying this out.
    const speaking = activity === "aide";
    const listening = activity === "you"; // never true while muted (mic is off)
    // A suspended mic (iOS backgrounding) means Aide can't hear you — say so
    // rather than showing a reassuring "Connected".
    const middleLabel = micSuspended
      ? "Mic paused"
      : speaking
        ? "Aide speaking…"
        : listening
          ? "Listening…"
          : muted
            ? "Muted"
            : "Connected";
    return (
      <div className="flex h-7 shrink-0 items-center overflow-hidden rounded-full border border-border bg-accent">
        <button
          type="button"
          aria-label={muted ? "Unmute Aide microphone" : "Mute Aide microphone"}
          title={muted ? "Unmute" : "Mute"}
          onPointerDown={(event) => event.button === 0 && event.preventDefault()}
          onClick={() => voiceAgent.toggleMuteFromSurface()}
          className={cn(
            "flex size-7 items-center justify-center transition-colors",
            muted
              ? "text-destructive hover:bg-destructive/20"
              : "text-muted-foreground hover:bg-background/50 hover:text-foreground",
          )}
        >
          <MicIcon slashed={muted} />
        </button>
        <span className="h-4 w-px bg-border" />
        <span
          className={cn(
            "flex h-7 items-center justify-center px-2 transition-colors",
            // Aide can still be talking while you're muted, so who's-speaking
            // wins over the muted/quiet dim (mute is shown by the slashed mic).
            micSuspended
              ? "text-destructive" // uplink down — surface it, don't reassure
              : speaking
                ? "text-[color:var(--success,#6faf76)]" // themed green for Aide
                : listening
                  ? "text-foreground"
                  : "text-muted-foreground/60",
          )}
          title={middleLabel}
          aria-label={middleLabel}
        >
          <WaveformIcon live={speaking || listening} />
        </span>
        <span className="h-4 w-px bg-border" />
        <button
          type="button"
          aria-label="Stop Aide voice session"
          title="Stop"
          onPointerDown={(event) => event.button === 0 && event.preventDefault()}
          onClick={() => voiceAgent.stopFromSurface()}
          className="flex size-7 items-center justify-center text-muted-foreground transition-colors hover:bg-destructive/15 hover:text-destructive"
        >
          <StopIcon />
        </button>
      </div>
    );
  }

  return (
    <button
      type="button"
      aria-label="Start Aide voice agent"
      title="Talk to Aide"
      onPointerDown={(event) => event.button === 0 && event.preventDefault()}
      onClick={() => voiceAgent.toggleFromSurface()}
      className={cn(
        "flex size-7 shrink-0 items-center justify-center rounded-full border transition-colors",
        state === "connecting"
          ? "animate-pulse border-primary/50 text-primary"
          : "border-border text-muted-foreground hover:bg-accent hover:text-foreground",
      )}
    >
      <WaveformIcon live={false} />
    </button>
  );
}

/**
 * Persistent voice bar pinned to the top of the sidebar thread area (between
 * the plugin nav rows and the Threads list). State-driven, so every button
 * reflects the live call — the reason we use `experimental_threadList` rather
 * than the state-blind footer-action slot.
 */
function SidebarVoiceBar() {
  const state = useSyncExternalStore(voiceAgent.subscribe, voiceAgent.getState);
  const activity = useSyncExternalStore(voiceAgent.subscribe, voiceAgent.getActivity);
  const live = state === "live";
  const muted = state === "muted";
  const active = live || muted;
  const speaking = activity === "aide";
  const listening = activity === "you";
  // Same neutral-chrome + activity-color scheme as the composer pill: color
  // marks who has the floor, everything else stays theme-neutral.
  const activityColor = speaking
    ? "text-[color:var(--success,#6faf76)]" // Aide
    : listening
      ? "text-foreground" // you
      : "text-muted-foreground";
  const label =
    state === "idle"
      ? "Talk to Aide"
      : state === "connecting"
        ? "Connecting…"
        : speaking
          ? "Aide speaking…"
          : listening
            ? "Listening…"
            : muted
              ? "Muted"
              : "Live";
  return (
    <div className="flex shrink-0 items-center gap-1.5 border-b border-border bg-background px-2 py-1.5">
      <button
        type="button"
        aria-label={active ? "Stop Aide voice agent" : "Start Aide voice agent"}
        title={active ? "Stop Aide" : "Talk to Aide"}
        onClick={() => voiceAgent.toggleFromSurface()}
        className={cn(
          "flex h-7 flex-1 items-center justify-center gap-1.5 rounded-md border border-border px-2 text-xs font-medium transition-colors",
          active
            ? "bg-accent"
            : "text-muted-foreground hover:bg-accent hover:text-foreground",
          state === "connecting" && "animate-pulse",
        )}
      >
        <span className={cn("flex items-center gap-1.5", active && activityColor)}>
          <WaveformIcon live={speaking || listening} />
          {label}
        </span>
      </button>
      {active ? (
        <button
          type="button"
          aria-label={muted ? "Unmute Aide microphone" : "Mute Aide microphone"}
          title={muted ? "Unmute" : "Mute"}
          onClick={() => voiceAgent.toggleMuteFromSurface()}
          className={cn(
            "flex size-7 shrink-0 items-center justify-center rounded-md border border-border transition-colors",
            muted
              ? "text-destructive hover:bg-destructive/15"
              : "text-muted-foreground hover:bg-accent hover:text-foreground",
          )}
        >
          <MicIcon slashed={muted} />
        </button>
      ) : null}
    </div>
  );
}

/**
 * Sidebar thread list with the voice bar above BB's own list. The bar is a
 * fixed-height flex child; `Original` gets the remaining height in a scrollable
 * box (`min-h-0` lets it shrink so the scroll region is bounded, not overlapping
 * the bar). `overflow-y-auto` — not `hidden` — so a list that scrolls via its
 * parent still scrolls.
 */
function ThreadListWithVoiceBar({ Original }: PluginThreadListProps) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <SidebarVoiceBar />
      <div className="relative min-h-0 flex-1 overflow-y-auto pb-6">
        <Original />
      </div>
    </div>
  );
}

/** Trailing accessory on the Aide sidebar row: a live indicator with duration. */
function SidebarLiveIndicator() {
  const state = useSyncExternalStore(voiceAgent.subscribe, voiceAgent.getState);
  const elapsed = useCallElapsed();
  if (state === "idle") return null;
  const muted = state === "muted";
  const connecting = state === "connecting";
  return (
    <span
      className="flex items-center gap-1.5 text-xs tabular-nums text-muted-foreground"
      title={muted ? "Muted" : connecting ? "Connecting" : "Live"}
    >
      {/* The timer stays one neutral color (it's just call duration, not an
          error). The dot carries the state: pulsing = connecting (in progress),
          solid = live (established), solid red = muted. */}
      <span
        className={cn(
          "size-2 rounded-full",
          connecting
            ? "bg-primary animate-pulse"
            : muted
              ? "bg-destructive"
              : "bg-primary",
        )}
      />
      {connecting ? "\u2026" : elapsed ?? ""}
    </span>
  );
}

export default definePluginApp((app) => {
  app.slots.settingsSection({
    id: "models",
    title: "Model & voice",
    component: ModelsSettings,
  });
  app.slots.settingsSection({
    id: "behavior",
    title: "Behavior",
    component: BehaviorSettings,
  });
  app.slots.settingsSection({
    id: "audio",
    title: "Audio",
    component: AudioSettings,
  });
  app.composer.customize({
    id: "aide-voice",
    actions: [{ id: "voice-agent", component: AideVoiceButton }],
  });
  app.slots.navPanel({
    id: "sessions",
    title: "Handsfree",
    icon: "AudioLines",
    path: "sessions",
    component: SessionsPanel,
    experimental_sidebarAccessory: SidebarLiveIndicator,
  });
  // --- Global surface trial: multiple always-reachable triggers for the same
  // singleton call. All are pure toggles; the composer button owns the binding.
  // Persistent voice bar above the Threads list. A component slot, so buttons
  // reflect live call state (unlike the footer-action / command-palette slots).
  // Optional: a voice bar above the thread list, for anyone who wants an
  // always-visible control. Off by default is not possible (registering
  // activates it), but users can pin BB's list under Settings → Appearance.
  app.slots.experimental_threadList({
    id: "voice-bar",
    title: "Handsfree voice bar",
    description: "Adds a persistent voice control bar above the thread list.",
    component: ThreadListWithVoiceBar,
  });
  // The session deliberately outlives any component, so tie it to the plugin
  // frontend generation instead: on reload/disable the old bundle's singleton
  // would otherwise keep a zombie WebRTC call no button controls.
  app.contentScripts.register({
    id: "aide-voice-lifecycle",
    mount({ signal }) {
      window.addEventListener("storage", (event) => {
        if (event.key === AUDIO_DEVICE_STORAGE_KEY) voiceAgent.refreshAudioPreferences();
      }, { signal });
      // Release the mic synchronously before the page tears down. Without this,
      // a hard reload (Cmd+R) leaves the previous page holding the input device,
      // so the fresh page enumerates zero microphones until the OS reclaims it.
      window.addEventListener("pagehide", () => voiceAgent.stop(), { signal });
      signal.addEventListener("abort", () => voiceAgent.stop());
      return () => voiceAgent.stop();
    },
  });
});
