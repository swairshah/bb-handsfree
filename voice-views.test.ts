import test from "node:test";
import assert from "node:assert/strict";
import { VoiceAgent, type Bindings } from "./voice-agent.ts";
import { ViewWorkspace } from "./view-workspace.ts";
import { clientDescriptor } from "./client-identity.ts";

type Call = { method: string; args: any };
function fixture() {
  const workspace = new ViewWorkspace();
  const agent = new VoiceAgent(workspace);
  const internal = agent as unknown as {
    nonce: string | null;
    state: string;
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
      preference: "auto",
    };
    if (method === "runTool") return { output: JSON.stringify(args), status: "success" };
    return { ok: true };
  } } as Bindings["rpc"];
  const base: Bindings = { rpc, context: { threadId: "original", projectId: "original-project", onNewThreadScreen: false }, openNewThread() {} };
  agent.bind(base);
  internal.nonce = "call-session";
  internal.state = "live";
  let count = 0;
  const execute = async (name: string, args: Record<string, unknown>) => {
    await internal.handleToolCall(dc, { name, call_id: `tool-${++count}`, arguments: JSON.stringify(args) });
    while (internal.logQueue) await internal.logQueue;
    return calls.filter(call => call.method === "logEvent" && call.args.kind === "tool.result").at(-1)?.args.payload;
  };
  return { workspace, agent, internal, calls, sent, dc, base, execute };
}

test("mobile and desktop openings use local panels, preserving correlated tool events", async () => {
  const oldMobile = clientDescriptor.mobile;
  try {
    for (const mobile of [true, false]) {
      clientDescriptor.mobile = mobile;
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
    }
  } finally { clientDescriptor.mobile = oldMobile; }
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
