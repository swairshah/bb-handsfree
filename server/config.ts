// kv-backed voice-session config (model / voice / behavior), the one-time
// migration from legacy declarative settings, and the plugin-command
// exposure it curates. The OpenAI API key is NOT here — secrets stay in
// bb.settings (0600-file storage, never in the db or frontend).
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  DEFAULT_MODEL,
  DEFAULT_VOICE,
  isModel,
  isVoice,
  type RealtimeModel,
  type Voice,
} from "../shared/models";
import { DEFAULT_SHORTCUTS, normalizeShortcuts, type Shortcuts } from "../shared/shortcuts";
import type { PluginCommandInfo } from "./tools.ts";

// "auto" keeps the historical precedence (key → env → subscription); the
// user can pin it to one credential when more than one is available.
export type CredentialPreference = "auto" | "apiKey" | "subscription";
const CREDENTIAL_PREFERENCES: readonly CredentialPreference[] = ["auto", "apiKey", "subscription"];
const isCredentialPreference = (value: unknown): value is CredentialPreference =>
  typeof value === "string" && (CREDENTIAL_PREFERENCES as readonly string[]).includes(value);

export interface VoiceConfig {
  model: RealtimeModel;
  voice: Voice;
  notifications: boolean;
  mobileViewBehavior: "reuse" | "new";
  pluginCommands: string;
  credentialPreference: CredentialPreference;
  shortcuts: Shortcuts;
}

/**
 * Which auth mechanism the realtime family last used, so moving to gpt-live-1
 * (key-forced) and back restores this default (see createCall / setConfig).
 */
export const LAST_REALTIME_AUTH_KEY = "lastRealtimeAuth";

const CONFIG_KEY = "config";
const CONFIG_DEFAULTS: VoiceConfig = {
  model: DEFAULT_MODEL,
  voice: DEFAULT_VOICE,
  notifications: true,
  mobileViewBehavior: "reuse",
  pluginCommands: "all",
  credentialPreference: "auto",
  shortcuts: { ...DEFAULT_SHORTCUTS },
};

export interface ConfigStore {
  readConfig(): Promise<VoiceConfig>;
  writeConfig(patch: Partial<VoiceConfig>): Promise<VoiceConfig>;
  /**
   * One-time migration: earlier versions stored model/voice/notifications/
   * pluginCommands as declarative settings. Carry any customized values into
   * kv so removing those descriptors doesn't silently reset them.
   */
  migrateLegacy(): Promise<void>;
}

export function createConfigStore(bb: BbPluginApi): ConfigStore {
  async function readConfig(): Promise<VoiceConfig> {
    const stored = (await bb.storage.kv.get<Partial<VoiceConfig> & { viewBehavior?: string }>(CONFIG_KEY)) ?? {};
    return {
      model: isModel(stored.model) ? stored.model : CONFIG_DEFAULTS.model,
      voice: isVoice(stored.voice) ? stored.voice : CONFIG_DEFAULTS.voice,
      notifications:
        typeof stored.notifications === "boolean" ? stored.notifications : CONFIG_DEFAULTS.notifications,
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
  async function migrateLegacy(): Promise<void> {
    if (await bb.storage.kv.get<boolean>("config.migrated")) return;
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
  return { readConfig, writeConfig, migrateLegacy };
}

/**
 * Other installed plugins contribute `bb` CLI commands. The voice agent
 * learns about them via its session prompt and runs them through the
 * run_plugin_command tool; the pluginCommands setting curates which
 * plugins are exposed (all / none / allowlist of plugin ids).
 */
export async function exposedPluginCommands(
  bb: BbPluginApi,
  readConfig: ConfigStore["readConfig"],
): Promise<PluginCommandInfo[]> {
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
