// bb-plugin-handsfree — Aide: a realtime voice operator for bb.
//
// The frontend (app.tsx) captures mic audio over WebRTC directly in the bb
// app; this backend holds the OpenAI API key, performs the SDP exchange with
// the OpenAI Realtime API, and executes the voice agent's tools against the
// bb SDK (threads, projects, diffs, panes).
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { MODEL_OPTIONS, VOICE_OPTIONS, isLiveModel } from "./shared/models";
import { sessionEventLog } from "./shared/session-events.ts";
import { isValidShortcut } from "./shared/shortcuts";
import {
  LOCAL_TOOL_NAMES,
  runTool,
  toolSchemas,
  threadViewInstructions,
  type ToolDeps,
} from "./server/tools.ts";
import { createConfigStore, exposedPluginCommands, LAST_REALTIME_AUTH_KEY } from "./server/config.ts";
import { createCredentials } from "./server/credentials.ts";
import { createCall, type CreateCallDeps } from "./server/realtime-call.ts";
import { registerHandsfreeCli } from "./server/cli.ts";
import { liveThreads } from "./server/live-threads.ts";
import { registerThreadNotifications } from "./server/notifications.ts";
import {
  MIGRATIONS,
  activePrompt as storedActivePrompt,
  insertPromptVersion,
  insertSessionEvent,
  listSessions,
  promptVersions,
  recordUsageEvent,
  sessionEvents,
} from "./server/store.ts";

// Re-exported so existing imports (tests, frontend) keep working; the
// registry in server/tools.ts is the source of truth.
export { toolSchemas, threadViewInstructions };

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
        /** Unique per call; broadcast so every other window ends its session. */
        nonce: z.string().min(1),
      })
      .strict(),
    output: z
      .object({
        sdp: z.string(),
        /** True for a GPT-Live session: different data-channel event protocol. */
        live: z.boolean(),
      })
      .strict(),
  },
  /** Record token usage (realtime response.done) or live duration snapshots. */
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
  /**
   * Store the OpenAI API key. Exists so flows that discover the requirement
   * mid-task (picking gpt-live-1, which rejects subscription auth) can capture
   * the key right there instead of bouncing through the host settings form.
   */
  setApiKey: {
    input: z.object({ key: z.string().trim().min(20).max(300) }).strict(),
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

const DEFAULT_PROMPT = `You are Aide, a concise voice operator for bb — the user's agentic IDE where coding agents run in threads inside projects.

The user talks to you to drive bb hands-free. You can list/search/read threads, focus them on screen, spotlight or maximize panes, send messages to agent threads, start new threads, stop or archive threads, summarize diffs, and edit the user's prompt composer.

Rules:
- Be extremely succinct. One short sentence by default ("Done.", "Focused.", "Sent."). Never narrate what you're about to do, never enumerate options, never restate the user's request. Add detail only when asked.
- Tool lookups are silent. Never say "let me check", "I'll look", or any other progress preamble before a tool call. Call the tool first, then speak only when you have its result. This is especially important for automatic thread updates and for read_thread or get_thread_error.
- Thread ids look like thr_x… and project ids like proj_x…. When the user names a thread by topic or title, find it with list_threads or search_threads first.
- Never invent prompts, titles, or messages on the user's behalf. If required information is missing, ask one short question.
- When reading agent output aloud, give a one-or-two-sentence summary; never read code or ids verbatim.
- Prefer focus_thread so the user sees what you are talking about.
- While a voice session is active, bb sends you updates when visible threads finish or fail (when Announcements is enabled). You can notify the user: if they ask to be told when a thread finishes, say yes, then announce the update in one short sentence when it arrives. Always name the thread by its title in that sentence; several threads may be running, so a bare "it finished" is ambiguous. Never claim that you cannot notify them, and do not poll the thread.
- When read_thread returns lastOutcome, report that outcome plainly instead of guessing why output is missing. When a thread has status error and read_thread still does not explain why, call get_thread_error with that thread id before answering. Never say no details are available without checking.
- Threads run on a machine. start_thread uses the project's default machine unless you pass machine_id — when the project is on several connected machines and the user didn't name one, use list_machines and ask one short question (e.g. "On your MacBook or the studio?") before starting. The personal project ("no project") needs no git checkout and no machine choice — but it CAN run on any connected machine: pass machine_id when the user names one, omit it for the default. Never claim a personal thread needs a project to run on a specific machine.
- Use list_providers when the user asks which agent harnesses or models are available. Pass provider_id when they want the models for one harness.
- Never invent or rearrange a model id. Pass the user's model wording to start_thread or set_thread_model, which searches the selected provider's catalog for one matching model. If the request is still ambiguous, use list_providers with provider_id before asking the user.
- A request to change an existing thread's model is configuration: use set_thread_model. Never send a model change to the thread as a message, because that starts an agent turn without changing the model.
- start_thread uses the project's provider and model defaults when provider_id and model are omitted. Set only the fields the user explicitly requested. For example, "use Pi with GPT-5.6 Sol" means provider_id "pi" and model "GPT-5.6 Sol"; do not change either setting on your own.
- When the user asks you to permanently behave differently ("always …", "from now on …"), use update_instructions to amend these standing instructions.`;

export default async function plugin(bb: BbPluginApi) {
  const db = bb.storage.database();
  bb.storage.migrate(db, MIGRATIONS);

  // The API key is the ONE declarative setting: secrets must live here to get
  // 0600-file storage that never touches the db or the frontend. Everything
  // else the user configures — model, voice, behavior — is kv-backed (see
  // server/config.ts) and rendered by our own polished settings sections, so
  // the host's auto-form stays a single clean field instead of a flat dump.
  const settings = bb.settings.define({
    openaiApiKey: {
      type: "string",
      label: "OpenAI API key (optional)",
      secret: true,
      description: "Leave blank to use your ChatGPT subscription instead (run `codex login`).",
    },
  });

  const { readConfig, writeConfig, migrateLegacy } = createConfigStore(bb);
  await migrateLegacy();
  const pluginCommands = () => exposedPluginCommands(bb, readConfig);

  registerThreadNotifications(bb, readConfig);

  const credentials = createCredentials({
    openaiApiKey: async () => (await settings.get()).openaiApiKey,
    credentialPreference: async () => (await readConfig()).credentialPreference,
    logError: (message) => bb.log.error(message),
  });

  {
    const { openaiApiKey } = await settings.get();
    if (!openaiApiKey && !process.env.OPENAI_API_KEY && !(await credentials.codexToken())) {
      bb.status.needsConfiguration("Set openaiApiKey with `bb plugin config handsfree set openaiApiKey <key>`, or run `codex login`, then reload.");
    }
  }

  /** The active prompt body: newest saved version, else the built-in default. */
  const activePrompt = () => storedActivePrompt(db, DEFAULT_PROMPT);

  function savePromptVersion(content: string, source: "user" | "agent", note: string | null) {
    insertPromptVersion(db, content, source, note);
    bb.realtime.publish("prompt-changed", {});
  }

  /** Wiring for the tool registry (see server/tools.ts). */
  const toolDeps: ToolDeps = {
    bb,
    liveThreads: () => liveThreads(bb),
    exposedPluginCommands: pluginCommands,
    async setMobileViewBehavior(behavior) {
      await writeConfig({ mobileViewBehavior: behavior });
      bb.realtime.publish("config-changed", {});
    },
    savePromptVersion,
  };

  registerHandsfreeCli(bb, db);

  /** Wiring for the SDP exchange (see server/realtime-call.ts). */
  const callDeps: CreateCallDeps = {
    readConfig,
    apiKey: credentials.apiKey,
    exposedPluginCommands: pluginCommands,
    activePrompt,
    log: bb.log,
    publish: (channel, payload) => bb.realtime.publish(channel, payload),
    rememberRealtimeAuth(mechanism) {
      void bb.storage.kv.set(LAST_REALTIME_AUTH_KEY, mechanism).catch(() => undefined);
    },
  };

  bb.rpc.register(rpcContract, {
    async createCall(input) {
      return await createCall(callDeps, input);
    },
    async getTools() {
      const commands = await pluginCommands();
      return {
        tools: toolSchemas(commands).map((tool) => ({
          name: tool.name,
          description: tool.description ?? "",
          parameters: "parameters" in tool && tool.parameters ? JSON.stringify(tool.parameters) : null,
          local: LOCAL_TOOL_NAMES.has(tool.name),
        })),
      };
    },
    async getPrompt() {
      return { content: activePrompt(), defaultContent: DEFAULT_PROMPT, versions: promptVersions(db) };
    },
    async setPrompt({ content, source, note }) {
      savePromptVersion(content, source, note);
      return { ok: true as const };
    },
    async getConfig() {
      return await readConfig();
    },
    async setConfig(patch) {
      if (patch.credentialPreference !== undefined) {
        // An explicit auth choice always wins and becomes the remembered
        // realtime default (auto clears the memory — follow precedence again).
        await bb.storage.kv.set(
          LAST_REALTIME_AUTH_KEY,
          patch.credentialPreference === "auto" ? null : patch.credentialPreference,
        );
      } else if (patch.model && !isLiveModel(patch.model)) {
        // Moving back from gpt-live-1 (which forces the API key) to a realtime
        // model: restore the auth mechanism realtime last used, unless this
        // very patch changes it explicitly (handled above).
        const current = await readConfig();
        if (isLiveModel(current.model)) {
          const remembered = await bb.storage.kv.get<string>(LAST_REALTIME_AUTH_KEY);
          if (remembered === "apiKey" || remembered === "subscription") {
            patch = { ...patch, credentialPreference: remembered };
          }
        }
      }
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
    async setApiKey({ key }) {
      await bb.sdk.plugins.updateSettings({ pluginId: bb.pluginId, values: { openaiApiKey: key.trim() } });
      bb.log.info("OpenAI API key saved");
      // Same signal the credential card already follows, so its status (and
      // any open model picker) flips to "Using your OpenAI API key" at once.
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
      const subscriptionAvailable = !!(await credentials.codexToken());
      const keySource = hasApiKey ? ("apiKey" as const) : envKeyPresent ? ("env" as const) : null;
      // Mirror apiKey() so the badge shows what a session will actually use —
      // including that a live model always takes the key, whatever the
      // preference says.
      const { model } = await readConfig();
      const effective = isLiveModel(model)
        ? (keySource ?? ("none" as const))
        : preference === "subscription"
          ? subscriptionAvailable
            ? ("subscription" as const)
            : (keySource ?? ("none" as const))
          : keySource ?? (subscriptionAvailable ? ("subscription" as const) : ("none" as const));
      return { effective, preference, hasApiKey, envKeyPresent, subscriptionAvailable };
    },
    async logEvent({ sessionId, kind, payload }) {
      const ts = Date.now();
      const id = insertSessionEvent(db, sessionId, kind, payload, ts);
      // Both views describe this exact persisted event, including client/session
      // and tool call identity. Client-handled tools must be visible here too.
      const entry = sessionEventLog({ id, ts, sessionId, kind, payload });
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
      return { views, preference: (await readConfig()).mobileViewBehavior };
    },
    async forceStop({ nonce }) {
      // Durable end-marker so listSessions stops showing it live even if the
      // owner realm never logs its own session.stopped (count > 0 is enough).
      insertSessionEvent(db, nonce, "session.stopped", { _forced: true });
      bb.realtime.publish("voice-presence", { nonce, phase: "idle", startedAt: null });
      bb.realtime.publish("voice-command", { nonce, action: "stop" });
      bb.realtime.publish("aide-log", { sessionId: nonce });
      return { ok: true as const };
    },
    async listSessions(input) {
      return listSessions(db, input?.offset ?? 0);
    },
    async getSessionEvents({ sessionId }) {
      return { events: sessionEvents(db, sessionId) };
    },
    async recordUsage({ model, sessionId, usage }) {
      const { model: configuredModel } = await readConfig();
      recordUsageEvent(db, { model, sessionId, usage }, configuredModel);
      return { ok: true as const };
    },
    async runTool({ name, args, threadId, projectId, onNewThreadScreen }) {
      try {
        const output = await runTool(toolDeps, name, args, { threadId, projectId, onNewThreadScreen });
        return { output, status: "success" as const };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { output: `Tool error: ${message}`, status: "error" as const };
      }
    },
  });
}
