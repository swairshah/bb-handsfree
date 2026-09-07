import test from "node:test";
import assert from "node:assert/strict";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin, { toolSchemas, threadViewInstructions } from "./server.ts";

test("session history and plugin logs describe the same stored action, and failed tools mark sessions", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "handsfree" });
  try {
    await plugin(bb);
    for (const kind of ["tool.call", "tool.result"]) await harness.behavior.callRpc("logEvent", {
      sessionId: "phone-call", kind,
      payload: { name: "focus_thread", callId: "tool-1", _id: { client: "phone", realm: "page" },
        ...(kind === "tool.result" ? { status: "error", output: "Could not open" } : { args: { thread_id: "a" } }) },
    });
    const { events } = await harness.behavior.callRpc("getSessionEvents", { sessionId: "phone-call" }) as { events: { id: number; ts: number; kind: string; payload: string }[] };
    const logs = harness.inspection.logEntries.filter(log => log.message.includes('"sessionId":"phone-call"'));
    assert.equal(logs.length, 2);
    events.forEach((event, index) => assert.deepEqual(JSON.parse(logs[index].message), {
      ...event, sessionId: "phone-call", payload: JSON.parse(event.payload),
    }));
    assert.equal(logs[1].level, "error");
    const { sessions } = await harness.behavior.callRpc("listSessions", null) as { sessions: { id: string; hasError: boolean }[] };
    assert.equal(sessions.find(session => session.id === "phone-call")?.hasError, true);
  } finally { await harness.lifecycle.dispose(); }
});

test("thread metadata is resolved once per ID and the saved preference applies immediately", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "handsfree", sdk: {
    threads: { get: async ({ threadId }) => makeThreadResponse({ id: threadId, title: `Title ${threadId}`, projectId: "project" }) },
  } });
  try {
    await plugin(bb);
    let result = await harness.behavior.callRpc("resolveThreadViews", { threadIds: ["a", "b", "a"] }) as any;
    assert.equal(result.preference, "reuse");
    assert.deepEqual(result.views.map((view: any) => view.id), ["thread:a", "thread:b"]);
    assert.equal(harness.inspection.sdk.callsTo("threads.get").length, 2);
    const saved = await harness.behavior.callRpc("runTool", {
      name: "set_view_behavior", args: { behavior: "new" }, threadId: null, projectId: null,
    }) as any;
    assert.equal(saved.status, "success");
    result = await harness.behavior.callRpc("resolveThreadViews", { threadIds: ["a"] }) as any;
    assert.equal(result.preference, "new");
    assert.ok(harness.inspection.realtimeSignals.some(signal => signal.channel === "config-changed"));
    await assert.rejects(harness.behavior.callRpc("resolveThreadViews", { threadIds: [] }));
  } finally { await harness.lifecycle.dispose(); }
});

test("server tool failures carry explicit status and do not create a separate server-only action log", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "handsfree", sdk: {
    threads: { get: async () => { throw new Error("Thread was deleted"); } },
  } });
  try {
    await plugin(bb);
    await assert.rejects(harness.behavior.callRpc("resolveThreadViews", { threadIds: ["deleted"] }), /deleted/);
    const result = await harness.behavior.callRpc("runTool", { name: "read_thread", args: { thread_id: "deleted" }, threadId: null, projectId: null }) as any;
    assert.equal(result.status, "error");
    assert.match(result.output, /deleted/);
    assert.equal(harness.inspection.logEntries.some(log => log.message.includes("voice tool")), false);
    const unknown = await harness.behavior.callRpc("runTool", { name: "not-a-tool", args: {}, threadId: null, projectId: null }) as any;
    assert.equal(unknown.status, "error");
  } finally { await harness.lifecycle.dispose(); }
});

test("desktop calls retain the original focus tool and exclude mobile-only controls", () => {
  const desktop = toolSchemas([], false);
  const mobile = toolSchemas([], true);
  for (const name of ["focus_threads", "manage_views", "set_view_behavior"]) {
    assert.equal(desktop.some(tool => tool.name === name), false);
    assert.equal(mobile.some(tool => tool.name === name), true);
  }
  const focusDesktop = desktop.find(tool => tool.name === "focus_thread") as any;
  const focusMobile = mobile.find(tool => tool.name === "focus_thread") as any;
  assert.equal("disposition" in focusDesktop.parameters.properties, false);
  assert.equal("disposition" in focusMobile.parameters.properties, true);
  assert.match(threadViewInstructions(false), /navigates to the requested thread/);
  assert.match(threadViewInstructions(true), /do not navigate away/);
  assert.deepEqual(toolSchemas(), desktop);
});

test("mobile settings never replace desktop navigation and migrate the prototype preference", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "handsfree" });
  try {
    await bb.storage.kv.set("config", { viewBehavior: "new" });
    await plugin(bb);
    const current = await harness.behavior.callRpc("getConfig", null) as any;
    assert.equal(current.mobileViewBehavior, "new");
    assert.equal("viewBehavior" in current, false);
    const saved = await harness.behavior.callRpc("setConfig", { mobileViewBehavior: "reuse" }) as any;
    assert.equal(saved.mobileViewBehavior, "reuse");
    await assert.rejects(harness.behavior.callRpc("setConfig", { mobileViewBehavior: "auto" }));
  } finally { await harness.lifecycle.dispose(); }
});

test("ring broadcasts an incoming-call invite to every window", async () => {  const { bb, harness } = createFakePluginHost({ pluginId: "handsfree" });
  try {
    await plugin(bb);
    const result = await harness.behavior.runCli(["ring", "--title", "Morning brief", "--ttl", "45"]);
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /Morning brief/);
    const signal = harness.inspection.realtimeSignals.find((s) => s.channel === "voice-invite");
    assert.ok(signal, "expected a voice-invite broadcast");
    const payload = signal!.payload as Record<string, unknown>;
    assert.equal(payload.title, "Morning brief");
    assert.match(String(payload.inviteId), /^inv-/);
    assert.ok((payload.expiresAt as number) > (payload.createdAt as number));
    // Toast-only by default: no native banner without --banner.
    assert.equal(harness.inspection.realtimeSignals.some((s) => s.channel === "notification"), false);
  } finally { await harness.lifecycle.dispose(); }
});

test("ring --banner adds the native OS banner alongside the invite", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "handsfree" });
  try {
    await plugin(bb);
    const result = await harness.behavior.runCli(["ring", "--title", "Morning brief", "--banner"]);
    assert.equal(result.exitCode, 0);
    const invite = harness.inspection.realtimeSignals.find((s) => s.channel === "voice-invite");
    const banner = harness.inspection.realtimeSignals.find((s) => s.channel === "notification");
    assert.deepEqual(banner?.payload, {
      id: (invite?.payload as Record<string, unknown>)?.inviteId,
      title: "Aide calling: Morning brief",
      body: "Accept the call in BB to talk.",
      threadId: null,
      channels: ["web", "desktop"],
    });
  } finally { await harness.lifecycle.dispose(); }
});

test("resolveInvite rebroadcasts answers and dismissals to every window", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "handsfree" });
  try {
    await plugin(bb);
    const result = await harness.behavior.callRpc("resolveInvite", { inviteId: "inv-1", action: "answered" });
    assert.deepEqual(result, { ok: true });
    const signal = harness.inspection.realtimeSignals.find((s) => s.channel === "voice-invite-resolved");
    assert.deepEqual(signal?.payload, { inviteId: "inv-1", action: "answered" });
    await assert.rejects(harness.behavior.callRpc("resolveInvite", { inviteId: "", action: "answered" }));
    await assert.rejects(harness.behavior.callRpc("resolveInvite", { inviteId: "inv-1", action: "maybe" }));
  } finally { await harness.lifecycle.dispose(); }
});

test("desktop focus still opens the real bb thread through the original SDK operation", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "handsfree", sdk: {
    threads: { open: async () => ({ delivered: 1 }) },
  } });
  try {
    await plugin(bb);
    const result = await harness.behavior.callRpc("runTool", {
      name: "focus_thread", args: { thread_id: "target" }, threadId: "source", projectId: "project",
    }) as any;
    assert.deepEqual(result, { output: "Focused.", status: "success" });
    assert.equal(harness.inspection.sdk.callsTo("threads.open").length, 1);
  } finally { await harness.lifecycle.dispose(); }
});

test("incoming-call preferences round-trip through getConfig/setConfig", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "handsfree" });
  try {
    await plugin(bb);
    const current = await harness.behavior.callRpc("getConfig", null) as any;
    assert.equal(current.incomingCalls, true);
    assert.equal(current.ringtone, true);
    assert.equal(current.snoozeMinutes, 10);
    assert.equal(current.greetFirst, true);
    const saved = await harness.behavior.callRpc("setConfig", {
      incomingCalls: false, ringtone: false, snoozeMinutes: 5, greetFirst: false,
    }) as any;
    assert.equal(saved.incomingCalls, false);
    assert.equal(saved.ringtone, false);
    assert.equal(saved.snoozeMinutes, 5);
    assert.equal(saved.greetFirst, false);
    await assert.rejects(harness.behavior.callRpc("setConfig", { snoozeMinutes: 0 }));
    await assert.rejects(harness.behavior.callRpc("setConfig", { snoozeMinutes: "soon" }));
  } finally { await harness.lifecycle.dispose(); }
});

test("ring stays silent while incoming calls are disabled", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "handsfree" });
  try {
    await plugin(bb);
    await bb.storage.kv.set("config", { incomingCalls: false });
    const result = await harness.behavior.runCli(["ring", "--title", "Should not ring"]);
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /disabled/);
    assert.equal(harness.inspection.realtimeSignals.some((s) => s.channel === "voice-invite"), false);
    assert.equal(harness.inspection.realtimeSignals.some((s) => s.channel === "notification"), false);
  } finally { await harness.lifecycle.dispose(); }
});
