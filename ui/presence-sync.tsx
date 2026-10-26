// Cross-realm presence input for this realm's voiceAgent.
//
// Every realm needs its voiceAgent to hear `voice-call` (another start ends
// this realm's call), `voice-mute` (CLI mute), `voice-presence` (mirror a
// remote call), `voice-command` (act on relayed stop/mute when this realm owns
// the call) and `voice-presence-query` (answer a peer's catch-up request). Historically only the composer button and the
// Handsfree page subscribed, so on any other route remote transitions were
// lost and the sidebar/root state went stale.
//
// `PresenceSync` is mounted once per app window as a null-rendering app
// overlay, so the realm hears presence for the window's whole lifetime. The
// composer button and page keep calling `usePresenceSync()` as a fallback for
// hosts without app overlays; only one holder per realm acts on each event,
// so the overlay and a surface never apply or answer the same event twice.
// Each holder also lends its RPC client as the realm's outgoing presence
// transport, so an owner's heartbeats and query replies continue off-page.
import { useEffect, useRef } from "react";
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../server";
import { voiceAgent } from "../voice/agent";

const holders: symbol[] = [];

/** Test-only: number of live holders in this realm. */
export function presenceHolderCount() { return holders.length; }

export function usePresenceSync() {
  const rpc = useRpc<typeof rpcContract>();
  const token = useRef<symbol>(Symbol("presence-holder")).current;
  // Outgoing presence (heartbeats, query replies, relayed commands) uses this
  // holder's RPC client whenever no surface has bound the agent.
  useEffect(() => voiceAgent.providePresenceRpc(rpc), [rpc]);
  const holding = () => holders[0] === token;
  // Global exclusivity: when any window starts a call, every other one stops.
  useRealtime("voice-call", (payload) => {
    const nonce = (payload as { nonce?: unknown } | null)?.nonce;
    if (holding() && typeof nonce === "string") voiceAgent.onCallStarted(nonce);
  });
  // CLI mute control: bb handsfree mute|unmute broadcasts on this channel.
  useRealtime("voice-mute", (payload) => {
    const muted = (payload as { muted?: unknown } | null)?.muted;
    if (holding() && typeof muted === "boolean") voiceAgent.setMuted(muted);
  });
  useRealtime("voice-presence", (payload) => { if (holding()) voiceAgent.ingestPresence(payload); });
  useRealtime("voice-command", (payload) => { if (holding()) voiceAgent.applyVoiceCommand(payload); });
  useRealtime("voice-presence-query", () => { if (holding()) voiceAgent.answerPresenceQuery(); });
  useEffect(() => {
    const first = holders.length === 0;
    holders.push(token);
    // Catch up the moment this realm starts listening (e.g. a realm rebuilt
    // after mobile navigation) instead of waiting up to a heartbeat. Uses this
    // component's own RPC client: the realm may have no composer bound yet.
    if (first) void rpc.call("requestPresence", null).catch(() => undefined);
    return () => {
      const index = holders.indexOf(token);
      if (index >= 0) holders.splice(index, 1);
    };
  }, [rpc, token]);
}

/** Window-lifetime presence listener; renders nothing. */
export function PresenceSync() {
  usePresenceSync();
  return null;
}
