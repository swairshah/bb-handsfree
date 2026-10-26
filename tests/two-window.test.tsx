// Two windows, one backend: the real Handsfree frontend bundle is loaded twice
// (two realms, each with its own voiceAgent singleton, realmId and React tree),
// talking to the real server.ts handlers through the SDK fake host. Realtime
// publishes are delivered by `deliver()` to the windows a scenario chooses, so
// tests can withhold presence from one window. WebRTC, the mic and OpenAI are
// fakes: no microphone, network or paid call. Both realms share one jsdom
// document and Node global (navigator, localStorage), like two surfaces on one
// device; that is the closest fixture available to separate app windows.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import React from "react";
import { act, fireEvent } from "@testing-library/react";
import { installTestPluginRuntime, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin, { rpcContract } from "../server.ts";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost", pretendToBeVisual: true });
for (const [name, value] of Object.entries({ window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, localStorage: dom.window.localStorage, IS_REACT_ACT_ENVIRONMENT: true, React })) {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}

// ---- WebRTC / media fakes (same shape as voice-agent.test.ts) ----
const peers: FakePeerConnection[] = [];
class FakePeerConnection {
  iceGatheringState = "complete";
  connectionState = "new";
  iceConnectionState = "new";
  localDescription: RTCSessionDescriptionInit | null = null;
  closed = false;
  remoteApplied = false;
  dc: { readyState: string; onopen: null | (() => void); close(): void; send(): void; onclose: null; onmessage: null } | null = null;
  ontrack = null; onconnectionstatechange = null; oniceconnectionstatechange = null;
  constructor() { peers.push(this); }
  addTrack() { return {}; }
  addEventListener() {}
  removeEventListener() {}
  getSenders() { return []; }
  close() { this.closed = true; }
  createDataChannel() {
    this.dc = { readyState: "connecting", onopen: null, onclose: null, onmessage: null, close() {}, send() {} };
    return this.dc;
  }
  async createOffer() { return { type: "offer" as const, sdp: "offer" }; }
  async setLocalDescription(description: RTCSessionDescriptionInit) { this.localDescription = description; }
  async setRemoteDescription() {
    this.remoteApplied = true;
    // The data channel opens once the answer lands: the call is live.
    queueMicrotask(() => { if (this.dc) { this.dc.readyState = "open"; this.dc.onopen?.(); } });
  }
}
class FakeAudio { autoplay = false; srcObject: unknown = null; style = {}; async play() {} remove() {} setAttribute() {} }
const track = { enabled: true, kind: "audio", stop() {}, addEventListener() {}, removeEventListener() {}, getSettings: () => ({}) };
const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
Object.defineProperty(globalThis, "navigator", { configurable: true, value: {
  userAgent: "Mozilla/5.0 (Macintosh) Chrome",
  mediaDevices: {
    getUserMedia: async () => stream,
    enumerateDevices: async () => [{ deviceId: "mic-1", kind: "audioinput", label: "Built-in Mic", groupId: "" }],
    addEventListener() {}, removeEventListener() {},
  },
} });
Object.defineProperty(globalThis, "RTCPeerConnection", { configurable: true, value: FakePeerConnection });
Object.defineProperty(globalThis, "Audio", { configurable: true, value: FakeAudio });
installTestPluginRuntime();

// ---- one frontend bundle, loaded once per window ----
const directory = mkdtempSync(join(process.cwd(), ".handsfree-two-window-"));
const entry = join(directory, "entry.ts");
writeFileSync(entry, [
  `export { voiceAgent } from "../voice/agent.ts";`,
  `export { SessionsPanel } from "../ui/sessions-panel.tsx";`,
  `export { PresenceSync } from "../ui/presence-sync.tsx";`,
].join("\n"));
const bundle = join(directory, "frontend.mjs");
await build({ entryPoints: [entry], outfile: bundle, bundle: true, platform: "node", format: "esm", packages: "external", loader: { ".css": "empty" }, jsx: "automatic", logLevel: "silent" });
type Frontend = typeof import("../ui/sessions-panel.tsx") & typeof import("../voice/agent.ts") & typeof import("../ui/presence-sync.tsx");
const loadWindow = (name: string) => import(`${pathToFileURL(bundle).href}?window=${name}`) as Promise<Frontend>;
after(() => { rmSync(directory, { recursive: true, force: true }); dom.window.close(); });

const settle = () => act(async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setTimeout(resolve, 5)); });

async function backend(duringExchange?: (rpc: Record<string, (input: unknown) => Promise<unknown>>) => Promise<void>) {
  const { bb, harness } = createFakePluginHost({ pluginId: "handsfree" });
  const originalFetch = globalThis.fetch;
  const savedKey = process.env.OPENAI_API_KEY;
  let exchanges = 0;
  globalThis.fetch = (async () => {
    exchanges += 1;
    await duringExchange?.(rpc);
    return new Response("answer", { status: 200 });
  }) as typeof fetch;
  process.env.OPENAI_API_KEY = "test-key";
  await plugin(bb);
  let current = harness;
  const rpc: Record<string, (input: unknown) => Promise<unknown>> = Object.fromEntries(Object.keys(rpcContract).map(method =>
    [method, (input: unknown) => current.behavior.callRpc(method as never, input as never)]));
  let delivered = 0;
  return {
    rpc,
    exchanges: () => exchanges,
    voiceCalls: () => current.inspection.realtimeSignals.filter(s => s.channel === "voice-call").map(s => (s.payload as { nonce: string }).nonce),
    async restart() {
      const next = await current.lifecycle.reload(plugin);
      current = next.harness; delivered = 0;
    },
    /** Deliver pending realtime publishes to the chosen windows' slots. */
    async deliver(slots: ReturnType<typeof renderSlot>[]) {
      const signals = current.inspection.realtimeSignals;
      while (delivered < signals.length) {
        const { channel, payload } = signals[delivered++];
        for (const slot of slots) await slot.behavior.emitRealtime(channel, payload);
      }
    },
    /** Drop pending publishes (a window that never hears them). */
    skip() { delivered = current.inspection.realtimeSignals.length; },
    async dispose() {
      globalThis.fetch = originalFetch;
      if (savedKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = savedKey;
      await current.lifecycle.dispose();
    },
  };
}

function openWindow(frontend: Frontend, rpc: Record<string, unknown>, subPath = "") {
  const overlay = renderSlot({ component: frontend.PresenceSync }, {}, { rpc: rpc as never });
  const page = renderSlot({ component: frontend.SessionsPanel }, { subPath }, { rpc: rpc as never });
  return { frontend, overlay, page, slots: [overlay, page], close() { page.lifecycle.unmount(); overlay.lifecycle.unmount(); frontend.voiceAgent.stop(); } };
}
const transcriptOpen = (w: ReturnType<typeof openWindow>) => w.page.queryByRole("button", { name: "← All sessions" }) !== null;
const notice = (w: ReturnType<typeof openWindow>) => w.page.queryByRole("status")?.textContent ?? null;

test("idle: the sidebar route starts exactly one call and opens its transcript", async () => {
  const server = await backend();
  const a = openWindow(await loadWindow("idle-a"), server.rpc);
  const b = openWindow(await loadWindow("idle-b"), server.rpc, "start");
  try {
    await settle(); await server.deliver([...a.slots, ...b.slots]); await settle();
    const nonce = b.frontend.voiceAgent.getSessionId();
    assert.ok(nonce);
    assert.equal(server.exchanges(), 1);
    assert.deepEqual(server.voiceCalls(), [nonce]);
    assert.equal(b.frontend.voiceAgent.getState(), "live");
    assert.ok(transcriptOpen(b), "window B shows its new call's transcript");
    assert.equal(a.frontend.voiceAgent.getState(), "live", "window A mirrors it");
    assert.deepEqual(b.page.inspection.navigateCalls, [{ method: "toPluginPanel", path: "sessions", options: { replace: true } }]);
  } finally { b.close(); a.close(); await server.dispose(); }
});

test("a call live in another window is opened, never replaced, even when its presence never arrives", async () => {
  const server = await backend();
  const a = openWindow(await loadWindow("live-a"), server.rpc);
  try {
    await settle();
    fireEvent.click(a.page.getByRole("button", { name: "Start Aide voice agent" })); // ordinary manual Start
    await settle(); await server.deliver(a.slots); await settle();
    const callA = a.frontend.voiceAgent.getSessionId();
    assert.equal(a.frontend.voiceAgent.getState(), "live");
    // Window B mounts and is tapped; it hears no presence at all.
    server.skip();
    const b = openWindow(await loadWindow("live-b"), server.rpc, "start");
    try {
      await settle(); server.skip(); await settle();
      assert.equal(b.frontend.voiceAgent.getState(), "idle", "B never learned of the call");
      assert.equal(server.exchanges(), 1, "no second exchange");
      assert.deepEqual(server.voiceCalls(), [callA], "no voice-call ended A");
      assert.equal(a.frontend.voiceAgent.getState(), "live");
      assert.ok(transcriptOpen(b), "B opens A's transcript from the ledger");
      assert.equal(notice(b), "A call is active elsewhere.Take overEnd it");
      // Once B hears presence, it mirrors the call and the notice goes away.
      a.frontend.voiceAgent.answerPresenceQuery();
      await settle(); await server.deliver([...a.slots, ...b.slots]); await settle();
      assert.equal(b.frontend.voiceAgent.getState(), "live");
      assert.equal(notice(b), null);
    } finally { b.close(); }
  } finally { a.close(); await server.dispose(); }
});

test("two windows tapped together start one call; the other is told a call is starting", async () => {
  const server = await backend();
  const a = openWindow(await loadWindow("race-a"), server.rpc, "start");
  const b = openWindow(await loadWindow("race-b"), server.rpc, "start");
  try {
    await settle(); server.skip(); await settle(); // neither hears the other
    const owners = [a, b].filter(w => w.frontend.voiceAgent.getState() !== "idle");
    assert.equal(owners.length, 1);
    assert.equal(server.exchanges(), 1);
    const loser = owners[0] === a ? b : a;
    assert.match(notice(loser) ?? "", /^A call is (starting|active) elsewhere\./);
  } finally { b.close(); a.close(); await server.dispose(); }
});

test("after a backend restart an unconfirmed call blocks the sidebar start until an explicit choice", async () => {
  const server = await backend();
  const a = openWindow(await loadWindow("restart-a"), server.rpc);
  try {
    await settle();
    fireEvent.click(a.page.getByRole("button", { name: "Start Aide voice agent" }));
    await settle(); server.skip();
    const callA = a.frontend.voiceAgent.getSessionId();
    a.close(); // the owner vanishes without announcing idle
    await server.restart();
    const b = openWindow(await loadWindow("restart-b"), server.rpc, "start");
    try {
      await settle(); server.skip(); await settle();
      assert.equal(server.exchanges(), 1, "no start from unknown");
      assert.equal(b.frontend.voiceAgent.getState(), "idle");
      assert.equal(notice(b), "A previous call may still be active.Take overEnd it");
      assert.equal(transcriptOpen(b), false);
      // Explicit End: forceStop clears the ledger; the next sidebar tap starts.
      fireEvent.click(b.page.getByRole("button", { name: "End it" }));
      await settle(); server.skip();
      const c = openWindow(await loadWindow("restart-c"), server.rpc, "start");
      try {
        await settle(); server.skip(); await settle();
        assert.equal(server.exchanges(), 2);
        assert.notEqual(c.frontend.voiceAgent.getSessionId(), callA);
        assert.equal(c.frontend.voiceAgent.getState(), "live");
      } finally { c.close(); }
    } finally { b.close(); }
  } finally { await server.dispose(); }
});

test("explicit Take over stays explicit: it starts and ends the unknown call", async () => {
  const server = await backend();
  const a = openWindow(await loadWindow("take-a"), server.rpc);
  try {
    await settle();
    fireEvent.click(a.page.getByRole("button", { name: "Start Aide voice agent" }));
    await settle(); server.skip();
    a.close();
    await server.restart();
    const b = openWindow(await loadWindow("take-b"), server.rpc, "start");
    try {
      await settle(); server.skip(); await settle();
      assert.equal(server.exchanges(), 1);
      fireEvent.click(b.page.getByRole("button", { name: "Take over" }));
      await settle();
      assert.equal(server.exchanges(), 2);
      assert.equal(b.frontend.voiceAgent.getState(), "live");
      assert.equal(server.voiceCalls().at(-1), b.frontend.voiceAgent.getSessionId(), "takeover announces itself, ending others");
    } finally { b.close(); }
  } finally { await server.dispose(); }
});

test("a sidebar start superseded during the exchange closes its connection and ends nothing", async () => {
  let once = true;
  const server = await backend(async (rpc) => {
    // Another device starts while this window's exchange is in flight.
    if (once) { once = false; await rpc.publishPresence({ nonce: "phone", phase: "connecting", startedAt: 1 }); }
  });
  const b = openWindow(await loadWindow("superseded-b"), server.rpc, "start");
  try {
    await settle(); server.skip(); await settle();
    const peer = peers.at(-1)!;
    assert.equal(server.exchanges(), 1);
    assert.deepEqual(server.voiceCalls(), [], "the phone call is not ended");
    assert.equal(peer.closed, true, "the created peer connection is closed");
    assert.equal(peer.remoteApplied, false, "the answer is never applied");
    assert.equal(b.frontend.voiceAgent.getState(), "idle");
    const reply = await server.rpc.reserveCall({ nonce: "later" }) as { conflict: { nonce: string } };
    assert.equal(reply.conflict.nonce, "phone", "only the phone call remains in the ledger");
  } finally { b.close(); await server.dispose(); }
});

test("Take over ends a live owner that is still mounted, and only the newest call survives", async () => {
  const server = await backend();
  const a = openWindow(await loadWindow("survivor-a"), server.rpc);
  try {
    await settle();
    fireEvent.click(a.page.getByRole("button", { name: "Start Aide voice agent" }));
    await settle(); await server.deliver(a.slots); await settle();
    const callA = a.frontend.voiceAgent.getSessionId()!;
    assert.equal(a.frontend.voiceAgent.getState(), "live");
    server.skip();
    const b = openWindow(await loadWindow("survivor-b"), server.rpc, "start");
    try {
      await settle(); server.skip(); await settle(); // B hears nothing: blocked
      assert.equal(notice(b), "A call is active elsewhere.Take overEnd it");
      fireEvent.click(b.page.getByRole("button", { name: "Take over" }));
      await settle();
      const callB = b.frontend.voiceAgent.getSessionId()!;
      assert.notEqual(callB, callA);
      await server.deliver([...a.slots, ...b.slots]); await settle();
      assert.equal(a.frontend.voiceAgent.getState() === "live" && a.frontend.voiceAgent.getSessionId() === callA, false, "A's own call ended");
      assert.equal(peers.filter(peer => !peer.closed).length, 1, "exactly one open connection remains");
      assert.equal(b.frontend.voiceAgent.getState(), "live");
      await settle(); await server.deliver([...a.slots, ...b.slots]); await settle();
      const reply = await server.rpc.reserveCall({ nonce: "later" }) as { conflict: { nonce: string } };
      assert.equal(reply.conflict.nonce, callB, "the ledger holds only the surviving call");
    } finally { b.close(); }
  } finally { a.close(); await server.dispose(); }
});
