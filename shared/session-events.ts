// One outcome vocabulary for the transcript, error filter, and plugin log.
export type ActionStatus = "success" | "error";
export function actionStatus(payload: Record<string, unknown>): ActionStatus {
  if (payload.status === "success" || payload.status === "error") return payload.status;
  // Older sessions and legacy tool outputs have no structured status.
  return /^(tool error\b|error:|no connected bb window|no composer|no bb surface|no thread_id)/i.test(String(payload.output ?? ""))
    ? "error" : "success";
}
/** Pair each result once, including out-of-order arrivals and legacy sessions. */
export function pairToolEvents(events: readonly { id: number; kind: string; payload: string }[]) {
  const parse = (text: string): Record<string, unknown> => {
    try { return JSON.parse(text) ?? {}; } catch { return {}; }
  };
  const byKey = new Map<string, { id: number; payload: Record<string, unknown> }[]>();
  const key = (payload: Record<string, unknown>) => typeof payload.callId === "string" && payload.callId
    ? `id:${payload.callId}` : `legacy:${payload.name}`;
  for (const event of events) {
    if (event.kind !== "tool.result") continue;
    const payload = parse(event.payload);
    const group = key(payload);
    const queue = byKey.get(group) ?? [];
    queue.push({ id: event.id, payload });
    byKey.set(group, queue);
  }
  const pairs = new Map<number, { id: number; payload: Record<string, unknown> }>();
  for (const event of events) {
    if (event.kind !== "tool.call") continue;
    const result = byKey.get(key(parse(event.payload)))?.shift();
    if (result) pairs.set(event.id, result);
  }
  return pairs;
}
export function sessionEventLog(event: {
  id: number; sessionId: string; ts: number; kind: string; payload: Record<string, unknown>;
}) {
  const error = event.kind === "error" || event.kind.endsWith(".failed") ||
    (event.kind === "tool.result" && actionStatus(event.payload) === "error");
  return { level: error ? "error" as const : "info" as const, message: JSON.stringify(event) };
}
