import test, { after } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import React from "react";
import { installTestPluginRuntime, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { act } from "@testing-library/react";
import type { VoiceActivity, VoiceState } from "../voice/agent.ts";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost", pretendToBeVisual: true });
for (const [name, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })) {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}
installTestPluginRuntime();
// The test runner compiles JSX in classic mode; sessions-panel.tsx relies on
// the production bundler's automatic runtime.
Object.defineProperty(globalThis, "React", { value: React, configurable: true, writable: true });
const { publishVoiceState, VOICE_ACTIVITY_ATTR, VOICE_STATE_ATTR } = await import("../voice/dom-state.ts");
const { voiceAgent } = await import("../voice/agent.ts");
const { SessionsPanel } = await import("../ui/sessions-panel.tsx");
after(() => dom.window.close());

function fakeSource() {
  const listeners = new Set<() => void>();
  const value = { state: "idle" as VoiceState, activity: "idle" as VoiceActivity, suspended: false };
  return {
    value,
    listeners,
    set(next: Partial<typeof value>) { Object.assign(value, next); for (const listener of listeners) listener(); },
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getState: () => value.state,
    getActivity: () => value.activity,
    getMicSuspended: () => value.suspended,
  };
}

test("root attributes follow call state and only claim the mic while it can hear the user", () => {
  const root = document.createElement("div");
  root.setAttribute(VOICE_STATE_ATTR, "live"); // stale value from an old bundle
  const source = fakeSource();
  const dispose = publishVoiceState(root, source);
  const read = () => [root.getAttribute(VOICE_STATE_ATTR), root.getAttribute(VOICE_ACTIVITY_ATTR)];
  assert.deepEqual(read(), [null, null]);
  source.set({ state: "connecting" });
  assert.deepEqual(read(), ["connecting", null]);
  source.set({ state: "live" });
  assert.deepEqual(read(), ["live", null]);
  source.set({ activity: "you" });
  assert.deepEqual(read(), ["live", "you"]);
  source.set({ suspended: true });
  assert.deepEqual(read(), ["live", null], "a suspended mic is not listening");
  source.set({ suspended: false, state: "muted" });
  assert.deepEqual(read(), ["muted", null], "a muted mic is not listening");
  source.set({ activity: "aide" });
  assert.deepEqual(read(), ["muted", "aide"], "Aide may still speak while you are muted");
  source.set({ state: "idle", activity: "idle" });
  assert.deepEqual(read(), [null, null]);
  source.set({ state: "live" });
  dispose();
  assert.deepEqual(read(), [null, null]);
  assert.equal(source.listeners.size, 0);
});

test("a call mirrored from another surface shows as live without an activity claim", () => {
  const root = document.createElement("div");
  const dispose = publishVoiceState(root, voiceAgent);
  try {
    voiceAgent.ingestPresence({ nonce: "remote-1", phase: "live", startedAt: Date.now(), client: "phone", realm: "phone-realm" });
    assert.equal(root.getAttribute(VOICE_STATE_ATTR), "live");
    assert.equal(root.getAttribute(VOICE_ACTIVITY_ATTR), null);
    voiceAgent.ingestPresence({ nonce: "remote-1", phase: "muted", startedAt: Date.now(), client: "phone", realm: "phone-realm" });
    assert.equal(root.getAttribute(VOICE_STATE_ATTR), "muted");
    voiceAgent.ingestPresence({ nonce: "remote-1", phase: "idle", client: "phone", realm: "phone-realm" });
    assert.equal(root.getAttribute(VOICE_STATE_ATTR), null);
  } finally {
    voiceAgent.ingestPresence({ nonce: "remote-1", phase: "idle", client: "phone", realm: "phone-realm" });
    dispose();
  }
});

const sessionRpc = {
  listSessions: () => ({ sessions: [], hasMore: false }),
  listPlugins: () => ({ plugins: [] }),
  getSessionEvents: () => ({ events: [] }),
  requestPresence: () => null,
  publishPresence: () => null,
  logEvent: () => null,
};

test("the live deep link opens the active transcript once presence arrives, then drops the subpath", async () => {
  const slot = renderSlot({ component: SessionsPanel }, { subPath: "live" }, { rpc: sessionRpc as never });
  try {
    assert.equal(slot.queryByRole("button", { name: "← All sessions" }), null);
    await slot.behavior.emitRealtime("voice-presence", { nonce: "remote-2", phase: "live", startedAt: Date.now(), client: "phone", realm: "phone-realm" });
    assert.ok(slot.getByRole("button", { name: "← All sessions" }), "transcript view is shown");
    assert.deepEqual(slot.inspection.navigateCalls, [{ method: "toPluginPanel", path: "sessions", options: { replace: true } }]);
    // The host keeps the panel mounted while the subpath changes.
    act(() => slot.lifecycle.rerender(<SessionsPanel subPath="" />));
    assert.ok(slot.getByRole("button", { name: "← All sessions" }));
    assert.equal(slot.inspection.navigateCalls.length, 1);
    assert.equal(slot.inspection.rpcCalls.some(call => call.method === "getSessionEvents"), true);
  } finally {
    await slot.behavior.emitRealtime("voice-presence", { nonce: "remote-2", phase: "idle", client: "phone", realm: "phone-realm" });
    slot.lifecycle.unmount();
  }
});

test("the plain Handsfree page does not jump to a live transcript", async () => {
  const slot = renderSlot({ component: SessionsPanel }, { subPath: "" }, { rpc: sessionRpc as never });
  try {
    await slot.behavior.emitRealtime("voice-presence", { nonce: "remote-3", phase: "live", startedAt: Date.now(), client: "phone", realm: "phone-realm" });
    assert.equal(slot.queryByRole("button", { name: "← All sessions" }), null);
    assert.deepEqual(slot.inspection.navigateCalls, []);
  } finally {
    await slot.behavior.emitRealtime("voice-presence", { nonce: "remote-3", phase: "idle", client: "phone", realm: "phone-realm" });
    slot.lifecycle.unmount();
  }
});
