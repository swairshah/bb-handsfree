// Thread-event notifications (feature-flagged by the `notifications` config).
// Voice sessions get told when agent threads finish or fail. The frontend
// queues and digests these (never interrupting speech or an active response);
// this side only decides WHETHER to publish, and grounds the announcement in
// the thread's actual result before the voice model sees it.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  THREAD_ERROR_EVENT_TYPES,
  THREAD_OUTCOME_EVENT_TYPES,
  latestThreadError,
  latestThreadOutcome,
} from "../shared/thread-errors";
import type { ConfigStore } from "./config.ts";

/** Compact a completed turn's result for a grounded voice notification. */
export function notificationDetail(detail: string | null, max = 600): string | null {
  const normalized = detail?.replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  if (normalized.length <= max) return normalized;
  const prefix = normalized.slice(0, max);
  const sentenceEnd = Math.max(prefix.lastIndexOf(". "), prefix.lastIndexOf("! "), prefix.lastIndexOf("? "));
  return `${prefix.slice(0, sentenceEnd >= max / 2 ? sentenceEnd + 1 : max).trimEnd()}…`;
}

export function registerThreadNotifications(bb: BbPluginApi, readConfig: ConfigStore["readConfig"]) {
  async function publishThreadEvent(
    kind: "idle" | "failed",
    thread: { id: string; title: string | null; visibility: string },
    detail: string | null,
  ) {
    const { notifications } = await readConfig();
    if (!notifications || thread.visibility === "hidden") return;

    // Resolve missing outcomes before notifying the voice model. Otherwise it
    // has to call read_thread/get_thread_error itself and may speak a progress
    // preamble before that lookup. This server-side fetch is intentionally
    // silent, so the user hears only the grounded final announcement.
    let resolvedDetail = detail;
    if (!resolvedDetail?.trim()) {
      try {
        if (kind === "failed") {
          const error = latestThreadError(
            await bb.sdk.threads.events.list({
              threadId: thread.id,
              order: "desc",
              limit: "100",
              types: THREAD_ERROR_EVENT_TYPES,
            }),
          );
          resolvedDetail = error?.detail ?? error?.message ?? null;
        } else {
          const { output } = await bb.sdk.threads.output({ threadId: thread.id });
          if (output) {
            resolvedDetail = output;
          } else {
            const outcome = latestThreadOutcome(
              await bb.sdk.threads.events.list({
                threadId: thread.id,
                order: "desc",
                limit: "100",
                types: THREAD_OUTCOME_EVENT_TYPES,
              }),
            );
            resolvedDetail = outcome?.message ?? null;
          }
        }
      } catch (error) {
        bb.log.warn(`could not resolve ${kind} notification for ${thread.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    bb.realtime.publish("aide-thread-event", {
      kind,
      threadId: thread.id,
      title: thread.title ?? "(untitled thread)",
      detail: notificationDetail(resolvedDetail),
    });
  }
  bb.events.on("thread.idle", async ({ thread, lastAssistantText }) => {
    await publishThreadEvent("idle", thread, lastAssistantText);
  });
  bb.events.on("thread.failed", async ({ thread, error }) => {
    await publishThreadEvent("failed", thread, error);
  });
}
