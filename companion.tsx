// Mobile-only host drawer, with a window-local collection of typed views.
// Additional first-party renderers can join WorkspaceView when bb supports them.
import React, { useEffect, useRef, useSyncExternalStore } from "react";
import { ThreadChat } from "@get-bb/plugin-sdk/app";
import type { ExperimentalPluginFixedTabReference } from "@get-bb/plugin-sdk/app";
import { viewWorkspace } from "./view-workspace";
import { voiceAgent } from "./voice-agent";
import { LiveCallControls } from "./voice-chrome";
import { ViewErrorBoundary } from "./thread-view-boundary";
import { useDrawerViewport } from "./hooks/useDrawerViewport";

export const COMPANION_TAB: ExperimentalPluginFixedTabReference = { panelId: "sessions", id: "companion" };
export const THREAD_WORKSPACE_ACTION = "thread-workspace";


export function CompanionTab() {
  const { views, activeId } = useSyncExternalStore(viewWorkspace.subscribe, viewWorkspace.get);
  const callState = useSyncExternalStore(voiceAgent.subscribe, voiceAgent.getState);
  const root = useRef<HTMLDivElement>(null);
  useDrawerViewport(root);
  const active = views.find(view => view.id === activeId);
  useEffect(() => viewWorkspace.registerVisiblePanel(() =>
    document.visibilityState !== "hidden" && !!root.current?.getClientRects().length,
  ), []);
  return (
    <div ref={root} data-handsfree-workspace className="flex h-full min-h-0 flex-col overflow-hidden">
      {active ? <>
        <div className="flex shrink-0 items-center gap-2 border-b border-border p-2">
          <select aria-label="Shown thread" value={activeId ?? ""} onChange={event => viewWorkspace.select(event.target.value)}
            className="min-w-0 flex-1 rounded-md border border-border bg-background p-2 text-sm">
            {views.map(view => <option key={view.id} value={view.id}>{view.title}</option>)}
          </select>
          <span className="text-xs text-muted-foreground">{views.length}</span>
          <button type="button" aria-label={`Close ${active.title}`} onClick={() => viewWorkspace.close(active.id)} className="size-11 shrink-0 rounded-md hover:bg-accent">×</button>
        </div>
        <div className="min-h-0 flex-1">
          <ViewErrorBoundary key={active.id}>
            <ThreadChat threadId={active.threadId} variant="compact" layout="contained" />
          </ViewErrorBoundary>
        </div>
      </> : <div className="flex min-h-0 flex-1 items-center justify-center p-6 text-center text-sm text-muted-foreground">
        Ask Aide to show a thread, or to open all your running threads.
      </div>}
      {callState !== "idle" && (
        <div role="group" aria-label="Aide call controls" className="flex shrink-0 justify-center border-t border-border bg-background p-2">
          <LiveCallControls />
        </div>
      )}
    </div>
  );
}
