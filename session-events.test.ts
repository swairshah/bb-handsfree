import test from "node:test";
import assert from "node:assert/strict";
import { actionStatus, pairToolEvents, sessionEventLog } from "./session-events.ts";

const event = (id: number, kind: string, payload: object) => ({ id, kind, payload: JSON.stringify(payload) });
test("same-named calls pair by identity even when results arrive in reverse order", () => {
  const pairs = pairToolEvents([
    event(1, "tool.result", { name: "focus_thread", callId: "b", output: "B" }),
    event(2, "tool.call", { name: "focus_thread", callId: "a" }),
    event(3, "tool.call", { name: "focus_thread", callId: "b" }),
    event(4, "tool.result", { name: "focus_thread", callId: "a", output: "A" }),
  ]);
  assert.equal(pairs.get(2)?.payload.output, "A");
  assert.equal(pairs.get(3)?.payload.output, "B");
});
test("a missing result stays pending, and legacy results are consumed only once", () => {
  const pairs = pairToolEvents([
    event(1, "tool.call", { name: "focus_thread", callId: "a" }),
    event(2, "tool.call", { name: "focus_thread" }),
    event(3, "tool.call", { name: "focus_thread" }),
    event(4, "tool.result", { name: "focus_thread", output: "Focused." }),
  ]);
  assert.equal(pairs.has(1), false);
  assert.equal(pairs.get(2)?.id, 4);
  assert.equal(pairs.has(3), false);
});
test("new outcomes use status rather than English text; old sessions remain readable", () => {
  assert.equal(actionStatus({ output: "Everything worked", status: "error" }), "error");
  assert.equal(actionStatus({ output: "Error: quoted from a document", status: "success" }), "success");
  assert.equal(actionStatus({ output: "Tool error: failed" }), "error");
  assert.equal(actionStatus({ output: "Focused." }), "success");
  const event = { id: 42, ts: 123, sessionId: "phone-call", kind: "tool.result", payload: { callId: "open-a", status: "error", output: "Could not open", _id: { client: "phone", realm: "page" } } };
  const log = sessionEventLog(event);
  assert.equal(log.level, "error");
  assert.deepEqual(JSON.parse(log.message), event);
});
