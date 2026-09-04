// The Handsfree page's mobile companion drawer.
//
// The Handsfree nav panel declares a fixed tab (COMPANION_TAB) that the host
// renders in its companion surface — a bottom drawer on mobile. During a live
// mobile call the voice agent can't navigate (it would background the app and
// suspend the mic), so `focus_thread` instead opens the requested thread here
// via experimental_useAppPanel().openFixedTab({ threadId }); the tab reads that
// target and shows the thread with <ThreadChat>. Re-targeting with a different
// threadId swaps which thread is shown, keeping the call alive throughout.
//
// The fixed-tab APIs (fixedTabs / useAppPanel / useFixedTabTarget) are all
// experimental_ SDK surface — expect them to move.
import {
  ThreadChat,
  experimental_useFixedTabTarget,
} from "@get-bb/plugin-sdk/app";
import type { ExperimentalPluginFixedTabReference, JsonValue, PluginNavPanelProps } from "@get-bb/plugin-sdk/app";

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

/** The drawer component. Shows the targeted thread, or a hint when untargeted. */
export function CompanionTab(_props: PluginNavPanelProps) {
  const state = experimental_useFixedTabTarget(COMPANION_TAB);
  const threadId = state?.target.threadId ?? null;
  if (!threadId) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
        Ask Aide to show a thread and it appears here beside your call.
      </div>
    );
  }
  return <ThreadChat threadId={threadId} variant="compact" layout="contained" />;
}
