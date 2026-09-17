// The "Live threads" view shared by the list_live_threads tool and the
// `bb handsfree live` CLI: running right now, plus recently finished.
import type { BbPluginApi } from "@get-bb/plugin-sdk";

const LIVE_STATUSES = new Set([
  "active",
  "starting",
  "stopping",
  "provisioning",
  "waiting-for-host",
  "host-reconnecting",
]);

// Matches the sidebar's Live threads definition (active-threads plugin):
// running now, or finished within this window (shown as "recently-finished").
const RECENT_WINDOW_MS = 30 * 60_000;

/** Threads that are live right now or finished recently, newest first. */
export async function liveThreads(bb: BbPluginApi) {
  const [threads, projects] = await Promise.all([
    bb.sdk.threads.list({ limit: 200 }),
    bb.sdk.projects.list({ includePersonal: true }),
  ]);
  const projectNames = new Map(projects.map((p) => [p.id, p.name]));
  const now = Date.now();
  return threads
    .filter((t) => {
      if (t.archivedAt) return false;
      if (LIVE_STATUSES.has(t.runtime.displayStatus)) return true;
      return now - t.updatedAt <= RECENT_WINDOW_MS;
    })
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map((t) => ({
      id: t.id,
      title: t.title ?? t.titleFallback ?? "(untitled)",
      status: LIVE_STATUSES.has(t.runtime.displayStatus)
        ? t.runtime.displayStatus
        : `recently-finished (${t.runtime.displayStatus}, ${relativeTime(t.updatedAt)})`,
      project: projectNames.get(t.projectId) ?? t.projectId,
      projectId: t.projectId,
      providerId: t.providerId,
      updatedAt: t.updatedAt,
      environmentId: t.environmentId ?? null,
    }));
}

export function relativeTime(timestamp: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
