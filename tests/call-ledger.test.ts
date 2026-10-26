// Backend call ledger: reserveCall / releaseCall / reserved createCall.
// Fake host only; OpenAI is a stubbed fetch, so no paid call is made.
import test from "node:test";
import assert from "node:assert/strict";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server.ts";
import { CALL_SUPERSEDED } from "../shared/call-reservation.ts";
import { createCall as createCallDirect } from "../server/realtime-call.ts";

type Reply = { ok: boolean; conflict: { nonce: string | null; phase: string } | null };

async function host(fetchHook?: (count: number) => Promise<void> | void) {
  const { bb, harness } = createFakePluginHost({ pluginId: "handsfree" });
  const originalFetch = globalThis.fetch;
  const savedKey = process.env.OPENAI_API_KEY;
  let fetches = 0;
  globalThis.fetch = (async () => {
    fetches += 1;
    await fetchHook?.(fetches);
    return new Response("answer-realtime", { status: 200 });
  }) as typeof fetch;
  process.env.OPENAI_API_KEY = "test-key";
  await plugin(bb);
  const call = <T = Reply>(method: string, input: unknown) => harness.behavior.callRpc(method as never, input as never) as Promise<T>;
  const presence = (nonce: string, phase: string) => call("publishPresence", { nonce, phase, startedAt: phase === "idle" ? null : 1 });
  const createCall = (nonce: string, reserved?: boolean) => call("createCall", {
    sdp: "offer", threadId: null, projectId: null, nonce, ...(reserved === undefined ? {} : { reserved }),
  });
  const voiceCalls = () => harness.inspection.realtimeSignals.filter(s => s.channel === "voice-call").map(s => (s.payload as { nonce: string }).nonce);
  return {
    bb, harness, call, presence, createCall, voiceCalls, fetches: () => fetches,
    async dispose() {
      globalThis.fetch = originalFetch;
      if (savedKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = savedKey;
      await harness.lifecycle.dispose();
    },
  };
}

test("only an empty ledger grants a reservation; every end path clears it", async () => {
  const h = await host();
  try {
    assert.deepEqual(await h.call("reserveCall", { nonce: "a" }), { ok: true, conflict: null });
    assert.deepEqual(await h.call("reserveCall", { nonce: "a" }), { ok: true, conflict: null }, "idempotent for the holder");
    assert.deepEqual(await h.call("reserveCall", { nonce: "b" }), { ok: false, conflict: { nonce: "a", phase: "reserved" } });
    await h.presence("a", "live");
    assert.deepEqual(await h.call("reserveCall", { nonce: "b" }), { ok: false, conflict: { nonce: "a", phase: "live" } }, "reservation vs positively live");
    await h.presence("a", "muted");
    assert.deepEqual((await h.call("reserveCall", { nonce: "b" })).conflict, { nonce: "a", phase: "muted" });
    await h.presence("a", "idle");
    assert.equal((await h.call("reserveCall", { nonce: "b" })).ok, true, "idle presence ends it");
    await h.call("logEvent", { sessionId: "b", kind: "session.stopped", payload: {} });
    assert.equal((await h.call("reserveCall", { nonce: "c" })).ok, true, "session.stopped ends it");
    await h.call("forceStop", { nonce: "c" });
    assert.equal((await h.call("reserveCall", { nonce: "d" })).ok, true, "forceStop ends it");
    await h.call("releaseCall", { nonce: "d" });
    assert.equal((await h.call("reserveCall", { nonce: "e" })).ok, true, "release ends it");
  } finally { await h.dispose(); }
});

test("a surviving second call keeps the ledger busy after the first ends", async () => {
  const h = await host();
  try {
    await h.presence("desktop", "live");
    await h.presence("frozen-phone", "live"); // missed the stop; still heartbeating
    await h.presence("desktop", "idle");
    assert.deepEqual((await h.call("reserveCall", { nonce: "new" })).conflict, { nonce: "frozen-phone", phase: "live" });
  } finally { await h.dispose(); }
});

test("a backend restart restores active calls as unknown, never idle, until renewed", async () => {
  const h = await host();
  try {
    await h.presence("phone", "live");
    const next = await h.harness.lifecycle.reload(plugin);
    const call = (method: string, input: unknown) => next.harness.behavior.callRpc(method as never, input as never) as Promise<Reply>;
    assert.deepEqual(await call("reserveCall", { nonce: "new" }), { ok: false, conflict: { nonce: "phone", phase: "unknown" } });
    await call("publishPresence", { nonce: "phone", phase: "live", startedAt: 1 }); // heartbeat renews it
    assert.deepEqual((await call("reserveCall", { nonce: "new" })).conflict, { nonce: "phone", phase: "live" });
  } finally { await h.dispose(); }
});

test("a ledger read or write failure fails closed for reservations", async () => {
  const h = await host();
  try {
    h.bb.storage.database().prepare("DROP TABLE active_calls").run();
    assert.deepEqual(await h.call("reserveCall", { nonce: "a" }), { ok: false, conflict: { nonce: null, phase: "unknown" } });
    await h.presence("x", "idle"); // pass-through presence still works
    assert.equal((await h.call("reserveCall", { nonce: "a" })).ok, false, "stays closed for this process");
  } finally { await h.dispose(); }
});

test("a reserved createCall that lost its reservation makes no paid exchange", async () => {
  const h = await host();
  try {
    await h.call("reserveCall", { nonce: "sidebar" });
    // An explicit Start elsewhere takes over before the sidebar's exchange.
    await h.createCall("manual");
    assert.deepEqual(h.voiceCalls(), ["manual"]);
    await assert.rejects(h.createCall("sidebar", true), new RegExp(CALL_SUPERSEDED));
    assert.equal(h.fetches(), 1, "only the manual call reached OpenAI");
    assert.deepEqual(h.voiceCalls(), ["manual"], "the manual call is not ended");
    await assert.rejects(h.createCall("never-reserved", true), new RegExp(CALL_SUPERSEDED));
  } finally { await h.dispose(); }
});

test("a reserved call superseded during the exchange never announces itself", async () => {
  let h!: Awaited<ReturnType<typeof host>>;
  h = await host(async (count) => {
    // While the sidebar's exchange is in flight, another device starts a call.
    if (count === 1) await h.presence("phone", "connecting");
  });
  try {
    await h.call("reserveCall", { nonce: "sidebar" });
    await assert.rejects(h.createCall("sidebar", true), new RegExp(CALL_SUPERSEDED));
    assert.deepEqual(h.voiceCalls(), [], "no voice-call, so the phone call is not ended");
    // The unreserved (manual) path keeps its takeover semantics.
    await h.createCall("manual");
    assert.deepEqual(h.voiceCalls(), ["manual"]);
  } finally { await h.dispose(); }
});

test("a reserved call that keeps its reservation starts and announces once", async () => {
  const h = await host();
  try {
    await h.call("reserveCall", { nonce: "sidebar" });
    await h.presence("sidebar", "connecting"); // its own presence keeps it sole
    const answer = await h.createCall("sidebar", true);
    assert.deepEqual(answer, { sdp: "answer-realtime", live: false });
    assert.deepEqual(h.voiceCalls(), ["sidebar"]);
  } finally { await h.dispose(); }
});

test("a call that cannot be recorded is not started, so a restart cannot read the ledger as empty", async () => {
  const h = await host();
  try {
    const db = h.bb.storage.database();
    db.prepare("CREATE TRIGGER block_active_calls BEFORE INSERT ON active_calls BEGIN SELECT RAISE(ABORT, 'blocked'); END").run();
    await assert.rejects(h.createCall("manual"), /Could not record the call/);
    assert.equal(h.fetches(), 0, "no paid exchange");
    assert.deepEqual(h.voiceCalls(), [], "nothing was ended");
    db.prepare("DROP TRIGGER block_active_calls").run();
    const next = await h.harness.lifecycle.reload(plugin);
    // No call ran, so an empty ledger after the restart is the truth.
    assert.deepEqual(await next.harness.behavior.callRpc("reserveCall" as never, { nonce: "new" } as never), { ok: true, conflict: null });
  } finally { await h.dispose(); }
});

// The reservation can be lost while createCall awaits its setup (config,
// credentials, plugin catalog). No exchange may follow, on either API.
for (const model of ["gpt-realtime", "gpt-live-1"]) {
  for (const stage of ["readConfig", "apiKey", "exposedPluginCommands", null] as const) {
    const name = stage
      ? `a reservation lost during ${stage} makes no ${model} exchange`
      : `a reservation kept through setup makes one ${model} exchange`;
    test(name, async () => {
      let held = true;
      let fetches = 0;
      const lose = (at: string) => { if (at === stage) held = false; };
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async () => {
        fetches += 1;
        const body = model === "gpt-live-1" ? JSON.stringify({ session: { id: "s" }, transport: { sdp: "answer" } }) : "answer";
        return new Response(body, { status: 200 });
      }) as typeof fetch;
      const published: string[] = [];
      const deps = {
        ledger: { held: () => held, reserve: () => true },
        readConfig: async () => { await Promise.resolve(); lose("readConfig"); return { model, voice: "marin" }; },
        apiKey: async () => { await Promise.resolve(); lose("apiKey"); return { key: "test-key", mechanism: "key" }; },
        exposedPluginCommands: async () => { await Promise.resolve(); lose("exposedPluginCommands"); return []; },
        activePrompt: () => "",
        log: { info() {}, error() {} },
        publish: (channel: string) => { published.push(channel); },
        rememberRealtimeAuth() {},
      } as never;
      try {
        const run = createCallDirect(deps, { sdp: "offer", threadId: null, projectId: null, nonce: "n", reserved: true });
        if (stage) {
          await assert.rejects(run, new RegExp(CALL_SUPERSEDED));
          assert.equal(fetches, 0, "no exchange after the reservation was lost");
          assert.deepEqual(published, []);
        } else {
          await run;
          assert.equal(fetches, 1);
          assert.deepEqual(published, ["voice-call"]);
        }
      } finally { globalThis.fetch = originalFetch; }
    });
  }
}
