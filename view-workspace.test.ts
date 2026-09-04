import test from "node:test";
import assert from "node:assert/strict";
import { ViewWorkspace, type ThreadView } from "./view-workspace.ts";

const view = (id: string): ThreadView => ({ kind: "thread", id: `thread:${id}`, threadId: id, projectId: `project-${id}`, title: `Thread ${id}` });
function workspace() {
  const store = new ViewWorkspace();
  store.registerPresenter({ available: () => true, reveal: () => true });
  return store;
}

test("mobile default reuses the shown thread; keeping views deduplicates by thread", () => {
  const replace = workspace();
  replace.open([view("a")], "auto", "reuse");
  replace.open([view("b")], "auto", "reuse");
  assert.deepEqual(replace.get().views, [view("b")]);
  const keep = workspace();
  keep.open([view("a")], "auto", "new");
  keep.open([view("b")], "auto", "new");
  keep.open([view("a")], "new", "new");
  assert.deepEqual(keep.get(), { views: [view("a"), view("b")], activeId: "thread:a" });
});

test("explicit disposition overrides preference; batches preserve all threads despite reuse", () => {
  const store = workspace();
  store.open([view("a")], "auto", "new");
  store.open([view("b")], "auto", "new");
  store.open([view("c")], "reuse", "new");
  assert.deepEqual(store.get().views, [view("a"), view("c")]);
  store.open([view("d"), view("e"), view("d")], "auto", "reuse");
  assert.deepEqual(store.get().views, [view("a"), view("c"), view("d"), view("e")]);
  assert.equal(store.get().activeId, "thread:d");
});

test("declined or throwing opens leave tabs and selection unchanged", () => {
  const store = workspace();
  store.open([view("a")], "auto", "reuse");
  const before = store.get();
  const unregister = store.registerPresenter({ available: () => true, reveal: () => false });
  assert.throws(() => store.open([view("b")], "reuse", "reuse"), /declined/);
  assert.equal(store.get(), before);
  unregister();
  store.registerPresenter({ available: () => true, reveal: () => { throw new Error("Host unavailable"); } });
  assert.throws(() => store.open([view("b")], "reuse", "reuse"), /Host unavailable/);
  assert.equal(store.get(), before);
});

test("windows are isolated and unmounted or unavailable presenters cannot receive opens", () => {
  const otherWindow = workspace();
  const ownWindow = new ViewWorkspace();
  assert.throws(() => ownWindow.open([view("a")], "auto", "reuse"), /cannot show/);
  assert.equal(otherWindow.get().views.length, 0);
  const unregister = ownWindow.registerPresenter({ available: () => true, reveal: () => true });
  unregister();
  ownWindow.registerPresenter({ available: () => false, reveal: () => { throw new Error("Must not run"); } });
  assert.throws(() => ownWindow.open([view("a")], "auto", "reuse"), /cannot show/);
});

test("context follows selected views only while a panel is visible; closing restores another tab", () => {
  const store = workspace();
  store.open([view("a"), view("b"), view("c")], "new", "reuse");
  assert.equal(store.current(), null);
  let visible = true;
  const unmount = store.registerVisiblePanel(() => visible);
  assert.equal(store.current()?.threadId, "a");
  store.select("thread:b");
  assert.equal(store.current()?.threadId, "b");
  store.close("thread:b");
  assert.equal(store.current()?.threadId, "c");
  visible = false;
  assert.equal(store.current(), null);
  visible = true;
  unmount();
  assert.equal(store.current(), null);
  assert.deepEqual(store.get().views, [view("a"), view("c")]);
  store.clear();
  assert.deepEqual(store.get(), { views: [], activeId: null });
});
