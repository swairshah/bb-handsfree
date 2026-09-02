// Prototype: a "companion" split pane for the Handsfree page.
//
// The Handsfree nav panel declares a fixed tab (COMPANION_TAB) that the host
// renders in its right split pane. From the page we call
// experimental_useAppPanel().openFixedTab(...) with a { threadId } target; the
// tab reads that target and shows the thread via <ThreadChat>. Re-targeting with
// a different threadId swaps which thread is shown — the thing we're testing:
// can the plugin open a second pane and drive its content.
//
// Everything here is experimental_ SDK surface (fixedTabs / useAppPanel /
// useFixedTabTarget) — treat as a spike, expect it to move.
import { useState } from "react";
import {
  ThreadChat,
  experimental_useAppPanel,
  experimental_useFixedTabTarget,
  experimental_useSidebarThreads,
} from "@get-bb/plugin-sdk/app";
import type { ExperimentalPluginFixedTabReference, JsonValue, PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import { cn } from "@/lib/utils";

// Must be JSON-serializable for the host, hence the index signature.
interface CompanionTarget {
  threadId: string;
  [key: string]: JsonValue;
}

function isCompanionTarget(value: unknown): value is CompanionTarget {
  return !!value && typeof value === "object" && typeof (value as { threadId?: unknown }).threadId === "string";
}

/** Shared reference: used both to register the tab (app.tsx) and to open/target it. */
export const COMPANION_TAB: ExperimentalPluginFixedTabReference<CompanionTarget> = {
  panelId: "sessions",
  id: "companion",
  experimental_target: {
    validate: (value): value is CompanionTarget => isCompanionTarget(value),
  },
};

/** The right-pane component. Shows the targeted thread, or a hint when untargeted. */
export function CompanionTab(_props: PluginNavPanelProps) {
  const state = experimental_useFixedTabTarget(COMPANION_TAB);
  const threadId = state?.target.threadId ?? null;
  if (!threadId) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
        Pick a thread on the Handsfree page to show it here.
      </div>
    );
  }
  return <ThreadChat threadId={threadId} variant="compact" layout="contained" />;
}

/**
 * Controls rendered on the Handsfree page: pick a thread to open in the companion
 * pane. Selecting a different one re-targets (swaps) the same pane.
 */
export function CompanionControls({ className }: { className?: string }) {
  const appPanel = experimental_useAppPanel();
  const { threads, status } = experimental_useSidebarThreads();
  const [selected, setSelected] = useState("");

  if (status !== "ready" || threads.length === 0) return null;

  const openThread = (threadId: string) => {
    setSelected(threadId);
    // surface: "current" = the panel we're in (the Handsfree page).
    appPanel.openFixedTab({ surface: { kind: "current" }, tab: COMPANION_TAB, target: { threadId } });
  };

  return (
    <div className={cn("flex items-center gap-2 text-xs text-muted-foreground", className)}>
      <span className="shrink-0">Companion pane (experimental):</span>
      <select
        value={selected}
        onChange={(event) => {
          if (event.target.value) openThread(event.target.value);
        }}
        className="min-w-0 flex-1 rounded-md border border-border bg-card px-2 py-1 text-foreground"
      >
        <option value="">Pick a thread to show on the right…</option>
        {threads.slice(0, 40).map((thread) => (
          <option key={thread.id} value={thread.id}>
            {thread.title ?? thread.titleFallback ?? "Untitled thread"}
          </option>
        ))}
      </select>
    </div>
  );
}
