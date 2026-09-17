// Frontend tool dispatch: decides, per tool call, whether the call is handled
// locally in this realm (composer text, mobile drawer views), locally with a
// backend lookup (mobile focus), or passed through to the server's registry
// via the runTool RPC. Pure dispatch — transcript logging and the data-channel
// reply protocol stay with the VoiceAgent.
import type { useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../server";
import type { ViewWorkspace, OpenDisposition } from "../shared/view-workspace.ts";
import { clientDescriptor } from "../shared/client-identity.ts";

export interface RpcClient {
  call: ReturnType<typeof useRpc<typeof rpcContract>>["call"];
}

export interface ComposerBinding {
  setText: (text: string) => void;
  updateText: (updater: (current: string) => string) => void;
}

export interface Bindings {
  rpc: RpcClient;
  context: {
    threadId: string | null;
    projectId: string | null;
    /** True when the user is on the New thread screen (no thread exists yet). */
    onNewThreadScreen: boolean;
  };
  /**
   * The composer to type into — present only when a composer surface is mounted
   * (e.g. a thread view). Absent on surfaces like the Handsfree page, where the
   * text tools report that no composer is focused rather than faking one.
   */
  composer?: ComposerBinding;
  openNewThread: (projectId: string | null) => void;
}

/**
 * Tools that do real work AND navigate (spawn/diff, then `bb.sdk.threads.open`).
 * Unlike a pure-navigation tool we don't refuse these — we run them with
 * `focus:false` on a live mobile call so the work happens without backgrounding
 * the call. The server honors the flag by skipping its `threads.open`.
 */
const FOCUS_SUPPRESSIBLE_TOOLS = new Set(["start_thread", "show_diff"]);

/** What the dispatcher needs from the owning VoiceAgent. */
export interface ToolDispatchHost {
  /** The surface bindings captured when the tool call arrived. */
  bindings: Bindings | null;
  workspace: ViewWorkspace;
  /** True while this realm's call is live or muted. */
  callActive(): boolean;
  /** False once the call that issued this tool ended (channel closed / new call). */
  sessionCurrent(): boolean;
  logDiag(kind: string, payload?: Record<string, unknown>): void;
}

/** The tool's result plus how the transcript should present it. */
export interface ToolDispatchOutcome {
  output: string;
  status?: "success" | "error";
  presentation?: string;
  label?: string;
}

/**
 * Run one tool call. Throws on failure; the caller formats the error into the
 * `Tool error: …` output the model sees.
 */
export async function dispatchToolCall(
  host: ToolDispatchHost,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolDispatchOutcome> {
  const bindings = host.bindings;
  let output: string;
  let status: "success" | "error" | undefined;
  let presentation: string | undefined;
  let label: string | undefined;
  const shown = clientDescriptor.mobile ? host.workspace.current() : null;
  const context = shown
    ? { threadId: shown.threadId, projectId: shown.projectId, onNewThreadScreen: false }
    : bindings?.context;
  if (!bindings) {
    throw new Error("No bb surface is bound right now.");
  } else if (name === "set_composer_text") {
    if (!bindings.composer || (shown && bindings.context.threadId !== shown.threadId)) {
      throw new Error("No matching composer is available. Tap the shown thread’s composer to draft a message.");
    } else {
      bindings.composer.setText(String(args.text ?? ""));
      output = "Composer text replaced.";
    }
  } else if (name === "append_composer_text") {
    if (!bindings.composer || (shown && bindings.context.threadId !== shown.threadId)) {
      throw new Error("No matching composer is available. Tap the shown thread’s composer to draft a message.");
    } else {
      const text = String(args.text ?? "");
      bindings.composer.updateText((current) => (current ? `${current}\n${text}` : text));
      output = "Text appended to composer.";
    }
  } else if (
    name === "start_thread" &&
    !(typeof args.prompt === "string" && args.prompt.trim())
  ) {
    // No dictated prompt: never fabricate one — open bb's New thread screen
    // with the project preselected and let the user type it themselves.
    const projectId =
      typeof args.project_id === "string" && args.project_id
        ? args.project_id
        : context?.projectId ?? null;
    bindings.openNewThread(projectId);
    output =
      "Opened the New thread screen with the project preselected. The user will type the prompt themselves; no thread exists yet.";
  } else if (!clientDescriptor.mobile && ["focus_threads", "manage_views", "set_view_behavior"].includes(name)) {
    throw new Error("Drawer tools are mobile-only. On desktop, use focus_thread to navigate to a thread.");
  } else if (
    clientDescriptor.mobile && host.callActive() &&
    (name === "focus_thread" || name === "focus_threads")
  ) {
    const ids = name === "focus_thread" ? [args.thread_id] : args.thread_ids;
    if (!Array.isArray(ids) || !ids.length || ids.length > 100 || ids.some(id => typeof id !== "string" || !id.trim())) {
      throw new Error("Provide between 1 and 100 valid thread IDs.");
    }
    const disposition = name === "focus_threads" ? "new" : args.disposition ?? "auto";
    if (disposition !== "auto" && disposition !== "reuse" && disposition !== "new") throw new Error("Invalid tab disposition.");
    const { views, preference } = await bindings.rpc.call("resolveThreadViews", { threadIds: ids as string[] });
    if (!host.sessionCurrent()) throw new Error("The call ended before the threads could be shown.");
    host.workspace.open(views, disposition as OpenDisposition, preference);
    output = views.length === 1 ? `Showing ${views[0].title}.` : `Showing ${views.length} threads. ${views[0].title} is selected.`;
    label = views.length === 1 ? `Showed ${views[0].title}` : `Showed ${views.length} threads`;
    status = "success";
    presentation = "panel";
  } else if (name === "manage_views") {
    const current = host.workspace.get();
    const id = typeof args.view_id === "string" ? args.view_id : "";
    const view = current.views.find(item => item.id === id);
    if (args.action === "list") {
      output = JSON.stringify(current);
    } else if (args.action === "clear") {
      host.workspace.clear();
      output = "Closed all views. Threads and the call are still running.";
    } else if (!view) {
      throw new Error("That view is not open. List the open views first.");
    } else if (args.action === "select") {
      host.workspace.open([view], "new", "new");
      output = `Showing ${view.title}.`;
    } else if (args.action === "close") {
      host.workspace.close(id);
      output = `Closed ${view.title}. The thread is still running.`;
    } else throw new Error("Unknown view action.");
  } else if (name === "get_context") {
    const result = await bindings.rpc.call("runTool", { name, args, ...context! });
    output = result.output;
    status = result.status;
  } else {
    // These tools navigate (…→ threads.open) which would background a live
    // mobile call — tell the server not to focus so the work still happens but
    // nothing navigates. (The promptless start_thread is handled above.)
    const suppressFocus =
      FOCUS_SUPPRESSIBLE_TOOLS.has(name) &&
      clientDescriptor.mobile &&
      host.callActive();
    if (suppressFocus) host.logDiag("nav.suppressedFocus", { name });
    const result = await bindings.rpc.call("runTool", {
      name,
      args: suppressFocus ? { ...args, focus: false } : args,
      ...context!,
    });
    output = result.output;
    status = result.status;
    if (name === "focus_thread") {
      presentation = "navigation";
      if (status === "success") label = "Focused a thread";
    }
  }
  return {
    output,
    ...(status ? { status } : {}),
    ...(presentation ? { presentation } : {}),
    ...(label ? { label } : {}),
  };
}
