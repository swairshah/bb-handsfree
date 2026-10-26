# Handsfree voice — architecture & terminology

Aide is a voice operator for bb: you talk, it drives bb (focuses threads, starts
work, reads output, edits the composer). The call is WebRTC to the OpenAI
Realtime API — microphone capture and audio playback happen in the bb app (a
webview); the plugin backend holds the API key, does the SDP exchange, and runs
tools via the bb SDK.

This is the shared vocabulary and how it actually works. For behaviors, see
[scenarios](./handsfree-voice-scenarios.md).

## Terminology

- **Realm** — an isolated JavaScript world (own globals and memory), like a
  browser tab. Two realms share nothing directly.
- **Surface** — a place the plugin renders: the composer button, the sidebar
  bar, the Handsfree page. bb renders each surface in its **own realm**.
- **Client** — one connected bb app instance: the desktop app, or a phone
  viewing over bb-connect. One client hosts several surfaces/realms.
- **WebRTC call** — the live audio connection between one client's microphone and
  OpenAI. Held by the realm that created it.
- **Owner** — the realm that physically holds the call: its `RTCPeerConnection`,
  mic capture, and audio element.
- **Mirror** — a realm that only reflects a call it doesn't own and relays
  controls to the owner.
- **Presence** — coarse call state (connecting / live / muted / idle + duration)
  broadcast so every surface can mirror it.
- **Command** — a control intent (stop / mute / unmute) relayed to the owner,
  addressed by nonce.
- **Nonce** — a per-call id; also the session id the transcript is logged under.
  Addresses presence and commands to one specific call.
- **clientId / realmId** — ids we mint for observability. `clientId` persists in
  localStorage (stable per device/browser); `realmId` is fresh per realm load
  (identifies one surface instance).

## One call, one realm

A WebRTC call is three physical things — a network connection, the microphone, an
audio element — held by JS objects in a single realm. They can't move to another
realm. So the surface you press "start" on owns the call; other surfaces can only
watch it and relay control. This one fact drives everything below.

Surfaces are separate realms even on one device (observed: distinct realmIds per
client), so a plain module singleton is **not** shared across them — each surface
gets its own instance.

## Cross-surface state

The only channel across realms is bb's realtime bus. The plugin **backend** can
`bb.realtime.publish(channel, payload)` to every connected client; a surface can
only **subscribe** (`useRealtime`). There is no client-to-client publish, so a
surface "broadcasts" by calling an RPC that publishes.

- The owner publishes **presence** on each coarse transition and on a ~10s
  heartbeat.
- Every other realm mirrors it. A mirror older than ~25s (two missed heartbeats)
  is treated as gone — so a vanished owner never leaves a ghost "live".
- Controls from a non-owner relay as **commands** addressed by nonce; only the
  realm holding that nonce acts.
- Result: composer pill, sidebar, and page all reflect and control the one live
  call, whichever surface started it.

Coarse only: who's-speaking isn't broadcast (too chatty); it shows on the owner
surface.

## Call ledger (start-if-idle)

Presence is advisory: a fresh realm sees "idle" until an owner answers, and an
unanswered query proves nothing. Every call passes through the backend's
`createCall`, and the backend is single-threaded, so it tracks calls there:
an `active_calls` SQLite table of every call not yet ended or explicitly
cleared (`server/call-ledger.ts`). It is scoped to one backend; it is not a
cross-process lock.

- Added by `reserveCall`, by unreserved `createCall`, and by any non-idle
  presence (so a surviving second call is tracked too).
- Removed only by end evidence from the owner (idle presence, a
  `session.stopped` event), by `forceStop`, or by `releaseCall` of an abandoned
  reservation. Heartbeat age never removes an entry.
- `forceStop` (**End it**) is an override, not proof the call ended: it clears
  the entry and broadcasts a best-effort stop without the owner's
  acknowledgement. It does not close the owner's peer connection. An
  unreachable owner may stay live, and its next heartbeat re-adds the entry; a
  reservation granted in between can start a second call.
- Entries restored after a backend restart report `unknown` until renewed.
  A ledger read or write failure disables reservations for that process.
- `reserveCall` succeeds only when the ledger is empty (or holds only this
  nonce). A reserved `createCall` re-checks that it is the sole entry at entry,
  again immediately before the paid exchange (after config, credential and
  catalog lookups), and again before announcing `voice-call`; otherwise it fails with "Another
  call started first." and the client closes its connection without applying
  the answer.
- Explicit Start remains unreserved and keeps takeover semantics, but any
  `createCall` whose nonce cannot be durably recorded fails before the paid
  exchange, so the ledger never misses a running call it accepted.
- `voice-call` (exclusivity), `voice-mute`, presence, commands and queries are
  all held by the single window-lifetime presence holder (`ui/presence-sync.tsx`),
  so a reachable call owned by the Handsfree page or any other surface stops on
  takeover.

Remaining gap: if a durable ledger write fails and the backend restarts before
the owner's next heartbeat, that call is missing from the restored ledger.

## Client, device, and realtime scope

`bb.realtime.publish` reaches "every connected client" of one plugin backend —
one bb app instance and everything attached to it (the local view plus remote
bb-connect views). It is **not** cross-machine: a separate, independent bb app has
its own backend, bus, and database. In our setup the phone is a bb-connect client
of the desktop-hosted app, which is why the desktop can see and control a call the
phone owns.

Voice input is always the **owner client's microphone**. Another client can mirror
and control the call but cannot become its microphone; to talk from a different
device you start a new call there (exclusivity ends the old one).

## The mobile constraint

When the owner realm is backgrounded on iOS (e.g. the app navigates away), the OS:

- **suspends the microphone** — the uplink dies (the mic track fires `mute` while
  the page is `hidden`),
- **freezes inbound messages** — the realm stops receiving relayed commands,
- **still fires timers occasionally** — so it keeps emitting presence heartbeats.

Left unhandled, this is a one-way zombie: you hear Aide, Aide can't hear you,
every surface shows "live", and no stop reaches the frozen owner.

A webview cannot hold the microphone in the background — only a native app with
background-audio entitlements can, and we run inside bb's webviews. So a
backgrounded call cannot survive on mobile. The plugin therefore does not try to
keep it alive; it **prevents** the backgrounding where it can and **ends cleanly**
(and recoverably) where it can't.

Desktop (Electron) does not suspend the mic on in-app navigation — audio may pause
while the panel is hidden, but the mic isn't suspended and the call resumes — so
the mobile-only paths below don't trigger there.

## Navigation

`bb.sdk.threads.open` is the navigation primitive (bring a thread on screen). Two
things follow from it:

- `start_thread` **also** navigates — its handler does `spawn()` then
  `threads.open()`.
- `threads.open` **delivers to every connected window**, not just the caller — so
  navigating from the phone also moves the desktop.

The plugin handles these per tool (see scenarios). Per-client navigation
targeting is a bb-native gap (see Known limitations).

## Observability

The SDK exposes no client/device id, so we mint our own and stamp it on events and
presence: `clientId` (device), `realmId` (surface), plus a one-time device
descriptor (platform, browser, runtime, raw user-agent) on `client.hello`. Every
event is then attributable to a device and surface — which is how the mobile bugs
were diagnosed. Suspensions log `mic.suspend.teardown {cause}` naming the tool
that triggered them, so a mis-classified navigating tool self-reports.

## Known limitations

- **No shared/background realm** for plugins — the call is trapped in a
  backgroundable surface. A shared context would remove the need for nav-gating.
- **No per-client navigation targeting** — `threads.open` hits all windows.
  Needed for the "phone is the mic, desktop is the driven screen" handoff model.
