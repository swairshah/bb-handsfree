// bb-plugin-handsfree — Aide: a realtime voice operator for bb.
//
// The frontend (app.tsx) captures mic audio over WebRTC directly in the bb
// app; this backend holds the OpenAI API key, performs the SDP exchange with
// the OpenAI Realtime API, and executes the voice agent's tools against the
// bb SDK (threads, projects, diffs, panes).
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, posix, win32 } from "node:path";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  DEFAULT_MODEL,
  DEFAULT_VOICE,
  MODEL_OPTIONS,
  VOICE_OPTIONS,
  isModel,
  isVoice,
  type RealtimeModel,
  type Voice,
} from "./models";
import { DESKTOP_DEFAULTS, type DesktopPreferences } from "./desktop-views";
import { readThreadDiff } from "./desktop-diff-data";
import { sessionEventLog } from "./session-events.ts";
import { DEFAULT_SHORTCUTS, isValidShortcut, normalizeShortcuts, type Shortcuts } from "./shortcuts";

/**
 * Rebindable keyboard shortcuts (see shortcuts.ts): each value is a
 * "Mod+Shift+H"-style string that includes Mod or Alt, or is a function key,
 * so it can't fire while the user is merely typing.
 */
const shortcutsSchema = z
  .object({
    toggle: z.string().max(60).refine(isValidShortcut, "not a usable key combination"),
    mute: z.string().max(60).refine(isValidShortcut, "not a usable key combination"),
  })
  .strict();

export const rpcContract = defineRpcContract({
  resolveFilePreview: {
    input: z.object({
      threadId: z.string().min(1),
      asHostFile: z.boolean().optional(),
      path: z.string().min(1).refine(path => !path.startsWith("/") && !/^[a-z][a-z0-9+.-]*:/i.test(path) &&
        !/[\\\u0000]/.test(path) && path.split("/").every(part => !!part && part !== "." && part !== ".."),
      "Use a workspace-relative file path without traversal, such as src/app.ts."),
    }).strict(),
    output: z.union([
      z.object({ kind: z.literal("workspace"), environmentId: z.string(), path: z.string() }).strict(),
      z.object({ kind: z.literal("host"), hostId: z.string(), path: z.string() }).strict(),
    ]),
  },
  getThreadDiff: {
    input: z.object({ threadId: z.string().min(1), path: z.string().min(1).optional() }).strict(),
    output: z.object({
      threadId: z.string(), projectId: z.string(), title: z.string(), shortstat: z.string(),
      files: z.array(z.object({ path: z.string(), additions: z.number(), deletions: z.number() }).strict()),
      path: z.string().nullable(), patch: z.string().nullable(), notice: z.string().nullable(), truncated: z.boolean(),
    }).strict(),
  },
  /** Exchange a WebRTC SDP offer with OpenAI Realtime. Returns the answer. */
  createCall: {
    input: z
      .object({
        sdp: z.string().min(1),
        threadId: z.string().nullable(),
        projectId: z.string().nullable(),
        /** True when the user is on the New thread screen (no thread yet). */
        onNewThreadScreen: z.boolean().optional(),
        /** Device policy is fixed for the call, independently of its entry point. */
        mobile: z.boolean().optional(),
        callOrigin: z.enum(["composer", "handsfree", "global"]).optional(),
        /** Unique per call; broadcast so every other window ends its session. */
        nonce: z.string().min(1),
      })
      .strict(),
    output: z.object({ sdp: z.string() }).strict(),
  },
  /** Record token usage from one realtime response.done event. */
  recordUsage: {
    input: z
      .object({
        model: z.string().nullable(),
        sessionId: z.string().nullable(),
        usage: z.record(z.string(), z.unknown()),
      })
      .strict(),
    output: z.object({ ok: z.literal(true) }).strict(),
  },
  /** View-only list of the voice agent's tools (source of truth: toolSchemas). */
  getTools: {
    input: z.null(),
    output: z
      .object({
        tools: z.array(
          z
            .object({
              name: z.string(),
              description: z.string(),
              /** JSON-schema of parameters, serialized; null = no parameters. */
              parameters: z.string().nullable(),
              /** Handled locally in the bb app frontend, not via bb.sdk. */
              local: z.boolean(),
            })
            .strict(),
        ),
      })
      .strict(),
  },
  /** Active prompt, the built-in default, and version history. */
  getPrompt: {
    input: z.null(),
    output: z
      .object({
        content: z.string(),
        defaultContent: z.string(),
        versions: z.array(
          z
            .object({
              id: z.number(),
              ts: z.number(),
              source: z.string(),
              note: z.string().nullable(),
              content: z.string(),
            })
            .strict(),
        ),
      })
      .strict(),
  },
  /** Save a new prompt version (becomes active for the next session). */
  setPrompt: {
    input: z
      .object({
        content: z.string().min(1).max(20000),
        source: z.enum(["user", "agent"]),
        note: z.string().nullable(),
      })
      .strict(),
    output: z.object({ ok: z.literal(true) }).strict(),
  },
  /** Effective non-secret config for new voice sessions (kv-backed). */
  getConfig: {
    input: z.null(),
    output: z
      .object({
        model: z.enum(MODEL_OPTIONS),
        voice: z.enum(VOICE_OPTIONS),
        notifications: z.boolean(),
        mobileViewBehavior: z.enum(["reuse", "new"]),
        desktopComposerDestination: z.enum(["navigate", "panel"]),
        desktopAideDestination: z.enum(["navigate", "panel"]),
        desktopTabBehavior: z.enum(["reuse", "new"]),
        pluginCommands: z.string(),
        credentialPreference: z.enum(["auto", "apiKey", "subscription"]),
        shortcuts: shortcutsSchema,
      })
      .strict(),
  },
  /** Update one or more config fields for new voice sessions. */
  setConfig: {
    input: z
      .object({
        model: z.enum(MODEL_OPTIONS).optional(),
        voice: z.enum(VOICE_OPTIONS).optional(),
        notifications: z.boolean().optional(),
        mobileViewBehavior: z.enum(["reuse", "new"]).optional(),
        desktopComposerDestination: z.enum(["navigate", "panel"]).optional(),
        desktopAideDestination: z.enum(["navigate", "panel"]).optional(),
        desktopTabBehavior: z.enum(["reuse", "new"]).optional(),
        pluginCommands: z.string().max(2000).optional(),
        credentialPreference: z.enum(["auto", "apiKey", "subscription"]).optional(),
        shortcuts: shortcutsSchema.optional(),
      })
      .strict(),
    output: z
      .object({
        model: z.enum(MODEL_OPTIONS),
        voice: z.enum(VOICE_OPTIONS),
        notifications: z.boolean(),
        mobileViewBehavior: z.enum(["reuse", "new"]),
        desktopComposerDestination: z.enum(["navigate", "panel"]),
        desktopAideDestination: z.enum(["navigate", "panel"]),
        desktopTabBehavior: z.enum(["reuse", "new"]),
        pluginCommands: z.string(),
        credentialPreference: z.enum(["auto", "apiKey", "subscription"]),
        shortcuts: shortcutsSchema,
      })
      .strict(),
  },
  /** Clear the stored OpenAI API key (falls back to env / subscription). */
  clearApiKey: {
    input: z.null(),
    output: z.object({ ok: z.literal(true) }).strict(),
  },
  /** Installed plugins that expose a bb command the voice agent could run. */
  listPlugins: {
    input: z.null(),
    output: z
      .object({
        plugins: z.array(
          z
            .object({ id: z.string(), name: z.string(), summary: z.string(), iconUrl: z.string().nullable() })
            .strict(),
        ),
      })
      .strict(),
  },
  /** Which credential the backend will use for new voice sessions. */
  getCredentialStatus: {
    input: z.null(),
    output: z
      .object({
        /** The credential apiKey() will actually pick right now. */
        effective: z.enum(["apiKey", "env", "subscription", "none"]),
        /** The user's stored preference; "auto" follows precedence. */
        preference: z.enum(["auto", "apiKey", "subscription"]),
        hasApiKey: z.boolean(),
        envKeyPresent: z.boolean(),
        subscriptionAvailable: z.boolean(),
      })
      .strict(),
  },
  /** Append one event to a voice session's transcript log. */
  logEvent: {
    input: z
      .object({
        sessionId: z.string().min(1),
        kind: z.string().min(1),
        payload: z.record(z.string(), z.unknown()),
      })
      .strict(),
    output: z.object({ ok: z.literal(true) }).strict(),
  },
  /**
   * Broadcast a live call's coarse presence to every surface/realm. The owning
   * realm (the one holding the WebRTC session) publishes on each state change
   * and on a heartbeat; other realms mirror it so their composer pill / sidebar
   * bar reflect the call they don't own. Pure pass-through to realtime.
   */
  publishPresence: {
    input: z
      .object({
        nonce: z.string().min(1),
        phase: z.enum(["connecting", "live", "muted", "idle"]),
        startedAt: z.number().nullable(),
        /** Which client/realm owns this call (observability; see client-identity). */
        client: z.string().optional(),
        realm: z.string().optional(),
      })
      .strict(),
    output: z.object({ ok: z.literal(true) }).strict(),
  },
  /**
   * Ask whoever owns a live call to re-announce its presence right now. A
   * freshly mounted surface (e.g. a page realm rebuilt after mobile navigation)
   * fires this so it catches up immediately instead of waiting up to a full
   * heartbeat — otherwise it briefly shows "idle" over a call that is live.
   */
  requestPresence: {
    input: z.null(),
    output: z.object({ ok: z.literal(true) }).strict(),
  },
  /**
   * Relay a control intent (stop/mute/unmute) from a surface that does NOT own
   * the call to the realm that does. Only the owner (matching nonce) acts on it.
   */
  sendVoiceCommand: {
    input: z
      .object({
        nonce: z.string().min(1),
        action: z.enum(["stop", "mute", "unmute"]),
        /** Which client/realm issued the command (observability). */
        client: z.string().optional(),
        realm: z.string().optional(),
      })
      .strict(),
    output: z.object({ ok: z.literal(true) }).strict(),
  },
  /** Resolve real thread metadata and the current opening preference. */
  resolveThreadViews: {
    input: z.object({ threadIds: z.array(z.string().min(1)).min(1).max(100) }).strict(),
    output: z.object({
      views: z.array(z.object({
        kind: z.literal("thread"), id: z.string(), threadId: z.string(),
        projectId: z.string().nullable(), title: z.string(),
      }).strict()),
      preference: z.enum(["reuse", "new"]),
      desktop: z.object({
        desktopComposerDestination: z.enum(["navigate", "panel"]),
        desktopAideDestination: z.enum(["navigate", "panel"]),
        desktopTabBehavior: z.enum(["reuse", "new"]),
      }).strict(),
    }).strict(),
  },
  /**
   * End a call authoritatively, without needing its owner realm to act — the
   * owner may be a frozen, backgrounded mobile webview that can no longer receive
   * commands. Marks the session stopped (so the list stops showing it live) and
   * broadcasts idle + a stop so every surface clears and the owner tears down if
   * it ever thaws. This is what makes stop reliable against the navigation zombie.
   */
  forceStop: {
    input: z.object({ nonce: z.string().min(1) }).strict(),
    output: z.object({ ok: z.literal(true) }).strict(),
  },
  /** List voice sessions, newest first, with counts and estimated cost. */
  listSessions: {
    input: z.object({ offset: z.number().int().min(0) }).strict().nullable(),
    output: z
      .object({
        sessions: z.array(
          z
            .object({
              id: z.string(),
              startedAt: z.number(),
              lastEventAt: z.number(),
              events: z.number(),
              ended: z.boolean(),
              costUsd: z.number(),
              preview: z.string(),
              hasError: z.boolean(),
              /** Which device the call came through (from session.started); null for old sessions. */
              device: z
                .object({
                  label: z.string(),
                  mobile: z.boolean(),
                  platform: z.string(),
                  browser: z.string(),
                  runtime: z.string(),
                })
                .nullable(),
            })
            .strict(),
        ),
        hasMore: z.boolean(),
      })
      .strict(),
  },
  /** Full event log for one session, oldest first. */
  getSessionEvents: {
    input: z.object({ sessionId: z.string().min(1) }).strict(),
    output: z
      .object({
        events: z.array(
          z
            .object({ id: z.number(), ts: z.number(), kind: z.string(), payload: z.string() })
            .strict(),
        ),
      })
      .strict(),
  },
  /** Run one realtime tool call against the bb SDK. Always returns text. */
  runTool: {
    input: z
      .object({
        name: z.string(),
        args: z.record(z.string(), z.unknown()),
        threadId: z.string().nullable(),
        projectId: z.string().nullable(),
        onNewThreadScreen: z.boolean().optional(),
      })
      .strict(),
    output: z.object({ output: z.string(), status: z.enum(["success", "error"]) }).strict(),
  },
});

const REALTIME_ENDPOINT = "https://api.openai.com/v1/realtime/calls";

// USD per 1M tokens for the gpt-realtime family (openai.com/api/pricing,
// checked 2026-02). Cached input (text or audio) is a flat $0.40.
const RATES = {
  textIn: 4,
  audioIn: 32,
  cachedIn: 0.4,
  textOut: 16,
  audioOut: 64,
};

interface UsageRow {
  ts: number;
  model: string;
  input_text: number;
  input_audio: number;
  cached_text: number;
  cached_audio: number;
  output_text: number;
  output_audio: number;
}

/** Estimated USD cost of one usage row at current RATES. */
function costUsd(row: UsageRow): number {
  const uncachedText = Math.max(0, row.input_text - row.cached_text);
  const uncachedAudio = Math.max(0, row.input_audio - row.cached_audio);
  return (
    (uncachedText * RATES.textIn +
      uncachedAudio * RATES.audioIn +
      (row.cached_text + row.cached_audio) * RATES.cachedIn +
      row.output_text * RATES.textOut +
      row.output_audio * RATES.audioOut) /
    1_000_000
  );
}

function truncate(text: string, max = 4000): string {
  return text.length > max ? `${text.slice(0, max)}\n…[truncated]` : text;
}

/** Compact a completed turn's result for a grounded voice notification. */
function notificationDetail(detail: string | null, max = 600): string | null {
  const normalized = detail?.replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  if (normalized.length <= max) return normalized;
  const prefix = normalized.slice(0, max);
  const sentenceEnd = Math.max(prefix.lastIndexOf(". "), prefix.lastIndexOf("! "), prefix.lastIndexOf("? "));
  return `${prefix.slice(0, sentenceEnd >= max / 2 ? sentenceEnd + 1 : max).trimEnd()}…`;
}

/** One installed plugin's contributed `bb` command, as exposed to the voice agent. */
interface PluginCommandInfo {
  id: string;
  name: string;
  summary: string;
}

export function toolSchemas(pluginCommands: PluginCommandInfo[] = [], mobile = false) {
  const pluginTool =
    pluginCommands.length === 0
      ? []
      : [
          {
            type: "function",
            name: "run_plugin_command",
            description: `Run an installed bb plugin's CLI command and return its text output. Available: ${pluginCommands.map((c) => `${c.id} (bb ${c.name} — ${c.summary})`).join("; ")}. When unsure of a plugin's subcommands, call it with argv ["--help"] first.`,
            parameters: {
              type: "object",
              properties: {
                plugin_id: { type: "string", enum: pluginCommands.map((c) => c.id), description: "Which plugin's command to run." },
                argv: { type: "array", items: { type: "string" }, description: 'Arguments after the command name, e.g. ["--help"] or ["list", "--json"].' },
              },
              required: ["plugin_id"],
            },
          },
        ];
  return [
    ...pluginTool,
    { type: "function", name: "get_context", description: "Get the user's current bb context: the thread and project currently in view, including the thread's status and latest assistant output." },
    { type: "function", name: "list_projects", description: "List bb projects with their ids and names." },
    { type: "function", name: "list_machines", description: "List the machines (hosts) bb can run threads on: id, name, connection status — and, for a project, which machines hold it and which is its default. Use before start_thread when the machine matters.", parameters: { type: "object", properties: { project_id: { type: "string", description: "Marks which machines hold this project and which is its default. Defaults to the user's current project." } } } },
    { type: "function", name: "list_live_threads", description: "List the threads in the Live threads sidebar section: running right now (active/starting/provisioning/waiting), plus threads that finished within the last 30 minutes (status 'recently-finished'). Only threads without a 'recently-finished' status are still working." },
    { type: "function", name: "list_threads", description: "List recent bb threads (id, title, status). Optionally filter by project id.", parameters: { type: "object", properties: { project_id: { type: "string" }, limit: { type: "number", description: "Max threads to return (default 15)." } } } },
    { type: "function", name: "search_threads", description: "Full-text search bb threads by title/content. Returns matching thread ids and titles.", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
    { type: "function", name: "read_thread", description: "Read a thread's details and its latest assistant output.", parameters: { type: "object", properties: { thread_id: { type: "string" } }, required: ["thread_id"] } },
    { type: "function", name: "focus_thread", description: mobile ? "Show a thread in the mobile drawer without leaving the call. disposition: auto uses the mobile preference, reuse replaces the active view, new keeps existing views." : "Show a thread on the calling desktop. destination auto follows the saved preference for where this call started; navigate moves the workspace; panel opens beside it. Use explicit destination only when the user asks for it. disposition applies to side panels: auto uses the preference, reuse replaces the preview, new opens a native thread-page tab. Aide page supports a single side-panel view, not new native tabs.", parameters: { type: "object", properties: { thread_id: { type: "string" }, disposition: { type: "string", enum: ["auto", "reuse", "new"] }, ...(!mobile ? { destination: { type: "string", enum: ["auto", "navigate", "panel"] } } : {}) }, required: ["thread_id"] } },
    { type: "function", name: "focus_threads", description: mobile ? "Show several threads in the mobile drawer switcher, preserving existing views. For all running threads, call list_live_threads and exclude recently-finished entries. Up to 100 per batch." : "Open several threads as separate native side-panel tabs on the current thread page, preserving existing tabs and selecting the first requested thread. Available only from existing thread pages, not the Aide page. For all running threads, first call list_live_threads and exclude recently-finished entries. Up to 100 per batch.", parameters: { type: "object", properties: { thread_ids: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 100 } }, required: ["thread_ids"] } },
    { type: "function", name: "set_desktop_behavior", description: "Save desktop opening preferences only when the user explicitly asks for a lasting change. composer_destination and aide_destination choose navigate or panel. tab_behavior chooses reuse or new for thread-page side panels. Does not affect mobile. Pass only requested changes.", parameters: { type: "object", properties: { composer_destination: { type: "string", enum: ["navigate", "panel"] }, aide_destination: { type: "string", enum: ["navigate", "panel"] }, tab_behavior: { type: "string", enum: ["reuse", "new"] } } } },
    { type: "function", name: "manage_views", description: "List, select, or close the views in the mobile drawer. Get view IDs using list. clear closes all views only when the user asks. Closing a view does not stop its thread or the call.", parameters: { type: "object", properties: { action: { type: "string", enum: ["list", "select", "close", "clear"] }, view_id: { type: "string" } }, required: ["action"] } },
    { type: "function", name: "set_view_behavior", description: "Save how future mobile drawer opens behave. Use only when the user asks for a lasting mobile preference: reuse replaces the active view; new keeps views in the switcher. Desktop preferences are separate. Explicit mobile requests and batches override this preference.", parameters: { type: "object", properties: { behavior: { type: "string", enum: ["reuse", "new"] } }, required: ["behavior"] } },
    { type: "function", name: "set_pane", description: "Change a thread pane's presentation in the bb app: spotlight, clear-spotlight, maximize, restore, or toggle.", parameters: { type: "object", properties: { thread_id: { type: "string" }, action: { type: "string", enum: ["spotlight", "clear-spotlight", "maximize", "restore", "toggle"] } }, required: ["thread_id", "action"] } },
    { type: "function", name: "send_to_thread", description: "Send a message to a thread's agent. Starts a turn if idle, queues/steers if running.", parameters: { type: "object", properties: { thread_id: { type: "string" }, message: { type: "string" } }, required: ["thread_id", "message"] } },
    { type: "function", name: "start_thread", description: "Start a new agent thread in a project. Only pass prompt when the user dictated actual work; With no prompt, this opens bb's New thread screen for the user to type their own. Runs on the project's default machine unless machine_id is given — if the project lives on several connected machines and the user didn't say which, check list_machines and ask one short question instead of guessing.", parameters: { type: "object", properties: { project_id: { type: "string", description: "Project id; defaults to the user's current project." }, prompt: { type: "string", description: "The user's own instruction for the agent, verbatim. Omit if they didn't give one." }, title: { type: "string" }, machine_id: { type: "string", description: "Machine (host) id to run on, from list_machines. Omit to use the project's default machine." } } } },
    { type: "function", name: "stop_thread", description: "Stop a running thread.", parameters: { type: "object", properties: { thread_id: { type: "string" } }, required: ["thread_id"] } },
    { type: "function", name: "archive_thread", description: "Archive a thread (and its children).", parameters: { type: "object", properties: { thread_id: { type: "string" } }, required: ["thread_id"] } },
    { type: "function", name: "rename_thread", description: "Rename a thread.", parameters: { type: "object", properties: { thread_id: { type: "string" }, title: { type: "string" } }, required: ["thread_id", "title"] } },
    { type: "function", name: "show_diff", description: mobile ? "Summarize a thread's workspace diff without navigating away from the mobile call." : "Show a workspace diff in a side-panel tab without navigating. Optional path selects that changed file in the diff (not the full file preview). Optional thread_id defaults to the currently shown thread. Returns a changed-file summary. Supports thread pages and Aide.", parameters: { type: "object", properties: { thread_id: { type: "string" }, ...(!mobile ? { path: { type: "string", description: "Workspace-relative changed-file path." } } : {}) }, ...(mobile ? { required: ["thread_id"] } : {}) } },
    { type: "function", name: "open_browser", description: "Open an HTTP(S) URL on the calling desktop using BB's saved browser preference (BB browser or external browser). Cannot force the built-in browser, confirm page load, or read/control the page. Does not change preferences. Use only when the user asks to open a URL.", parameters: { type: "object", properties: { url: { type: "string", description: "Complete http:// or https:// URL." } }, required: ["url"] } },
    { type: "function", name: "update_instructions", description: "Amend your own standing instructions (the system prompt for future voice sessions). Pass the COMPLETE new instructions text, not a diff. Use only when the user asks for a lasting behavior change.", parameters: { type: "object", properties: { instructions: { type: "string", description: "The full replacement instructions." }, reason: { type: "string", description: "One short sentence: why, quoting the user's request." } }, required: ["instructions", "reason"] } },
    { type: "function", name: "preview_file", description: "Request BB's native file preview in the calling desktop window. path must be a known workspace-relative file path (e.g. README.md or src/app.ts), not a URL or an absolute path. Optional thread_id chooses the workspace; omit for the current thread. Optional line reveals a one-based line number. Opens a preview without navigating the thread or using an external editor. Host acceptance does not confirm the file exists or has loaded. Ask for the path/thread if unclear; do not guess filenames.", parameters: { type: "object", properties: { path: { type: "string" }, thread_id: { type: "string" }, line: { type: "integer", minimum: 1 } }, required: ["path"] } },
    // Handled locally in the bb app frontend, never reaches runTool:
    { type: "function", name: "set_composer_text", description: "Replace the text in the user's message composer (the box they type prompts into).", parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
    { type: "function", name: "append_composer_text", description: "Append text to the user's message composer.", parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
  ].filter(tool => mobile ? !["set_desktop_behavior", "open_browser", "preview_file"].includes(tool.name) : !["manage_views", "set_view_behavior"].includes(tool.name));
}

export function threadViewInstructions(mobile: boolean) {
  if (mobile) return "Mobile thread views: focus_thread shows a thread in the drawer without navigating away from the call. disposition new preserves other views and reuse replaces the selected view. focus_threads opens a batch into the drawer switcher, not separate native bb tabs. For all running threads, use list_live_threads and exclude recently-finished entries. Use manage_views to list, select, or close mobile views. Use set_view_behavior only for an explicitly requested lasting mobile preference. Call get_context for the thread currently shown. If the drawer is unavailable, report the limitation; do not navigate away from the mobile call.";
  return `Desktop navigation:
- Use the call origin captured at startup for saved defaults. Composer calls default to workspace navigation, Aide calls to its fixed Thread view, and global/sidebar calls to navigation. Later navigation never changes that origin.
- An ordinary unambiguous "show/open X" follows the saved default. Do not ask on every request. If the user's intent is ambiguous between moving the workspace, adding a side-panel tab, or replacing a view, ask one short question before acting, offering only choices supported on this screen. You can ask directly in conversation; no tool is needed to ask.
- "Navigate/take me to X" means destination navigate. "Beside/in the side panel" means destination panel. "Also/as well/keep the other one/new tab" means destination panel and disposition new, preserving existing tabs. "Replace the preview" means destination panel and disposition reuse. If "replace this tab" could mean a dedicated native tab, clarify: reuse targets the reusable Thread preview, not arbitrary native tabs.
- focus_threads preserves existing tabs on thread pages. Aide's own page supports one fixed Thread view; it cannot add multiple native thread tabs. If adding is unavailable, ask whether to replace that Thread view or navigate to a thread page. Never silently reinterpret an additive request as replacement.
- If a tool reports clarification needed, nothing changed. Ask the user, then retry with their chosen destination/disposition. Do not retry a declined action with guessed arguments. Changing Aide's existing fixed Thread target requires explicit disposition reuse after the user requests replacement.
- Describe the exact tool outcome: navigated the workspace, opened/selected separate side-panel tabs (existing tabs kept), selected/updated the reusable Thread preview, or replaced the fixed Handsfree Thread view. BB does not distinguish newly created tabs from already-existing tabs in its return value; never invent that distinction or say a view is "alongside" another when it replaced it.
- Call get_context for current visible-thread context and side-panel capabilities. Use set_desktop_behavior only for explicitly requested lasting preferences. Per-request choices never change saved preferences. Mobile drawer preferences do not apply to desktop.
- open_browser follows the client browser preference and reports request acceptance, not page load; it cannot force internal/external or control the page.
- show_diff opens a diff panel without navigating. To show changes to a specific file, pass its workspace-relative path to show_diff; do not substitute preview_file, which shows the full file. Ask if a named file is ambiguous or absent from the changed-file list.
- preview_file opens a known workspace-relative file with optional line and thread_id. Ask for missing paths/context rather than inventing them. A declined preview does not mean a plugin is missing. Offer navigation to the owning thread or opening from Handsfree if the current screen cannot accept it; never navigate automatically.
- Native tab closure/reordering, Terminal-tab opening, and arbitrary plugin-tab opening are not available through these tools. Never claim an open succeeded before the tool result.`;
}

const DEFAULT_PROMPT = `You are Aide, a concise voice operator for bb — the user's agentic IDE where coding agents run in threads inside projects.

The user talks to you to drive bb hands-free. You can list/search/read threads, focus them on screen, spotlight or maximize panes, send messages to agent threads, start new threads, stop or archive threads, summarize diffs, and edit the user's prompt composer.

Rules:
- Be extremely succinct. One short sentence by default ("Done.", "Focused.", "Sent."). Never narrate what you're about to do, never enumerate options, never restate the user's request. Add detail only when asked.
- Thread ids look like thr_x… and project ids like proj_x…. When the user names a thread by topic or title, find it with list_threads or search_threads first.
- Never invent prompts, titles, or messages on the user's behalf. If required information is missing, ask one short question.
- When reading agent output aloud, give a one-or-two-sentence summary; never read code or ids verbatim.
- Prefer focus_thread so the user sees what you are talking about.
- While a voice session is active, bb sends you updates when visible threads finish or fail (when Announcements is enabled). You can notify the user: if they ask to be told when a thread finishes, say yes, then announce the update in one short sentence when it arrives. Always name the thread by its title in that sentence; several threads may be running, so a bare "it finished" is ambiguous. Never claim that you cannot notify them, and do not poll the thread.
- Threads run on a machine. start_thread uses the project's default machine unless you pass machine_id — when the project is on several connected machines and the user didn't name one, use list_machines and ask one short question (e.g. "On your MacBook or the studio?") before starting.
- When the user asks you to permanently behave differently ("always …", "from now on …"), use update_instructions to amend these standing instructions.`;

export default async function plugin(bb: BbPluginApi) {
  const db = bb.storage.database();
  bb.storage.migrate(db, [
    `CREATE TABLE IF NOT EXISTS usage_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      model TEXT NOT NULL,
      input_text INTEGER NOT NULL DEFAULT 0,
      input_audio INTEGER NOT NULL DEFAULT 0,
      cached_text INTEGER NOT NULL DEFAULT 0,
      cached_audio INTEGER NOT NULL DEFAULT 0,
      output_text INTEGER NOT NULL DEFAULT 0,
      output_audio INTEGER NOT NULL DEFAULT 0
    )`,
    `ALTER TABLE usage_events ADD COLUMN session_id TEXT`,
    `CREATE TABLE IF NOT EXISTS session_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      ts INTEGER NOT NULL,
      kind TEXT NOT NULL,
      payload TEXT NOT NULL DEFAULT '{}'
    )`,
    `CREATE INDEX IF NOT EXISTS idx_session_events_session ON session_events (session_id, ts)`,
    `CREATE TABLE IF NOT EXISTS prompt_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      source TEXT NOT NULL,
      note TEXT,
      content TEXT NOT NULL
    )`,
  ]);

  // The API key is the ONE declarative setting: secrets must live here to get
  // 0600-file storage that never touches the db or the frontend. Everything
  // else the user configures — model, voice, behavior — is kv-backed below and
  // rendered by our own polished settings sections, so the host's auto-form
  // stays a single clean field instead of a flat dump.
  const settings = bb.settings.define({
    openaiApiKey: {
      type: "string",
      label: "OpenAI API key (optional)",
      secret: true,
      description: "Leave blank to use your ChatGPT subscription instead (run `codex login`).",
    },
  });

  // ---- kv-backed voice-session config (model / voice / behavior) ----
  // "auto" keeps the historical precedence (key → env → subscription); the
  // user can pin it to one credential when more than one is available.
  type CredentialPreference = "auto" | "apiKey" | "subscription";
  const CREDENTIAL_PREFERENCES: readonly CredentialPreference[] = ["auto", "apiKey", "subscription"];
  const isCredentialPreference = (value: unknown): value is CredentialPreference =>
    typeof value === "string" && (CREDENTIAL_PREFERENCES as readonly string[]).includes(value);

  interface VoiceConfig extends DesktopPreferences {
    model: RealtimeModel;
    voice: Voice;
    notifications: boolean;
    mobileViewBehavior: "reuse" | "new";
    pluginCommands: string;
    credentialPreference: CredentialPreference;
    shortcuts: Shortcuts;
  }
  const CONFIG_KEY = "config";
  const CONFIG_DEFAULTS: VoiceConfig = {
    ...DESKTOP_DEFAULTS,
    model: DEFAULT_MODEL,
    voice: DEFAULT_VOICE,
    notifications: true,
    mobileViewBehavior: "reuse",
    pluginCommands: "all",
    credentialPreference: "auto",
    shortcuts: { ...DEFAULT_SHORTCUTS },
  };
  async function readConfig(): Promise<VoiceConfig> {
    const stored = (await bb.storage.kv.get<Partial<VoiceConfig> & { viewBehavior?: string }>(CONFIG_KEY)) ?? {};
    return {
      model: isModel(stored.model) ? stored.model : CONFIG_DEFAULTS.model,
      voice: isVoice(stored.voice) ? stored.voice : CONFIG_DEFAULTS.voice,
      notifications:
        typeof stored.notifications === "boolean" ? stored.notifications : CONFIG_DEFAULTS.notifications,
      desktopComposerDestination: stored.desktopComposerDestination === "panel" ? "panel" : "navigate",
      desktopAideDestination: stored.desktopAideDestination === "navigate" ? "navigate" : "panel",
      desktopTabBehavior: stored.desktopTabBehavior === "reuse" ? "reuse" : "new",
      mobileViewBehavior: (stored.mobileViewBehavior ?? stored.viewBehavior) === "new" ? "new" : "reuse",
      pluginCommands:
        typeof stored.pluginCommands === "string" ? stored.pluginCommands : CONFIG_DEFAULTS.pluginCommands,
      credentialPreference: isCredentialPreference(stored.credentialPreference)
        ? stored.credentialPreference
        : CONFIG_DEFAULTS.credentialPreference,
      shortcuts: normalizeShortcuts(stored.shortcuts),
    };
  }
  async function writeConfig(patch: Partial<VoiceConfig>): Promise<VoiceConfig> {
    // Store the canonical spelling so equality checks downstream are simple.
    if (patch.shortcuts) patch = { ...patch, shortcuts: normalizeShortcuts(patch.shortcuts) };
    const next = { ...(await readConfig()), ...patch };
    await bb.storage.kv.set(CONFIG_KEY, next);
    return next;
  }

  // One-time migration: earlier versions stored model/voice/notifications/
  // pluginCommands as declarative settings. Carry any customized values into
  // kv so removing those descriptors doesn't silently reset them.
  if (!(await bb.storage.kv.get<boolean>("config.migrated"))) {
    try {
      const legacy = await bb.sdk.plugins.getSettings({ pluginId: bb.pluginId });
      const v = (legacy?.values ?? {}) as Record<string, unknown>;
      const patch: Partial<VoiceConfig> = {};
      if (isModel(v.model)) patch.model = v.model;
      if (isVoice(v.voice)) patch.voice = v.voice;
      if (typeof v.notifications === "boolean") patch.notifications = v.notifications;
      if (typeof v.pluginCommands === "string") patch.pluginCommands = v.pluginCommands;
      if (Object.keys(patch).length > 0) await writeConfig(patch);
    } catch (error) {
      bb.log.warn(`config migration skipped: ${error instanceof Error ? error.message : String(error)}`);
    }
    await bb.storage.kv.set("config.migrated", true);
  }

  // ---- plugin-command exposure ----
  // Other installed plugins contribute `bb` CLI commands. The voice agent
  // learns about them via its session prompt and runs them through the
  // run_plugin_command tool; the pluginCommands setting curates which
  // plugins are exposed (all / none / allowlist of plugin ids).
  async function exposedPluginCommands(): Promise<PluginCommandInfo[]> {
    const { pluginCommands } = await readConfig();
    const filter = (pluginCommands ?? "all").trim().toLowerCase();
    if (filter === "none") return [];
    const allow =
      filter === "all" || filter === ""
        ? null
        : new Set(filter.split(",").map((entry) => entry.trim()).filter(Boolean));
    try {
      const { plugins } = await bb.sdk.plugins.list();
      return plugins
        .filter(
          (plugin) =>
            plugin.enabled &&
            plugin.status === "running" &&
            plugin.cliCommand !== null &&
            plugin.id !== bb.pluginId &&
            (allow === null || allow.has(plugin.id)),
        )
        .map((plugin) => ({
          id: plugin.id,
          name: plugin.cliCommand?.name ?? plugin.id,
          summary: plugin.cliCommand?.summary ?? "",
        }))
        .sort((a, b) => a.id.localeCompare(b.id));
    } catch (error) {
      bb.log.warn(`could not list plugin commands: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  }

  // ---- thread-event notifications (feature-flagged by `notifications`) ----
  // Voice sessions get told when agent threads finish or fail. The frontend
  // queues and digests these (never interrupting speech or an active
  // response); this side only decides WHETHER to publish.
  async function publishThreadEvent(kind: "idle" | "failed", thread: { id: string; title: string | null; visibility: string }, detail: string | null) {
    const { notifications } = await readConfig();
    if (!notifications || thread.visibility === "hidden") return;
    bb.realtime.publish("aide-thread-event", {
      kind,
      threadId: thread.id,
      title: thread.title ?? "(untitled thread)",
      detail: notificationDetail(detail),
    });
  }
  bb.events.on("thread.idle", ({ thread, lastAssistantText }) => {
    void publishThreadEvent("idle", thread, lastAssistantText);
  });
  bb.events.on("thread.failed", ({ thread, error }) => {
    void publishThreadEvent("failed", thread, error);
  });

  // ---- Codex subscription auth ----
  // The OpenAI Realtime endpoints accept the ChatGPT-subscription OAuth
  // access token that Codex CLI stores in ~/.codex/auth.json (its audience is
  // literally https://api.openai.com/v1). We use it as a fallback when no API
  // key is configured, refreshing it via the Codex OAuth client when expired.
  const CODEX_AUTH_PATH = join(homedir(), ".codex", "auth.json");
  const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

  function jwtExp(token: string): number {
    try {
      const payload = token.split(".")[1];
      const json = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
      return typeof json.exp === "number" ? json.exp : 0;
    } catch {
      return 0;
    }
  }

  async function codexToken(): Promise<string | null> {
    let auth: { tokens?: { access_token?: string; refresh_token?: string } };
    try {
      auth = JSON.parse(readFileSync(CODEX_AUTH_PATH, "utf8"));
    } catch {
      return null;
    }
    const access = auth.tokens?.access_token;
    const refresh = auth.tokens?.refresh_token;
    if (!access) return null;
    if (jwtExp(access) - 60 > Date.now() / 1000) return access;
    if (!refresh) return null;
    try {
      const response = await fetch("https://auth.openai.com/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_type: "refresh_token",
          client_id: CODEX_CLIENT_ID,
          refresh_token: refresh,
          scope: "openid profile email",
        }),
      });
      if (!response.ok) {
        bb.log.error(`codex token refresh failed: ${response.status}`);
        return null;
      }
      const fresh = (await response.json()) as { access_token?: string; refresh_token?: string; id_token?: string };
      if (!fresh.access_token) return null;
      // Persist back like Codex CLI does, so both tools stay in sync.
      const updated = {
        ...auth,
        tokens: {
          ...auth.tokens,
          access_token: fresh.access_token,
          refresh_token: fresh.refresh_token ?? refresh,
          ...(fresh.id_token ? { id_token: fresh.id_token } : {}),
        },
        last_refresh: new Date().toISOString(),
      };
      try {
        writeFileSync(CODEX_AUTH_PATH, JSON.stringify(updated, null, 2));
      } catch {
        // Read-only auth file is fine; the token still works for this session.
      }
      return fresh.access_token;
    } catch (error) {
      bb.log.error(`codex token refresh error: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  async function apiKey(): Promise<string> {
    const { openaiApiKey } = await settings.get();
    const { credentialPreference } = await readConfig();
    const key = openaiApiKey || process.env.OPENAI_API_KEY;
    // When the user pinned the subscription, try it first and only fall back to
    // a key. Otherwise (auto / apiKey) a key wins, then the subscription.
    if (credentialPreference === "subscription") {
      const codex = await codexToken();
      if (codex) return codex;
      if (key) return key;
    } else {
      if (key) return key;
      const codex = await codexToken();
      if (codex) return codex;
    }
    throw new Error(
      "No OpenAI credentials. Set an API key in the Handsfree settings, or sign in with `codex login` to use your ChatGPT subscription.",
    );
  }

  {
    const { openaiApiKey } = await settings.get();
    if (!openaiApiKey && !process.env.OPENAI_API_KEY && !(await codexToken())) {
      bb.status.needsConfiguration("Set openaiApiKey with `bb plugin config handsfree set openaiApiKey <key>`, or run `codex login`, then reload.");
    }
  }

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
  async function liveThreads() {
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

  function relativeTime(timestamp: number): string {
    const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
    if (seconds < 60) return "just now";
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.round(hours / 24)}d ago`;
  }

  /** The active prompt body: newest saved version, else the built-in default. */
  function activePrompt(): string {
    const row = db.prepare("SELECT content FROM prompt_versions ORDER BY id DESC LIMIT 1").get() as
      | { content: string }
      | undefined;
    return row?.content ?? DEFAULT_PROMPT;
  }

  function savePromptVersion(content: string, source: "user" | "agent", note: string | null) {
    db.prepare("INSERT INTO prompt_versions (ts, source, note, content) VALUES (?, ?, ?, ?)").run(
      Date.now(),
      source,
      note,
      content,
    );
    bb.realtime.publish("prompt-changed", {});
  }

  async function resolveEnvironmentId(threadId: string): Promise<string | null> {
    const thread = await bb.sdk.threads.get({ threadId });
    return (thread as { environmentId?: string | null }).environmentId ?? null;
  }

  function describeThread(thread: unknown): Record<string, unknown> {
    const t = thread as Record<string, unknown>;
    return {
      id: t.id,
      title: t.title,
      status: t.status,
      projectId: t.projectId,
      providerId: t.providerId ?? t.provider,
      environmentId: t.environmentId ?? null,
    };
  }

  /**
   * Attach `machine` (host name) to described threads by resolving each
   * thread's environment → hostId → host name. Best-effort: lookup failures
   * leave `machine: null` rather than failing the tool.
   */
  async function withMachines(
    threads: Record<string, unknown>[],
  ): Promise<Record<string, unknown>[]> {
    const environmentIds = [
      ...new Set(
        threads
          .map((t) => t.environmentId)
          .filter((id): id is string => typeof id === "string" && id.length > 0),
      ),
    ];
    const hostNames = new Map<string, string>();
    try {
      for (const host of await bb.sdk.hosts.list()) hostNames.set(host.id, host.name);
    } catch {
      /* machine stays null */
    }
    const envHost = new Map<string, string>();
    await Promise.all(
      environmentIds.map(async (environmentId) => {
        try {
          const environment = await bb.sdk.environments.get({ environmentId });
          const hostId = (environment as { hostId?: string }).hostId;
          if (hostId) envHost.set(environmentId, hostId);
        } catch {
          /* machine stays null */
        }
      }),
    );
    return threads.map(({ environmentId, ...rest }) => {
      const hostId = typeof environmentId === "string" ? envHost.get(environmentId) : undefined;
      return { ...rest, machine: hostId ? (hostNames.get(hostId) ?? hostId) : null };
    });
  }

  async function runTool(
    name: string,
    args: Record<string, unknown>,
    context: { threadId: string | null; projectId: string | null; onNewThreadScreen?: boolean },
  ): Promise<string> {
    const str = (key: string): string => {
      const value = args[key];
      if (typeof value !== "string" || !value) throw new Error(`Missing argument: ${key}`);
      return value;
    };
    switch (name) {
      case "get_context": {
        const result: Record<string, unknown> = { threadId: context.threadId, projectId: context.projectId };
        if (!context.threadId && context.onNewThreadScreen) {
          result.view = "new-thread";
          result.note =
            "The user is on the New thread screen: no thread exists yet — they are composing the prompt for one. The project shown is the one selected in the composer. Help via set_composer_text/append_composer_text or start_thread; do not look for a current thread.";
        }
        if (context.threadId) {
          const thread = await bb.sdk.threads.get({ threadId: context.threadId });
          result.thread = (await withMachines([describeThread(thread)]))[0];
          const { output } = await bb.sdk.threads.output({ threadId: context.threadId });
          if (output) result.lastAssistantOutput = truncate(output, 2000);
        }
        if (context.projectId) {
          const projects = await bb.sdk.projects.list({ includePersonal: true });
          const project = projects.find((p) => p.id === context.projectId);
          if (project) result.project = { id: project.id, name: project.name };
        }
        return JSON.stringify(result);
      }
      case "list_projects": {
        const projects = await bb.sdk.projects.list({ includePersonal: true });
        return JSON.stringify(projects.map((p) => ({ id: p.id, name: p.name })));
      }
      case "list_machines": {
        const hosts = await bb.sdk.hosts.list();
        const projectId =
          typeof args.project_id === "string" && args.project_id ? args.project_id : context.projectId;
        let sources: { hostId: string; isDefault: boolean }[] = [];
        if (projectId) {
          const projects = await bb.sdk.projects.list({ includePersonal: true });
          sources = projects.find((p) => p.id === projectId)?.sources ?? [];
        }
        return JSON.stringify(
          hosts.map((host) => ({
            id: host.id,
            name: host.name,
            status: host.status,
            ...(projectId
              ? {
                  hasProject: sources.some((s) => s.hostId === host.id),
                  projectDefault: sources.some((s) => s.hostId === host.id && s.isDefault),
                }
              : {}),
          })),
        );
      }
      case "list_live_threads": {
        const live = await withMachines(await liveThreads());
        return live.length === 0 ? "No live threads right now." : JSON.stringify(live);
      }
      case "list_threads": {
        const projectId = typeof args.project_id === "string" ? args.project_id : undefined;
        const limit = typeof args.limit === "number" ? Math.min(args.limit, 50) : 15;
        const threads = await bb.sdk.threads.list({ projectId, limit });
        return JSON.stringify(await withMachines(threads.map(describeThread)));
      }
      case "search_threads": {
        const result = await bb.sdk.threads.search({ query: str("query") });
        return truncate(JSON.stringify(result), 6000);
      }
      case "read_thread": {
        const threadId = str("thread_id");
        const thread = await bb.sdk.threads.get({ threadId });
        const { output } = await bb.sdk.threads.output({ threadId });
        const [described] = await withMachines([describeThread(thread)]);
        return JSON.stringify({ ...described, lastAssistantOutput: output ? truncate(output) : null });
      }
      case "set_desktop_behavior": {
        const patch: Partial<DesktopPreferences> = {};
        for (const [arg, key] of [["composer_destination", "desktopComposerDestination"], ["aide_destination", "desktopAideDestination"]] as const) {
          if (args[arg] !== undefined) {
            if (args[arg] !== "navigate" && args[arg] !== "panel") throw new Error("Invalid desktop destination.");
            patch[key] = args[arg] as "navigate" | "panel";
          }
        }
        if (args.tab_behavior !== undefined) {
          if (args.tab_behavior !== "reuse" && args.tab_behavior !== "new") throw new Error("Invalid desktop tab behavior.");
          patch.desktopTabBehavior = args.tab_behavior;
        }
        if (!Object.keys(patch).length) throw new Error("Specify a desktop preference to change.");
        await writeConfig(patch);
        bb.realtime.publish("config-changed", {});
        return "Saved desktop opening preferences. Mobile behavior is unchanged.";
      }
      case "set_view_behavior": {
        const behavior = str("behavior");
        if (behavior !== "reuse" && behavior !== "new") throw new Error("Invalid view behavior.");
        await writeConfig({ mobileViewBehavior: behavior });
        bb.realtime.publish("config-changed", {});
        return "Saved the mobile drawer preference. Desktop navigation is unchanged.";
      }
      case "focus_threads":
      case "manage_views":
        throw new Error("This tool requires an updated Handsfree frontend on the calling device.");
      case "focus_thread": {
        const { delivered } = await bb.sdk.threads.open({ threadId: str("thread_id"), file: null });
        if (delivered <= 0) throw new Error("No connected bb window received the action.");
        return "Focused.";
      }
      case "set_pane": {
        const action = str("action") as "spotlight" | "clear-spotlight" | "maximize" | "restore" | "toggle";
        const { delivered } = await bb.sdk.threads.paneAction({ threadId: str("thread_id"), action });
        if (delivered <= 0) throw new Error("No connected bb window received the action.");
        return `Pane ${action} applied.`;
      }
      case "send_to_thread": {
        await bb.sdk.threads.send({
          threadId: str("thread_id"),
          mode: "auto",
          input: [{ type: "text", text: str("message"), mentions: [] }],
        });
        return "Message sent.";
      }
      case "start_thread": {
        const projectId = typeof args.project_id === "string" && args.project_id ? args.project_id : context.projectId;
        if (!projectId) throw new Error("No project selected. Ask the user or call list_projects.");
        const prompt = typeof args.prompt === "string" && args.prompt.trim() ? args.prompt : undefined;
        // Promptless start_thread is handled in the frontend (opens the New
        // thread screen); reaching here without one means that path failed.
        if (!prompt) throw new Error("No prompt given. Ask the user what the new thread should work on.");
        const machineId =
          typeof args.machine_id === "string" && args.machine_id ? args.machine_id : null;
        const thread = await bb.sdk.threads.spawn({
          projectId,
          // A named machine gets a fresh managed worktree from the default
          // branch there; otherwise bb's project-default environment applies.
          environment: machineId
            ? {
                type: "host",
                hostId: machineId,
                workspace: { type: "managed-worktree", baseBranch: { kind: "default" } },
              }
            : { type: "project-default" },
          prompt,
          ...(typeof args.title === "string" && args.title ? { title: args.title } : {}),
        });
        // `threads.open` navigates every connected window — which backgrounds a
        // live mobile call (and yanks other windows). The client sets focus:false
        // when it must not navigate; the thread still spawns and runs.
        const shouldFocus = args.focus !== false;
        if (shouldFocus) {
          await bb.sdk.threads.open({ threadId: thread.id, file: null }).catch(() => undefined);
        }
        const started = (await withMachines([describeThread(thread)]))[0];
        return JSON.stringify(
          shouldFocus
            ? { started }
            : {
                started,
                focused: false,
                note: "Started and running, but not brought on screen. Call focus_thread with its ID if the user wants to see it beside the call.",
              },
        );
      }
      case "stop_thread": {
        await bb.sdk.threads.stop({ threadId: str("thread_id") });
        return "Thread stopped.";
      }
      case "archive_thread": {
        await bb.sdk.threads.archive({ threadId: str("thread_id") });
        return "Thread archived.";
      }
      case "rename_thread": {
        await bb.sdk.threads.update({ threadId: str("thread_id"), title: str("title") });
        return "Thread renamed.";
      }
      case "run_plugin_command": {
        const requested = str("plugin_id");
        const available = await exposedPluginCommands();
        const command = available.find((c) => c.id === requested || c.name === requested);
        if (!command) {
          throw new Error(`Plugin "${requested}" is not available. Available plugins: ${available.map((c) => c.id).join(", ") || "none"}.`);
        }
        const argv = Array.isArray(args.argv)
          ? (args.argv as unknown[]).filter((v): v is string => typeof v === "string")
          : [];
        const response = await fetch(
          `${bb.server.loopbackBaseUrl}/api/v1/plugins/${encodeURIComponent(command.id)}/cli`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              argv,
              ...(context.threadId ? { threadId: context.threadId } : {}),
              ...(context.projectId ? { projectId: context.projectId } : {}),
            }),
          },
        );
        const result = (await response.json().catch(() => null)) as {
          exitCode?: number;
          stdout?: string;
          stderr?: string;
          error?: string;
        } | null;
        if (!response.ok || result === null) {
          throw new Error(`Error running bb ${command.name}: HTTP ${response.status}${result?.error ? ` — ${result.error}` : ""}`);
        }
        const out = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
        if (result.exitCode !== 0) {
          throw new Error(truncate(`bb ${command.name} ${argv.join(" ")} failed (exit ${result.exitCode ?? "?"}):\n${out || "(no output)"}`));
        }
        return truncate(out || "(no output)");
      }
      case "update_instructions": {
        const content = str("instructions");
        if (content.length > 20000) throw new Error("Instructions too long (max 20000 characters).");
        savePromptVersion(content, "agent", str("reason"));
        return "Instructions updated. They apply from the next voice session.";
      }
      case "show_diff": {
        const threadId = str("thread_id");
        const environmentId = await resolveEnvironmentId(threadId);
        if (!environmentId) return "This thread has no environment, so there is no diff.";
        const environment = await bb.sdk.environments.get({ environmentId });
        const mergeBaseBranch = (environment as { mergeBaseBranch?: string | null }).mergeBaseBranch;
        const diff = await bb.sdk.environments.diffFiles(
          mergeBaseBranch
            ? { environmentId, target: "all", mergeBaseBranch }
            : { environmentId, target: "uncommitted" },
        );
        // Like start_thread, show_diff both computes something useful AND
        // navigates (threads.open). Skip the navigation when the client asks
        // (focus:false) so a live mobile call isn't backgrounded — the diff
        // summary is still returned either way.
        if (args.focus !== false) {
          await bb.sdk.threads.open({ threadId, file: null }).catch(() => undefined);
        }
        if (diff.outcome !== "available") return `Diff not available (${diff.outcome}).`;
        const files = diff.files.map((f) => ({ path: f.path, additions: f.additions, deletions: f.deletions }));
        return JSON.stringify({ shortstat: diff.shortstat, files: files.slice(0, 50) });
      }
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }

  bb.cli.register({
    name: "handsfree",
    summary: "Handsfree voice plugin: inspect live threads and voice sessions",
    commands: [
      { name: "live", summary: "List live threads: running now plus recently finished (last 30 min), like the sidebar. Add --json for machine output.", usage: "bb handsfree live [--json]" },
      { name: "read", summary: "Read a thread's status and latest assistant output.", usage: "bb handsfree read <thread-id>" },
      { name: "usage", summary: "Voice-session token usage and estimated cost, grouped per day. Add --json for machine output, --days N to limit the window.", usage: "bb handsfree usage [--days N] [--json]" },
      { name: "stop", summary: "Stop any active Aide voice session in any bb window.", usage: "bb handsfree stop" },
      { name: "mute", summary: "Mute the active voice session's microphone (call stays up).", usage: "bb handsfree mute" },
      { name: "unmute", summary: "Unmute the active voice session's microphone.", usage: "bb handsfree unmute" },
    ],
    async run(argv) {
      const [command, ...rest] = argv;
      const help = [
        "Handsfree \u2014 voice operator for bb",
        "",
        "Usage:",
        "  bb handsfree live [--json]            threads that are live right now",
        "  bb handsfree read <thread-id>         thread status + latest assistant output",
        "  bb handsfree usage [--days N] [--json] voice-session tokens and estimated cost",
        "  bb handsfree stop                     stop any active voice session",
        "  bb handsfree mute | unmute            mute/unmute the active session's mic",
      ].join("\n");
      try {
        if (command === undefined || command === "help" || command === "--help" || command === "-h") {
          return { exitCode: 0, stdout: help };
        }
        if (command === "mute" || command === "unmute") {
          bb.realtime.publish("voice-mute", { muted: command === "mute" });
          return { exitCode: 0, stdout: `${command === "mute" ? "Mute" : "Unmute"} signal broadcast.` };
        }
        if (command === "stop") {
          // Every mounted voice button listens on this channel and stops any
          // session whose nonce differs — an unknown nonce stops them all.
          bb.realtime.publish("voice-call", { nonce: `cli-stop-${Date.now()}` });
          return { exitCode: 0, stdout: "Stop signal broadcast to all bb windows." };
        }
        if (command === "live") {
          const live = await liveThreads();
          if (rest.includes("--json") || argv.includes("--json")) {
            return { exitCode: 0, stdout: JSON.stringify(live, null, 2) };
          }
          if (live.length === 0) return { exitCode: 0, stdout: "No live threads right now." };
          const lines = live.map(
            (t) => `${t.id}  [${t.status}]  ${t.title}  (${t.project} \u00b7 ${t.providerId} \u00b7 ${relativeTime(t.updatedAt)})`,
          );
          return { exitCode: 0, stdout: `${live.length} live thread(s):\n${lines.join("\n")}` };
        }
        if (command === "read") {
          const threadId = rest.find((arg) => !arg.startsWith("-"));
          if (!threadId) return { exitCode: 1, stderr: "Usage: bb handsfree read <thread-id>" };
          const thread = await bb.sdk.threads.get({ threadId });
          const { output } = await bb.sdk.threads.output({ threadId });
          const t = thread as { title?: string | null; status?: string };
          const header = `${threadId}  [${t.status ?? "?"}]  ${t.title ?? "(untitled)"}`;
          return { exitCode: 0, stdout: `${header}\n\n${output ? truncate(output, 20000) : "(no assistant output yet)"}` };
        }
        if (command === "usage") {
          const daysFlag = rest.indexOf("--days");
          const days = daysFlag >= 0 ? Number(rest[daysFlag + 1]) || 30 : 30;
          const since = Date.now() - days * 86_400_000;
          const rows = db
            .prepare("SELECT * FROM usage_events WHERE ts >= ? ORDER BY ts")
            .all(since) as UsageRow[];
          const byDay = new Map<string, { responses: number; audioIn: number; audioOut: number; textIn: number; textOut: number; cached: number; cost: number }>();
          for (const row of rows) {
            const day = new Date(row.ts).toISOString().slice(0, 10);
            const entry = byDay.get(day) ?? { responses: 0, audioIn: 0, audioOut: 0, textIn: 0, textOut: 0, cached: 0, cost: 0 };
            entry.responses += 1;
            entry.audioIn += row.input_audio;
            entry.audioOut += row.output_audio;
            entry.textIn += row.input_text;
            entry.textOut += row.output_text;
            entry.cached += row.cached_text + row.cached_audio;
            entry.cost += costUsd(row);
            byDay.set(day, entry);
          }
          const daysOut = [...byDay.entries()].map(([day, e]) => ({ day, ...e, cost: Number(e.cost.toFixed(4)) }));
          const total = Number(daysOut.reduce((sum, d) => sum + d.cost, 0).toFixed(4));
          if (rest.includes("--json")) {
            return { exitCode: 0, stdout: JSON.stringify({ days: daysOut, totalCostUsd: total, rates: RATES }, null, 2) };
          }
          if (daysOut.length === 0) return { exitCode: 0, stdout: `No voice usage recorded in the last ${days} day(s).` };
          const lines = daysOut.map(
            (d) => `${d.day}  $${d.cost.toFixed(4)}  (${d.responses} responses \u00b7 audio ${d.audioIn}/${d.audioOut} \u00b7 text ${d.textIn}/${d.textOut} \u00b7 cached ${d.cached})`,
          );
          return {
            exitCode: 0,
            stdout: `Voice usage, last ${days} day(s) \u2014 estimated at gpt-realtime rates:\n${lines.join("\n")}\nTotal: ~$${total.toFixed(4)}  (tokens in/out per line; authoritative numbers: platform.openai.com/usage)`,
          };
        }
        return { exitCode: 1, stderr: `Unknown command: ${command}\n\n${help}` };
      } catch (error) {
        return { exitCode: 1, stderr: error instanceof Error ? error.message : String(error) };
      }
    },
  });

  bb.rpc.register(rpcContract, {
    async resolveFilePreview({ threadId, path, asHostFile }) {
      const environmentId = await resolveEnvironmentId(threadId);
      if (!environmentId) throw new Error("This thread has no workspace to preview files from.");
      if (asHostFile) {
        const environment = await bb.sdk.environments.get({ environmentId });
        const root = environment.path;
        if (!root || (!posix.isAbsolute(root) && !win32.isAbsolute(root))) throw new Error("This workspace has no resolved absolute path for a native file preview.");
        return { kind: "host" as const, hostId: environment.hostId,
          path: posix.isAbsolute(root) ? posix.join(root, path) : win32.join(root, path) };
      }
      return { kind: "workspace" as const, environmentId, path };
    },
    async getThreadDiff({ threadId, path }) { return readThreadDiff(bb, threadId, path); },
    async createCall({ sdp, threadId, projectId, onNewThreadScreen, nonce, mobile = false, callOrigin = "global" }) {
      const key = await apiKey();
      const { model, voice } = await readConfig();
      const pluginCommands = await exposedPluginCommands();
      const pluginSection =
        pluginCommands.length === 0
          ? ""
          : `\n\nInstalled bb plugins contribute extra commands you can run with run_plugin_command:\n${pluginCommands.map((c) => `- ${c.id}: bb ${c.name} — ${c.summary}`).join("\n")}\nWhen unsure of a plugin's subcommands, run it with argv ["--help"] first. Summarize command output aloud in a sentence or two; never read raw JSON or long output verbatim.`;
      const session = {
        type: "realtime",
        model,
        instructions: `${activePrompt()}${pluginSection}\n\n${threadViewInstructions(mobile)}\n\nCall origin: ${callOrigin}.\n\nCurrent context: threadId=${threadId ?? "none"}, projectId=${projectId ?? "none"}${onNewThreadScreen ? " — the user is on the New thread screen (no thread exists yet; they're composing the prompt for one)" : ""}. Call get_context for fresh context — the user navigates while talking.`,
        audio: {
          input: {
            noise_reduction: { type: "near_field" },
            transcription: { model: "gpt-realtime-whisper" },
            // Default server VAD (threshold 0.5) fires on background noise and
            // makes Aide respond to phantom turns. Require a stronger signal and
            // a longer pause before treating audio as an utterance.
            turn_detection: {
              type: "server_vad",
              threshold: 0.75,
              prefix_padding_ms: 300,
              silence_duration_ms: 700,
            },
          },
          output: { voice },
        },
        tools: toolSchemas(pluginCommands, mobile),
      };
      const form = new FormData();
      form.set("sdp", sdp);
      form.set("session", JSON.stringify(session));
      const response = await fetch(REALTIME_ENDPOINT, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}` },
        body: form,
      });
      const text = await response.text();
      if (!response.ok) {
        bb.log.error(`OpenAI realtime call failed: ${response.status} ${text.slice(0, 500)}`);
        throw new Error(`OpenAI realtime call failed: ${response.status} ${response.statusText}`);
      }
      // One voice session at a time, everywhere: every connected client hears
      // this and stops any session whose nonce differs.
      bb.realtime.publish("voice-call", { nonce });
      return { sdp: text };
    },
    async getTools() {
      const local = new Set(["focus_thread", "focus_threads", "show_diff", "open_browser", "preview_file", "set_composer_text", "append_composer_text"]);
      const pluginCommands = await exposedPluginCommands();
      return {
        tools: toolSchemas(pluginCommands).map((tool) => ({
          name: tool.name,
          description: tool.description ?? "",
          parameters: "parameters" in tool && tool.parameters ? JSON.stringify(tool.parameters) : null,
          local: local.has(tool.name),
        })),
      };
    },
    async getPrompt() {
      const versions = db
        .prepare("SELECT id, ts, source, note, content FROM prompt_versions ORDER BY id DESC LIMIT 50")
        .all() as { id: number; ts: number; source: string; note: string | null; content: string }[];
      return { content: activePrompt(), defaultContent: DEFAULT_PROMPT, versions };
    },
    async setPrompt({ content, source, note }) {
      savePromptVersion(content, source, note);
      return { ok: true as const };
    },
    async getConfig() {
      return await readConfig();
    },
    async setConfig(patch) {
      const next = await writeConfig(patch);
      bb.log.info(`voice config updated: ${JSON.stringify(patch)}`);
      // Every open window refetches, so the settings sections and the nav-panel
      // quick-switch stay in sync across windows.
      bb.realtime.publish("config-changed", {});
      return next;
    },
    async clearApiKey() {
      // null (not "") actually removes the secret, so the settings field shows
      // "not set" again rather than an empty-but-present value.
      await bb.sdk.plugins.updateSettings({ pluginId: bb.pluginId, values: { openaiApiKey: null } });
      bb.log.info("OpenAI API key cleared");
      bb.realtime.publish("config-changed", {});
      return { ok: true as const };
    },
    async listPlugins() {
      try {
        const { plugins } = await bb.sdk.plugins.list();
        return {
          plugins: plugins
            .filter(
              (plugin) =>
                plugin.enabled &&
                plugin.status === "running" &&
                plugin.cliCommand !== null &&
                plugin.id !== bb.pluginId,
            )
            .map((plugin) => ({
              id: plugin.id,
              name: plugin.cliCommand?.name ?? plugin.id,
              summary: plugin.cliCommand?.summary ?? "",
              iconUrl: plugin.iconUrl ?? null,
            }))
            .sort((a, b) => a.name.localeCompare(b.name)),
        };
      } catch (error) {
        bb.log.warn(`could not list plugins: ${error instanceof Error ? error.message : String(error)}`);
        return { plugins: [] };
      }
    },
    async getCredentialStatus() {
      const { openaiApiKey } = await settings.get();
      const { credentialPreference: preference } = await readConfig();
      const hasApiKey = !!openaiApiKey;
      const envKeyPresent = !!process.env.OPENAI_API_KEY;
      const subscriptionAvailable = !!(await codexToken());
      const keySource = hasApiKey ? ("apiKey" as const) : envKeyPresent ? ("env" as const) : null;
      // Mirror apiKey() so the badge shows what a session will actually use.
      const effective =
        preference === "subscription"
          ? subscriptionAvailable
            ? ("subscription" as const)
            : (keySource ?? ("none" as const))
          : keySource ?? (subscriptionAvailable ? ("subscription" as const) : ("none" as const));
      return { effective, preference, hasApiKey, envKeyPresent, subscriptionAvailable };
    },
    async logEvent({ sessionId, kind, payload }) {
      const ts = Date.now();
      const result = db.prepare(
        "INSERT INTO session_events (session_id, ts, kind, payload) VALUES (?, ?, ?, ?)",
      ).run(sessionId, ts, kind, JSON.stringify(payload));
      // Both views describe this exact persisted event, including client/session
      // and tool call identity. Client-handled tools must be visible here too.
      const entry = sessionEventLog({ id: Number(result.lastInsertRowid), ts, sessionId, kind, payload });
      bb.log[entry.level](entry.message);
      bb.realtime.publish("aide-log", { sessionId });
      return { ok: true as const };
    },
    async publishPresence({ nonce, phase, startedAt, client, realm }) {
      bb.realtime.publish("voice-presence", { nonce, phase, startedAt, client, realm });
      return { ok: true as const };
    },
    async requestPresence() {
      bb.realtime.publish("voice-presence-query", {});
      return { ok: true as const };
    },
    async sendVoiceCommand({ nonce, action, client, realm }) {
      bb.realtime.publish("voice-command", { nonce, action, client, realm });
      return { ok: true as const };
    },
    async resolveThreadViews({ threadIds }) {
      const views: { kind: "thread"; id: string; threadId: string; projectId: string | null; title: string }[] = [];
      const ids = [...new Set(threadIds)];
      // Bound backend concurrency; resolve everything before changing the UI.
      for (let i = 0; i < ids.length; i += 8) {
        views.push(...await Promise.all(ids.slice(i, i + 8).map(async threadId => {
          const thread = await bb.sdk.threads.get({ threadId });
          return { kind: "thread" as const, id: `thread:${threadId}`, threadId,
            projectId: thread.projectId, title: thread.title || thread.titleFallback || threadId };
        })));
      }
      const config = await readConfig();
      return { views, preference: config.mobileViewBehavior, desktop: {
        desktopComposerDestination: config.desktopComposerDestination,
        desktopAideDestination: config.desktopAideDestination,
        desktopTabBehavior: config.desktopTabBehavior,
      } };
    },
    async forceStop({ nonce }) {
      // Durable end-marker so listSessions stops showing it live even if the
      // owner realm never logs its own session.stopped (count > 0 is enough).
      db.prepare(
        "INSERT INTO session_events (session_id, ts, kind, payload) VALUES (?, ?, ?, ?)",
      ).run(nonce, Date.now(), "session.stopped", JSON.stringify({ _forced: true }));
      bb.realtime.publish("voice-presence", { nonce, phase: "idle", startedAt: null });
      bb.realtime.publish("voice-command", { nonce, action: "stop" });
      bb.realtime.publish("aide-log", { sessionId: nonce });
      return { ok: true as const };
    },
    async listSessions(input) {
      // Page through grouped sessions newest-first. Fetch one extra row past the
      // page to tell the client whether a "Load more" is worthwhile, then drop it.
      const pageSize = 30;
      const offset = input?.offset ?? 0;
      const rows = db
        .prepare(
          `SELECT session_id AS id, MIN(ts) AS startedAt, MAX(ts) AS lastEventAt, COUNT(*) AS events,
                  SUM(CASE WHEN kind = 'session.stopped' THEN 1 ELSE 0 END) AS stopped
           FROM session_events GROUP BY session_id ORDER BY startedAt DESC LIMIT ? OFFSET ?`,
        )
        .all(pageSize + 1, offset) as { id: string; startedAt: number; lastEventAt: number; events: number; stopped: number }[];
      const hasMore = rows.length > pageSize;
      const page = hasMore ? rows.slice(0, pageSize) : rows;
      const costStmt = db.prepare("SELECT * FROM usage_events WHERE session_id = ?");
      // First thing the user said, as a scannable preview; fall back to Aide's
      // opening line so a row is never blank.
      const previewStmt = db.prepare(
        "SELECT payload FROM session_events WHERE session_id = ? AND kind IN ('user', 'assistant') ORDER BY (kind = 'assistant'), ts, id LIMIT 1",
      );
      const errorStmt = db.prepare(
        `SELECT 1 FROM session_events WHERE session_id = ? AND (
          kind = 'error' OR (kind = 'tool.result' AND (
            json_extract(payload, '$.status') = 'error' OR
            (json_extract(payload, '$.status') IS NULL AND (
              json_extract(payload, '$.output') LIKE 'Tool error%' OR
              json_extract(payload, '$.output') LIKE 'Error:%'
            ))
          ))
        ) LIMIT 1`,
      );
      const deviceStmt = db.prepare(
        "SELECT payload FROM session_events WHERE session_id = ? AND kind = 'session.started' ORDER BY ts LIMIT 1",
      );
      const device = (sessionId: string) => {
        const found = deviceStmt.get(sessionId) as { payload: string } | undefined;
        if (!found) return null;
        try {
          const d = (JSON.parse(found.payload) as { device?: unknown }).device;
          if (!d || typeof d !== "object") return null;
          const o = d as Record<string, unknown>;
          return {
            label: String(o.label ?? ""),
            mobile: Boolean(o.mobile),
            platform: String(o.platform ?? ""),
            browser: String(o.browser ?? ""),
            runtime: String(o.runtime ?? ""),
          };
        } catch {
          return null;
        }
      };
      const preview = (sessionId: string): string => {
        const found = previewStmt.get(sessionId) as { payload: string } | undefined;
        if (!found) return "";
        try {
          const text = (JSON.parse(found.payload) as { text?: unknown }).text;
          return typeof text === "string" ? text.slice(0, 140) : "";
        } catch {
          return "";
        }
      };
      return {
        hasMore,
        sessions: page.map((row) => ({
          id: row.id,
          startedAt: row.startedAt,
          lastEventAt: row.lastEventAt,
          events: row.events,
          // Ended if it logged session.stopped, OR it went quiet long ago: a
          // call that dies uncleanly (page unload, torn-down WebRTC on
          // navigation, app killed on mobile) never logs session.stopped, so
          // without this stale check every crashed session shows "live" forever.
          // The active window overrides this to keep a genuinely live call live.
          ended: row.stopped > 0 || Date.now() - row.lastEventAt > 300_000,
          costUsd: Number(
            (costStmt.all(row.id) as UsageRow[]).reduce((sum, usage) => sum + costUsd(usage), 0).toFixed(4),
          ),
          preview: preview(row.id),
          hasError: errorStmt.get(row.id) !== undefined,
          device: device(row.id),
        })),
      };
    },
    async getSessionEvents({ sessionId }) {
      const events = db
        .prepare("SELECT id, ts, kind, payload FROM session_events WHERE session_id = ? ORDER BY ts, id")
        .all(sessionId) as { id: number; ts: number; kind: string; payload: string }[];
      return { events };
    },
    async recordUsage({ model, sessionId, usage }) {
      const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);
      const inDetails = (usage.input_token_details ?? {}) as Record<string, unknown>;
      const outDetails = (usage.output_token_details ?? {}) as Record<string, unknown>;
      const cachedDetails = (inDetails.cached_tokens_details ?? {}) as Record<string, unknown>;
      const { model: configuredModel } = await readConfig();
      db.prepare(
        `INSERT INTO usage_events (ts, model, session_id, input_text, input_audio, cached_text, cached_audio, output_text, output_audio)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        Date.now(),
        model ?? configuredModel,
        sessionId,
        num(inDetails.text_tokens),
        num(inDetails.audio_tokens),
        num(cachedDetails.text_tokens),
        num(cachedDetails.audio_tokens),
        num(outDetails.text_tokens),
        num(outDetails.audio_tokens),
      );
      return { ok: true as const };
    },
    async runTool({ name, args, threadId, projectId, onNewThreadScreen }) {
      try {
        const output = await runTool(name, args, { threadId, projectId, onNewThreadScreen });
        return { output, status: "success" as const };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { output: `Tool error: ${message}`, status: "error" as const };
      }
    },
  });
}
