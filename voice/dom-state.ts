// Mirror this client's effective call state onto the document root so host
// chrome owned by another plugin (for example a sidebar shortcut) can style
// itself from CSS without its own realtime subscription or DOM polling.
// Display-only: nothing reads these attributes to control the call.
import type { VoiceActivity, VoiceState } from "./agent.ts";

/** "connecting" | "live" | "muted"; absent while idle. */
export const VOICE_STATE_ATTR = "data-handsfree-voice";
/**
 * "you" | "aide"; absent when nobody has the floor. Only the realm that owns
 * the call tracks speech, so a mirrored call never sets this.
 */
export const VOICE_ACTIVITY_ATTR = "data-handsfree-voice-activity";
/** Deep-link subpath of the Handsfree page that opens the live transcript. */
export const LIVE_TRANSCRIPT_SUBPATH = "live";
/**
 * Deep-link subpath that starts a call only if the backend ledger confirms none
 * is active (startIfIdle), and otherwise opens the call in the way. The sidebar
 * Voice chat shortcut uses this; it never takes over a call.
 */
export const START_IF_IDLE_SUBPATH = "start";

export interface VoiceStateSource {
  subscribe(listener: () => void): () => void;
  getState(): VoiceState;
  getActivity(): VoiceActivity;
  getMicSuspended(): boolean;
}

function write(root: Element, name: string, value: string | null) {
  if (root.getAttribute(name) === value) return;
  if (value === null) root.removeAttribute(name);
  else root.setAttribute(name, value);
}

export function publishVoiceState(root: Element, source: VoiceStateSource): () => void {
  const sync = () => {
    const state = source.getState();
    const activity = state === "idle" ? "idle" : source.getActivity();
    // "you" claims the mic is hearing the user: never while muted or while the
    // OS has suspended the mic.
    const floor =
      activity === "aide" ? "aide"
        : activity === "you" && state === "live" && !source.getMicSuspended() ? "you"
          : null;
    write(root, VOICE_STATE_ATTR, state === "idle" ? null : state);
    write(root, VOICE_ACTIVITY_ATTR, floor);
  };
  sync();
  const unsubscribe = source.subscribe(sync);
  return () => {
    unsubscribe();
    root.removeAttribute(VOICE_STATE_ATTR);
    root.removeAttribute(VOICE_ACTIVITY_ATTR);
  };
}
