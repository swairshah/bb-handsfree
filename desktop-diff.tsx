import React, { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { experimental_Diff as Diff, experimental_useFixedTabTarget, useRpc } from "@get-bb/plugin-sdk/app";
import type { PluginThreadPanelProps, ExperimentalPluginFixedTabReference } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import type { readThreadDiff } from "./desktop-diff-data";
import { DESKTOP_FIXED_TAB } from "./desktop-thread";
import { desktopViews } from "./desktop-views";
import { LiveCallControls } from "./voice-chrome";
import { ViewErrorBoundary } from "./thread-view-boundary";

export const DESKTOP_DIFF_TAB: ExperimentalPluginFixedTabReference<{ threadId: string; path?: string }> = {
  panelId: DESKTOP_FIXED_TAB.panelId, id: "desktop-diff",
  experimental_target: { validate: (value): value is { threadId: string; path?: string } =>
    !!value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).every(key => key === "threadId" || key === "path") &&
    typeof value.threadId === "string" && !!value.threadId.trim() &&
    (value.path === undefined || (typeof value.path === "string" && !!value.path.trim())),
  },
};

export function DesktopDiffTab({ threadId, params }: PluginThreadPanelProps) {
  const value = params && typeof params === "object" && !Array.isArray(params) ? params : null;
  const targetId = typeof value?.threadId === "string" ? value.threadId : threadId;
  const selection = useSyncExternalStore(desktopViews.subscribe, () => desktopViews.diffTarget(threadId, targetId));
  return <DesktopDiffContent key={`${targetId}:${selection?.sequence ?? 0}`} threadId={targetId} initialPath={selection?.path} />;
}

export function DesktopPageDiff() {
  const target = experimental_useFixedTabTarget(DESKTOP_DIFF_TAB);
  return target ? <DesktopDiffContent key={`${target.target.threadId}:${target.sequence}`} threadId={target.target.threadId} initialPath={target.target.path} />
    : <p className="p-4 text-sm text-muted-foreground">Ask Aide to show a thread’s diff.</p>;
}

function DesktopDiffContent({ threadId, initialPath }: { threadId: string; initialPath?: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const root = useRef<HTMLDivElement>(null);
  const [data, setData] = useState<Awaited<ReturnType<typeof readThreadDiff>> | null>(null);
  const [path, setPath] = useState<string | undefined>(initialPath);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError(null);
    rpc.call("getThreadDiff", { threadId, ...(path ? { path } : {}) }).then(result => {
      if (!cancelled) { setData(result); setLoading(false); }
    }, cause => { if (!cancelled) { setError(cause instanceof Error ? cause.message : String(cause)); setLoading(false); } });
    return () => { cancelled = true; };
  }, [rpc, threadId, path, revision]);
  useEffect(() => desktopViews.registerContext(() => {
    const el = root.current;
    return data && document.visibilityState !== "hidden" && el?.getClientRects().length && !el.closest('[inert], [aria-hidden="true"]')
      ? { kind: "thread", id: `thread:${threadId}`, threadId, projectId: data.projectId, title: data.title } : null;
  }), [data, threadId]);
  return <div ref={root} data-handsfree-desktop-diff={threadId} className="flex h-full min-h-0 flex-col overflow-hidden">
    <div className="flex shrink-0 items-center gap-2 border-b border-border p-2">
      <span className="min-w-0 flex-1 truncate text-sm">{data?.title ?? "Workspace diff"}</span>
      <button type="button" className="rounded-md px-2 py-1 text-xs hover:bg-accent" disabled={loading}
        onClick={() => { setPath(undefined); setRevision(value => value + 1); }}>Refresh</button>
    </div>
    {data && <div className="shrink-0 space-y-2 border-b border-border p-2 text-xs">
      <p>{data.shortstat || "No changes"}</p>
      {!!data.files.length && <select aria-label="Diff file" className="w-full rounded-md border border-border bg-background p-2 text-foreground"
        value={path ?? data.path ?? ""} onChange={event => setPath(event.target.value)}>
        {data.files.map(file => <option key={file.path} value={file.path}>{file.path} (+{file.additions} −{file.deletions})</option>)}
      </select>}
    </div>}
    <div className="min-h-0 flex-1 overflow-auto">
      {loading ? <p className="p-4 text-sm text-muted-foreground">Loading diff…</p>
        : error ? <p role="alert" className="p-4 text-sm text-destructive">{error}</p>
        : data && <>
          {data.truncated && <p className="p-2 text-xs text-muted-foreground">BB returned a truncated diff.</p>}
          {data.notice ? <p className="p-4 text-sm text-muted-foreground">{data.notice}</p>
            : data.patch && data.path ? <ViewErrorBoundary key={data.path}><Diff path={data.path} patch={data.patch} /></ViewErrorBoundary>
            : <p className="p-4 text-sm text-muted-foreground">No text changes to display.</p>}
        </>}
    </div>
    <div className="flex shrink-0 justify-center p-2"><LiveCallControls /></div>
  </div>;
}
