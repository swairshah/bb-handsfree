# Handsfree 🎙️

**Talk to bb.** Handsfree adds a voice agent to [bb](https://getbb.app): click
the little waveform button in the composer, start talking, and an assistant
with real control over bb does the work — finds threads, puts them on screen,
messages your coding agents, kicks off new work, and reads results back to
you.

## Quick start

1. Install and configure:

   ```sh
   cd bb-handsfree
   npm install
   bb plugin install . --yes
   bb plugin config handsfree set openaiApiKey <your-openai-key>
   bb plugin reload handsfree
   ```

2. Open any thread (or the New thread screen) in bb. Next to the mic button
   in the composer you'll see a **circle with a waveform**.

3. Click it. Allow microphone access the first time. When the bars start
   dancing, you're live — just talk. Click again to hang up.

The button has three states:

| Button | Meaning |
|---|---|
| Still bars | Idle — click to start |
| Pulsing outline | Connecting |
| Animated bars | Live — it's listening; click to stop |

Keyboard: **Cmd+Shift+H** (Ctrl+Shift+H on Windows/Linux) starts or stops a
call from anywhere in bb; **Cmd+Shift+M** mutes/unmutes during a call. Both are
also in the quick palette (Cmd+Shift+P) under Handsfree.

## Things you can say

- *"What's running right now?"* — lists your live threads
- *"Find the thread about the flaky login test and put it on screen"*
- *"Spotlight that pane"* / *"maximize it"* / *"restore it"*
- *"What did the agent say?"* — summarizes the latest output aloud
- *"Tell it to also add tests for the error path"* — messages the thread's agent
- *"Start a new thread in the replay project: fix the CI timeout"*
- *"Show me the diff for that thread"*
- *"Stop that thread"* / *"archive it"* / *"rename it to 'CI fix'"*
- *"Type a prompt for me: refactor the session store to…"* — writes into
  your composer so you can review and hit send yourself
- *"What automations do I have?"* — runs other installed plugins' `bb`
  commands (curate which with the `pluginCommands` setting)

The agent always knows which thread and project you're looking at — even as
you navigate mid-conversation — so "this thread" just works. If a project
lives on several machines, it checks which and asks before starting work.

A voice session is shared across all your bb windows and devices: the sidebar
shows a live voice bar (with which device the session came through), and any
window can pick it up or stop it.

## Inspecting live threads from the terminal

The same "Live threads" view from the sidebar is available as a CLI, for you
and for your coding agents:

```sh
bb handsfree live            # who's running right now
bb handsfree live --json     # machine-readable
bb handsfree read thr_xxxxx  # a thread's status + latest assistant output
bb handsfree usage           # what your voice sessions cost, per day (estimated)
bb handsfree stop            # stop an active voice session in any bb window
```

Agents discover these commands automatically through bb's plugin-commands
skill.

## Settings

Open the Handsfree plugin settings for curated sections:

- **Models & voice** — the OpenAI Realtime model, the assistant voice (marin
  and cedar are the highest-quality options), and a badge showing which
  credential Aide will use.
- **Behavior** — whether Aide announces thread events, and which installed
  plugins' `bb` commands it may run (all / none / a specific list).
- **Audio** — pick and test the microphone with a live input-level meter. The
  chosen mic is stored in the current browser and applies to the next voice
  session; if it disconnects, Handsfree falls back to the system default.
  Playback always uses your system-default speaker (change it in your OS Sound
  settings).

The only credential is the **OpenAI API key**, a secret stored in bb's plugin
secret store (0600 file, never in the db or frontend). It's optional: leave it
blank to use your ChatGPT subscription (`codex login`), or set `OPENAI_API_KEY`
in the bb server's environment. Set it in the settings field, or via the CLI:

```
bb plugin config handsfree set openaiApiKey <your-openai-key>
```

Model, voice, and behavior are configured from the settings sections above (no
longer via `bb plugin config`).

## Troubleshooting

- **No button?** Composer actions hide in bb's compact layout — widen the
  window. Also check `bb plugin list` shows `handsfree … running`.
- **"needs-configuration"** — set the API key (Quick start step 1).
- **Connects then drops** — check `bb plugin logs handsfree -f` while clicking;
  the SDP exchange error (bad key, model name) is logged there.
- **No audio out** — the first click must come from you (browser autoplay
  rules); if you started it and hear nothing, check system output device.

Your audio goes directly from the bb app to OpenAI over WebRTC; the API key
never leaves the bb server, and no audio is stored by the plugin.

---

## For developers

Architecture: bb's plugin frontend runs in a real browser context, so mic
capture and playback live in `app.tsx` (getUserMedia + RTCPeerConnection +
data channel) with no native helper — unlike its VS Code sibling
[CodeAide](../CodeAide), which needs a Swift WebRTC binary.

```text
app.tsx            composer button + sidebar voice bar
voice-agent.ts     WebRTC session, data channel, tool dispatch
voice-chrome.tsx   waveform button + session UI; sessions-panel.tsx sessions view
server.ts          API key + SDP exchange, bb tools via bb.sdk, `bb handsfree` CLI
```

More detail: [docs/handsfree-voice-architecture.md](docs/handsfree-voice-architecture.md)
and [docs/handsfree-voice-scenarios.md](docs/handsfree-voice-scenarios.md).

Tool-call flow: model → data channel → `app.tsx` → plugin RPC `runTool` →
`bb.sdk` → output back over the data channel (function_call_output +
response.create).

Voice tools: `get_context`, `list_projects`, `list_machines`,
`list_live_threads`, `list_threads`, `search_threads`, `read_thread`,
`focus_thread`, `set_pane`, `send_to_thread`, `start_thread`, `stop_thread`,
`archive_thread`, `rename_thread`, `show_diff`, `update_instructions`,
`run_plugin_cli`, plus frontend-local `set_composer_text` /
`append_composer_text`.

Dev loop:

```sh
bb plugin dev          # rebuild + reload on save
bb plugin logs handsfree -f # tool traffic and errors
```
