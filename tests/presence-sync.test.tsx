import test, { after } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import React from "react";
import { installTestPluginRuntime, renderSlot } from "@get-bb/plugin-sdk/testing/app";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost", pretendToBeVisual: true });
for (const [name, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })) {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}
installTestPluginRuntime();
Object.defineProperty(globalThis, "React", { value: React, configurable: true, writable: true });
const { publishVoiceState, VOICE_STATE_ATTR } = await import("../voice/dom-state.ts");
const { voiceAgent } = await import("../voice/agent.ts");
const { PresenceSync, presenceHolderCount } = await import("../ui/presence-sync.tsx");
const { SessionsPanel } = await import("../ui/sessions-panel.tsx");
after(() => dom.window.close());

const rpc = {
  listSessions: () => ({ sessions: [], hasMore: false }),
  listPlugins: () => ({ plugins: [] }),
  getSessionEvents: () => ({ events: [] }),
  requestPresence: () => ({ ok: true }),
  publishPresence: () => ({ ok: true }),
  logEvent: () => ({ ok: true }),
};
const presence = (phase: string) => ({ nonce: "remote-sync", phase, startedAt: phase === "idle" ? null : Date.now(), client: "phone", realm: "phone-realm" });

test("the window overlay keeps root state current after the page unmounts, without double handling", async () => {
  const root = dom.window.document.documentElement;
  const unpublish = publishVoiceState(root, voiceAgent);
  const overlay = renderSlot({ component: PresenceSync }, {}, { rpc: rpc as never });
  const page = renderSlot({ component: SessionsPanel }, { subPath: "" }, { rpc: rpc as never });
  // Both components hear the one realtime bus; emulate it by emitting to both.
  const emit = async (channel: string, payload: unknown, slots = [overlay, page]) => {
    for (const slot of slots) await slot.behavior.emitRealtime(channel, payload);
  };
  const ingest = voiceAgent.ingestPresence.bind(voiceAgent);
  let ingested = 0;
  voiceAgent.ingestPresence = (payload: unknown) => { ingested += 1; ingest(payload); };
  try {
    // Only the first holder in the realm asks peers to re-announce.
    const requests = [...overlay.inspection.rpcCalls, ...page.inspection.rpcCalls].filter(call => call.method === "requestPresence");
    assert.equal(requests.length, 1);
    assert.equal(presenceHolderCount(), 2);
    await emit("voice-presence", presence("live"));
    assert.equal(root.getAttribute(VOICE_STATE_ATTR), "live");
    assert.equal(ingested, 1, "one holder acts per event");
    page.lifecycle.unmount();
    await emit("voice-presence", presence("muted"), [overlay]);
    assert.equal(root.getAttribute(VOICE_STATE_ATTR), "muted", "remote mute after the page unmounts");
    await emit("voice-presence", presence("live"), [overlay]);
    assert.equal(root.getAttribute(VOICE_STATE_ATTR), "live", "remote unmute");
    await emit("voice-presence", presence("idle"), [overlay]);
    assert.equal(root.getAttribute(VOICE_STATE_ATTR), null, "remote end");
    await emit("voice-presence", { ...presence("live"), nonce: "remote-sync-2" }, [overlay]);
    assert.equal(root.getAttribute(VOICE_STATE_ATTR), "live", "a new remote call is discovered");
    await emit("voice-presence", { ...presence("idle"), nonce: "remote-sync-2" }, [overlay]);
  } finally {
    voiceAgent.ingestPresence = ingest;
    overlay.lifecycle.unmount();
    unpublish();
  }
  assert.equal(presenceHolderCount(), 0, "unmounting releases every holder");
  assert.equal(root.hasAttribute(VOICE_STATE_ATTR), false);
});

test("a surface falls back to holding presence when no overlay is mounted", async () => {
  const page = renderSlot({ component: SessionsPanel }, { subPath: "" }, { rpc: rpc as never });
  try {
    assert.equal(presenceHolderCount(), 1);
    await page.behavior.emitRealtime("voice-presence", presence("live"));
    assert.equal(voiceAgent.getState(), "live");
    await page.behavior.emitRealtime("voice-presence", presence("idle"));
    assert.equal(voiceAgent.getState(), "idle");
  } finally {
    page.lifecycle.unmount();
  }
});

test("an owner with no surface bound still answers queries and heartbeats through the overlay", async () => {
  const published: unknown[] = [];
  const overlay = renderSlot({ component: PresenceSync }, {}, { rpc: { ...rpc, publishPresence: (input: unknown) => { published.push(input); return { ok: true }; } } as never });
  const agent = voiceAgent as unknown as { state: string; nonce: string | null; bindings: unknown };
  try {
    assert.equal(agent.bindings, null);
    // Model an existing local call without audio or a paid call.
    agent.state = "live"; agent.nonce = "owned-off-page";
    await overlay.behavior.emitRealtime("voice-presence-query", {});
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(published.length, 1, "query reply is published off-page");
    assert.equal((published[0] as { nonce: string }).nonce, "owned-off-page");
  } finally {
    agent.state = "idle"; agent.nonce = null;
    overlay.lifecycle.unmount();
  }
  // Released with the overlay: nothing is published without a transport.
  agent.state = "live"; agent.nonce = "owned-off-page";
  try { voiceAgent.answerPresenceQuery(); } finally { agent.state = "idle"; agent.nonce = null; }
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(published.length, 1);
});

test("holders that share one RPC client release only their own registration", async () => {
  const published: unknown[] = [];
  // One client object, as useRpc returns within a slot environment.
  const shared = { call: async (method: string, input: unknown) => { if (method === "publishPresence") published.push(input); return { ok: true }; } } as never;
  const agent = voiceAgent as unknown as { state: string; nonce: string | null; bindings: unknown };
  const releaseFirst = voiceAgent.providePresenceRpc(shared);
  const releaseSecond = voiceAgent.providePresenceRpc(shared);
  const answer = async () => {
    agent.state = "live"; agent.nonce = "owned-off-page";
    try { voiceAgent.answerPresenceQuery(); } finally { agent.state = "idle"; agent.nonce = null; }
    await new Promise(resolve => setTimeout(resolve, 0));
  };
  try {
    assert.equal(agent.bindings, null);
    releaseFirst();
    releaseFirst(); // idempotent: must not remove the second registration
    await answer();
    assert.equal(published.length, 1, "the remaining holder still has a transport");
  } finally {
    releaseSecond();
  }
  await answer();
  assert.equal(published.length, 1, "the last release removes the transport");
});
