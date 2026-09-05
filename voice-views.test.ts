import test from "node:test";
import assert from "node:assert/strict";
import { VoiceAgent, type Bindings } from "./voice-agent.ts";
import { ViewWorkspace } from "./view-workspace.ts";
import { DesktopViews, DESKTOP_DEFAULTS, type CallOrigin } from "./desktop-views.ts";
import { clientDescriptor } from "./client-identity.ts";

type Call = { method: string; args: any };
function fixture(mobile = true, origin: CallOrigin = "composer") {
  clientDescriptor.mobile = mobile;
  const workspace = new ViewWorkspace();
  const desktop = new DesktopViews();
  const preferences = { ...DESKTOP_DEFAULTS };
  const navigated: string[] = [];
  const agent = new VoiceAgent(workspace, desktop);
  const internal = agent as unknown as {
    nonce: string | null;
    state: string;
    callOrigin: CallOrigin;
    handleToolCall(dc: RTCDataChannel, event: Record<string, unknown>): Promise<void>;
    logQueue: Promise<unknown> | null;
  };
  const calls: Call[] = [];
  const sent: any[] = [];
  const dc = { readyState: "open", send: (text: string) => sent.push(JSON.parse(text)) } as unknown as RTCDataChannel;
  const rpc = { call: async (method: string, args: any) => {
    calls.push({ method, args });
    if (method === "resolveThreadViews") return {
      views: [...new Set(args.threadIds as string[])].map(threadId => ({ kind: "thread", id: `thread:${threadId}`, threadId, projectId: `project-${threadId}`, title: `Title ${threadId}` })),
      preference: "reuse", desktop: preferences,
    };
    if (method === "runTool") return { output: JSON.stringify(args), status: "success" };
    if (method === "getThreadDiff") return { title: "Target", shortstat: "1 file changed", files: [], truncated: false };
    return { ok: true };
  } } as Bindings["rpc"];
  const base: Bindings = { rpc, context: { threadId: "original", projectId: "original-project", onNewThreadScreen: false }, openNewThread() {}, routeThreadId: "original", navigateToThread: id => { navigated.push(id); agent.bind({ ...base, routeThreadId: id, context: { ...base.context, threadId: id } }); } };
  agent.bind(base);
  internal.nonce = "call-session";
  internal.state = "live";
  internal.callOrigin = origin;
  let count = 0;
  const execute = async (name: string, args: Record<string, unknown>) => {
    await internal.handleToolCall(dc, { name, call_id: `tool-${++count}`, arguments: JSON.stringify(args) });
    while (internal.logQueue) await internal.logQueue;
    return calls.filter(call => call.method === "logEvent" && call.args.kind === "tool.result").at(-1)?.args.payload;
  };
  return { workspace, desktop, preferences, navigated, agent, internal, calls, sent, dc, base, execute };
}

test("browser opens are local, respect host acceptance, and reject unsupported URLs and mobile", async () => {
  for (const origin of ["composer", "handsfree"] as const) {
    const f = fixture(false, origin);
    const urls: string[] = [];
    f.agent.bind({ ...f.base, openUrl: url => { urls.push(url); return true; } });
    const result = await f.execute("open_browser", { url: "https://example.com" });
    assert.equal(result.status, "success");
    assert.match(result.output, /preference.*not confirmed/);
    assert.deepEqual(urls, ["https://example.com/"]);
    for (const url of ["javascript:alert(1)", "file:///tmp/a", "example.com", "https://u:p@example.com", "https://"]) {
      assert.equal((await f.execute("open_browser", { url })).status, "error");
    }
    assert.equal(urls.length, 1);
    f.agent.bind({ ...f.base, openUrl: () => false });
    assert.equal((await f.execute("open_browser", { url: "https://example.com" })).status, "error");
    assert.equal(f.calls.some(call => call.method === "runTool"), false);
    assert.deepEqual(f.navigated, []);
  }
  const mobile = fixture(true);
  mobile.agent.bind({ ...mobile.base, openUrl: () => { throw new Error("Must not open"); } });
  assert.match((await mobile.execute("open_browser", { url: "https://example.com" })).output, /desktop-only/);
});

test("desktop diff opens a local panel; decline and ended calls never fall back to navigation", async () => {
  const f = fixture(false);
  const opened: string[] = [];
  f.desktop.registerPresenter({ kind: "thread", ownerId: "source", available: () => true, open: () => true,
    openDiff: id => { opened.push(id); return true; } });
  const result = await f.execute("show_diff", { thread_id: "a" });
  assert.equal(result.status, "success");
  assert.equal(result.presentation, "panel");
  assert.deepEqual(opened, ["a"]);
  f.desktop.registerPresenter({ kind: "page", ownerId: "page", available: () => true, open: () => true, openDiff: () => false });
  assert.equal((await f.execute("show_diff", { thread_id: "b" })).status, "error");
  const originalCall = f.base.rpc.call;
  f.agent.bind({ ...f.base, rpc: { call: (async (method: any, args: any) => {
    const result = await originalCall(method, args);
    if (method === "getThreadDiff") f.internal.nonce = null;
    return result;
  }) as Bindings["rpc"]["call"] } });
  assert.match((await f.execute("show_diff", { thread_id: "c" })).output, /call ended/);
  assert.deepEqual(opened, ["a"]);
  assert.deepEqual(f.navigated, []);
  assert.equal(f.calls.some(call => call.method === "runTool"), false);
  const mobile = fixture(true);
  await mobile.execute("show_diff", { thread_id: "a" });
  assert.equal(mobile.calls.find(call => call.method === "runTool")?.args.args.focus, false);
});

test("mobile openings use local drawers with correlated tool events", async () => {
  const f = fixture();
  f.workspace.registerPresenter({ available: () => true, reveal: () => true });
  const result = await f.execute("focus_thread", { thread_id: "a" });
  assert.equal(result.status, "success");
  assert.equal(result.label, "Showed Title a");
  assert.equal(result.presentation, "panel");
  const events = f.calls.filter(call => call.method === "logEvent" && call.args.sessionId === "call-session");
  assert.deepEqual(events.map(event => event.args.kind), ["tool.call", "tool.result"]);
  assert.equal(events[0].args.payload.callId, result.callId);
  assert.deepEqual(events[0].args.payload._id, result._id);
  assert.equal(f.calls.some(call => call.method === "runTool" || call.method === "sendCompanion"), false);
});

test("desktop composer and global defaults navigate only the calling window", async () => {
  for (const origin of ["composer", "global"] as const) {
    const f = fixture(false, origin);
    f.desktop.registerPresenter({ kind: "thread", ownerId: "source", available: () => true, open: () => { throw new Error("Must navigate"); } });
    const result = await f.execute("focus_thread", { thread_id: "a" });
    assert.equal(result.status, "success");
    assert.equal(result.presentation, "navigation");
    assert.deepEqual(f.navigated, ["a"]);
    assert.equal(f.calls.some(call => call.method === "runTool"), false);
    assert.equal(f.workspace.get().views.length, 0);
  }
});

test("stale desktop sessions cannot activate mobile drawer tools", async () => {
  const f = fixture(false);
  for (const name of ["manage_views", "set_view_behavior"]) {
    const result = await f.execute(name, { action: "clear", thread_ids: ["a"], behavior: "new" });
    assert.equal(result.status, "error");
    assert.match(result.output, /mobile-only/);
  }
  assert.equal(f.calls.some(call => call.method === "runTool" || call.method === "resolveThreadViews"), false);
});

test("a host rejection, exception, or absent presenter returns an error to the model", async () => {
  for (const reveal of [null, () => false, () => { throw new Error("host crashed"); }]) {
    const f = fixture();
    if (reveal) f.workspace.registerPresenter({ available: () => true, reveal });
    const result = await f.execute("focus_thread", { thread_id: "a" });
    assert.equal(result.status, "error");
    assert.match(result.output, /^Tool error:/);
    assert.equal(f.workspace.get().views.length, 0);
    const response = f.sent.find(message => message.type === "conversation.item.create");
    assert.equal(response.item.output, result.output);
  }
});

test("batch opens, selection, and closing feed the displayed thread into get_context", async () => {
  const f = fixture();
  f.workspace.registerPresenter({ available: () => true, reveal: () => true });
  const unmount = f.workspace.registerVisiblePanel(() => true);
  await f.execute("focus_threads", { thread_ids: ["a", "b"] });
  await f.execute("manage_views", { action: "select", view_id: "thread:b" });
  let result = await f.execute("get_context", {});
  assert.equal(JSON.parse(result.output).threadId, "b");
  assert.equal(JSON.parse(result.output).projectId, "project-b");
  await f.execute("manage_views", { action: "close", view_id: "thread:b" });
  result = await f.execute("get_context", {});
  assert.equal(JSON.parse(result.output).threadId, "a");
  unmount();
  result = await f.execute("get_context", {});
  assert.equal(JSON.parse(result.output).threadId, "original");
  assert.equal(f.internal.state, "live");
});

test("composer bindings clean up without clobbering a newer binding", async () => {
  const f = fixture();
  const disposeA = f.agent.bind({ ...f.base, context: { ...f.base.context, threadId: "a" } });
  const disposeB = f.agent.bind({ ...f.base, context: { ...f.base.context, threadId: "b" } });
  disposeA();
  assert.equal(JSON.parse((await f.execute("get_context", {})).output).threadId, "b");
  disposeB();
  assert.equal(JSON.parse((await f.execute("get_context", {})).output).threadId, "original");
});

test("voice cannot write into an unrelated composer while another thread is shown", async () => {
  const f = fixture();
  let wrote = false;
  f.agent.bind({ ...f.base, composer: { setText() { wrote = true; }, updateText() { wrote = true; } } });
  f.workspace.registerPresenter({ available: () => true, reveal: () => true });
  f.workspace.registerVisiblePanel(() => true);
  await f.execute("focus_thread", { thread_id: "a" });
  const result = await f.execute("set_composer_text", { text: "wrong thread" });
  assert.equal(result.status, "error");
  assert.equal(wrote, false);
});

test("stopping during metadata resolution prevents a late open and logs to the original session", async () => {
  const f = fixture();
  let resolve!: (value: unknown) => void;
  f.base.rpc.call = (async (method: string, args: any) => {
    f.calls.push({ method, args });
    if (method === "resolveThreadViews") return new Promise<unknown>(done => { resolve = done; });
    return { ok: true };
  }) as Bindings["rpc"]["call"];
  f.workspace.registerPresenter({ available: () => true, reveal: () => true });
  const pending = f.execute("focus_thread", { thread_id: "a" });
  f.internal.nonce = "new-session";
  resolve({ views: [{ kind: "thread", id: "thread:a", threadId: "a", projectId: null, title: "A" }], preference: "auto" });
  const result = await pending;
  assert.equal(result.status, "error");
  assert.equal(f.workspace.get().views.length, 0);
  assert.equal(f.sent.length, 0);
  assert.equal(f.calls.filter(call => call.args.kind === "tool.result").at(-1)?.args.sessionId, "call-session");
});


test("desktop preferences use the captured origin, survive rebinding, and honor action overrides", async () => {
  const f = fixture(false, "handsfree");
  const opened: string[] = [];
  f.desktop.registerPresenter({ kind: "thread", ownerId: "source", available: () => true, open: view => { opened.push(view.threadId); return true; } });
  // A composer mounts later; it must not change the call's original entry point.
  f.agent.bind({ ...f.base, context: { threadId: "later", projectId: "later-project", onNewThreadScreen: false } });
  assert.equal(f.agent.getCallOrigin(), "handsfree");
  assert.equal((await f.execute("focus_thread", { thread_id: "a" })).presentation, "panel");
  assert.deepEqual(opened, ["a"]);
  assert.equal((await f.execute("focus_thread", { thread_id: "b", destination: "navigate" })).presentation, "navigation");
  assert.deepEqual(f.navigated, ["b"]);
  f.preferences.desktopAideDestination = "navigate";
  assert.equal((await f.execute("focus_thread", { thread_id: "c" })).presentation, "navigation");
  assert.equal((await f.execute("focus_thread", { thread_id: "d", disposition: "new" })).presentation, "panel");
  assert.deepEqual(opened, ["a", "d"]);
});

test("desktop native batches preserve origin preferences and never enter the mobile collection", async () => {
  const f = fixture(false);
  const opened: string[] = [];
  f.desktop.registerPresenter({ kind: "thread", ownerId: "source", available: () => true, open: view => { opened.push(view.threadId); return true; } });
  const result = await f.execute("focus_threads", { thread_ids: ["a", "b", "a"] });
  assert.equal(result.status, "success");
  assert.deepEqual(opened, ["a", "b", "a"]);
  assert.deepEqual(f.navigated, []);
  assert.deepEqual(f.workspace.get().views, []);
  assert.equal(f.preferences.desktopComposerDestination, "navigate");
});

test("desktop unavailable destinations and late results do not broadcast or navigate as fallback", async () => {
  const f = fixture(false, "handsfree");
  assert.equal((await f.execute("focus_thread", { thread_id: "a" })).status, "error");
  let resolve!: (value: any) => void;
  f.base.rpc.call = ((method: string, args: any) => method === "resolveThreadViews"
    ? new Promise(r => { resolve = r; }) : Promise.resolve((f.calls.push({ method, args }), { ok: true }))) as Bindings["rpc"]["call"];
  const pending = f.execute("focus_thread", { thread_id: "a", destination: "navigate" });
  f.internal.nonce = null;
  resolve({ views: [{ kind: "thread", id: "thread:a", threadId: "a", projectId: null, title: "A" }], desktop: f.preferences });
  await pending;
  assert.deepEqual(f.navigated, []);
  assert.equal(f.calls.some(call => call.method === "runTool"), false);
});

test("mobile stale schemas cannot activate desktop preferences or navigation", async () => {
  const f = fixture();
  assert.equal((await f.execute("set_desktop_behavior", { composer_destination: "navigate" })).status, "error");
  assert.equal((await f.execute("focus_thread", { thread_id: "a", destination: "navigate" })).status, "error");
  assert.deepEqual(f.navigated, []);
  assert.equal(f.calls.some(call => call.method === "runTool"), false);
});

test("desktop navigation waits through the unbound route transition before the next tool", async () => {
  const f = fixture(false);
  f.base.navigateToThread = id => { f.navigated.push(id); };
  let finished = false;
  const pending = f.execute("focus_thread", { thread_id: "target" }).then(result => { finished = true; return result; });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.navigated, ["target"]);
  assert.equal(finished, false);
  f.agent.bind({ ...f.base, routeThreadId: "target", context: { threadId: "target", projectId: "project-target", onNewThreadScreen: false } });
  assert.equal((await pending).status, "success");
  const context = JSON.parse((await f.execute("get_context", {})).output);
  assert.equal(context.threadId, "target");
});

test("stopping cancels a pending desktop navigation acknowledgement", async () => {
  const f = fixture(false);
  f.base.navigateToThread = () => {};
  const pending = f.execute("focus_thread", { thread_id: "target" });
  await new Promise(resolve => setImmediate(resolve));
  f.agent.stop();
  assert.equal((await pending).status, "error");
  assert.equal(f.sent.length, 0);
});

test("visible desktop tabs provide context and guard composer edits", async () => {
  const f = fixture(false);
  const unmount = f.desktop.registerContext(() => ({ kind: "thread", id: "thread:shown", threadId: "shown", projectId: "shown-project", title: "Shown" }));
  const context = JSON.parse((await f.execute("get_context", {})).output);
  assert.equal(context.threadId, "shown");
  assert.equal(context.projectId, "shown-project");
  assert.equal(context.callOrigin, "composer");
  assert.equal((await f.execute("set_composer_text", { text: "wrong composer" })).status, "error");
  unmount();
  assert.equal(JSON.parse((await f.execute("get_context", {})).output).threadId, "original");
});
