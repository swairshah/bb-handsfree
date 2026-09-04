import { useEffect, useRef, useState, type ReactElement } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { Button } from "./components/ui/button";
import type { Voice } from "./models";
import type { rpcContract } from "./server";

type PreviewState = "idle" | "connecting" | "playing";

/** Key by voice/model so changing either disposes the previous sample. */
export function VoicePreview({
  voice,
  disabled,
}: {
  voice: Voice;
  disabled: boolean;
}): ReactElement {
  const rpc = useRpc<typeof rpcContract>();
  const [state, setState] = useState<PreviewState>("idle");
  const [error, setError] = useState<string | null>(null);
  const stop = useRef<(() => void) | null>(null);
  useEffect(
    () => () => {
      stop.current?.();
    },
    [],
  );

  function start(): void {
    if (stop.current) {
      stop.current();
      return;
    }
    setError(null);
    setState("connecting");
    let peer: RTCPeerConnection;
    try {
      peer = new RTCPeerConnection();
    } catch {
      setState("idle");
      setError("Voice previews are unavailable in this browser.");
      return;
    }
    const audio: HTMLAudioElement = new Audio();
    audio.autoplay = true;
    audio.setAttribute("playsinline", "");
    audio.hidden = true;
    document.body.append(audio);
    const channel: RTCDataChannel = peer.createDataChannel("voice-preview");
    let disposed: boolean = false;
    const timeout: ReturnType<typeof setTimeout> = setTimeout(() => {
      fail("Voice preview timed out. Please try again.");
    }, 30000);

    function dispose(): void {
      if (disposed) return;
      disposed = true;
      clearTimeout(timeout);
      channel.onopen = channel.onmessage = channel.onclose = null;
      peer.ontrack = peer.onconnectionstatechange = null;
      channel.close();
      peer
        .getReceivers()
        .forEach((receiver: RTCRtpReceiver): void => receiver.track.stop());
      peer.close();
      audio.pause();
      audio.srcObject = null;
      audio.remove();
      stop.current = null;
      setState("idle");
    }
    function fail(message: string): void {
      if (disposed) return;
      dispose();
      setError(message);
    }
    stop.current = dispose;
    // Receive only: never ask for microphone permission or send user audio.
    peer.addTransceiver("audio", { direction: "recvonly" });
    peer.ontrack = (event: RTCTrackEvent): void => {
      if (disposed) return;
      audio.srcObject = event.streams[0] ?? new MediaStream([event.track]);
      void audio
        .play()
        .catch((): void =>
          fail("Could not play the preview. Check your speaker and try again."),
        );
    };
    peer.onconnectionstatechange = (): void => {
      if (
        peer.connectionState === "failed" ||
        peer.connectionState === "disconnected"
      ) {
        fail("Voice preview disconnected. Please try again.");
      }
    };
    channel.onopen = (): void => {
      if (!disposed) channel.send(JSON.stringify({ type: "response.create" }));
    };
    channel.onclose = (): void =>
      fail("Voice preview disconnected. Please try again.");
    channel.onmessage = (message: MessageEvent<string>): void => {
      if (disposed) return;
      let event: unknown;
      try {
        event = JSON.parse(message.data);
      } catch {
        return;
      }
      if (typeof event !== "object" || event === null || !("type" in event))
        return;
      if (event.type === "output_audio_buffer.started") setState("playing");
      if (event.type === "output_audio_buffer.stopped") dispose();
      if (event.type === "error")
        fail(
          "The voice service could not play this preview. Please try again.",
        );
      if (event.type === "response.done" && "response" in event) {
        const response: unknown = event.response;
        if (
          typeof response === "object" &&
          response !== null &&
          "status" in response &&
          response.status !== "completed"
        ) {
          fail("The voice sample could not finish. Please try again.");
        }
      }
    };
    async function connect(): Promise<void> {
      const offer: RTCSessionDescriptionInit = await peer.createOffer();
      if (disposed) return;
      await peer.setLocalDescription(offer);
      if (disposed) return;
      const sdp: string | undefined = peer.localDescription?.sdp;
      if (!sdp) throw new Error("Could not prepare the voice preview.");
      const answer: { sdp: string } = await rpc.call("previewVoice", {
        sdp,
        voice,
      });
      if (!disposed)
        await peer.setRemoteDescription({ type: "answer", sdp: answer.sdp });
    }
    void connect().catch((cause: unknown): void => {
      fail(
        cause instanceof Error
          ? cause.message
          : "Could not connect the voice preview.",
      );
    });
  }

  return (
    <div className="space-y-2">
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={disabled}
        onClick={start}
        aria-label={
          state === "idle" ? `Preview ${voice} voice` : "Stop voice preview"
        }
      >
        {state === "idle" ? "Preview voice" : "Stop preview"}
      </Button>
      <p className="text-xs text-muted-foreground" role="status">
        {state === "connecting"
          ? "Connecting preview…"
          : state === "playing"
            ? `Playing ${voice}…`
            : "Hear a short sample. Uses your configured voice service; microphone stays off."}
      </p>
      {error ? (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
