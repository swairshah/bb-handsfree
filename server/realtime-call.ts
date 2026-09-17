// The SDP exchange that opens a voice session: builds the session
// instructions (active prompt + plugin commands + device policy + context),
// then negotiates with OpenAI — the Realtime API for gpt-realtime models, or
// the Live API (full-duplex, delegated Responses backend) for gpt-live-1.
// The API key never leaves this backend.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { isLiveModel, liveVoice } from "../shared/models";
import { toolSchemas, threadViewInstructions } from "./tools.ts";
import type { ConfigStore } from "./config.ts";
import type { Credentials, AuthMechanism } from "./credentials.ts";

const REALTIME_ENDPOINT = "https://api.openai.com/v1/realtime/calls";
// GPT-Live (full-duplex) sessions use a different API surface: JSON body with
// `session` + `transport`, answer SDP in `transport.sdp` (developers.openai.com
// /api/docs/guides/voice-webrtc?api=live).
const LIVE_ENDPOINT = "https://api.openai.com/v1/live/sessions";
// The Responses model that carries the full Handsfree prompt and tool set when
// gpt-live-1 delegates reasoning and tool use (the docs' recommended default).
const LIVE_BACKEND_MODEL = "gpt-5.6-terra";

export interface CreateCallDeps {
  readConfig: ConfigStore["readConfig"];
  apiKey: Credentials["apiKey"];
  exposedPluginCommands: () => Promise<{ id: string; name: string; summary: string }[]>;
  /** The active prompt body (newest saved version or the default). */
  activePrompt(): string;
  log: BbPluginApi["log"];
  publish: BbPluginApi["realtime"]["publish"];
  /** Remember which auth mechanism the realtime family actually used. */
  rememberRealtimeAuth(mechanism: AuthMechanism): void;
}

export interface CreateCallInput {
  sdp: string;
  threadId: string | null;
  projectId: string | null;
  onNewThreadScreen?: boolean;
  nonce: string;
  mobile?: boolean;
}

export async function createCall(
  deps: CreateCallDeps,
  { sdp, threadId, projectId, onNewThreadScreen, nonce, mobile = false }: CreateCallInput,
): Promise<{ sdp: string; live: boolean }> {
  const { model, voice } = await deps.readConfig();
  const { key, mechanism } = await deps.apiKey({ requireKey: isLiveModel(model) });
  const pluginCommands = await deps.exposedPluginCommands();
  const pluginSection =
    pluginCommands.length === 0
      ? ""
      : `\n\nInstalled bb plugins contribute extra commands you can run with run_plugin_command:\n${pluginCommands.map((c) => `- ${c.id}: bb ${c.name} — ${c.summary}`).join("\n")}\nWhen unsure of a plugin's subcommands, run it with argv ["--help"] first. Summarize command output aloud in a sentence or two; never read raw JSON or long output verbatim.`;
  const instructions = `${deps.activePrompt()}${pluginSection}\n\n${threadViewInstructions(mobile)}\n\nCurrent context: threadId=${threadId ?? "none"}, projectId=${projectId ?? "none"}${onNewThreadScreen ? " — the user is on the New thread screen (no thread exists yet; they're composing the prompt for one)" : ""}. Call get_context for fresh context — the user navigates while talking.`;

  if (isLiveModel(model)) {
    // GPT-Live is a full-duplex voice frontend: it only handles the
    // conversation. The full Handsfree prompt and tool set live on a
    // Responses backend via delegation; tool calls come back to the client
    // as nested `response.event` messages (see voice-agent.ts).
    const liveSession = {
      model,
      instructions:
        "You are Aide, the voice of the user's bb workspace (an IDE for coding agents). Keep replies short and conversational. Delegate anything that needs bb data or actions — projects, threads, machines, composer text, plugin commands — to the backend, and keep the conversation moving while it works. Announce backend results in one or two sentences; never read ids, code, or raw output aloud.",
      audio: { output: { voice: liveVoice(voice) } },
      delegation: {
        type: "responses",
        responses: {
          model: LIVE_BACKEND_MODEL,
          instructions,
          tools: toolSchemas(pluginCommands, mobile),
          tool_choice: "auto",
        },
      },
    };
    const response = await fetch(LIVE_ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ session: liveSession, transport: { type: "webrtc", sdp } }),
    });
    const text = await response.text();
    if (!response.ok) {
      deps.log.error(`OpenAI live session failed: ${response.status} ${text.slice(0, 500)}`);
      throw new Error(`OpenAI live session failed: ${response.status} ${response.statusText}`);
    }
    let answer: string | undefined;
    let liveSessionId: string | undefined;
    try {
      const parsed = JSON.parse(text) as { session?: { id?: string }; transport?: { sdp?: string } };
      answer = parsed.transport?.sdp;
      liveSessionId = parsed.session?.id;
    } catch {
      /* handled below */
    }
    if (typeof answer !== "string" || !answer) {
      deps.log.error(`OpenAI live session returned no SDP answer: ${text.slice(0, 500)}`);
      throw new Error("OpenAI live session returned no SDP answer");
    }
    deps.log.info(`live session created: ${liveSessionId ?? "(no id)"}`);
    deps.publish("voice-call", { nonce });
    return { sdp: answer, live: true };
  }

  const session = {
    type: "realtime",
    model,
    instructions,
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
    deps.log.error(`OpenAI realtime call failed: ${response.status} ${text.slice(0, 500)}`);
    throw new Error(`OpenAI realtime call failed: ${response.status} ${response.statusText}`);
  }
  // One voice session at a time, everywhere: every connected client hears
  // this and stops any session whose nonce differs.
  // Remember which auth mechanism the realtime family actually used, so
  // moving to gpt-live-1 (key-forced) and back restores this default.
  deps.rememberRealtimeAuth(mechanism);
  deps.publish("voice-call", { nonce });
  return { sdp: text, live: false };
}
