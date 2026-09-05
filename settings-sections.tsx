// bb-plugin-handsfree — polished settings sections.
//
// The host renders a single declarative field (the secret OpenAI API key) and
// then these custom sections below it. Everything the user tunes day-to-day —
// which model and voice to use, whether Aide announces thread events, the
// microphone, and the keyboard shortcuts — lives here as curated sections
// instead of a flat auto-form.
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "./server";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
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
import { voiceAgent } from "./voice-agent";
import { deviceDisplayLabel } from "./audio-devices";
import {
  DEFAULT_SHORTCUTS,
  SHORTCUT_ACTIONS,
  SHORTCUT_ACTION_LABELS,
  comboFromEvent,
  formatShortcut,
  isModifierKey,
  sameShortcut,
  shortcutLabel,
  shortcutLabelParts,
  shortcutProblem,
  type ShortcutAction,
  type Shortcuts,
} from "./shortcuts";
import { MAC, shortcutStore } from "./shortcut-store";
import { cn } from "@/lib/utils";

type CredentialPreference = "auto" | "apiKey" | "subscription";

interface VoiceConfig extends DesktopPreferences {
  model: RealtimeModel;
  voice: Voice;
  notifications: boolean;
  mobileViewBehavior: "reuse" | "new";
  pluginCommands: string;
  credentialPreference: CredentialPreference;
  shortcuts: Shortcuts;
}

/**
 * Shared kv-backed config, fetched over rpc and kept live across windows via
 * the `config-changed` signal. `update` is optimistic and reconciles with the
 * authoritative value the backend returns.
 */
function useVoiceConfig() {
  const rpc = useRpc<typeof rpcContract>();
  const [config, setConfig] = useState<VoiceConfig | null>(null);

  // Whatever the backend says is also pushed into the shortcut mirror, so the
  // content-script listener and tooltips follow an edit made on this page.
  const adopt = useCallback((next: VoiceConfig) => {
    setConfig(next);
    shortcutStore.set(next.shortcuts);
  }, []);
  const refetch = useCallback(() => {
    rpc.call("getConfig", null).then(adopt, () => undefined);
  }, [rpc, adopt]);
  useEffect(refetch, [refetch]);
  useRealtime("config-changed", refetch);

  const update = useCallback(
    async (patch: Partial<VoiceConfig>) => {
      setConfig((prev) => (prev ? { ...prev, ...patch } : prev));
      try {
        adopt(await rpc.call("setConfig", patch));
        return true;
      } catch (cause) {
        refetch();
        toast.error(`Could not save: ${cause instanceof Error ? cause.message : String(cause)}`);
        return false;
      }
    },
    [rpc, refetch, adopt],
  );

  return { config, update };
}

function voiceLabel(voice: Voice): string {
  return voice.charAt(0).toUpperCase() + voice.slice(1);
}

const selectClass =
  "block w-56 max-w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground disabled:opacity-60";

function SettingRow({ id, label, hint, children }: {
  id: string; label: string; hint?: string; children: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
      <div className="min-w-0 flex-1 basis-40">
        <label htmlFor={id} className="block text-sm font-medium text-foreground">{label}</label>
        {hint ? <p className="mt-1 text-xs text-muted-foreground">{hint}</p> : null}
      </div>
      <div className="ml-auto flex max-w-full items-center gap-2">{children}</div>
    </div>
  );
}

const settingsCardClass = "rounded-lg border border-border bg-muted/20 p-4";

/**
 * A labelled sub-group: a title-case heading (matching the host's section
 * headings, never all-caps) and an optional one-line explanation, then the
 * control. Used across every section so the page reads consistently.
 */
function Group({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="space-y-2 border-t border-border/50 pt-4 first:border-t-0 first:pt-0">
      <div>
        <span className="block text-sm font-medium text-foreground">{label}</span>
        {hint ? <span className="mt-0.5 block text-xs text-muted-foreground">{hint}</span> : null}
      </div>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Models: credential status + realtime model + voice.
// ---------------------------------------------------------------------------

interface CredentialStatus {
  effective: "apiKey" | "env" | "subscription" | "none";
  preference: CredentialPreference;
  hasApiKey: boolean;
  envKeyPresent: boolean;
  subscriptionAvailable: boolean;
}

/**
 * Shows which credential Aide is using, and — only when both an API key and a
 * ChatGPT subscription are available — lets the user pick between them.
 */
function CredentialCard() {
  const rpc = useRpc<typeof rpcContract>();
  const [status, setStatus] = useState<CredentialStatus | null>(null);

  const refetch = useCallback(() => {
    rpc.call("getCredentialStatus", null).then(setStatus, () => undefined);
  }, [rpc]);
  useEffect(refetch, [refetch]);
  useRealtime("config-changed", refetch);
  // Adding the key above is a host settings save with no plugin signal we can
  // hook, so poll while this page is open. That's why entering a key here
  // surfaces the credential picker on its own within a couple of seconds.
  useEffect(() => {
    const id = setInterval(refetch, 2500);
    return () => clearInterval(id);
  }, [refetch]);

  const statusText = (() => {
    switch (status?.effective) {
      case "apiKey":
      case "env":
        return "Using your OpenAI API key";
      case "subscription":
        return "Using your ChatGPT subscription";
      default:
        return "No credentials yet";
    }
  })();

  const canChoose = !!status && status.hasApiKey && status.subscriptionAvailable;
  const chooserValue: "apiKey" | "subscription" =
    status?.preference === "subscription" ? "subscription" : "apiKey";

  async function choose(preference: "apiKey" | "subscription") {
    setStatus((prev) => (prev ? { ...prev, preference } : prev));
    try {
      await rpc.call("setConfig", { credentialPreference: preference });
    } catch {
      refetch();
    }
  }

  async function removeKey() {
    try {
      await rpc.call("clearApiKey", null);
      refetch();
      toast.success("API key removed");
    } catch (cause) {
      toast.error(`Could not remove key: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }

  // Both credentials present: pick which one Aide uses. The dropdown speaks for
  // itself, so no hint.
  if (canChoose) {
    return (
      <div className="space-y-1.5">
        <SettingRow id="handsfree-credential" label="Credential">
          <select id="handsfree-credential"
            value={chooserValue}
            onChange={(event) => void choose(event.target.value as "apiKey" | "subscription")}
            className={selectClass}
          >
            <option value="subscription">ChatGPT subscription</option>
            <option value="apiKey">OpenAI API key</option>
          </select>
        </SettingRow>
        <div>
          <Button type="button" variant="outline" size="sm" onClick={() => void removeKey()}>
            Remove API key
          </Button>
        </div>
      </div>
    );
  }

  // A single credential (or none): a status line plus an italic helper — the
  // auth method, or the next step when nothing is set.
  const helper =
    status?.effective === "subscription"
      ? "Signed in with codex login."
      : status?.effective === "none"
        ? "Add an API key above, or run codex login to use your ChatGPT subscription."
        : null;
  return (
    <div className="space-y-1 rounded-md border border-border bg-muted/30 px-3 py-2">
      <div className="flex items-center justify-between gap-3">
        <span className="flex items-center gap-2">
          <span
            className={cn(
              "size-2 shrink-0 rounded-full",
              status && status.effective !== "none" ? "bg-primary" : "bg-destructive/80",
            )}
          />
          <span className="text-sm text-foreground">{status ? statusText : "Checking…"}</span>
        </span>
        {status?.hasApiKey ? (
          <Button type="button" variant="outline" size="sm" onClick={() => void removeKey()}>
            Remove API key
          </Button>
        ) : null}
      </div>
      {helper ? <p className="text-xs italic text-muted-foreground">{helper}</p> : null}
    </div>
  );
}

export function ModelsSettings() {
  const { config, update } = useVoiceConfig();
  const model = config?.model ?? DEFAULT_MODEL;
  const voice = config?.voice ?? DEFAULT_VOICE;
  const loading = config === null;

  return (
    <div className={cn(settingsCardClass, "space-y-4")}>
      <CredentialCard />
      <SettingRow id="handsfree-model" label="Model">
        <select id="handsfree-model"
          value={model}
          disabled={loading}
          onChange={(event) => {
            const next = event.target.value;
            if (isModel(next)) void update({ model: next });
          }}
          className={selectClass}
        >
          {MODEL_OPTIONS.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </SettingRow>
      <SettingRow id="handsfree-voice" label="Voice">
        <select id="handsfree-voice"
          value={voice}
          disabled={loading}
          onChange={(event) => {
            const next = event.target.value;
            if (isVoice(next)) void update({ voice: next });
          }}
          className={selectClass}
        >
          {VOICE_OPTIONS.map((option) => (
            <option key={option} value={option}>
              {voiceLabel(option)}
            </option>
          ))}
        </select>
      </SettingRow>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Behavior: instructions, announcements, and plugin access.
// ---------------------------------------------------------------------------

export function BehaviorSettings() {
  const { config, update } = useVoiceConfig();
  const loading = config === null;
  const notifications = config?.notifications ?? true;
  const pluginCommands = (config?.pluginCommands ?? "all").trim();

  const exposure: "all" | "none" | "custom" =
    pluginCommands.toLowerCase() === "all" || pluginCommands === ""
      ? "all"
      : pluginCommands.toLowerCase() === "none"
        ? "none"
        : "custom";
  // "custom" with an empty selection reads back as "none", so a local flag
  // keeps the picker open while the user has chosen nothing yet.
  const [customMode, setCustomMode] = useState(false);
  const showCustom = customMode || exposure === "custom";

  return (
    <div className={cn(settingsCardClass, "space-y-5")}>
      <PromptEditor />

      <Group label="Announcements">
        <label className="flex items-center justify-between gap-3">
          <span className="text-sm text-foreground">When a thread finishes or fails</span>
          <input
            type="checkbox"
            checked={notifications}
            disabled={loading}
            onChange={(event) => void update({ notifications: event.target.checked })}
            className="size-4 shrink-0 accent-primary"
          />
        </label>
      </Group>

      <Group label="Plugins">
        <SettingRow id="handsfree-plugins" label="Available plugins" hint="Aide’s built-in tools are always available.">
          <select id="handsfree-plugins"
            value={showCustom ? "custom" : exposure}
            disabled={loading}
            onChange={(event) => {
              const next = event.target.value;
              if (next === "all") {
                setCustomMode(false);
                void update({ pluginCommands: "all" });
              } else if (next === "none") {
                setCustomMode(false);
                void update({ pluginCommands: "none" });
              } else {
                // Entering custom: start from a clean slate unless a real list
                // was already saved, then let the picker turn plugins on.
                setCustomMode(true);
                if (exposure !== "custom") void update({ pluginCommands: "none" });
              }
            }}
            className={selectClass}
          >
            <option value="all">All plugins</option>
            <option value="none">None</option>
            <option value="custom">Selected plugins…</option>
          </select>
        </SettingRow>
        {showCustom ? (
          <PluginPicker
            value={pluginCommands}
            disabled={loading}
            onChange={(csv) => void update({ pluginCommands: csv || "none" })}
          />
        ) : null}
        <BuiltInToolsLink />
      </Group>
    </div>
  );
}

export function DefaultBehaviorSettings() {
  const { config, update } = useVoiceConfig();
  const loading = config === null;

  return (
    <div className={cn(settingsCardClass, "space-y-5")}>
      <p className="text-xs text-muted-foreground">Choose where Handsfree shows threads during a call.</p>
      <Group label="Desktop">
        <div className="space-y-3">
          <SettingRow id="handsfree-desktopComposerDestination" label="Calls from a thread’s composer"
            hint="Switch the main view, or show the thread alongside it.">
            <select id="handsfree-desktopComposerDestination" className={selectClass} disabled={loading}
              value={config?.desktopComposerDestination ?? DESKTOP_DEFAULTS.desktopComposerDestination}
              onChange={event => void update({ desktopComposerDestination: event.target.value as "navigate" | "panel" })}>
              <option value="navigate">Main view</option>
              <option value="panel">Side panel</option>
            </select>
          </SettingRow>
          <SettingRow id="handsfree-desktop-tabs" label="Threads beside the composer"
            hint="Keep separate tabs, or replace the thread in one shared tab.">
            <select id="handsfree-desktop-tabs" className={selectClass} disabled={loading} value={config?.desktopTabBehavior ?? "new"}
              onChange={event => void update({ desktopTabBehavior: event.target.value as "reuse" | "new" })}>
              <option value="new">Separate tabs</option>
              <option value="reuse">One shared tab</option>
            </select>
          </SettingRow>
        </div>
        <div className="border-t border-border/50 pt-3">
          <SettingRow id="handsfree-desktopAideDestination" label="Calls from the plugin page"
            hint="The side panel keeps the plugin page open, with one shared thread view.">
            <select id="handsfree-desktopAideDestination" className={selectClass} disabled={loading}
              value={config?.desktopAideDestination ?? DESKTOP_DEFAULTS.desktopAideDestination}
              onChange={event => void update({ desktopAideDestination: event.target.value as "navigate" | "panel" })}>
              <option value="navigate">Main view</option>
              <option value="panel">Side panel</option>
            </select>
          </SettingRow>
        </div>
      </Group>
      <Group label="Mobile" hint="From the plugin page, threads open in a bottom drawer without leaving the call. You can keep multiple views and switch between them; only one is visible at a time.">
        <SettingRow id="handsfree-view-behavior" label="When opening another thread">
          <select id="handsfree-view-behavior" className={selectClass} disabled={loading} value={config?.mobileViewBehavior ?? "reuse"}
            onChange={event => void update({ mobileViewBehavior: event.target.value as VoiceConfig["mobileViewBehavior"] })}>
            <option value="reuse">Replace current view</option>
            <option value="new">Keep existing views</option>
          </select>
        </SettingRow>
      </Group>
      <p className="text-xs italic text-muted-foreground">Explicit voice requests can use a different supported view for one action, such as “open in the side panel” on desktop. Your saved defaults stay the same.</p>
    </div>
  );
}

const linkClass =
  "text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline";

/** A small link that opens a read-only list of Aide's built-in tools. */
function BuiltInToolsLink() {
  const rpc = useRpc<typeof rpcContract>();
  const [open, setOpen] = useState(false);
  const [tools, setTools] = useState<{ name: string; description: string }[] | null>(null);

  useEffect(() => {
    if (!open || tools) return;
    rpc.call("getTools", null).then(
      (result) => setTools(result.tools.filter((tool) => tool.name !== "run_plugin_command")),
      () => setTools([]),
    );
  }, [open, tools, rpc]);

  return (
    <>
      <button type="button" className={linkClass} onClick={() => setOpen(true)}>
        View built-in tools
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Built-in tools</DialogTitle>
          </DialogHeader>
          <p className="text-xs text-muted-foreground">
            These are always available — Aide uses them to navigate bb, start and steer threads, read
            output, and show diffs by voice.
          </p>
          <div className="max-h-80 divide-y divide-border/50 overflow-auto rounded-md border border-border/70">
            {tools === null ? (
              <p className="px-3 py-3 text-sm text-muted-foreground">Loading…</p>
            ) : (
              tools.map((tool) => (
                <div key={tool.name} className="px-3 py-2">
                  <code className="text-xs font-medium text-foreground">{tool.name}</code>
                  <p className="mt-0.5 text-xs text-muted-foreground">{tool.description}</p>
                </div>
              ))
            )}
          </div>
          <DialogFooter>
            <Button type="button" onClick={() => setOpen(false)}>
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

interface PluginInfo {
  id: string;
  name: string;
  summary: string;
  iconUrl: string | null;
}

/** A modal checklist of installed plugins; the selection is stored as a csv. */
function PluginPicker({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (csv: string) => void;
  disabled?: boolean;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [open, setOpen] = useState(false);
  const [plugins, setPlugins] = useState<PluginInfo[] | null>(null);

  useEffect(() => {
    if (!open || plugins) return;
    rpc.call("listPlugins", null).then((result) => setPlugins(result.plugins), () => setPlugins([]));
  }, [open, plugins, rpc]);

  const selected = new Set(
    value
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry && entry !== "all" && entry !== "none"),
  );

  function toggle(id: string, on: boolean) {
    const next = new Set(selected);
    if (on) next.add(id);
    else next.delete(id);
    onChange(Array.from(next).join(","));
  }

  const summary =
    selected.size === 0
      ? "No plugins chosen yet."
      : Array.from(selected)
          .map((id) => plugins?.find((plugin) => plugin.id === id)?.name ?? id)
          .join(", ");

  return (
    <div className="space-y-1.5 pt-1">
      <div className="flex items-center gap-2">
        <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={() => setOpen(true)}>
          Choose plugins
        </Button>
        <span className="text-xs text-muted-foreground">{selected.size} selected</span>
      </div>
      <p className="truncate text-xs text-muted-foreground">{summary}</p>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Plugins Aide can use</DialogTitle>
          </DialogHeader>
          <div className="max-h-80 space-y-0.5 overflow-auto">
            {plugins === null ? (
              <p className="px-2 py-3 text-sm text-muted-foreground">Loading…</p>
            ) : plugins.length === 0 ? (
              <p className="px-2 py-3 text-sm text-muted-foreground">
                No other installed plugins expose a command.
              </p>
            ) : (
              plugins.map((plugin) => (
                <label
                  key={plugin.id}
                  className="flex cursor-pointer items-start gap-2.5 rounded-md px-2 py-1.5 hover:bg-state-hover"
                >
                  <Checkbox
                    checked={selected.has(plugin.id)}
                    onCheckedChange={(checked) => toggle(plugin.id, checked === true)}
                    className="mt-0.5"
                  />
                  <span className="min-w-0">
                    <span className="block text-sm text-foreground">{plugin.name}</span>
                    {plugin.summary ? (
                      <span className="block truncate text-xs text-muted-foreground">{plugin.summary}</span>
                    ) : null}
                  </span>
                </label>
              ))
            )}
          </div>
          <DialogFooter>
            <Button type="button" onClick={() => setOpen(false)}>
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Prompt editor — used inside Behavior. View / preview the prompt, edit and
// save your own, or reset to the default.
// ---------------------------------------------------------------------------

function PromptEditor() {
  const rpc = useRpc<typeof rpcContract>();
  const [active, setActive] = useState("");
  const [defaultContent, setDefaultContent] = useState("");
  const [mode, setMode] = useState<"view" | "preview" | "edit">("view");
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);

  const refetch = useCallback(() => {
    rpc.call("getPrompt", null).then((result) => {
      setActive(result.content);
      setDefaultContent(result.defaultContent);
    }, () => undefined);
  }, [rpc]);
  useEffect(refetch, [refetch]);
  useRealtime("prompt-changed", refetch);

  const isCustom = active.trim() !== defaultContent.trim();

  async function save(content: string, note: string) {
    if (content.trim().length === 0) return;
    setBusy(true);
    try {
      await rpc.call("setPrompt", { content, source: "user", note });
      setMode("view");
      toast.success("Prompt saved");
    } catch (cause) {
      toast.error(`Could not save prompt: ${cause instanceof Error ? cause.message : String(cause)}`);
    } finally {
      setBusy(false);
    }
  }

  const changed = draft.trim() !== active.trim();
  const stateText = isCustom ? "Currently using a custom prompt" : "Currently using the default prompt";

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm font-medium text-foreground">Prompt</span>
        {mode === "edit" ? null : (
          <span className="flex shrink-0 items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setMode((prev) => (prev === "preview" ? "view" : "preview"))}
            >
              {mode === "preview" ? "Hide" : "Preview"}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                setDraft(active);
                setMode("edit");
              }}
            >
              Edit
            </Button>
          </span>
        )}
      </div>

      {mode === "edit" ? (
        <div className="space-y-2">
          <textarea
            value={draft}
            autoFocus
            spellCheck={false}
            rows={16}
            onChange={(event) => setDraft(event.target.value)}
            className="w-full resize-y rounded-md border border-border bg-background p-2 font-mono text-xs leading-relaxed text-foreground"
          />
          <div className="flex items-center gap-2">
            <Button
              type="button"
              size="sm"
              disabled={busy || !changed || draft.trim().length === 0}
              onClick={() => void save(draft, "edited in settings")}
            >
              Save
            </Button>
            <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => setMode("view")}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span>{stateText}</span>
            {isCustom ? (
              <button type="button" className={linkClass} disabled={busy} onClick={() => void save(defaultContent, "reset to built-in default")}>
                Reset to default
              </button>
            ) : null}
          </div>
          {mode === "preview" ? (
            <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-muted/30 p-3 font-mono text-xs leading-relaxed text-foreground">
              {active}
            </pre>
          ) : null}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Audio: microphone picker + a live level meter to test it, and a read-only
// view of the system-default speaker (output is never routed in-app).
// ---------------------------------------------------------------------------

/** Live RMS of the selected mic, 0..1, while `active`. Cleans up fully on stop. */
function MicLevelMeter({ deviceId, active }: { deviceId: string; active: boolean }) {
  const [level, setLevel] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!active) {
      setLevel(0);
      return;
    }
    let stream: MediaStream | null = null;
    let context: AudioContext | null = null;
    let raf = 0;
    let cancelled = false;

    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: deviceId ? { deviceId: { exact: deviceId } } : true,
        });
        if (cancelled) return;
        context = new AudioContext();
        const source = context.createMediaStreamSource(stream);
        const analyser = context.createAnalyser();
        analyser.fftSize = 512;
        source.connect(analyser);
        const data = new Uint8Array(analyser.fftSize);
        const tick = () => {
          analyser.getByteTimeDomainData(data);
          let sum = 0;
          for (const sample of data) {
            const centered = (sample - 128) / 128;
            sum += centered * centered;
          }
          const rms = Math.sqrt(sum / data.length);
          // Light compression so speech visibly fills the bar.
          setLevel(Math.min(1, rms * 3));
          raf = requestAnimationFrame(tick);
        };
        tick();
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      }
    })();

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach((track) => track.stop());
      void context?.close();
      setLevel(0);
    };
  }, [deviceId, active]);

  if (!active) return null;
  if (error) return <p className="text-xs text-destructive">Mic test failed: {error}</p>;

  const segments = 20;
  const lit = Math.round(level * segments);
  return (
    <div className="flex items-center gap-2">
      <div className="flex h-3 flex-1 items-stretch gap-0.5">
        {Array.from({ length: segments }, (_, index) => (
          <span
            key={index}
            className={cn(
              "flex-1 rounded-[1px] transition-colors",
              index < lit
                ? index > segments * 0.85
                  ? "bg-destructive"
                  : "bg-primary"
                : "bg-muted",
            )}
          />
        ))}
      </div>
      <span className="w-8 shrink-0 text-right text-[10px] tabular-nums text-muted-foreground">
        {Math.round(level * 100)}%
      </span>
    </div>
  );
}

export function AudioSettings() {
  const preferences = useSyncExternalStore(voiceAgent.subscribe, voiceAgent.getAudioPreferences);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [deviceError, setDeviceError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const testingRef = useRef(false);
  testingRef.current = testing;

  const refresh = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) {
      setDeviceError("Audio device discovery is not supported in this browser.");
      setLoading(false);
      return;
    }
    try {
      setDevices(await navigator.mediaDevices.enumerateDevices());
      setDeviceError(null);
    } catch (cause) {
      setDeviceError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    navigator.mediaDevices?.addEventListener?.("devicechange", refresh);
    return () => navigator.mediaDevices?.removeEventListener?.("devicechange", refresh);
  }, [refresh]);

  const inputs = devices.filter((device) => device.kind === "audioinput" && device.deviceId);
  const outputs = devices.filter((device) => device.kind === "audiooutput" && device.deviceId);
  const labelsHidden = inputs.length > 0 && inputs.every((device) => !device.label);
  const savedMicMissing =
    !!preferences.inputDeviceId &&
    !inputs.some((device) => device.deviceId === preferences.inputDeviceId);

  // Best-effort system-default output: the entry whose id is "default", else
  // the first output. Its label reads e.g. "Default - MacBook Pro Speakers".
  const defaultOutput =
    outputs.find((device) => device.deviceId === "default") ?? outputs[0] ?? null;
  const speakerName = defaultOutput?.label
    ? defaultOutput.label.replace(/^Default\s*-\s*/i, "")
    : null;

  async function allowAccess() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      for (const track of stream.getTracks()) track.stop();
      await refresh();
    } catch (cause) {
      setDeviceError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  function change(deviceId: string) {
    const label = inputs.find((device) => device.deviceId === deviceId)?.label ?? "";
    voiceAgent.setAudioPreferences({ inputDeviceId: deviceId, inputLabel: label });
    toast.success("Microphone saved");
  }

  return (
    <div className={cn(settingsCardClass, "space-y-5")}>
      <Group label="Microphone">
        <SettingRow id="handsfree-microphone" label="Input device">
          <select id="handsfree-microphone"
            value={preferences.inputDeviceId}
            disabled={loading}
            onChange={(event) => change(event.target.value)}
            className={cn(selectClass, "min-w-0")}
          >
            <option value="">System default</option>
            {savedMicMissing ? (
              <option value={preferences.inputDeviceId}>
                {preferences.inputLabel
                  ? `${preferences.inputLabel} (not connected)`
                  : "Selected microphone (not connected)"}
              </option>
            ) : null}
            {inputs.map((device, index) => (
              <option key={device.deviceId} value={device.deviceId}>
                {deviceDisplayLabel(device, index)}
              </option>
            ))}
          </select>
          <Button
            type="button"
            variant={testing ? "secondary" : "outline"}
            size="sm"
            className="shrink-0"
            aria-label={testing ? "Stop microphone test" : "Test microphone"}
            onClick={() => setTesting((prev) => !prev)}
          >
            {testing ? "Stop" : "Test"}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="shrink-0"
            aria-label="Refresh microphone devices"
            onClick={() => void refresh()}
          >
            Refresh
          </Button>
        </SettingRow>

        {testing ? (
          <div className="rounded-md border border-border bg-muted/30 px-3 py-2">
            <MicLevelMeter deviceId={savedMicMissing ? "" : preferences.inputDeviceId} active={testing} />
            <p className="mt-1.5 text-[11px] text-muted-foreground">Speak — the bar should move with your voice.</p>
          </div>
        ) : null}

        {labelsHidden ? (
          <p className="text-xs text-muted-foreground"><button type="button" className={cn(linkClass, "underline")} onClick={() => void allowAccess()}>Allow access</button> to see microphone names.</p>
        ) : savedMicMissing ? (
          <p className="text-xs text-muted-foreground">This mic isn't connected, so Aide falls back to your default.</p>
        ) : null}
        {deviceError ? <p className="text-xs text-destructive">{deviceError}</p> : null}
      </Group>

      <Group label="Speaker">
        <SettingRow id="handsfree-speaker" label="Output device">
          <output id="handsfree-speaker" className="block w-56 max-w-full truncate rounded-md border border-border bg-muted/40 px-2 py-1.5 text-sm text-muted-foreground" title={speakerName ?? "System default"}>
            {labelsHidden || !speakerName ? "System default" : speakerName}
          </output>
        </SettingRow>
        <p className="text-xs italic text-muted-foreground">
          Switching speakers in the app isn't supported yet — change your output in your system sound settings.
        </p>
      </Group>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Keyboard shortcuts: one row per action showing the current binding as
// keycaps, with a recorder that captures the next combination pressed.
// ---------------------------------------------------------------------------

/** The binding as keycaps, e.g. [⌘][Shift][H]; an ellipsis while recording. */
function Keycaps({ value }: { value: string | null }) {
  const parts = value === null ? ["…"] : shortcutLabelParts(value, MAC);
  return (
    <span className="flex items-center gap-1" aria-hidden={value === null}>
      {parts.map((part, index) => (
        <kbd
          key={index}
          className="inline-flex h-6 min-w-6 items-center justify-center rounded border border-border bg-muted px-1.5 font-sans text-[11px] font-medium text-foreground shadow-[inset_0_-1px_0_var(--border)]"
        >
          {part}
        </kbd>
      ))}
    </span>
  );
}

function ShortcutRow({
  action,
  shortcuts,
  disabled,
  onChange,
}: {
  action: ShortcutAction;
  shortcuts: Shortcuts;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const [recording, setRecording] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // The recorder is installed once per recording session; read the latest
  // bindings and callback through a ref so it never goes stale.
  const latest = useRef({ shortcuts, onChange });
  latest.current = { shortcuts, onChange };
  const value = shortcuts[action];
  const isDefault = sameShortcut(value, DEFAULT_SHORTCUTS[action]);

  useEffect(() => {
    if (!recording) return;
    shortcutStore.setRecording(true);
    const onKeyDown = (event: KeyboardEvent) => {
      // Capture phase on window: ahead of bb's own bindings and our global
      // listener, so the keystroke reaches only this recorder and nothing is
      // typed into whatever has focus.
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.key === "Escape") {
        setRecording(false);
        return;
      }
      if (isModifierKey(event.key)) return; // waiting for the key itself
      const combo = comboFromEvent(event, MAC);
      if (!combo) {
        setProblem(MAC ? "Use ⌘ rather than Control." : "Use Ctrl rather than the Windows or Command key.");
        return;
      }
      const next = formatShortcut(combo);
      const why = shortcutProblem(next, action, latest.current.shortcuts, MAC);
      if (why) {
        setProblem(why); // stay in recording mode so they can try again
        return;
      }
      setRecording(false);
      latest.current.onChange(next);
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => {
      window.removeEventListener("keydown", onKeyDown, { capture: true });
      shortcutStore.setRecording(false);
    };
  }, [recording, action]);

  const status = recording ? (
    <span className={cn("block text-xs", problem ? "text-destructive" : "text-muted-foreground")}>
      {problem ?? "Press the new combination, or Esc to keep the current one."}
    </span>
  ) : isDefault ? null : (
    <button type="button" className={linkClass} disabled={disabled} onClick={() => onChange(DEFAULT_SHORTCUTS[action])}>
      Reset to {shortcutLabel(DEFAULT_SHORTCUTS[action], MAC)}
    </button>
  );

  return (
    <div className="flex items-center justify-between gap-3 px-3 py-2">
      <div className="min-w-0 space-y-0.5">
        <span className="block text-sm text-foreground">{SHORTCUT_ACTION_LABELS[action]}</span>
        {status}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Keycaps value={recording ? null : value} />
        <Button
          type="button"
          variant={recording ? "secondary" : "outline"}
          size="sm"
          disabled={disabled}
          onClick={() => {
            setProblem(null);
            setRecording((prev) => !prev);
          }}
        >
          {recording ? "Cancel" : "Change"}
        </Button>
      </div>
    </div>
  );
}

export function ShortcutsSettings() {
  const { config, update } = useVoiceConfig();
  const shortcuts = config?.shortcuts ?? DEFAULT_SHORTCUTS;
  const loading = config === null;

  return (
    <div className={cn(settingsCardClass, "space-y-3")}>
      <p className="text-xs text-muted-foreground">
        These work anywhere in bb, even while typing in the composer. Click Change, then press the new
        combination. Bindings are shared across your devices; ⌘ here means Ctrl on Windows and Linux.
      </p>
      <div className="divide-y divide-border/50 rounded-md border border-border">
        {SHORTCUT_ACTIONS.map((action) => (
          <ShortcutRow
            key={action}
            action={action}
            shortcuts={shortcuts}
            disabled={loading}
            onChange={(value) => {
              void update({ shortcuts: { ...shortcuts, [action]: value } }).then((ok) => {
                if (ok) toast.success(`Shortcut saved: ${shortcutLabel(value, MAC)}`);
              });
            }}
          />
        ))}
      </div>
    </div>
  );
}
