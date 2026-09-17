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

test("automatic failure notifications resolve missing error details before reaching the voice model", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "handsfree", sdk: {
    threads: {
      events: {
        list: async () => [{
          type: "provider/error",
          data: {
            message: "Provider error",
            detail: "OAuth refresh failed because the refresh token expired.",
          },
          seq: 15,
          createdAt: 123,
        }],
      },
    },
  } as any });
  try {
    await plugin(bb);
    const prompt = await harness.behavior.callRpc("getPrompt", null) as { defaultContent: string };
    assert.match(prompt.defaultContent, /Tool lookups are silent/);
    assert.match(prompt.defaultContent, /Never say "let me check"/);
    const delivered = await harness.behavior.emitThreadEvent("thread.failed", {
      thread: makeThreadResponse({
        id: "failed-thread",
        title: "Check model support",
        status: "error",
        runtime: { displayStatus: "error", hostReconnectGraceExpiresAt: null },
        visibility: "visible",
      }),
      error: null,
    });
    assert.deepEqual(delivered.errors, []);
    const signal = harness.inspection.realtimeSignals.find(entry => entry.channel === "aide-thread-event");
    assert.deepEqual(signal?.payload, {
      kind: "failed",
      threadId: "failed-thread",
      title: "Check model support",
      detail: "OAuth refresh failed because the refresh token expired.",
    });
    assert.equal(harness.inspection.sdk.callsTo("threads.events.list").length, 1);
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
  for (const name of ["read_thread", "get_thread_error"]) {
    const lookup = desktop.find(tool => tool.name === name) as any;
    assert.match(lookup.description, /Call silently/);
    assert.match(lookup.description, /speak only after its result/);
  }
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

test("gpt-live-1 sessions post to the Live API with delegation and report live: true", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "handsfree" });
  const originalFetch = globalThis.fetch;
  const requests: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    requests.push({ url: String(url), init: init ?? {} });
    if (String(url).includes("/v1/live/sessions")) {
      return new Response(
        JSON.stringify({ session: { id: "live_test" }, transport: { type: "webrtc", sdp: "answer-live" } }),
        { status: 201 },
      );
    }
    return new Response("answer-realtime", { status: 200 });
  }) as typeof fetch;
  const savedEnv = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "test-key";
  try {
    await plugin(bb);
    await harness.behavior.callRpc("setConfig", { model: "gpt-live-1" });
    const live = await harness.behavior.callRpc("createCall", {
      sdp: "offer", threadId: null, projectId: null, onNewThreadScreen: false, nonce: "call-live",
    }) as { sdp: string; live: boolean };
    assert.deepEqual(live, { sdp: "answer-live", live: true });
    const request = requests.find((r) => r.url.includes("/v1/live/sessions"));
    assert.ok(request, "expected a POST to /v1/live/sessions");
    const body = JSON.parse(String(request!.init.body)) as any;
    assert.equal(body.session.model, "gpt-live-1");
    assert.equal(body.transport.type, "webrtc");
    assert.equal(body.transport.sdp, "offer");
    // The full Handsfree prompt and tool set ride on the Responses backend.
    assert.equal(body.session.delegation.type, "responses");
    assert.ok(body.session.delegation.responses.tools.some((tool: any) => tool.name === "get_context"));
    assert.match(body.session.delegation.responses.instructions, /Current context/);
    // marin is the safe default: classic realtime voices are not documented for live.
    assert.equal(body.session.audio.output.voice, "marin");

    await harness.behavior.callRpc("setConfig", { model: "gpt-realtime-2.1" });
    const realtime = await harness.behavior.callRpc("createCall", {
      sdp: "offer", threadId: null, projectId: null, onNewThreadScreen: false, nonce: "call-rt",
    }) as { sdp: string; live: boolean };
    assert.deepEqual(realtime, { sdp: "answer-realtime", live: false });

    // The realtime call above ran under "auto" and used the env API key; that
    // mechanism is remembered across a gpt-live-1 detour and restored as the
    // explicit realtime default on the way back.
    await harness.behavior.callRpc("setConfig", { model: "gpt-live-1" });
    const restored = await harness.behavior.callRpc("setConfig", { model: "gpt-realtime-2.1-mini" }) as any;
    assert.equal(restored.credentialPreference, "apiKey");
    // An explicit choice made in the same switch beats the memory — and
    // becomes the new remembered default.
    await harness.behavior.callRpc("setConfig", { model: "gpt-live-1" });
    const explicit = await harness.behavior.callRpc("setConfig", {
      model: "gpt-realtime-2.1", credentialPreference: "subscription",
    }) as any;
    assert.equal(explicit.credentialPreference, "subscription");
    await harness.behavior.callRpc("setConfig", { model: "gpt-live-1" });
    const rememberedExplicit = await harness.behavior.callRpc("setConfig", { model: "gpt-realtime-2.1" }) as any;
    assert.equal(rememberedExplicit.credentialPreference, "subscription");
  } finally {
    globalThis.fetch = originalFetch;
    if (savedEnv === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = savedEnv;
    await harness.lifecycle.dispose();
  }
});

test("live duration snapshots keep one row per session and price at $0.05/min", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "handsfree" });
  try {
    await plugin(bb);
    await harness.behavior.callRpc("logEvent", { sessionId: "live-call", kind: "session.started", payload: {} });
    // Cumulative snapshots: the largest wins; out-of-order and repeats collapse.
    for (const seconds of [10, 30, 30, 20]) {
      await harness.behavior.callRpc("recordUsage", { model: "gpt-live-1", sessionId: "live-call", usage: { seconds } });
    }
    const { sessions } = await harness.behavior.callRpc("listSessions", null) as {
      sessions: { id: string; costUsd: number }[];
    };
    const row = sessions.find((session) => session.id === "live-call");
    assert.equal(row?.costUsd, 0.025); // 30s at $0.05/min
  } finally { await harness.lifecycle.dispose(); }
});

test("gpt-live-1 calls demand an API key and never fall back to subscription auth", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "handsfree" });
  const savedEnv = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    await plugin(bb);
    await harness.behavior.callRpc("setConfig", { model: "gpt-live-1" });
    // No stored key, no env key: the error must name the requirement instead
    // of sending a subscription token that OpenAI will 403.
    await assert.rejects(
      harness.behavior.callRpc("createCall", {
        sdp: "offer", threadId: null, projectId: null, onNewThreadScreen: false, nonce: "call-live",
      }),
      /needs an OpenAI API key/,
    );
  } finally {
    if (savedEnv !== undefined) process.env.OPENAI_API_KEY = savedEnv;
    await harness.lifecycle.dispose();
  }
});

test("setApiKey stores the trimmed key and signals the credential card", async () => {
  const updates: unknown[] = [];
  const { bb, harness } = createFakePluginHost({ pluginId: "handsfree", sdk: {
    plugins: { updateSettings: async (input: unknown) => { updates.push(input); return {}; } },
  } });
  try {
    await plugin(bb);
    await harness.behavior.callRpc("setApiKey", { key: "  sk-test-0123456789abcdef0123  " });
    assert.deepEqual(updates, [{ pluginId: "handsfree", values: { openaiApiKey: "sk-test-0123456789abcdef0123" } }]);
    assert.ok(harness.inspection.realtimeSignals.some((signal) => signal.channel === "config-changed"));
    await assert.rejects(harness.behavior.callRpc("setApiKey", { key: "short" }));
  } finally { await harness.lifecycle.dispose(); }
});
