// Aide sessions page: inspect voice sessions inside bb — the bb-native
// version of CodeAide's HTML session log. Lists sessions with cost, and shows
// a live-updating transcript: what you said, what Aide said, every tool call
// with arguments and result, and errors. A bottom-center call console (the FAB)
// starts/controls the call right here, so you never route through the composer
// (which collapses on mobile) or switch sidebars to talk.
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  experimental_useAppPanel,
  experimental_useSidebarThreadActions,
  useBbContext,
  useBbNavigate,
  useRealtime,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import { voiceAgent } from "./voice-agent";
import { MicIcon, StopIcon, WaveformIcon, useCallElapsed } from "./voice-chrome";
import { COMPANION_TAB, CompanionControls } from "./companion";
import { cn } from "@/lib/utils";

interface DeviceInfo {
  label: string;
  mobile: boolean;
  platform: string;
  browser: string;
  runtime: string;
}
interface SessionRow {
  id: string;
  startedAt: number;
  lastEventAt: number;
  events: number;
  ended: boolean;
  costUsd: number;
  preview: string;
  hasError: boolean;
  device: DeviceInfo | null;
}

/** A phone glyph for mobile clients, a monitor for everything else. */
function DeviceIcon({ mobile, className }: { mobile: boolean; className?: string }) {
  return mobile ? (
    <svg viewBox="0 0 16 16" className={className} fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden>
      <rect x="4.5" y="1.5" width="7" height="13" rx="1.6" />
      <path d="M7 12.5h2" strokeLinecap="round" />
    </svg>
  ) : (
    <svg viewBox="0 0 16 16" className={className} fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden>
      <rect x="1.5" y="2.5" width="13" height="8.5" rx="1.4" />
      <path d="M6 14h4M8 11v3" strokeLinecap="round" />
    </svg>
  );
}

/** A friendly one-word runtime for the session header. */
function runtimeLabel(runtime: string): string {
  return runtime === "electron"
    ? "desktop app"
    : runtime === "native-webview"
      ? "native app"
      : runtime === "pwa"
        ? "installed"
        : runtime === "browser"
          ? "browser"
          : runtime;
}

/** "iOS · Safari · native app" — omits blanks. */
function deviceDetail(d: DeviceInfo): string {
  return [d.platform, d.browser, runtimeLabel(d.runtime)].filter(Boolean).join(" · ");
}
interface EventRow {
  id: number;
  ts: number;
  kind: string;
  payload: string;
}
interface PluginMeta {
  id: string;
  name: string;
  iconUrl: string | null;
}

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function fmtDate(ts: number): string {
  return new Date(ts).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function duration(startMs: number, endMs: number): string {
  const seconds = Math.max(0, Math.round((endMs - startMs) / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function parsePayload(raw: string): Record<string, unknown> {
  try {
    const value = JSON.parse(raw);
    return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Open this plugin's settings page (Settings → Plugins → Handsfree). The SDK
 * only hands `openSettings()` to sidebar footer actions, so from a nav panel we
 * push the host route directly and nudge the router with a popstate event.
 */
function openHandsfreeSettings() {
  window.history.pushState({}, "", "/settings/plugins/handsfree");
  window.dispatchEvent(new PopStateEvent("popstate"));
}

/** The exact gear bb uses for its own Settings button (hugeicons Settings01). */
function GearIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M21.3175 7.14139L20.8239 6.28479C20.4506 5.63696 20.264 5.31305 19.9464 5.18388C19.6288 5.05472 19.2696 5.15664 18.5513 5.36048L17.3311 5.70418C16.8725 5.80994 16.3913 5.74994 15.9726 5.53479L15.6357 5.34042C15.2766 5.11043 15.0004 4.77133 14.8475 4.37274L14.5136 3.37536C14.294 2.71534 14.1842 2.38533 13.9228 2.19657C13.6615 2.00781 13.3143 2.00781 12.6199 2.00781H11.5051C10.8108 2.00781 10.4636 2.00781 10.2022 2.19657C9.94085 2.38533 9.83106 2.71534 9.61149 3.37536L9.27753 4.37274C9.12465 4.77133 8.84845 5.11043 8.48937 5.34042L8.15249 5.53479C7.73374 5.74994 7.25259 5.80994 6.79398 5.70418L5.57375 5.36048C4.85541 5.15664 4.49625 5.05472 4.17867 5.18388C3.86109 5.31305 3.67445 5.63696 3.30115 6.28479L2.80757 7.14139C2.45766 7.74864 2.2827 8.05227 2.31666 8.37549C2.35061 8.69871 2.58483 8.95918 3.05326 9.48012L4.0843 10.6328C4.3363 10.9518 4.51521 11.5078 4.51521 12.0077C4.51521 12.5078 4.33636 13.0636 4.08433 13.3827L3.05326 14.5354C2.58483 15.0564 2.35062 15.3168 2.31666 15.6401C2.2827 15.9633 2.45766 16.2669 2.80757 16.8741L3.30114 17.7307C3.67443 18.3785 3.86109 18.7025 4.17867 18.8316C4.49625 18.9608 4.85542 18.8589 5.57377 18.655L6.79394 18.3113C7.25263 18.2055 7.73387 18.2656 8.15267 18.4808L8.4895 18.6752C8.84851 18.9052 9.12464 19.2442 9.2775 19.6428L9.61149 20.6403C9.83106 21.3003 9.94085 21.6303 10.2022 21.8191C10.4636 22.0078 10.8108 22.0078 11.5051 22.0078H12.6199C13.3143 22.0078 13.6615 22.0078 13.9228 21.8191C14.1842 21.6303 14.294 21.3003 14.5136 20.6403L14.8476 19.6428C15.0004 19.2442 15.2765 18.9052 15.6356 18.6752L15.9724 18.4808C16.3912 18.2656 16.8724 18.2055 17.3311 18.3113L18.5513 18.655C19.2696 18.8589 19.6288 18.9608 19.9464 18.8316C20.264 18.7025 20.4506 18.3785 20.8239 17.7307L21.3175 16.8741C21.6674 16.2669 21.8423 15.9633 21.8084 15.6401C21.7744 15.3168 21.5402 15.0564 21.0718 14.5354L20.0407 13.3827C19.7887 13.0636 19.6098 12.5078 19.6098 12.0077C19.6098 11.5078 19.7888 10.9518 20.0407 10.6328L21.0718 9.48012C21.5402 8.95918 21.7744 8.69871 21.8084 8.37549C21.8423 8.05227 21.6674 7.74864 21.3175 7.14139Z" />
      <path d="M15.5195 12C15.5195 13.933 13.9525 15.5 12.0195 15.5C10.0865 15.5 8.51953 13.933 8.51953 12C8.51953 10.067 10.0865 8.5 12.0195 8.5C13.9525 8.5 15.5195 10.067 15.5195 12Z" />
    </svg>
  );
}

/**
 * The call console — a bottom-center control that owns the entire call
 * lifecycle right on the Handsfree page. Idle: a "Talk to Aide" pill. Live: it
 * expands into a console (mute · who-has-the-floor + duration · jump to the live
 * transcript · stop). Same neutral-chrome + activity-color language as the
 * composer pill; color marks who's speaking, everything else stays neutral.
 *
 * Rendered as a real element in a footer bar (not `position: fixed`) so it
 * reserves its own space — nothing overlaps — and stays inside the plugin's own
 * pointer/stacking context, which is what makes it reliably tappable on mobile.
 */
function CallConsole({ onViewTranscript, selectedId }: { onViewTranscript: (sessionId: string) => void; selectedId: string | null }) {
  const state = useSyncExternalStore(voiceAgent.subscribe, voiceAgent.getState);
  const activity = useSyncExternalStore(voiceAgent.subscribe, voiceAgent.getActivity);
  const micSuspended = useSyncExternalStore(voiceAgent.subscribe, voiceAgent.getMicSuspended);
  const lastActivity = useSyncExternalStore(voiceAgent.subscribe, voiceAgent.getLastActivity);
  const elapsed = useCallElapsed();
  const live = state === "live";
  const muted = state === "muted";
  const active = live || muted;
  const connecting = state === "connecting";

  if (!active) {
    return (
      <button
        type="button"
        aria-label="Start Aide voice agent"
        title="Talk to Aide"
        onClick={() => voiceAgent.toggleFromSurface()}
        className={cn(
          "flex h-11 items-center gap-2 rounded-full border border-border bg-card px-5 text-sm font-medium text-foreground shadow-lg transition-colors hover:bg-accent",
          connecting && "animate-pulse",
        )}
      >
        <WaveformIcon live={false} />
        {connecting ? "Connecting…" : "Talk to Aide"}
      </button>
    );
  }

  const speaking = activity === "aide";
  const listening = activity === "you";
  const activityColor = micSuspended
    ? "text-destructive" // uplink down (iOS backgrounded the mic)
    : speaking
      ? "text-[color:var(--success,#6faf76)]" // Aide
      : listening
        ? "text-foreground" // you
        : "text-muted-foreground/70";
  const label = micSuspended
    ? "Mic paused"
    : speaking
      ? "Aide speaking…"
      : listening
        ? "Listening…"
        : muted
          ? "Muted"
          : "Connected";
  const liveId = voiceAgent.getSessionId();
  const ticker = tickerFor(lastActivity);
  // When you're already reading the live transcript, the ticker (and the pill's
  // transcript button) are redundant with what's on screen — hide them.
  const viewingLive = liveId != null && selectedId === liveId;

  return (
    <div className="flex w-full flex-col items-center gap-1.5">
      {liveId && !viewingLive ? (
        <button
          type="button"
          onClick={() => onViewTranscript(liveId)}
          className="flex max-w-full items-center gap-1.5 rounded-full bg-card/70 px-3 py-1 text-xs text-muted-foreground shadow-sm backdrop-blur transition-colors hover:text-foreground"
          title="See full transcript"
        >
          {ticker?.family ? (
            <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground/80">
              <ActionGlyph family={ticker.family} />
            </span>
          ) : null}
          <span className="truncate">{ticker?.text ?? "See full transcript"}</span>
          <svg viewBox="0 0 16 16" className="size-3 shrink-0 text-muted-foreground/50" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M6 4l4 4-4 4" />
          </svg>
        </button>
      ) : null}
      <div className="flex h-11 max-w-full items-center overflow-hidden rounded-full border border-border bg-card shadow-lg">
      <button
          type="button"
          aria-label={muted ? "Unmute Aide microphone" : "Mute Aide microphone"}
          title={muted ? "Unmute" : "Mute"}
          onClick={() => voiceAgent.toggleMuteFromSurface()}
          className={cn(
            "flex size-11 shrink-0 items-center justify-center transition-colors",
            muted
              ? "text-destructive hover:bg-destructive/15"
              : "text-muted-foreground hover:bg-accent hover:text-foreground",
          )}
        >
          <MicIcon slashed={muted} />
        </button>
        <span className="h-5 w-px bg-border" />
        <span className="flex min-w-0 items-center gap-2 px-3">
          <span className={cn("flex shrink-0 items-center", activityColor)} title={label} aria-label={label}>
            <WaveformIcon live={speaking || listening} />
          </span>
          <span className="truncate text-sm text-foreground">{label}</span>
          <span className="shrink-0 tabular-nums text-xs text-muted-foreground">{elapsed ?? ""}</span>
        </span>
        <span className="h-5 w-px bg-border" />
        <button
          type="button"
          aria-label="Stop Aide voice session"
          title="Stop"
          onClick={() => voiceAgent.stopFromSurface()}
          className="flex size-11 shrink-0 items-center justify-center text-muted-foreground transition-colors hover:bg-destructive/15 hover:text-destructive"
        >
          <StopIcon />
        </button>
      </div>
    </div>
  );
}

// ─── Transcript rendering ────────────────────────────────────────────────────
// The transcript reads as a narrative, not a raw log: speech is attributed with
// a speaker gutter + tint, and tool calls become human "action chips" (a paired
// call+result resolved into one line) with the raw {args, output} always one
// tap away. The action set is open-ended (built-ins + a dynamic
// run_plugin_command), so known tools get crafted phrasing and everything else
// falls through a generic humanizer — nothing is ever dropped or shown as junk.

type ActionFamily = "inspect" | "navigate" | "mutate" | "compose" | "self" | "plugin" | "other";

const ACTIONS: Record<string, { family: ActionFamily; verb: string }> = {
  get_context: { family: "inspect", verb: "Read your context" },
  list_projects: { family: "inspect", verb: "Listed projects" },
  list_machines: { family: "inspect", verb: "Listed machines" },
  list_live_threads: { family: "inspect", verb: "Listed live threads" },
  list_threads: { family: "inspect", verb: "Listed threads" },
  search_threads: { family: "inspect", verb: "Searched threads" },
  read_thread: { family: "inspect", verb: "Read a thread" },
  focus_thread: { family: "navigate", verb: "Focused a thread" },
  set_pane: { family: "navigate", verb: "Changed the layout" },
  show_diff: { family: "navigate", verb: "Opened a diff" },
  send_to_thread: { family: "mutate", verb: "Sent a message" },
  start_thread: { family: "mutate", verb: "Started a thread" },
  stop_thread: { family: "mutate", verb: "Stopped a thread" },
  archive_thread: { family: "mutate", verb: "Archived a thread" },
  rename_thread: { family: "mutate", verb: "Renamed a thread" },
  update_instructions: { family: "self", verb: "Updated its instructions" },
  set_composer_text: { family: "compose", verb: "Drafted a message" },
  append_composer_text: { family: "compose", verb: "Appended to the draft" },
  run_plugin_command: { family: "plugin", verb: "Ran a plugin command" },
};

function actionMeta(name: string): { family: ActionFamily; verb: string } {
  return ACTIONS[name] ?? { family: "other", verb: name.replace(/[._]/g, " ").replace(/^\w/, (c) => c.toUpperCase()) };
}

/**
 * Human label for the dock's activity ticker from the agent's last event: a
 * tool call shows its verb (with the family glyph); speech/notice show a short
 * quote (no glyph). Returns null when there's nothing worth showing yet.
 */
function tickerFor(last: { kind: string; name: string; text: string } | null): { family: ActionFamily | null; text: string } | null {
  if (!last) return null;
  if (last.kind === "tool.call") {
    const meta = actionMeta(last.name);
    return { family: meta.family, text: meta.verb };
  }
  const text = last.text.trim();
  if (!text) return null;
  const clipped = text.length > 80 ? `${text.slice(0, 80)}…` : text;
  return { family: null, text: last.kind === "assistant" ? `“${clipped}”` : clipped };
}

/** The most salient argument to show inline next to the verb, if any. */
function actionObject(name: string, args: Record<string, unknown>): string {
  const str = (value: unknown): string => (typeof value === "string" ? value : "");
  const clip = (text: string, max = 64): string => (text.length > max ? `${text.slice(0, max)}…` : text);
  if (name === "run_plugin_command") {
    const argv = Array.isArray(args.argv) ? (args.argv as unknown[]).map(String).join(" ") : "";
    return clip([str(args.plugin_id), argv].filter(Boolean).join(" "));
  }
  return clip(str(args.query) || str(args.title) || str(args.message) || str(args.text) || str(args.prompt) || str(args.action));
}

function ActionGlyph({ family }: { family: ActionFamily }) {
  const cls = "size-3";
  switch (family) {
    case "inspect":
      return <svg viewBox="0 0 16 16" className={cls} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden><circle cx="7" cy="7" r="4" /><path d="M13 13l-3-3" /></svg>;
    case "navigate":
      return <svg viewBox="0 0 16 16" className={cls} fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden><circle cx="8" cy="8" r="5.5" /><circle cx="8" cy="8" r="1.4" fill="currentColor" stroke="none" /></svg>;
    case "mutate":
      return <svg viewBox="0 0 16 16" className={cls} fill="currentColor" aria-hidden><path d="M8.7 1L3 9h4l-1.3 6L13 6.5H8.6z" /></svg>;
    case "compose":
      return <svg viewBox="0 0 16 16" className={cls} fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M11 2.4l2.6 2.6L6 12.6l-3.2.6.6-3.2z" /></svg>;
    case "self":
      return <svg viewBox="0 0 16 16" className={cls} fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden><circle cx="8" cy="8" r="2.1" /><circle cx="8" cy="8" r="5.5" /></svg>;
    case "plugin":
      return <svg viewBox="0 0 16 16" className={cls} fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" aria-hidden><path d="M6.2 2.5h3.6v1.6a1.4 1.4 0 002.8 0V4h1.4v3.4h-1.6a1.4 1.4 0 000 2.8h1.6V13H2.4V9.9H4a1.4 1.4 0 000-2.8H2.4V2.5z" /></svg>;
    default:
      return <svg viewBox="0 0 16 16" className={cls} fill="currentColor" aria-hidden><circle cx="8" cy="8" r="2.4" /></svg>;
  }
}

function Chevron() {
  return (
    <svg viewBox="0 0 16 16" className="ml-auto size-3 shrink-0 text-muted-foreground/40 transition-transform group-open:rotate-90" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M6 4l4 4-4 4" />
    </svg>
  );
}

type Row =
  | { kind: "speech"; id: number; ts: number; who: "you" | "aide"; text: string }
  | { kind: "action"; id: number; ts: number; name: string; args: Record<string, unknown>; output: string | null }
  | { kind: "notice"; id: number; ts: number; text: string }
  | { kind: "error"; id: number; ts: number; message: string }
  | { kind: "sysgroup"; id: number; ts: number; events: EventRow[] };

const CONVERSATION_KINDS = new Set(["user", "assistant", "tool.call", "tool.result", "notice", "error"]);

/**
 * Fold the raw event log into display rows: pair each tool.call with its result,
 * and coalesce runs of low-level diagnostics (session.*, conn.*, audio.*) into a
 * single collapsible "session connected"-style group so they don't bury the
 * conversation. The full detail stays one tap away inside the group.
 */
function buildRows(events: EventRow[]): Row[] {
  const rows: Row[] = [];
  const consumed = new Set<number>();
  let diagnostics: EventRow[] = [];
  const flush = () => {
    if (diagnostics.length === 0) return;
    rows.push({ kind: "sysgroup", id: diagnostics[0].id, ts: diagnostics[0].ts, events: diagnostics });
    diagnostics = [];
  };
  events.forEach((event, index) => {
    if (!CONVERSATION_KINDS.has(event.kind)) {
      diagnostics.push(event);
      return;
    }
    flush();
    const payload = parsePayload(event.payload);
    switch (event.kind) {
      case "user":
      case "assistant":
        rows.push({ kind: "speech", id: event.id, ts: event.ts, who: event.kind === "user" ? "you" : "aide", text: String(payload.text ?? "") });
        break;
      case "tool.call": {
        const name = String(payload.name ?? "?");
        let output: string | null = null;
        for (let j = index + 1; j < events.length; j++) {
          const later = events[j];
          if (later.kind !== "tool.result" || consumed.has(later.id)) continue;
          const lp = parsePayload(later.payload);
          if (String(lp.name ?? "?") === name) {
            output = String(lp.output ?? "");
            consumed.add(later.id);
            break;
          }
        }
        rows.push({ kind: "action", id: event.id, ts: event.ts, name, args: (payload.args as Record<string, unknown>) ?? {}, output });
        break;
      }
      case "tool.result":
        if (consumed.has(event.id)) break; // already merged into its call
        rows.push({ kind: "action", id: event.id, ts: event.ts, name: String(payload.name ?? "?"), args: {}, output: String(payload.output ?? "") });
        break;
      case "notice":
        rows.push({ kind: "notice", id: event.id, ts: event.ts, text: String(payload.text ?? "") });
        break;
      case "error":
        rows.push({ kind: "error", id: event.id, ts: event.ts, message: String(payload.message ?? "error") });
        break;
    }
  });
  flush();
  return rows;
}

/** Human label for a diagnostics group, from the lifecycle events it contains. */
function sysGroupLabel(events: EventRow[]): string {
  const kinds = new Set(events.map((event) => event.kind));
  if (kinds.has("session.stopped")) return "Session ended";
  if (kinds.has("session.live")) return "Session connected";
  if (kinds.has("session.started")) return "Session connecting";
  return "Session activity";
}

function SpeechRow({ row }: { row: Extract<Row, { kind: "speech" }> }) {
  const you = row.who === "you";
  return (
    <div className={cn("flex gap-2.5 rounded-md border-l-2 py-1.5 pl-2.5 pr-2", you ? "border-l-border bg-muted/40" : "border-l-primary/50 bg-primary/[0.06]")}>
      <span className={cn("mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full", you ? "bg-muted text-muted-foreground" : "bg-primary/15 text-primary")}>
        <span className="scale-75">{you ? <MicIcon slashed={false} /> : <WaveformIcon live={false} />}</span>
      </span>
      <div className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span className={cn("text-xs font-semibold", you ? "text-foreground" : "text-primary")}>{you ? "You" : "Aide"}</span>
          <span className="text-[10px] tabular-nums text-muted-foreground/50">{fmtTime(row.ts)}</span>
        </span>
        <p className="whitespace-pre-wrap text-sm text-foreground/90">{row.text}</p>
      </div>
    </div>
  );
}

function ActionRow({ row, plugins }: { row: Extract<Row, { kind: "action" }>; plugins: Map<string, PluginMeta> }) {
  const meta = actionMeta(row.name);
  const pending = row.output === null;
  const isError = !pending && /^tool error/i.test(row.output ?? "");
  const hasArgs = Object.keys(row.args).length > 0;

  // run_plugin_command reads as "Used plugin [chip]": the left square keeps the
  // generic plugin glyph (consistent with every action row), and the plugin's
  // real name + icon (from listPlugins) ride in a chip next to it.
  const isPlugin = row.name === "run_plugin_command";
  let verb = meta.verb;
  let object = actionObject(row.name, row.args);
  let pluginName = "";
  let pluginIcon: string | null = null;
  if (isPlugin) {
    const pluginId = typeof row.args.plugin_id === "string" ? row.args.plugin_id : "";
    const plugin = plugins.get(pluginId);
    verb = "Used plugin";
    pluginName = plugin?.name ?? pluginId;
    pluginIcon = plugin?.iconUrl ?? null;
    object = Array.isArray(row.args.argv) ? (row.args.argv as unknown[]).map(String).join(" ") : "";
  }

  return (
    <details className="group min-w-0 pl-2.5">
      <summary className="flex min-w-0 cursor-pointer list-none items-center gap-2 py-1 text-xs">
        <span className={cn("flex size-5 shrink-0 items-center justify-center rounded-md", isError ? "bg-destructive/15 text-destructive" : "bg-muted text-muted-foreground")}>
          <ActionGlyph family={meta.family} />
        </span>
        <span className={cn("shrink-0 font-medium", isError ? "text-destructive" : "text-foreground/80")}>{verb}</span>
        {isPlugin && pluginName ? (
          <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-muted px-1.5 py-px text-[11px] font-medium text-foreground/80">
            {pluginIcon ? <img src={pluginIcon} alt="" className="size-3 rounded-[3px] object-contain" /> : null}
            {pluginName}
          </span>
        ) : null}
        {object ? <span className="min-w-0 truncate text-muted-foreground">· {object}</span> : null}
        {pending ? <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-primary" /> : null}
        <Chevron />
      </summary>
      <div className="mb-1 mt-1 space-y-1 pl-7">
        {hasArgs ? (
          <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded bg-muted p-2 font-mono text-[11px] text-muted-foreground">{JSON.stringify(row.args, null, 2)}</pre>
        ) : null}
        {row.output ? (
          <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded bg-muted p-2 font-mono text-[11px] text-foreground/80">{row.output}</pre>
        ) : (
          <p className="text-[11px] italic text-muted-foreground">Waiting for result…</p>
        )}
      </div>
    </details>
  );
}

function NoticeRow({ row }: { row: Extract<Row, { kind: "notice" }> }) {
  return (
    <p className="px-2 py-1 text-center text-xs italic text-muted-foreground/80">🔔 {row.text}</p>
  );
}

function ErrorRow({ row }: { row: Extract<Row, { kind: "error" }> }) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-2.5 py-1.5">
      <span className="mt-px text-xs text-destructive">⚠</span>
      <span className="text-sm text-destructive">{row.message}</span>
    </div>
  );
}

function SysGroupRow({ row }: { row: Extract<Row, { kind: "sysgroup" }> }) {
  const label = sysGroupLabel(row.events);
  return (
    <details className="group min-w-0">
      <summary className="mx-auto flex w-fit cursor-pointer list-none items-center justify-center gap-1.5 py-0.5 text-[11px] text-muted-foreground/60 hover:text-muted-foreground">
        <span className="size-1.5 rounded-full bg-muted-foreground/40" />
        {label}
        <span className="text-muted-foreground/40">· {row.events.length}</span>
        <Chevron />
      </summary>
      <div className="mt-1 space-y-1 rounded-md bg-muted/40 p-2">
        {row.events.map((event) => {
          const payload = event.payload && event.payload !== "{}" ? event.payload : "";
          return (
            <div key={event.id} className="min-w-0 font-mono text-[10px] leading-relaxed text-muted-foreground">
              <span className="mr-2 tabular-nums text-muted-foreground/50">{fmtTime(event.ts)}</span>
              <span className="text-foreground/70">{event.kind}</span>
              {payload ? <span className="break-all"> {payload}</span> : null}
            </div>
          );
        })}
      </div>
    </details>
  );
}

type TranscriptFilter = "all" | "talk" | "actions" | "errors";

const FILTERS: { id: TranscriptFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "talk", label: "Conversation" },
  { id: "actions", label: "Actions" },
  { id: "errors", label: "Errors" },
];

function rowMatchesFilter(row: Row, filter: TranscriptFilter): boolean {
  const actionErrored = row.kind === "action" && row.output !== null && /^tool error/i.test(row.output);
  switch (filter) {
    case "talk":
      return row.kind === "speech" || row.kind === "notice";
    case "actions":
      return row.kind === "action";
    case "errors":
      return row.kind === "error" || actionErrored;
    default:
      return true;
  }
}

function FilterBar({ value, onChange }: { value: TranscriptFilter; onChange: (next: TranscriptFilter) => void }) {
  return (
    <div className="flex items-center gap-1 rounded-md border border-border bg-card p-0.5">
      {FILTERS.map((filter) => (
        <button
          key={filter.id}
          type="button"
          onClick={() => onChange(filter.id)}
          className={cn(
            "rounded px-2 py-0.5 text-xs transition-colors",
            value === filter.id ? "bg-accent font-medium text-foreground" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {filter.label}
        </button>
      ))}
    </div>
  );
}

function TranscriptBody({ events, plugins, filter }: { events: EventRow[]; plugins: Map<string, PluginMeta>; filter: TranscriptFilter }) {
  const rows = buildRows(events).filter((row) => rowMatchesFilter(row, filter));
  if (rows.length === 0) {
    return <p className="py-3 text-center text-sm text-muted-foreground">Nothing matches this filter.</p>;
  }
  return (
    <div className="space-y-1 py-1.5">
      {rows.map((row) => {
        switch (row.kind) {
          case "speech":
            return <SpeechRow key={row.id} row={row} />;
          case "action":
            return <ActionRow key={row.id} row={row} plugins={plugins} />;
          case "notice":
            return <NoticeRow key={row.id} row={row} />;
          case "error":
            return <ErrorRow key={row.id} row={row} />;
          default:
            return <SysGroupRow key={row.id} row={row} />;
        }
      })}
    </div>
  );
}

/**
 * Close the page on Escape by going back in history (bb's router follows
 * popstate). Skips presses aimed at inputs/textareas/contenteditables and
 * ones something else already handled (e.g. closing a dialog), so Escape
 * still means "dismiss" inside nested UI.
 */
function useEscapeToClose() {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable ||
          target instanceof HTMLInputElement ||
          target instanceof HTMLTextAreaElement ||
          target instanceof HTMLSelectElement)
      ) {
        return;
      }
      event.preventDefault();
      window.history.back();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}

export function SessionsPanel() {
  const rpc = useRpc<typeof rpcContract>();
  const { threadId, projectId } = useBbContext();
  const sidebarActions = experimental_useSidebarThreadActions();
  const appPanel = experimental_useAppPanel();
  useEscapeToClose();

  // The Handsfree page has no composer, so nothing else binds the voice agent
  // here. Install a fallback binding so the FAB can actually start a call from a
  // cold page — but only when nothing richer is already bound (a live composer's
  // binding, which its text tools target, must win). We deliberately bind no
  // composer: with nothing to type into, the text tools report that honestly
  // (see handleToolCall) rather than silently opening a thread behind the user's
  // back. Everything else (thread focus, starting work, diffs) runs through rpc,
  // which works from anywhere.
  useEffect(() => {
    voiceAgent.bindFallback({
      rpc,
      context: { threadId: threadId ?? null, projectId: projectId ?? null, onNewThreadScreen: false },
      openNewThread: (targetProjectId) =>
        sidebarActions.openNewThread({
          ...(targetProjectId ? { projectId: targetProjectId } : {}),
          focusPrompt: true,
        }),
    });
  }, [rpc, threadId, projectId, sidebarActions]);

  // Register the companion-pane opener OUTSIDE the voice binding, so a composer's
  // bind() (which replaces the whole bindings object) can't clobber it. The agent's
  // show_thread runs in whichever realm owns the call and relays over
  // voice-companion; the realm with the page mounted (this one) opens the pane.
  useEffect(() => {
    voiceAgent.setCompanionOpener((id) =>
      appPanel.openFixedTab({ surface: { kind: "current" }, tab: COMPANION_TAB, target: { threadId: id } }),
    );
    return () => voiceAgent.setCompanionOpener(null);
  }, [appPanel]);
  useRealtime("voice-companion", (payload) => voiceAgent.applyCompanion(payload));

  // Open URLs in the bb browser (works from any surface; harmless duplicate set).
  const navigate = useBbNavigate();
  useEffect(() => {
    voiceAgent.setUrlOpener((url) => navigate.openUrl(url));
  }, [navigate]);
  const [sessions, setSessions] = useState<SessionRow[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [events, setEvents] = useState<EventRow[]>([]);
  const [filter, setFilter] = useState<TranscriptFilter>("all");
  const [search, setSearch] = useState("");
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [plugins, setPlugins] = useState<Map<string, PluginMeta>>(() => new Map());
  const [error, setError] = useState<string | null>(null);
  // The call active in THIS window always reads live, overriding the server's
  // stale heuristic (which can't see an active-but-quiet call).
  const activeSessionId = useSyncExternalStore(voiceAgent.subscribe, voiceAgent.getSessionId);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // Set when the transcript is opened so the first batch of events snaps to the
  // bottom (latest), even if the list is taller than the viewport.
  const pendingBottom = useRef(false);

  // Refresh the newest page and fold it over what's loaded: update rows in place
  // (counts/cost/ended change as a call runs) and prepend brand-new sessions,
  // without dropping older pages the user already fetched via "Load more".
  const mergeNewest = useCallback((rows: SessionRow[], more: boolean) => {
    setSessions((prev) => {
      if (!prev) {
        setHasMore(more);
        return rows;
      }
      const incoming = new Map(rows.map((row) => [row.id, row]));
      const updated = prev.map((session) => incoming.get(session.id) ?? session);
      const existing = new Set(prev.map((session) => session.id));
      const fresh = rows.filter((row) => !existing.has(row.id));
      return fresh.length ? [...fresh, ...updated] : updated;
    });
  }, []);

  const refreshNewest = useCallback(() => {
    rpc.call("listSessions", { offset: 0 }).then(
      (result) => {
        mergeNewest(result.sessions, result.hasMore);
        setError(null);
      },
      (cause) => setError(cause instanceof Error ? cause.message : String(cause)),
    );
  }, [rpc, mergeNewest]);

  const loadMore = useCallback(() => {
    if (!sessions) return;
    setLoadingMore(true);
    rpc.call("listSessions", { offset: sessions.length }).then(
      (result) => {
        setSessions((prev) => {
          if (!prev) return result.sessions;
          const existing = new Set(prev.map((session) => session.id));
          return [...prev, ...result.sessions.filter((row) => !existing.has(row.id))];
        });
        setHasMore(result.hasMore);
        setLoadingMore(false);
      },
      () => setLoadingMore(false),
    );
  }, [rpc, sessions]);

  const refetchEvents = useCallback(
    (sessionId: string) => {
      rpc.call("getSessionEvents", { sessionId }).then(
        (result) => setEvents(result.events),
        () => undefined,
      );
    },
    [rpc],
  );

  useEffect(() => {
    refreshNewest();
  }, [refreshNewest]);
  // Plugin metadata (id → name + icon) to narrate run_plugin_command; static
  // enough to fetch once.
  useEffect(() => {
    rpc.call("listPlugins", null).then(
      (result) => setPlugins(new Map(result.plugins.map((plugin) => [plugin.id, plugin]))),
      () => undefined,
    );
  }, [rpc]);
  useEffect(() => {
    if (selected) {
      pendingBottom.current = true;
      refetchEvents(selected);
    }
  }, [selected, refetchEvents]);

  // Live updates: the server publishes on every logged event.
  useRealtime("aide-log", (payload) => {
    refreshNewest();
    const sessionId = (payload as { sessionId?: unknown } | null)?.sessionId;
    if (selected && sessionId === selected) refetchEvents(selected);
  });

  // Cross-surface presence: mirror a call owned by another realm so the console
  // reflects it, and relay stop/mute from the console back to the owning realm.
  useRealtime("voice-presence", (payload) => voiceAgent.ingestPresence(payload));
  useRealtime("voice-command", (payload) => voiceAgent.applyVoiceCommand(payload));
  useRealtime("voice-presence-query", () => voiceAgent.answerPresenceQuery());

  // Catch up the moment the page mounts (e.g. a realm rebuilt after navigating
  // back) instead of waiting up to a heartbeat — this is the "shows Talk to Aide
  // over a live call, then flips to Connected a few seconds later" gap.
  useEffect(() => voiceAgent.requestPresence(), []);

  // Auto-follow the transcript: after opening it, or when new events land while
  // you're already reading the bottom, snap to the latest — but if you've
  // scrolled up to read history, stay put.
  useEffect(() => {
    const el = scrollRef.current;
    if (!selected || !el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 160;
    if (pendingBottom.current || nearBottom) {
      el.scrollTop = el.scrollHeight;
      pendingBottom.current = false;
    }
  }, [events, selected]);

  const current = sessions?.find((session) => session.id === selected) ?? null;
  const isLive = (session: SessionRow): boolean => !session.ended || session.id === activeSessionId;
  const query = search.trim().toLowerCase();
  // Client-side filter over already-loaded sessions (Load more fetches the rest).
  const visibleSessions = sessions?.filter(
    (session) =>
      (!errorsOnly || session.hasError) &&
      (!query || session.preview.toLowerCase().includes(query) || fmtDate(session.startedAt).toLowerCase().includes(query)),
  );

  return (
    <div className="flex h-full flex-col">
      <div ref={scrollRef} className="flex-1 overflow-y-auto overflow-x-hidden p-4 md:p-5">
      <div className="mx-auto w-full min-w-0 max-w-3xl space-y-4">
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        {selected ? (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <button
                type="button"
                onClick={() => setSelected(null)}
                className="flex shrink-0 items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                ← All sessions
              </button>
              <FilterBar value={filter} onChange={setFilter} />
            </div>
            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-lg border border-border bg-card px-3.5 py-2.5">
              <div className="flex items-center gap-2.5">
                {current && isLive(current) ? (
                  <span className="size-2.5 shrink-0 animate-pulse rounded-full bg-primary" />
                ) : null}
                <div className="leading-tight">
                  <div className="text-sm font-medium text-foreground">
                    {current ? fmtDate(current.startedAt) : "Live session"}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {current ? (isLive(current) ? "Live now" : "Ended") : "Connecting…"}
                    {current ? ` · ${duration(current.startedAt, current.lastEventAt)}` : ""}
                  </div>
                  {current?.device ? (
                    <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground/80">
                      <DeviceIcon mobile={current.device.mobile} className="size-3.5 shrink-0" />
                      <span className="truncate">{deviceDetail(current.device)}</span>
                    </div>
                  ) : null}
                </div>
              </div>
              {current ? (
                <div className="flex items-center gap-4 tabular-nums">
                  <span className="flex flex-col items-end">
                    <span className="text-sm font-medium text-foreground">{current.events}</span>
                    <span className="text-[10px] uppercase tracking-wide text-muted-foreground/60">events</span>
                  </span>
                  <span className="flex flex-col items-end">
                    <span className="text-sm font-medium text-foreground">
                      {current.costUsd > 0 ? `~$${current.costUsd.toFixed(4)}` : "—"}
                    </span>
                    <span className="text-[10px] uppercase tracking-wide text-muted-foreground/60">cost</span>
                  </span>
                </div>
              ) : null}
            </div>
            <div className="rounded-lg border border-border bg-card px-2 py-1">
              {events.length === 0 ? (
                <p className="py-3 text-center text-sm text-muted-foreground">No events yet.</p>
              ) : (
                <TranscriptBody events={events} plugins={plugins} filter={filter} />
              )}
            </div>
          </>
        ) : (
          <>
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm font-medium text-foreground">Voice sessions</p>
              <button
                type="button"
                onClick={openHandsfreeSettings}
                title="Open Handsfree settings"
                aria-label="Open Handsfree settings"
                className="flex items-center gap-1.5 rounded-md border border-border px-2 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                <GearIcon />
                Settings
              </button>
            </div>
            <CompanionControls className="rounded-md border border-dashed border-border/70 px-2.5 py-1.5" />
            {sessions && sessions.length > 0 ? (
              <div className="flex items-center gap-2">
                <input
                  type="search"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search sessions…"
                  className="min-w-0 flex-1 rounded-md border border-border bg-card px-2.5 py-1.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                />
                <button
                  type="button"
                  onClick={() => setErrorsOnly((value) => !value)}
                  className={cn(
                    "shrink-0 rounded-md border px-2.5 py-1.5 text-xs transition-colors",
                    errorsOnly
                      ? "border-destructive/50 bg-destructive/10 text-destructive"
                      : "border-border text-muted-foreground hover:text-foreground",
                  )}
                >
                  Errors
                </button>
              </div>
            ) : null}
            <div className="divide-y divide-border/50 rounded-lg border border-border bg-card">
              {sessions === null ? (
                <p className="p-3 text-sm text-muted-foreground">Loading…</p>
              ) : sessions.length === 0 ? (
                <p className="p-3 text-sm text-muted-foreground">
                  No sessions yet. Tap “Talk to Aide” below to start your first one.
                </p>
              ) : visibleSessions && visibleSessions.length === 0 ? (
                <p className="p-3 text-sm text-muted-foreground">No sessions match.</p>
              ) : (
                visibleSessions?.map((session) => (
                  <button
                    key={session.id}
                    type="button"
                    onClick={() => setSelected(session.id)}
                    className="flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-accent"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm text-foreground">
                        {session.preview || <span className="italic text-muted-foreground">No transcript</span>}
                      </span>
                      <span className="mt-0.5 block text-xs tabular-nums text-muted-foreground">
                        {fmtDate(session.startedAt)} · {duration(session.startedAt, session.lastEventAt)}
                      </span>
                    </span>
                    {session.device ? (
                      <span title={session.device.label} className="flex shrink-0 items-center">
                        <DeviceIcon mobile={session.device.mobile} className="size-4 text-muted-foreground/50" />
                      </span>
                    ) : null}
                    {isLive(session) ? (
                      <span className="size-2 shrink-0 animate-pulse rounded-full bg-primary" title="Live" />
                    ) : session.hasError ? (
                      <span className="shrink-0 text-xs text-destructive" title="This session had an error">⚠</span>
                    ) : null}
                  </button>
                ))
              )}
            </div>
            {hasMore ? (
              <div className="flex justify-center">
                <button
                  type="button"
                  onClick={loadMore}
                  disabled={loadingMore}
                  className="rounded-md border border-border px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-60"
                >
                  {loadingMore ? "Loading…" : "Load more"}
                </button>
              </div>
            ) : null}
          </>
        )}
      </div>
      </div>
      <div className="shrink-0 border-t border-border/60 bg-background/90 px-4 py-3 backdrop-blur">
        <div className="mx-auto flex w-full max-w-3xl justify-center">
          <CallConsole onViewTranscript={(sessionId) => setSelected(sessionId)} selectedId={selected} />
        </div>
      </div>
    </div>
  );
}
