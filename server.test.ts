import test from "node:test";
import assert from "node:assert/strict";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin, { toolSchemas, threadViewInstructions } from "./server.ts";

test("file previews use the named thread's environment and reject ambiguous paths or absent workspaces", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "handsfree", sdk: { threads: {
    get: async ({ threadId }) => makeThreadResponse({ id: threadId, environmentId: threadId === "none" ? null : `env-${threadId}` }),
  } } });
  try {
    await plugin(bb);
    assert.deepEqual(await harness.behavior.callRpc("resolveFilePreview", { threadId: "other", path: "src/my file.ts" }),
      { kind: "workspace", environmentId: "env-other", path: "src/my file.ts" });
    for (const path of ["/tmp/file", "../file", "a/../file", "https://example.com/a", "C:\\file", "", "a\u0000b"]) {
      await assert.rejects(harness.behavior.callRpc("resolveFilePreview", { threadId: "a", path }));
    }
    await assert.rejects(harness.behavior.callRpc("resolveFilePreview", { threadId: "none", path: "README.md" }), /no workspace/);
    assert.equal(harness.inspection.sdk.callsTo("threads.open").length, 0);
  } finally { await harness.lifecycle.dispose(); }
});

test("diff RPC resolves the thread workspace, loads patches on demand, and reports unavailable content", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "handsfree" });
  let branch: string | null = "main";
  let binary = false;
  let unavailable = false;
  harness.sdk.stub("threads.get", async () => makeThreadResponse({ id: "a", environmentId: "env", title: "A" }));
  harness.sdk.stub("environments.get", async () => ({ mergeBaseBranch: branch }) as any);
  harness.sdk.stub("environments.diffFiles", async () => unavailable ? ({ outcome: "not_applicable", message: "Not a git workspace", reason: "non_git_environment" }) : ({
    outcome: "available", shortstat: "1 file changed", truncated: false, mergeBaseRef: "base",
    files: [{ path: "a.txt", additions: 1, deletions: 1, binary, loadMode: "on_demand", changeKind: "modified", origin: "tracked", previousPath: null }], initialPatches: [],
  }));
  harness.sdk.stub("environments.diffPatch", async () => ({ outcome: "available", patches: [{ path: "a.txt", patch: "@@ -1 +1 @@\n-old\n+new\n", truncated: true }] }));
  try {
    await plugin(bb);
    const diff = await harness.behavior.callRpc("getThreadDiff", { threadId: "a" }) as any;
    assert.match(diff.patch, /\+new/);
    assert.equal(diff.truncated, true);
    assert.equal(diff.path, "a.txt");
    assert.equal(harness.inspection.sdk.callsTo("threads.open").length, 0);
    await assert.rejects(harness.behavior.callRpc("getThreadDiff", { threadId: "a", path: "missing" }), /no longer/);
    branch = null; binary = true;
    const binaryDiff = await harness.behavior.callRpc("getThreadDiff", { threadId: "a" }) as any;
    assert.equal(binaryDiff.patch, null);
    assert.match(binaryDiff.notice, /Binary/);
    assert.equal(harness.inspection.sdk.callsTo("environments.diffPatch").length, 1);
    unavailable = true;
    await assert.rejects(harness.behavior.callRpc("getThreadDiff", { threadId: "a" }), /Not a git workspace/);
  } finally { await harness.lifecycle.dispose(); }
});

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

test("desktop tools expose destination overrides and native batches, independently of mobile tools", () => {
  const desktop = toolSchemas([], false);
  const mobile = toolSchemas([], true);
  for (const name of ["manage_views", "set_view_behavior"]) {
    assert.equal(desktop.some(tool => tool.name === name), false);
    assert.equal(mobile.some(tool => tool.name === name), true);
  }
  const focusDesktop = desktop.find(tool => tool.name === "focus_thread") as any;
  const focusMobile = mobile.find(tool => tool.name === "focus_thread") as any;
  assert.equal("disposition" in focusDesktop.parameters.properties, true);
  assert.equal("destination" in focusDesktop.parameters.properties, true);
  assert.equal("destination" in focusMobile.parameters.properties, false);
  assert.ok(desktop.some(tool => tool.name === "focus_threads"));
  assert.ok(desktop.some(tool => tool.name === "set_desktop_behavior"));
  assert.ok(desktop.some(tool => tool.name === "open_browser"));
  assert.ok(desktop.some(tool => tool.name === "preview_file"));
  assert.equal(mobile.some(tool => tool.name === "preview_file"), false);
  assert.equal(mobile.some(tool => tool.name === "open_browser"), false);
  assert.equal(mobile.some(tool => tool.name === "set_desktop_behavior"), false);
  assert.equal("disposition" in focusMobile.parameters.properties, true);
  assert.match(threadViewInstructions(false), /call origin captured at startup/);
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

test("legacy server focus remains available for old frontends", async () => {
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


test("desktop settings persist per origin and remain independent of mobile preferences", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "handsfree" });
  try {
    await plugin(bb);
    const initial = await harness.behavior.callRpc("getConfig", null) as any;
    assert.equal(initial.desktopComposerDestination, "navigate");
    assert.equal(initial.desktopAideDestination, "panel");
    assert.equal(initial.desktopTabBehavior, "new");
    const result = await harness.behavior.callRpc("runTool", { name: "set_desktop_behavior", args: { composer_destination: "panel", tab_behavior: "reuse" }, threadId: null, projectId: null }) as any;
    assert.equal(result.status, "success");
    const saved = await harness.behavior.callRpc("getConfig", null) as any;
    assert.equal(saved.desktopComposerDestination, "panel");
    assert.equal(saved.desktopAideDestination, "panel");
    assert.equal(saved.desktopTabBehavior, "reuse");
    assert.equal(saved.mobileViewBehavior, initial.mobileViewBehavior);
    assert.equal((await harness.behavior.callRpc("runTool", { name: "set_desktop_behavior", args: {}, threadId: null, projectId: null }) as any).status, "error");
    await assert.rejects(harness.behavior.callRpc("setConfig", { desktopAideDestination: "drawer" }));
  } finally { await harness.lifecycle.dispose(); }
});
