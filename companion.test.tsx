import test, { after } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { installTestPluginRuntime, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { act, fireEvent } from "@testing-library/react";
import { viewWorkspace, type ThreadView } from "./view-workspace.ts";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost", pretendToBeVisual: true });
for (const [name, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })) {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}
installTestPluginRuntime();
const { CompanionTab } = await import("./companion.tsx");
after(() => dom.window.close());
const view = (id: string): ThreadView => ({ kind: "thread", id: `thread:${id}`, threadId: id, projectId: "project", title: `Thread ${id}` });

test("desktop buttons and the mobile switcher share selection; closing only removes the requested view", () => {
  viewWorkspace.clear();
  const unregister = viewWorkspace.registerPresenter({ available: () => true, reveal: () => true });
  const slot = renderSlot({ component: CompanionTab }, {});
  try {
    assert.match(slot.container.textContent ?? "", /all your running threads/);
    act(() => viewWorkspace.open([view("a"), view("b")], "new", "auto", true));
    assert.equal(slot.getAllByTestId("bb-thread-chat").length, 1);
    assert.equal(slot.getByRole("combobox", { name: "Shown thread" }).getAttribute("aria-label"), "Shown thread");
    fireEvent.change(slot.getByRole("combobox"), { target: { value: "thread:b" } });
    assert.equal(viewWorkspace.get().activeId, "thread:b");
    fireEvent.click(slot.getByRole("button", { name: "Thread a" }));
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
  viewWorkspace.open([view("a"), view("b")], "new", "auto", true);
  const first = renderSlot({ component: CompanionTab }, {});
  first.lifecycle.unmount();
  assert.equal(viewWorkspace.current(), null);
  const second = renderSlot({ component: CompanionTab }, {});
  try {
    assert.equal(second.getAllByRole("option").length, 2);
    assert.equal(second.getByTestId("bb-thread-chat").getAttribute("data-thread-id"), "a");
  } finally { second.lifecycle.unmount(); unregister(); viewWorkspace.clear(); }
});
