// WebRTC/mic plumbing for the realm that owns a call: the session handle
// shape, deterministic microphone acquisition (with the post-reload and
// rapid-restart races handled), and the suspend/recover lifecycle that keeps
// the uplink honest across OS mic suspension (iOS backgrounding, device
// grabs). The VoiceAgent orchestrates; this module owns the hardware edges.
// Everything here is defensive; a browser without DOM (tests) simply skips
// the DOM/track wiring.
import { audioCaptureConstraint } from "../shared/audio-devices.ts";

export interface SessionHandle {
  pc: RTCPeerConnection;
  stream: MediaStream;
  audio: HTMLAudioElement;
  dc: RTCDataChannel | null;
  /** The live mic track feeding the pc; swapped in when iOS suspends the mic. */
  micTrack: MediaStreamTrack | null;
  /** The pc's audio sender, so a fresh mic track can replace a suspended one. */
  micSender: RTCRtpSender | null;
  /** Tears down the page/visibility listeners installed for this session. */
  disposeLifecycle?: () => void;
}

/** Wait for ICE gathering to finish (bounded) so we send a complete offer. */
export function waitForIceGathering(pc: RTCPeerConnection, timeoutMs = 2000): Promise<void> {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, timeoutMs);
    function done() {
      clearTimeout(timer);
      pc.removeEventListener("icegatheringstatechange", check);
      resolve();
    }
    function check() {
      if (pc.iceGatheringState === "complete") done();
    }
    pc.addEventListener("icegatheringstatechange", check);
  });
}

/** Inline playback + in-DOM element: the reliable iOS shape for WebRTC audio. */
export function prepareAudioElement(audio: HTMLAudioElement) {
  (audio as HTMLAudioElement & { playsInline?: boolean }).playsInline = true;
  if (typeof document === "undefined") return;
  try {
    audio.setAttribute("playsinline", "");
    audio.style.display = "none";
    document.body.appendChild(audio);
  } catch {
    /* no DOM to attach to — inbound audio still plays via srcObject */
  }
}

/** What the mic manager reads from (and reports to) its owning VoiceAgent. */
export interface MicManagerHost {
  /** True while `session` is still the agent's active session. */
  isCurrent(session: SessionHandle): boolean;
  /** True while the user has muted the call (a recovered track stays silent). */
  isMuted(): boolean;
  /** The saved input device id ("" = system default). */
  inputDeviceId(): string;
  /** Name of a tool that ran in the last few seconds, as a suspension cause. */
  recentToolName(): string | null;
  /** Surface (or clear) the "mic paused" state on the owning agent. */
  setMicSuspended(value: boolean): void;
  /** End the call because the OS suspended its mic while backgrounded. */
  endBecauseSuspended(): void;
  logDiag(kind: string, payload?: Record<string, unknown>): void;
}

/**
 * Owns microphone acquisition and the per-track suspend/recover lifecycle.
 * Stateless between calls — every method takes the session it acts on, and
 * `host.isCurrent` guards against acting on a torn-down session.
 */
export class MicManager {
  constructor(private readonly host: MicManagerHost) {}

  /** Enumerate devices, degrading to an empty list rather than throwing. */
  async enumerateDevices(): Promise<MediaDeviceInfo[]> {
    try {
      return await navigator.mediaDevices.enumerateDevices();
    } catch {
      return [];
    }
  }

  /**
   * Acquire the microphone, tolerating the brief post-reload window where the
   * OS reports zero input devices (a Chromium/Electron re-enumeration race that
   * survives even a clean release). On NotFoundError we wait, bounded, for an
   * input to reappear via `devicechange`, then retry once with the default.
   */
  async acquireMic(inputId: string): Promise<MediaStream> {
    try {
      return await this.micStream(audioCaptureConstraint(inputId));
    } catch (error) {
      if ((error instanceof Error ? error.name : "") !== "NotFoundError") throw error;
      this.host.logDiag("audio.getUserMedia.retry", { deviceId: inputId || "default" });
      if (!(await this.waitForInputDevice(6000))) throw error;
      return await this.micStream(true);
    }
  }

  /**
   * getUserMedia with a hard timeout. After a rapid stop→start the audio input
   * can be mid-release and getUserMedia hangs forever (never resolves or
   * rejects) — which stranded the UI in "connecting". A late-arriving stream is
   * released so a timeout can't leak the mic.
   */
  private micStream(
    constraint: true | MediaTrackConstraints,
    timeoutMs = 10000,
  ): Promise<MediaStream> {
    const request = navigator.mediaDevices.getUserMedia({ audio: constraint });
    let timedOut = false;
    return new Promise<MediaStream>((resolve, reject) => {
      const timer = setTimeout(() => {
        timedOut = true;
        this.host.logDiag("audio.getUserMedia.timeout", {});
        reject(new DOMException("microphone did not respond", "TimeoutError"));
      }, timeoutMs);
      request.then(
        (stream) => {
          clearTimeout(timer);
          if (timedOut) for (const track of stream.getTracks()) track.stop();
          else resolve(stream);
        },
        (error) => {
          clearTimeout(timer);
          if (!timedOut) reject(error);
        },
      );
    });
  }

  /** Resolve true once an audio input is present, else false after `timeoutMs`. */
  private waitForInputDevice(timeoutMs: number): Promise<boolean> {
    const media = navigator.mediaDevices;
    return new Promise((resolve) => {
      let settled = false;
      const finish = (ok: boolean) => {
        if (settled) return;
        settled = true;
        clearInterval(poll);
        clearTimeout(timer);
        media.removeEventListener?.("devicechange", probe);
        resolve(ok);
      };
      const probe = () => {
        void this.enumerateDevices().then((devices) => {
          if (devices.some((device) => device.kind === "audioinput" && device.deviceId)) finish(true);
        });
      };
      media.addEventListener?.("devicechange", probe);
      const poll = setInterval(probe, 500);
      const timer = setTimeout(() => finish(false), timeoutMs);
      probe();
    });
  }

  /**
   * Watch a mic track for OS suspension. iOS mutes (and sometimes ends) the mic
   * track when it backgrounds the owning realm; `enabled=false` from our own
   * mute does NOT fire these, so `mute` here always means the source stopped.
   */
  attachMicLifecycle(session: SessionHandle, track: MediaStreamTrack) {
    track.onmute = () => {
      if (!this.host.isCurrent(session)) return;
      const hidden = typeof document !== "undefined" && document.visibilityState === "hidden";
      // Name the tool that ran just before this, so a suspension caused by a
      // navigation tool we haven't classified yet is self-reporting in the logs.
      const cause = this.host.recentToolName();
      this.host.logDiag("mic.track.muted", { hidden, cause });
      if (hidden) {
        // Backgrounded on mobile: the mic is gone and this realm is about to
        // freeze. End cleanly NOW (while the handler still runs) and enforce it
        // server-side, so it never becomes an unstoppable zombie.
        this.host.logDiag("mic.suspend.teardown", { cause });
        this.host.endBecauseSuspended();
      } else {
        // Mic muted while visible (another app grabbed it, glitch): try to heal.
        this.host.setMicSuspended(true);
        void this.recoverMicIfNeeded(session);
      }
    };
    track.onunmute = () => {
      if (!this.host.isCurrent(session)) return;
      this.host.logDiag("mic.track.unmuted", {});
      this.host.setMicSuspended(false); // OS resumed the same track — uplink is back
    };
    track.onended = () => {
      if (!this.host.isCurrent(session)) return;
      this.host.logDiag("mic.track.ended", {});
      this.host.setMicSuspended(true);
      void this.recoverMicIfNeeded(session);
    };
  }

  /** On returning to the foreground, try to revive a suspended mic. */
  attachPageLifecycle(session: SessionHandle) {
    if (typeof document === "undefined") return;
    const onVisibility = () => {
      if (!this.host.isCurrent(session)) return;
      this.host.logDiag("page.visibility", { state: document.visibilityState });
      if (document.visibilityState === "visible") void this.recoverMicIfNeeded(session);
    };
    document.addEventListener("visibilitychange", onVisibility);
    session.disposeLifecycle = () => document.removeEventListener("visibilitychange", onVisibility);
  }

  /**
   * Replace a dead/suspended mic track with a fresh one, keeping the same pc and
   * realtime session (replaceTrack needs no renegotiation). Only attempts in the
   * foreground — iOS blocks getUserMedia while backgrounded. A no-op when the mic
   * is already healthy.
   */
  private async recoverMicIfNeeded(session: SessionHandle) {
    if (!this.host.isCurrent(session)) return;
    const sender = session.micSender;
    const track = session.micTrack;
    if (!sender) return;
    if (track && track.readyState === "live" && !track.muted) {
      this.host.setMicSuspended(false); // already healthy
      return;
    }
    if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
    this.host.logDiag("mic.recover.attempt", { readyState: track?.readyState ?? null, muted: track?.muted ?? null });
    try {
      const fresh = await this.acquireMic(this.host.inputDeviceId());
      if (!this.host.isCurrent(session)) {
        for (const t of fresh.getTracks()) t.stop();
        return;
      }
      const newTrack = fresh.getAudioTracks()[0];
      if (!newTrack) throw new Error("no audio track");
      newTrack.enabled = !this.host.isMuted(); // preserve the user's mute
      await sender.replaceTrack(newTrack);
      // Detach the old track's lifecycle handlers before stopping it — otherwise
      // its onended fires (session still current) and re-enters suspend/recover,
      // flashing a false "mic paused".
      if (session.micTrack) {
        session.micTrack.onmute = null;
        session.micTrack.onunmute = null;
        session.micTrack.onended = null;
        session.micTrack.stop();
      }
      session.micTrack = newTrack;
      this.attachMicLifecycle(session, newTrack);
      this.host.setMicSuspended(false);
      this.host.logDiag("mic.recover.ok", {});
    } catch (error) {
      this.host.logDiag("mic.recover.failed", { name: error instanceof Error ? error.name : "unknown" });
    }
  }
}
