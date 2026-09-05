import test from "node:test";
import assert from "node:assert/strict";
import { DesktopViews, DESKTOP_DEFAULTS, desktopDestination } from "./desktop-views.ts";
import type { ThreadView } from "./view-workspace.ts";
const view = (threadId: string): ThreadView => ({ kind: "thread", id: `thread:${threadId}`, threadId, projectId: "project", title: `Title ${threadId}` });

test("desktop defaults and direct overrides are independent of tab reuse", () => {
  assert.equal(desktopDestination("composer", undefined, DESKTOP_DEFAULTS), "navigate");
  assert.equal(desktopDestination("handsfree", "auto", DESKTOP_DEFAULTS), "panel");
  assert.equal(desktopDestination("global", "auto", DESKTOP_DEFAULTS), "navigate");
  assert.equal(desktopDestination("composer", "panel", DESKTOP_DEFAULTS), "panel");
  assert.equal(desktopDestination("handsfree", "navigate", DESKTOP_DEFAULTS), "navigate");
  assert.throws(() => desktopDestination("composer", "drawer", DESKTOP_DEFAULTS));
});

test("native batch opens preserve order, deduplicate, and reselect the first tab", () => {
  const desktop = new DesktopViews();
  const calls: [string, boolean][] = [];
  desktop.registerPresenter({ kind: "thread", ownerId: "source", available: () => true,
    open: (view, reuse) => { calls.push([view.threadId, reuse]); return true; } });
  const result = desktop.open([view("a"), view("b"), view("a")], "new", "reuse");
  assert.deepEqual(calls, [["a", false], ["b", false], ["a", false]]);
  assert.equal(result.count, 2);
  assert.equal(result.selected.threadId, "a");
  assert.equal(result.nativeTabs, true);
});

test("preview replacement is scoped to the host thread and happens only after acceptance", () => {
  const desktop = new DesktopViews();
  let accept = true;
  const unregister = desktop.registerPresenter({ kind: "thread", ownerId: "source-a", available: () => true, open: () => accept });
  desktop.open([view("a")], "reuse", "new");
  assert.equal(desktop.preview("source-a")?.threadId, "a");
  accept = false;
  assert.throws(() => desktop.open([view("b")], "reuse", "new"), /Nothing was opened/);
  assert.equal(desktop.preview("source-a")?.threadId, "a");
  unregister();
  desktop.registerPresenter({ kind: "thread", ownerId: "source-b", available: () => true, open: () => true });
  desktop.open([view("b")], "auto", "reuse");
  assert.equal(desktop.preview("source-b")?.threadId, "b");
  assert.equal(desktop.preview("source-a")?.threadId, "a");
});

test("Aide page rejects multi-tab requests before any UI change", () => {
  const desktop = new DesktopViews();
  let opens = 0;
  desktop.registerPresenter({ kind: "page", ownerId: "handsfree", available: () => true, open: () => { opens++; return true; } });
  assert.deepEqual(desktop.capabilities(), { sidePanel: true, nativeTabs: false });
  assert.throws(() => desktop.open([view("a"), view("b")], "new", "new"), /Nothing was opened/);
  assert.throws(() => desktop.open([view("a")], "new", "new"), /Nothing was opened/);
  assert.equal(opens, 0);
  assert.equal(desktop.open([view("a")], "auto", "new").count, 1);
});

test("partial host failure reports opened tabs rather than pretending the batch was atomic", () => {
  const desktop = new DesktopViews();
  desktop.registerPresenter({ kind: "thread", ownerId: "source", available: () => true, open: target => target.threadId !== "b" });
  assert.throws(() => desktop.open([view("a"), view("b"), view("c")], "new", "new"), /Opened 1 of 3: Title a/);
});

test("destinations and visible context never leak across windows or hidden panels", () => {
  const desktop = new DesktopViews();
  const other = new DesktopViews();
  let visible = true;
  const unregister = desktop.registerPresenter({ kind: "thread", ownerId: "source", available: () => visible, open: () => true });
  const unmount = desktop.registerContext(() => visible ? view("a") : null);
  assert.equal(desktop.current()?.threadId, "a");
  assert.equal(other.current(), null);
  assert.throws(() => other.open([view("a")], "new", "new"), /no available side panel/);
  visible = false;
  assert.equal(desktop.current(), null);
  assert.throws(() => desktop.open([view("a")], "new", "new"), /no available side panel/);
  unmount(); unregister();
  assert.deepEqual(desktop.capabilities(), { sidePanel: false, nativeTabs: false });
});
