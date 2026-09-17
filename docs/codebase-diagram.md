# Handsfree codebase diagram

Handsfree adds voice control to bb. The browser handles the microphone and the
OpenAI Realtime connection, while the plugin server holds credentials and runs
bb commands.

## Main components

```mermaid
flowchart TB
    subgraph browser["bb app: browser or webview"]
        app["app.tsx<br/>Registers composer, sidebar, page, settings and shortcuts"]
        ui["ui/voice-chrome.tsx + ui/sessions-panel.tsx<br/>Call controls, session history and transcripts"]
        agent["voice/agent.ts<br/>Call lifecycle, WebRTC, tool dispatch and presence"]
        views["shared/view-workspace.ts + ui/companion.tsx<br/>Mobile thread drawer and embedded ThreadChat"]
        settings["settings-sections.tsx<br/>Model, voice, behavior, audio and shortcuts"]
        app --> ui
        app --> settings
        ui <--> agent
        agent --> views
    end

    openai["OpenAI Realtime<br/>Speech, transcripts and tool requests"]

    subgraph backend["bb plugin backend"]
        server["server.ts<br/>RPC contract, call setup, tools and CLI"]
        sdk["bb.sdk<br/>Threads, projects, machines and plugin commands"]
        bus["bb.realtime<br/>Presence, commands, thread notices and log updates"]
        storage[("Plugin storage<br/>SQLite: events, usage, prompt versions<br/>KV: configuration")]
        credentials["Server-only credentials<br/>Plugin secret, environment key or Codex login"]
        server --> sdk
        server --> bus
        server <--> storage
        credentials --> server
    end

    agent <-->|"Direct WebRTC: audio + data channel"| openai
    agent <-->|"RPC: createCall, runTool, logging, controls"| server
    server <-->|"Authenticated SDP call setup"| openai
    settings <-->|"Configuration RPC"| server
    ui <-->|"Session history RPC"| server
    bus -.->|"Subscriptions in each surface"| agent
    bus -.->|"Refresh history"| ui
    cli["bb handsfree<br/>live, read, usage, stop, mute, unmute"] --> server
```

The browser box groups frontend responsibilities, not a shared JavaScript
instance. Each bb surface has its own isolated JavaScript context, called a
realm, and its own `voiceAgent` instance.

## One spoken request

```mermaid
sequenceDiagram
    actor User
    participant App as voice/agent.ts (call owner)
    participant Server as server.ts
    participant AI as OpenAI Realtime
    participant BB as bb.sdk

    User->>App: Start a call
    App->>App: Capture microphone and create WebRTC offer
    App->>Server: createCall(SDP offer, current context)
    Server->>AI: Credentials + offer + instructions + tool schemas
    AI-->>Server: SDP answer
    Server-->>App: SDP answer
    App->>App: Complete WebRTC connection

    User->>App: Speak a request
    App->>AI: Microphone audio directly over WebRTC
    AI->>App: Tool request over the data channel
    alt Composer text or local view controls
        App->>App: Update composer or drawer
    else bb operation
        App->>Server: runTool(name, args, current context)
        Server->>BB: Read or change bb state
        BB-->>Server: Result
        Server-->>App: Tool output
    end
    App->>AI: function_call_output, then request a response
    AI->>App: Spoken response directly over WebRTC
    App->>User: Play audio
```

On mobile, opening a thread in the drawer first uses `resolveThreadViews` to
fetch its details. The drawer then displays the thread without navigating away
from the call. Desktop thread focus uses server-side navigation.

## One call across surfaces and devices

```mermaid
flowchart LR
    owner["Owner realm<br/>Holds microphone, peer connection and audio playback"]
    server["server.ts<br/>RPC handlers publish to bb.realtime"]
    mirror["Other surfaces and connected devices<br/>Mirror call state and relay controls"]

    owner -->|"Presence RPC: state changes and heartbeat"| server
    server -->|"voice-presence"| mirror
    mirror -->|"Command RPC: stop, mute or unmute + call nonce"| server
    server -->|"voice-command"| owner
```

Only the owner holds the audio connection. Other surfaces cannot take over its
microphone. A new call ends the previous call through a `voice-call` broadcast.
The bus connects clients of one bb backend, not independent bb installations.

## Supporting files

| Files | Responsibility |
| --- | --- |
| `voice/tool-runner.ts` | Frontend tool dispatch: local tools, mobile drawer, RPC fallthrough. Owns the `Bindings` type. |
| `voice/presence.ts` | `PresenceChannel`: cross-surface mirror, heartbeat, expiry, command relay. |
| `voice/rtc-session.ts` | `SessionHandle`, ICE wait, `MicManager` (acquisition + suspend/recover). |
| `server/tools.ts` | Backend tool registry: each tool's schema + handler in one `ToolDef`. |
| `server/config.ts`, `server/credentials.ts` | kv-backed voice config and migration; API key / env / Codex subscription resolution. |
| `server/store.ts`, `server/cli.ts` | SQLite schema and queries (usage, transcripts, prompts); the `bb handsfree` CLI. |
| `server/realtime-call.ts`, `server/live-threads.ts`, `server/notifications.ts` | SDP exchange with OpenAI; the Live threads view; thread finish/fail announcements. |
| `shared/audio-devices.ts`, `shared/client-identity.ts` | Resolve microphone preferences and identify devices and realms. |
| `shared/models.ts`, `shared/shortcuts.ts`, `shared/shortcut-store.ts` | Define model and voice choices, validate shortcuts, and sync bindings. |
| `shared/session-events.ts`, `shared/thread-errors.ts` | Pair tool calls with results, classify outcomes, and format thread errors. |
| `components/ui/`, `hooks/`, `app.css` | Provide UI controls, drawer sizing, modal behavior, and styling. |

`voice/agent.ts` orchestrates the frontend modules; `server.ts` is the RPC
contract plus a composition root that wires the `server/` modules. Tests live
in `tests/`. Start reading with `app.tsx`, then `voice/agent.ts`, then
`server.ts`.
See [architecture and terminology](handsfree-voice-architecture.md) for ownership
and mobile lifecycle constraints.
