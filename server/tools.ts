// The voice agent's tool registry: every tool's model-facing schema and its
// backend handler live together in one ToolDef, in the exact order the model
// sees them. `toolSchemas` and `runTool` are both derived from this registry,
// so adding a tool means adding one entry here (frontend-local tools declare
// `local: true` and have no `run`).
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  THREAD_ERROR_EVENT_TYPES,
  THREAD_OUTCOME_EVENT_TYPES,
  latestThreadError,
  latestThreadOutcome,
} from "../shared/thread-errors";

export function truncate(text: string, max = 4000): string {
  return text.length > max ? `${text.slice(0, max)}\n…[truncated]` : text;
}

/** Refuse accidental agent messages that are plainly thread configuration. */
function isThreadConfigurationMessage(message: string): boolean {
  return /\b(?:for (?:future|next) (?:runs?|turns?)|keep the (?:provider|harness)|(?:switch|change|set) the (?:provider|harness|model|reasoning(?: level)?)(?:\s+to)?\b)/i.test(message);
}

/** One installed plugin's contributed `bb` command, as exposed to the voice agent. */
export interface PluginCommandInfo {
  id: string;
  name: string;
  summary: string;
}

/** The bb context the frontend stamps on each tool call. */
export interface ToolContext {
  threadId: string | null;
  projectId: string | null;
  onNewThreadScreen?: boolean;
}

/**
 * What tool handlers may touch outside the bb SDK. The plugin body wires these
 * from its config/prompt/thread helpers, so handlers stay free of closures.
 */
export interface ToolDeps {
  bb: BbPluginApi;
  /** Threads that are live right now or finished recently, newest first. */
  liveThreads(): Promise<Record<string, unknown>[]>;
  /** Plugins whose `bb` commands the voice agent may run (curated by config). */
  exposedPluginCommands(): Promise<PluginCommandInfo[]>;
  /** Persist the mobile drawer preference and broadcast config-changed. */
  setMobileViewBehavior(behavior: "reuse" | "new"): Promise<void>;
  /** Save a new standing-instructions version (becomes active next session). */
  savePromptVersion(content: string, source: "user" | "agent", note: string | null): void;
}

/** One function entry as advertised to the model. */
export interface ToolSchema {
  type: "function";
  name: string;
  description: string;
  parameters?: Record<string, unknown>;
}

/** What shapes a session's tool list: which plugins are exposed, which device. */
interface SessionShape {
  pluginCommands: PluginCommandInfo[];
  mobile: boolean;
}

export interface ToolDef {
  name: string;
  /** The schema for this session shape, or null when the tool is not exposed. */
  schema(session: SessionShape): ToolSchema | null;
  /** True when the bb app frontend handles the call locally (never reaches runTool). */
  local?: boolean;
  /** Backend handler; absent for frontend-local tools. */
  run?(deps: ToolDeps, args: Record<string, unknown>, context: ToolContext): Promise<string>;
}

function str(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || !value) throw new Error(`Missing argument: ${key}`);
  return value;
}

// ---- provider / model name resolution ----
// The voice model passes provider and model names as the user spoke them;
// these helpers resolve that wording against the machine's actual catalog.

const normalizedExecutionName = (value: string) => value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
const shortExecutionName = (value: string) => value.trim().toLowerCase().split("/").at(-1) ?? "";
const executionNameTokens = (value: string) => value.toLowerCase().match(/[a-z]+|\d+/g) ?? [];

function editDistance(left: string, right: string): number {
  const row = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    let diagonal = row[0];
    row[0] = leftIndex;
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const above = row[rightIndex];
      row[rightIndex] = Math.min(
        row[rightIndex] + 1,
        row[rightIndex - 1] + 1,
        diagonal + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      );
      diagonal = above;
    }
  }
  return row[right.length];
}

/** Score a spoken/model-generated alias against one catalog name. */
function modelNameScore(requested: string, candidate: string): number {
  const requestedTokens = executionNameTokens(requested);
  const candidateTokens = executionNameTokens(candidate);
  if (!requestedTokens.length || !candidateTokens.length) return Number.NEGATIVE_INFINITY;
  if (
    requestedTokens.length === candidateTokens.length &&
    [...requestedTokens].sort().every((token, index) => token === [...candidateTokens].sort()[index])
  ) return 1000;

  const remaining = [...candidateTokens];
  let score = 0;
  let missing = 0;
  for (const token of requestedTokens) {
    const exact = remaining.indexOf(token);
    if (exact >= 0) {
      remaining.splice(exact, 1);
      score += 10;
      continue;
    }
    if (/^[a-z]{4,}$/.test(token)) {
      let fuzzyIndex = -1;
      let closest = 3;
      for (let index = 0; index < remaining.length; index += 1) {
        if (!/^[a-z]{4,}$/.test(remaining[index])) continue;
        const distance = editDistance(token, remaining[index]);
        if (distance < closest) {
          closest = distance;
          fuzzyIndex = index;
        }
      }
      if (fuzzyIndex >= 0 && closest <= 2) {
        remaining.splice(fuzzyIndex, 1);
        score += 8 - closest;
        continue;
      }
    }
    missing += 1;
  }
  return score - missing * 12 - remaining.length * 2;
}

function requestedModelMatches<T extends { id: string; model: string; displayName: string }>(
  models: T[],
  requestedModel: string,
): T[] {
  const lower = requestedModel.trim().toLowerCase();
  const normalized = normalizedExecutionName(requestedModel);
  const exact = models.filter((candidate) => {
    const names = [candidate.id, candidate.model, candidate.displayName];
    return names.some((name) => name.toLowerCase() === lower) ||
      names.some((name) => shortExecutionName(name) === lower) ||
      names.some((name) => normalizedExecutionName(name) === normalized) ||
      names.some((name) => normalizedExecutionName(shortExecutionName(name)) === normalized);
  });
  if (exact.length > 0) return exact;

  const ranked = models
    .map((candidate) => ({
      candidate,
      score: Math.max(
        modelNameScore(requestedModel, candidate.id),
        modelNameScore(requestedModel, candidate.model),
        modelNameScore(requestedModel, candidate.displayName),
      ),
    }))
    .sort((left, right) => right.score - left.score);
  const best = ranked[0]?.score ?? Number.NEGATIVE_INFINITY;
  if (best < 10) return [];
  return ranked.filter((entry) => entry.score === best).map((entry) => entry.candidate);
}

function requestedProviderMatch<T extends { id: string; displayName: string; available: boolean }>(
  providers: T[],
  requestedProvider: string,
): T {
  const lower = requestedProvider.trim().toLowerCase();
  const normalized = normalizedExecutionName(requestedProvider);
  const matches = providers.filter(
    (provider) =>
      provider.id.toLowerCase() === lower ||
      provider.displayName.toLowerCase() === lower ||
      normalizedExecutionName(provider.id) === normalized ||
      normalizedExecutionName(provider.displayName) === normalized,
  );
  if (matches.length !== 1) {
    const available = providers.filter((provider) => provider.available).map((provider) => provider.id).slice(0, 12);
    throw new Error(
      matches.length > 1
        ? `Provider "${requestedProvider}" is ambiguous. Use one of: ${matches.map((provider) => provider.id).join(", ")}.`
        : `Provider "${requestedProvider}" is not available. Available providers: ${available.join(", ") || "none"}.`,
    );
  }
  if (!matches[0].available) throw new Error(`Provider "${matches[0].id}" is not available on the selected machine.`);
  return matches[0];
}

type ProviderRouting =
  | { environmentId: string; hostId?: never }
  | { environmentId?: never; hostId: string }
  | { environmentId?: never; hostId?: never };

async function projectProviderRouting(
  bb: BbPluginApi,
  projectId: string | null,
  machineId: string | null,
): Promise<ProviderRouting> {
  if (machineId) return { hostId: machineId };
  if (!projectId) return {};
  const projects = await bb.sdk.projects.list({ includePersonal: true });
  const project = projects.find((candidate) => candidate.id === projectId);
  const hostId = project?.sources.find((source) => source.isDefault)?.hostId ?? project?.sources[0]?.hostId;
  return hostId ? { hostId } : {};
}

async function resolveRequestedModel(
  bb: BbPluginApi,
  providerId: string,
  routing: ProviderRouting,
  requestedModel: string,
): Promise<string> {
  const options = await bb.sdk.providers.models({ ...routing, providerId });
  if (options.modelLoadError) {
    throw new Error(`Could not load models for provider "${providerId}" (${options.modelLoadError.code}).`);
  }
  const allModels = [...options.models, ...options.selectedOnlyModels];
  const uniqueModels = [...new Map(allModels.map((candidate) => [candidate.id, candidate])).values()];
  const matches = requestedModelMatches(uniqueModels, requestedModel);
  if (matches.length !== 1) {
    const available = uniqueModels.slice(0, 12).map((candidate) => candidate.id);
    throw new Error(
      matches.length > 1
        ? `Model "${requestedModel}" is ambiguous for provider "${providerId}". Use one of: ${matches.map((candidate) => candidate.id).join(", ")}.`
        : `Model "${requestedModel}" is not available for provider "${providerId}". Available models: ${available.join(", ") || "none"}.`,
    );
  }
  return matches[0].model;
}

/**
 * Resolve user-spoken provider and model names against the target machine.
 * We keep the fields absent when the user did not request them, which lets bb
 * apply the project's remembered defaults without the plugin overriding them.
 */
async function resolveRequestedExecution(
  bb: BbPluginApi,
  projectId: string,
  machineId: string | null,
  requestedProvider: string | null,
  requestedModel: string | null,
): Promise<{ providerId?: string; model?: string; executionInputSources?: { providerId?: "explicit"; model?: "explicit" } }> {
  if (!requestedProvider && !requestedModel) return {};

  const routing = await projectProviderRouting(bb, projectId, machineId);
  const providers = await bb.sdk.providers.list(routing);

  let providerForCatalog: string;
  let explicitProviderId: string | undefined;
  if (requestedProvider) {
    const provider = requestedProviderMatch(providers, requestedProvider);
    providerForCatalog = provider.id;
    explicitProviderId = provider.id;
  } else {
    const defaults = await bb.sdk.projects.defaultExecutionOptions({ projectId });
    providerForCatalog = defaults?.providerId ?? "codex";
  }

  const model = requestedModel
    ? await resolveRequestedModel(bb, providerForCatalog, routing, requestedModel)
    : undefined;

  return {
    ...(explicitProviderId ? { providerId: explicitProviderId } : {}),
    ...(model ? { model } : {}),
    executionInputSources: {
      ...(explicitProviderId ? { providerId: "explicit" as const } : {}),
      ...(model ? { model: "explicit" as const } : {}),
    },
  };
}

async function resolveEnvironmentId(bb: BbPluginApi, threadId: string): Promise<string | null> {
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
  bb: BbPluginApi,
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

// ---- the registry ----
// Order matters: this is the order the model sees the tools in.

const TOOLS: ToolDef[] = [
  {
    name: "run_plugin_command",
    schema: ({ pluginCommands }) =>
      pluginCommands.length === 0
        ? null
        : {
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
    async run(deps, args, context) {
      const requested = str(args, "plugin_id");
      const available = await deps.exposedPluginCommands();
      const command = available.find((c) => c.id === requested || c.name === requested);
      if (!command) {
        throw new Error(`Plugin "${requested}" is not available. Available plugins: ${available.map((c) => c.id).join(", ") || "none"}.`);
      }
      const argv = Array.isArray(args.argv)
        ? (args.argv as unknown[]).filter((v): v is string => typeof v === "string")
        : [];
      const response = await fetch(
        `${deps.bb.server.loopbackBaseUrl}/api/v1/plugins/${encodeURIComponent(command.id)}/cli`,
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
    },
  },
  {
    name: "get_context",
    schema: () => ({ type: "function", name: "get_context", description: "Get the user's current bb context: the thread and project currently in view, including the thread's status and latest assistant output." }),
    async run(deps, _args, context) {
      const bb = deps.bb;
      const result: Record<string, unknown> = { threadId: context.threadId, projectId: context.projectId };
      if (!context.threadId && context.onNewThreadScreen) {
        result.view = "new-thread";
        result.note =
          "The user is on the New thread screen: no thread exists yet — they are composing the prompt for one. The project shown is the one selected in the composer. Help via set_composer_text/append_composer_text or start_thread; do not look for a current thread.";
      }
      if (context.threadId) {
        const thread = await bb.sdk.threads.get({ threadId: context.threadId });
        result.thread = (await withMachines(bb, [describeThread(thread)]))[0];
        const { output } = await bb.sdk.threads.output({ threadId: context.threadId });
        if (output) result.lastAssistantOutput = truncate(output, 2000);
      }
      if (context.projectId) {
        const projects = await bb.sdk.projects.list({ includePersonal: true });
        const project = projects.find((p) => p.id === context.projectId);
        if (project) result.project = { id: project.id, name: project.name };
      }
      return JSON.stringify(result);
    },
  },
  {
    name: "list_projects",
    schema: () => ({ type: "function", name: "list_projects", description: "List bb projects with their ids and names." }),
    async run(deps) {
      const projects = await deps.bb.sdk.projects.list({ includePersonal: true });
      return JSON.stringify(projects.map((p) => ({ id: p.id, name: p.name, kind: p.kind })));
    },
  },
  {
    name: "list_machines",
    schema: () => ({ type: "function", name: "list_machines", description: "List the machines (hosts) bb can run threads on: id, name, connection status — and, for a project, which machines hold it and which is its default. Use before start_thread when the machine matters.", parameters: { type: "object", properties: { project_id: { type: "string", description: "Marks which machines hold this project and which is its default. Defaults to the user's current project." } } } }),
    async run(deps, args, context) {
      const bb = deps.bb;
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
    },
  },
  {
    name: "list_providers",
    schema: () => ({ type: "function", name: "list_providers", description: "List the available bb agent harnesses/providers for the current thread environment or target project machine. Pass provider_id to list that provider's exact model ids. Use this when the user asks what harnesses or models are available.", parameters: { type: "object", properties: { project_id: { type: "string", description: "Project whose default machine should be checked. Defaults to the user's current project." }, machine_id: { type: "string", description: "Machine id to check instead of the current environment or project default." }, provider_id: { type: "string", description: "Provider id or name whose models should be listed, such as pi, codex, or claude-code." } } } }),
    async run(deps, args, context) {
      const bb = deps.bb;
      const projectId =
        typeof args.project_id === "string" && args.project_id ? args.project_id : context.projectId;
      const machineId =
        typeof args.machine_id === "string" && args.machine_id ? args.machine_id : null;
      let routing: ProviderRouting;
      // With no explicit target, the current thread environment is more exact
      // than the project's default host, especially for workspace-scoped Pi models.
      if (!machineId && !args.project_id && context.threadId) {
        const environmentId = await resolveEnvironmentId(bb, context.threadId);
        routing = environmentId
          ? { environmentId }
          : await projectProviderRouting(bb, projectId, null);
      } else {
        routing = await projectProviderRouting(bb, projectId, machineId);
      }
      const providers = await bb.sdk.providers.list(routing);
      const requestedProvider =
        typeof args.provider_id === "string" && args.provider_id.trim() ? args.provider_id.trim() : null;
      if (!requestedProvider) {
        return JSON.stringify({
          providers: providers
            .filter((provider) => provider.available)
            .map((provider) => ({
              id: provider.id,
              name: provider.displayName,
              modelCatalogScope: provider.capabilities.modelCatalogScope,
            })),
        });
      }
      const provider = requestedProviderMatch(providers, requestedProvider);
      const options = await bb.sdk.providers.models({ ...routing, providerId: provider.id });
      if (options.modelLoadError) {
        throw new Error(`Could not load models for provider "${provider.id}" (${options.modelLoadError.code}).`);
      }
      const allModels = [...options.models, ...options.selectedOnlyModels];
      const models = [...new Map(allModels.map((candidate) => [candidate.id, candidate])).values()];
      return JSON.stringify({
        provider: { id: provider.id, name: provider.displayName },
        models: models.slice(0, 100).map((candidate) => ({
          id: candidate.id,
          name: candidate.displayName,
          isDefault: candidate.isDefault,
          defaultReasoningLevel: candidate.defaultReasoningEffort,
        })),
        totalModels: models.length,
        truncated: models.length > 100,
      });
    },
  },
  {
    name: "list_live_threads",
    schema: () => ({ type: "function", name: "list_live_threads", description: "List the threads in the Live threads sidebar section: running right now (active/starting/provisioning/waiting), plus threads that finished within the last 30 minutes (status 'recently-finished'). Only threads without a 'recently-finished' status are still working." }),
    async run(deps) {
      const live = await withMachines(deps.bb, await deps.liveThreads());
      return live.length === 0 ? "No live threads right now." : JSON.stringify(live);
    },
  },
  {
    name: "list_threads",
    schema: () => ({ type: "function", name: "list_threads", description: "List recent bb threads (id, title, status). Optionally filter by project id.", parameters: { type: "object", properties: { project_id: { type: "string" }, limit: { type: "number", description: "Max threads to return (default 15)." } } } }),
    async run(deps, args) {
      const projectId = typeof args.project_id === "string" ? args.project_id : undefined;
      const limit = typeof args.limit === "number" ? Math.min(args.limit, 50) : 15;
      const threads = await deps.bb.sdk.threads.list({ projectId, limit });
      return JSON.stringify(await withMachines(deps.bb, threads.map(describeThread)));
    },
  },
  {
    name: "search_threads",
    schema: () => ({ type: "function", name: "search_threads", description: "Full-text search bb threads by title/content. Returns matching thread ids and titles.", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } }),
    async run(deps, args) {
      const result = await deps.bb.sdk.threads.search({ query: str(args, "query") });
      return truncate(JSON.stringify(result), 6000);
    },
  },
  {
    name: "read_thread",
    schema: () => ({ type: "function", name: "read_thread", description: "Read a thread's details and latest assistant output. When no output exists, also returns the latest terminal outcome, including failure or interruption reasons. Call silently: do not speak before this tool; speak only after its result.", parameters: { type: "object", properties: { thread_id: { type: "string" } }, required: ["thread_id"] } }),
    async run(deps, args) {
      const bb = deps.bb;
      const threadId = str(args, "thread_id");
      const thread = await bb.sdk.threads.get({ threadId });
      const { output } = await bb.sdk.threads.output({ threadId });
      const [described] = await withMachines(bb, [describeThread(thread)]);
      const lastOutcome = output
        ? null
        : latestThreadOutcome(
            await bb.sdk.threads.events.list({
              threadId,
              order: "desc",
              limit: "100",
              types: THREAD_OUTCOME_EVENT_TYPES,
            }),
          );
      return JSON.stringify({
        ...described,
        lastAssistantOutput: output ? truncate(output) : null,
        lastOutcome,
      });
    },
  },
  {
    name: "get_thread_error",
    schema: () => ({ type: "function", name: "get_thread_error", description: "Get the latest recorded error for a thread. Call this before explaining a thread whose status is error, especially when read_thread has no assistant output. Call silently: do not speak before this tool; speak only after its result.", parameters: { type: "object", properties: { thread_id: { type: "string" } }, required: ["thread_id"] } }),
    async run(deps, args) {
      const threadId = str(args, "thread_id");
      const events = await deps.bb.sdk.threads.events.list({
        threadId,
        order: "desc",
        limit: "100",
        types: THREAD_ERROR_EVENT_TYPES,
      });
      return JSON.stringify({ threadId, error: latestThreadError(events) });
    },
  },
  {
    name: "focus_thread",
    schema: ({ mobile }) => ({ type: "function", name: "focus_thread", description: mobile ? "Show a thread in the mobile drawer without leaving the call. Reopening a thread selects its existing view. disposition: auto uses the mobile preference, reuse replaces the active view, new keeps existing views." : "Open/focus a thread in the user's bb app window, navigating to that thread.", parameters: { type: "object", properties: { thread_id: { type: "string" }, ...(mobile ? { disposition: { type: "string", enum: ["auto", "reuse", "new"] } } : {}) }, required: ["thread_id"] } }),
    async run(deps, args) {
      const { delivered } = await deps.bb.sdk.threads.open({ threadId: str(args, "thread_id"), file: null });
      if (delivered <= 0) throw new Error("No connected bb window received the action.");
      return "Focused.";
    },
  },
  {
    name: "focus_threads",
    schema: ({ mobile }) => mobile ? { type: "function", name: "focus_threads", description: "Show several threads in the mobile drawer switcher, preserving existing views. To show all running threads, first call list_live_threads and exclude recently-finished entries; pass their IDs here. Up to 100 per batch; split larger lists into batches.", parameters: { type: "object", properties: { thread_ids: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 100 } }, required: ["thread_ids"] } } : null,
    async run() {
      throw new Error("This tool requires an updated Handsfree frontend on the calling device.");
    },
  },
  {
    name: "manage_views",
    schema: ({ mobile }) => mobile ? { type: "function", name: "manage_views", description: "List, select, or close the views in the mobile drawer. Get view IDs using list. clear closes all views only when the user asks. Closing a view does not stop its thread or the call.", parameters: { type: "object", properties: { action: { type: "string", enum: ["list", "select", "close", "clear"] }, view_id: { type: "string" } }, required: ["action"] } } : null,
    async run() {
      throw new Error("This tool requires an updated Handsfree frontend on the calling device.");
    },
  },
  {
    name: "set_view_behavior",
    schema: ({ mobile }) => mobile ? { type: "function", name: "set_view_behavior", description: "Save how future mobile drawer opens behave. Use only when the user asks for a lasting mobile preference: reuse replaces the active view; new keeps views in the switcher. Desktop always navigates normally. Explicit mobile requests and batches override this preference.", parameters: { type: "object", properties: { behavior: { type: "string", enum: ["reuse", "new"] } }, required: ["behavior"] } } : null,
    async run(deps, args) {
      const behavior = str(args, "behavior");
      if (behavior !== "reuse" && behavior !== "new") throw new Error("Invalid view behavior.");
      await deps.setMobileViewBehavior(behavior);
      return "Saved the mobile drawer preference. Desktop navigation is unchanged.";
    },
  },
  {
    name: "set_pane",
    schema: () => ({ type: "function", name: "set_pane", description: "Change a thread pane's presentation in the bb app: spotlight, clear-spotlight, maximize, restore, or toggle.", parameters: { type: "object", properties: { thread_id: { type: "string" }, action: { type: "string", enum: ["spotlight", "clear-spotlight", "maximize", "restore", "toggle"] } }, required: ["thread_id", "action"] } }),
    async run(deps, args) {
      const action = str(args, "action") as "spotlight" | "clear-spotlight" | "maximize" | "restore" | "toggle";
      const { delivered } = await deps.bb.sdk.threads.paneAction({ threadId: str(args, "thread_id"), action });
      if (delivered <= 0) throw new Error("No connected bb window received the action.");
      return `Pane ${action} applied.`;
    },
  },
  {
    name: "send_to_thread",
    schema: () => ({ type: "function", name: "send_to_thread", description: "Send a work instruction or follow-up message to a thread's agent. Starts a turn if idle, queues/steers if running. Never use this for provider, model, reasoning, or other thread configuration changes; use the matching configuration tool instead.", parameters: { type: "object", properties: { thread_id: { type: "string" }, message: { type: "string" } }, required: ["thread_id", "message"] } }),
    async run(deps, args) {
      const message = str(args, "message");
      if (isThreadConfigurationMessage(message)) {
        throw new Error("Thread configuration was not sent as a message. Use set_thread_model for model changes.");
      }
      await deps.bb.sdk.threads.send({
        threadId: str(args, "thread_id"),
        mode: "auto",
        input: [{ type: "text", text: message, mentions: [] }],
      });
      return "Message sent.";
    },
  },
  {
    name: "set_thread_model",
    schema: () => ({ type: "function", name: "set_thread_model", description: "Change an existing thread's sticky model for its next and later turns without sending the agent a message or starting a turn. The thread keeps its current harness/provider. The backend searches that provider's model catalog for the user's wording.", parameters: { type: "object", properties: { thread_id: { type: "string" }, model: { type: "string", description: "The user's requested model wording or exact model id." } }, required: ["thread_id", "model"] } }),
    async run(deps, args) {
      const bb = deps.bb;
      const threadId = str(args, "thread_id");
      const requestedModel = str(args, "model");
      const thread = await bb.sdk.threads.get({ threadId });
      if (!thread.providerId) throw new Error("This thread has no provider to select a model for.");
      const routing: ProviderRouting = thread.environmentId
        ? { environmentId: thread.environmentId }
        : await projectProviderRouting(bb, thread.projectId, null);
      const model = await resolveRequestedModel(bb, thread.providerId, routing, requestedModel);
      await bb.sdk.threads.update({ threadId, model });
      return JSON.stringify({
        threadId,
        providerId: thread.providerId,
        model,
        applies: "next turn",
        messageSent: false,
      });
    },
  },
  {
    name: "start_thread",
    schema: () => ({ type: "function", name: "start_thread", description: "Start a new agent thread. Only pass prompt when the user dictated actual work; With no prompt, this opens bb's New thread screen for the user to type their own. Omit provider_id and model to use the project's defaults. Set them only when the user explicitly requests a harness/provider or model. Runs on the project's default machine unless machine_id is given — if the project lives on several connected machines and the user didn't say which, check list_machines and ask one short question instead of guessing. Threads can also run outside any project: pass the personal project's id from list_projects (or omit project_id when there is no current project) and the thread lands in the Personal section, no machine choice needed.", parameters: { type: "object", properties: { project_id: { type: "string", description: "Project id; defaults to the user's current project, or to the personal project when there is none." }, prompt: { type: "string", description: "The user's own instruction for the agent, verbatim. Omit if they didn't give one." }, title: { type: "string" }, machine_id: { type: "string", description: "Machine (host) id from list_machines, or the machine's name as the user said it. Omit to use the project's default machine." }, provider_id: { type: "string", description: "Requested bb agent harness/provider id, such as pi, codex, or claude-code. Set only when the user explicitly asks; otherwise omit for project defaults." }, model: { type: "string", description: "The user's requested model wording. The backend searches the selected provider's catalog, so pass the name as heard instead of inventing or rearranging an exact id. Exact ids and unambiguous short names also work. Set only when the user explicitly asks; otherwise omit for project defaults." } } } }),
    async run(deps, args, context) {
      const bb = deps.bb;
      const prompt = typeof args.prompt === "string" && args.prompt.trim() ? args.prompt : undefined;
      // Promptless start_thread is handled in the frontend (opens the New
      // thread screen); reaching here without one means that path failed.
      if (!prompt) throw new Error("No prompt given. Ask the user what the new thread should work on.");
      const machineId =
        typeof args.machine_id === "string" && args.machine_id ? args.machine_id : null;
      const requestedProjectId =
        typeof args.project_id === "string" && args.project_id ? args.project_id : context.projectId;
      const projects = await bb.sdk.projects.list({ includePersonal: true });
      // No project anywhere means bb's "Don't work in a project": the thread
      // goes to the implicit personal project and shows under Personal.
      const project = requestedProjectId
        ? projects.find((p) => p.id === requestedProjectId)
        : projects.find((p) => p.kind === "personal");
      if (!project) {
        throw new Error(
          requestedProjectId
            ? `Unknown project: ${requestedProjectId}. Call list_projects.`
            : "No project selected and no personal project exists. Ask the user or call list_projects.",
        );
      }
      // The voice model sometimes passes the machine's spoken name instead
      // of a host id from list_machines; resolve either, and fail with the
      // connected machine names rather than bb's bare HTTP 404.
      let hostId: string | null = null;
      let hostName: string | null = null;
      if (machineId) {
        const hosts = await bb.sdk.hosts.list();
        const wanted = machineId.toLowerCase();
        const host =
          hosts.find((h) => h.id === machineId) ??
          hosts.find((h) => h.name.toLowerCase() === wanted) ??
          hosts.find((h) => h.name.toLowerCase().includes(wanted));
        if (!host) {
          throw new Error(
            `No machine matches "${machineId}". Connected machines: ${hosts.map((h) => h.name).join(", ") || "none"}. Use list_machines for ids.`,
          );
        }
        hostId = host.id;
        hostName = host.name;
      }
      const requestedProvider =
        typeof args.provider_id === "string" && args.provider_id.trim() ? args.provider_id.trim() : null;
      const requestedModel =
        typeof args.model === "string" && args.model.trim() ? args.model.trim() : null;
      const execution = await resolveRequestedExecution(
        bb,
        project.id,
        hostId,
        requestedProvider,
        requestedModel,
      );
      type SpawnEnvironment = Parameters<typeof bb.sdk.threads.spawn>[0]["environment"];
      const spawn = (environment: SpawnEnvironment) =>
        bb.sdk.threads.spawn({
          projectId: project.id,
          environment,
          prompt,
          ...execution,
          ...(typeof args.title === "string" && args.title ? { title: args.title } : {}),
        });
      let thread: Awaited<ReturnType<typeof spawn>>;
      if (project.kind === "personal") {
        // Personal threads must use a personal workspace (no git checkout);
        // managed worktrees are rejected with HTTP 400. They can still run
        // on any connected machine via hostId.
        thread = await spawn({
          type: "host",
          ...(hostId ? { hostId } : {}),
          workspace: { type: "personal" },
        });
      } else if (hostId) {
        // A named machine gets a fresh managed worktree from the default
        // branch there. Projects that aren't git repos can't have worktrees,
        // so fall back to working directly in the project's source directory
        // on that host.
        try {
          thread = await spawn({
            type: "host",
            hostId,
            workspace: { type: "managed-worktree", baseBranch: { kind: "default" } },
          });
        } catch (error) {
          const source = project.sources.find((s) => s.hostId === hostId);
          if (!source) throw error;
          thread = await spawn({
            type: "host",
            hostId,
            workspace: { type: "unmanaged", path: source.path },
          });
        }
      } else {
        // bb's project-default environment applies.
        thread = await spawn({ type: "project-default" });
      }
      // `threads.open` navigates every connected window — which backgrounds a
      // live mobile call (and yanks other windows). The client sets focus:false
      // when it must not navigate; the thread still spawns and runs.
      const shouldFocus = args.focus !== false;
      if (shouldFocus) {
        await bb.sdk.threads.open({ threadId: thread.id, file: null }).catch(() => undefined);
      }
      const started = (await withMachines(bb, [describeThread(thread)]))[0];
      // Right after spawn the thread's environment may not be resolvable yet,
      // so withMachines reports machine: null; use the host we spawned on.
      if (hostName && !started.machine) started.machine = hostName;
      return JSON.stringify(
        shouldFocus
          ? { started }
          : {
              started,
              focused: false,
              note: "Started and running, but not brought on screen. Call focus_thread with its ID if the user wants to see it beside the call.",
            },
      );
    },
  },
  {
    name: "stop_thread",
    schema: () => ({ type: "function", name: "stop_thread", description: "Stop a running thread.", parameters: { type: "object", properties: { thread_id: { type: "string" } }, required: ["thread_id"] } }),
    async run(deps, args) {
      await deps.bb.sdk.threads.stop({ threadId: str(args, "thread_id") });
      return "Thread stopped.";
    },
  },
  {
    name: "archive_thread",
    schema: () => ({ type: "function", name: "archive_thread", description: "Archive a thread (and its children).", parameters: { type: "object", properties: { thread_id: { type: "string" } }, required: ["thread_id"] } }),
    async run(deps, args) {
      await deps.bb.sdk.threads.archive({ threadId: str(args, "thread_id") });
      return "Thread archived.";
    },
  },
  {
    name: "rename_thread",
    schema: () => ({ type: "function", name: "rename_thread", description: "Rename a thread.", parameters: { type: "object", properties: { thread_id: { type: "string" }, title: { type: "string" } }, required: ["thread_id", "title"] } }),
    async run(deps, args) {
      await deps.bb.sdk.threads.update({ threadId: str(args, "thread_id"), title: str(args, "title") });
      return "Thread renamed.";
    },
  },
  {
    name: "show_diff",
    schema: () => ({ type: "function", name: "show_diff", description: "Summarize a thread's workspace diff (changed files, additions/deletions) and focus the thread so the user can see it.", parameters: { type: "object", properties: { thread_id: { type: "string" } }, required: ["thread_id"] } }),
    async run(deps, args) {
      const bb = deps.bb;
      const threadId = str(args, "thread_id");
      const environmentId = await resolveEnvironmentId(bb, threadId);
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
    },
  },
  {
    name: "update_instructions",
    schema: () => ({ type: "function", name: "update_instructions", description: "Amend your own standing instructions (the system prompt for future voice sessions). Pass the COMPLETE new instructions text, not a diff. Use only when the user asks for a lasting behavior change.", parameters: { type: "object", properties: { instructions: { type: "string", description: "The full replacement instructions." }, reason: { type: "string", description: "One short sentence: why, quoting the user's request." } }, required: ["instructions", "reason"] } }),
    async run(deps, args) {
      const content = str(args, "instructions");
      if (content.length > 20000) throw new Error("Instructions too long (max 20000 characters).");
      deps.savePromptVersion(content, "agent", str(args, "reason"));
      return "Instructions updated. They apply from the next voice session.";
    },
  },
  // Handled locally in the bb app frontend, never reaches runTool:
  {
    name: "set_composer_text",
    local: true,
    schema: () => ({ type: "function", name: "set_composer_text", description: "Replace the text in the user's message composer (the box they type prompts into).", parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }),
  },
  {
    name: "append_composer_text",
    local: true,
    schema: () => ({ type: "function", name: "append_composer_text", description: "Append text to the user's message composer.", parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }),
  },
];

/** Names of tools the bb app frontend handles locally (for getTools). */
export const LOCAL_TOOL_NAMES: ReadonlySet<string> = new Set(
  TOOLS.filter((tool) => tool.local).map((tool) => tool.name),
);

/** The tool list advertised to the model, in registry order. */
export function toolSchemas(pluginCommands: PluginCommandInfo[] = [], mobile = false): ToolSchema[] {
  return TOOLS
    .map((tool) => tool.schema({ pluginCommands, mobile }))
    .filter((schema): schema is ToolSchema => schema !== null);
}

export function threadViewInstructions(mobile: boolean) {
  return mobile
    ? "Mobile thread views: focus_thread shows a thread in the drawer without navigating away from the call. disposition new preserves other views and reuse replaces the selected view. focus_threads opens a batch into the drawer switcher, not separate native bb tabs. For all running threads, use list_live_threads and exclude recently-finished entries. Use manage_views to list, select, or close mobile views. Use set_view_behavior only for an explicitly requested lasting mobile preference. Call get_context for the thread currently shown. If the drawer is unavailable, report the limitation; do not navigate away from the mobile call."
    : "Desktop navigation: focus_thread opens and navigates to the requested thread, as usual, regardless of where the call started. There is no desktop companion-view mode in this version. Call get_context after navigation for the current thread. Mobile drawer preferences do not apply to desktop.";
}

/** Run one backend tool. Frontend-local and unknown names both reject. */
export async function runTool(
  deps: ToolDeps,
  name: string,
  args: Record<string, unknown>,
  context: ToolContext,
): Promise<string> {
  const tool = TOOLS.find((candidate) => candidate.name === name);
  if (!tool?.run) throw new Error(`Unknown tool: ${name}`);
  return tool.run(deps, args, context);
}
