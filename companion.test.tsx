import test, { after } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { installTestPluginRuntime, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { act, fireEvent, within } from "@testing-library/react";
import { viewWorkspace, type ThreadView } from "./view-workspace.ts";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost", pretendToBeVisual: true });
for (const [name, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })) {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}
installTestPluginRuntime();
const { CompanionTab } = await import("./companion.tsx");
const { voiceAgent } = await import("./voice-agent.ts");
const { LiveCallControls } = await import("./voice-chrome.tsx");
after(() => dom.window.close());
const view = (id: string): ThreadView => ({ kind: "thread", id: `thread:${id}`, threadId: id, projectId: "project", title: `Thread ${id}` });

test("the mobile switcher changes the shown thread; closing only removes the requested view", () => {
  viewWorkspace.clear();
  const unregister = viewWorkspace.registerPresenter({ available: () => true, reveal: () => true });
  const slot = renderSlot({ component: CompanionTab }, {});
  try {
    assert.match(slot.container.textContent ?? "", /all your running threads/);
    act(() => viewWorkspace.open([view("a"), view("b")], "new", "reuse"));
    assert.equal(slot.getAllByTestId("bb-thread-chat").length, 1);
    assert.equal(slot.getByRole("combobox", { name: "Shown thread" }).getAttribute("aria-label"), "Shown thread");
    fireEvent.change(slot.getByRole("combobox"), { target: { value: "thread:b" } });
    assert.equal(viewWorkspace.get().activeId, "thread:b");
    fireEvent.change(slot.getByRole("combobox"), { target: { value: "thread:a" } });
    assert.equal(viewWorkspace.get().activeId, "thread:a");
    const chat = slot.getByTestId("bb-thread-chat");
    assert.equal(chat.getAttribute("data-thread-id"), "a");
    fireEvent.click(slot.getAllByRole("button", { name: "Close Thread a" })[0]);
    assert.equal(viewWorkspace.get().activeId, "thread:b");
    assert.equal(slot.getByTestId("bb-thread-chat").getAttribute("data-thread-id"), "b");
    fireEvent.click(slot.getAllByRole("button", { name: "Close Thread b" })[0]);
    assert.equal(slot.queryByTestId("bb-thread-chat"), null);
    assert.equal(viewWorkspace.get().views.length, 0);
  } finally { slot.lifecycle.unmount(); unregister(); }
});

test("closing and remounting a host panel preserves the collection for the app session", () => {
  viewWorkspace.clear();
  const unregister = viewWorkspace.registerPresenter({ available: () => true, reveal: () => true });
  viewWorkspace.open([view("a"), view("b")], "new", "reuse");
  const first = renderSlot({ component: CompanionTab }, {});
  first.lifecycle.unmount();
  assert.equal(viewWorkspace.current(), null);
  const second = renderSlot({ component: CompanionTab }, {});
  try {
    assert.equal(second.getAllByRole("option").length, 2);
    assert.equal(second.getByTestId("bb-thread-chat").getAttribute("data-thread-id"), "a");
  } finally { second.lifecycle.unmount(); unregister(); viewWorkspace.clear(); }
});


test("drawer controls share call state, survive view changes, and only stop on explicit tap", (t) => {
  const call = voiceAgent as unknown as { state: "idle" | "connecting" | "live" | "muted"; emitChange(): void };
  const setState = (state: typeof call.state) => { call.state = state; call.emitChange(); };
  const mute = t.mock.method(voiceAgent, "toggleMuteFromSurface", () => setState(call.state === "muted" ? "live" : "muted"));
  const stop = t.mock.method(voiceAgent, "stopFromSurface", () => setState("idle"));
  viewWorkspace.clear();
  const unregister = viewWorkspace.registerPresenter({ available: () => true, reveal: () => true });
  const drawer = renderSlot({ component: CompanionTab }, {});
  const pageControls = renderSlot({ component: LiveCallControls }, {});
  const drawerUi = within(drawer.container);
  const pageUi = within(pageControls.container);
  try {
    assert.equal(drawerUi.queryByRole("group", { name: "Aide call controls" }), null);
    act(() => setState("connecting"));
    assert.equal(drawerUi.getByRole("button", { name: "Mute Aide microphone" }).hasAttribute("disabled"), true);
    assert.ok(drawerUi.getByText("Connecting…"));
    act(() => setState("live"));
    act(() => viewWorkspace.open([view("a"), view("b")], "new", "reuse"));
    fireEvent.click(drawerUi.getByRole("button", { name: "Mute Aide microphone" }));
    assert.equal(mute.mock.callCount(), 1);
    assert.ok(pageUi.getByRole("button", { name: "Unmute Aide microphone" }));
    fireEvent.change(drawerUi.getByRole("combobox"), { target: { value: "thread:b" } });
    assert.ok(drawerUi.getByRole("button", { name: "Unmute Aide microphone" }));
    act(() => viewWorkspace.clear());
    assert.ok(drawerUi.getByRole("group", { name: "Aide call controls" }));
    assert.equal(stop.mock.callCount(), 0);
    fireEvent.click(pageUi.getByRole("button", { name: "Unmute Aide microphone" }));
    assert.ok(drawerUi.getByRole("button", { name: "Mute Aide microphone" }));
    fireEvent.click(drawerUi.getByRole("button", { name: "Stop Aide voice session" }));
    assert.equal(stop.mock.callCount(), 1);
    assert.equal(drawerUi.queryByRole("group", { name: "Aide call controls" }), null);
  } finally {
    drawer.lifecycle.unmount(); pageControls.lifecycle.unmount(); unregister();
    setState("idle"); viewWorkspace.clear();
  }
  assert.equal(stop.mock.callCount(), 1);
});
