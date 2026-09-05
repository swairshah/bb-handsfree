import type { BbPluginApi } from "@get-bb/plugin-sdk";

/** Read-only diff data; BB resolves the workspace host and computes patches. */
export async function readThreadDiff(bb: BbPluginApi, threadId: string, path?: string) {
  const thread = await bb.sdk.threads.get({ threadId });
  if (!thread.environmentId) throw new Error("This thread has no workspace diff.");
  const environmentId = thread.environmentId;
  const environment = await bb.sdk.environments.get({ environmentId });
  const branch = environment.mergeBaseBranch;
  const target = branch ? { target: "all" as const, mergeBaseBranch: branch } : { target: "uncommitted" as const };
  const diff = await bb.sdk.environments.diffFiles({ environmentId, ...target });
  if (diff.outcome !== "available") throw new Error(diff.outcome === "not_applicable" ? diff.message : diff.failure.message);
  const file = path === undefined ? diff.files[0] : diff.files.find(file => file.path === path);
  if (path !== undefined && !file) throw new Error("That file is no longer in the diff. Refresh the file list.");
  let patch = file ? diff.initialPatches.find(patch => patch.path === file.path) : undefined;
  if (file && !file.binary && file.loadMode !== "too_large" && !patch) {
    const result = await bb.sdk.environments.diffPatch({ environmentId, paths: [file.path],
      target: branch ? { type: "all", mergeBaseBranch: branch } : { type: "uncommitted" } });
    if (result.outcome !== "available") throw new Error(result.outcome === "not_applicable" ? result.message : result.failure.message);
    patch = result.patches.find(patch => patch.path === file.path);
    if (!patch) throw new Error("The requested patch is unavailable. Refresh to try again.");
  }
  return {
    threadId, projectId: thread.projectId, title: thread.title || thread.titleFallback || threadId,
    shortstat: diff.shortstat, truncated: diff.truncated || !!patch?.truncated,
    files: diff.files.map(({ path, additions, deletions }) => ({ path, additions, deletions })),
    path: file?.path ?? null, patch: patch?.patch ?? null,
    notice: file?.binary ? "Binary file: no text diff." : file?.loadMode === "too_large" ? "This file is too large for an inline diff." : null,
  };
}
