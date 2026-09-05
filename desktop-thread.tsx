import React, { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ThreadChat, experimental_useFixedTabTarget, useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import type { ExperimentalPluginFixedTabReference, PluginThreadPanelProps } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import type { ThreadView } from "./view-workspace";
import { desktopViews, DESKTOP_PAGE_TAB } from "./desktop-views";
import { ViewErrorBoundary } from "./thread-view-boundary";
import { LiveCallControls } from "./voice-chrome";
import { voiceAgent } from "./voice-agent";

export const DESKTOP_FIXED_TAB: ExperimentalPluginFixedTabReference<{ threadId: string }> = {
  ...DESKTOP_PAGE_TAB,
  experimental_target: {
    validate: (value): value is { threadId: string } => !!value && typeof value === "object" &&
      !Array.isArray(value) && Object.keys(value).length === 1 && typeof value.threadId === "string" && !!value.threadId.trim(),
  },
};

/** Params contain only stable IDs. BB persists and deduplicates native tabs. */
export function DesktopThreadTab({ threadId: ownerId, params }: PluginThreadPanelProps) {
  const preview = useSyncExternalStore(desktopViews.subscribe, () => desktopViews.preview(ownerId));
  const value = params && typeof params === "object" && !Array.isArray(params) ? params : null;
  const targetId = typeof value?.threadId === "string" ? value.threadId : value?.preview === true ? preview?.threadId : null;
  return targetId ? <DesktopThreadContent key={targetId} threadId={targetId} />
    : <p className="p-4 text-sm text-muted-foreground">Ask Aide to show a thread in this preview.</p>;
}

export function DesktopPageThread() {
  const target = experimental_useFixedTabTarget(DESKTOP_FIXED_TAB);
  return target ? <DesktopThreadContent key={target.target.threadId} threadId={target.target.threadId} />
    : <p className="p-4 text-sm text-muted-foreground">Ask Aide to show a thread beside the call.</p>;
}

function DesktopThreadContent({ threadId }: { threadId: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const root = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<ThreadView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const callState = useSyncExternalStore(voiceAgent.subscribe, voiceAgent.getState);
  useEffect(() => {
    let cancelled = false;
    rpc.call("resolveThreadViews", { threadIds: [threadId] }).then(
      result => { if (!cancelled) setView(result.views[0]); },
      cause => { if (!cancelled) setError(cause instanceof Error ? cause.message : "Could not load this thread."); },
    );
    return () => { cancelled = true; };
  }, [rpc, threadId]);
  useEffect(() => desktopViews.registerContext(() => {
    const el = root.current;
    return document.visibilityState !== "hidden" && el?.getClientRects().length &&
      !el.closest('[inert], [aria-hidden="true"]') ? view : null;
  }), [view]);
  return (
    <div ref={root} data-handsfree-desktop-thread={threadId} className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="flex shrink-0 items-center gap-2 border-b border-border p-2">
        <span className="min-w-0 flex-1 truncate text-sm">{view?.title ?? "Loading thread…"}</span>
        <button type="button" className="shrink-0 rounded-md px-2 py-1 text-xs hover:bg-accent"
          onClick={() => navigate.toThread(threadId)}>Open in workspace</button>
      </div>
      <div className="min-h-0 flex-1">
        {error ? <p role="alert" className="p-4 text-sm text-destructive">{error}</p>
          : <ViewErrorBoundary><ThreadChat threadId={threadId} variant="compact" layout="contained" /></ViewErrorBoundary>}
      </div>
      {callState !== "idle" && <div className="flex shrink-0 justify-center border-t border-border p-2"><LiveCallControls /></div>}
    </div>
  );
}
