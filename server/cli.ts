// The `bb handsfree` CLI: the sidebar's Live threads view, thread reads,
// usage/cost summaries, and voice-session controls — for the user and for
// coding agents (discovered via bb's plugin-commands skill).
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { truncate } from "./tools.ts";
import { liveThreads, relativeTime } from "./live-threads.ts";
import { RATES, costUsd, usageEventsSince, type Db } from "./store.ts";

export function registerHandsfreeCli(bb: BbPluginApi, db: Db) {
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
          const live = await liveThreads(bb);
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
          const rows = usageEventsSince(db, since);
          const byDay = new Map<string, { responses: number; audioIn: number; audioOut: number; textIn: number; textOut: number; cached: number; liveSeconds: number; cost: number }>();
          for (const row of rows) {
            const day = new Date(row.ts).toISOString().slice(0, 10);
            const entry = byDay.get(day) ?? { responses: 0, audioIn: 0, audioOut: 0, textIn: 0, textOut: 0, cached: 0, liveSeconds: 0, cost: 0 };
            entry.responses += 1;
            entry.liveSeconds += row.duration_seconds ?? 0;
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
            (d) => `${d.day}  $${d.cost.toFixed(4)}  (${d.responses} responses \u00b7 audio ${d.audioIn}/${d.audioOut} \u00b7 text ${d.textIn}/${d.textOut} \u00b7 cached ${d.cached}${d.liveSeconds ? ` \u00b7 live ${Math.round(d.liveSeconds / 6) / 10}min` : ""})`,
          );
          return {
            exitCode: 0,
            stdout: `Voice usage, last ${days} day(s) \u2014 estimated at gpt-realtime/gpt-live rates (gpt-live backend tokens are billed separately, not tracked):\n${lines.join("\n")}\nTotal: ~$${total.toFixed(4)}  (tokens in/out per line; authoritative numbers: platform.openai.com/usage)`,
          };
        }
        return { exitCode: 1, stderr: `Unknown command: ${command}\n\n${help}` };
      } catch (error) {
        return { exitCode: 1, stderr: error instanceof Error ? error.message : String(error) };
      }
    },
  });
}
