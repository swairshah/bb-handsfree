# Thread views beside a call

Handsfree keeps a collection of views in the calling window. bb supplies the
host panel (a drawer on compact mobile surfaces); Handsfree supplies its contents,
selection, and close controls. The initial view type is a thread, rendered by the
host's `ThreadChat` component.

## Behavior

- `focus_thread({ thread_id, disposition? })` shows or selects one thread.
- `focus_threads({ thread_ids })` adds a batch and selects the first requested
  thread. Existing views remain available. Repeated IDs never create duplicates.
- `manage_views({ action: "list" | "select" | "close" | "clear", view_id? })`
  lets voice inspect and manage the same collection as the UI. View IDs come from
  `list`. Closing views does not stop their threads or the voice call.
- `set_view_behavior({ behavior: "auto" | "reuse" | "new" })` saves a preference
  only when the user asks for a lasting change. The same preference appears in
  Handsfree settings under Behavior → Thread tabs.

Automatic behavior replaces the active tab on mobile and keeps separate tabs on
desktop. Explicit `reuse` or `new` overrides the preference. A batch always keeps
all its requested threads. Reopening an existing thread selects it even under
`reuse`; it does not discard a different tab unnecessarily.

“Show all my running threads” uses `list_live_threads`, excludes
`recently-finished` entries, then calls `focus_threads`. Batches contain at most
100 IDs; larger lists can be opened in successive batches. Metadata is resolved
before revealing the collection, and a failed lookup rejects that batch without
changing its tabs.

Desktop shows buttons for open threads; mobile shows one thread with a selector.
Only the active thread chat is mounted. bb owns its draft state (scoped to the
thread), so switching views does not require Handsfree to copy or manage drafts.
The collection survives panel dismissal/remount during the loaded app session.
It does not persist across an app refresh, restart, or plugin reload.

## Surfaces and ownership

- Handsfree page: the fixed Views tab via `experimental_useAppPanel`.
- Existing thread page: one reusable Handsfree views panel via `openThreadPanel`.
- Embedded thread chats do not register another destination, preventing recursive
  panels. Their composer bindings use their actual composer scope rather than
  the outer page route.
- A call originating in a runtime with no available local presenter reports an
  error. There is no cross-device or cross-window navigation broadcast.

Web slots share the loaded plugin module. Separate native webviews/windows may
have separate runtimes. A presenter's local availability is a capability, not
something inferred from another device's call presence. The prior server relay
has been removed; no claim is made that it can reveal a view in an arbitrary
native webview.

The selected **visible** view supplies the thread and project for voice context.
Once the panel unmounts or is hidden, ordinary surface bindings supply context.
Unmounted composer bindings are removed, and voice refuses composer edits when
the bound composer does not belong to the shown thread.

The host's boolean open result confirms acceptance, not completed rendering or
successful thread loading. We handle declines and exceptions as failures. The
host chat handles loading/deleted-thread states; a rendering exception is
contained within the view. A stopped/replaced call cannot reveal the results of
its late metadata lookup.

## Event consistency

`tool.call` and `tool.result` describe both local and server-handled actions.
Their shared call ID pairs results without relying on tool names or arrival
order. New tool results carry explicit success/error status. Human labels can
name the thread; transport details remain outside the product flow.

`logEvent` persists each event, then mirrors that exact event with its database
ID, timestamp, session ID, and client/runtime identity into the plugin log.
Server-side tool execution no longer writes a competing `voice tool:` entry.
Session error filtering includes failed tool results. Legacy transcripts without
call IDs or explicit status retain a compatibility reader.

Client writes are ordered and do not block audio. Persistence is still dependent
on the RPC connection; failed writes surface in the client console. Plugin logs
rotate separately from the durable session database, so historical retention is
not identical and old events are not retroactively copied into plugin logs.

## Extension boundary

`WorkspaceView` is a discriminated union, initially containing `ThreadView`.
Collection operations (add, replace, select, close) and host presentation are
separate from rendering. A future supported first-party view can add a target
shape and renderer without changing the thread-opening preference or tab logic.

There is no public cross-plugin tab registry in this implementation. Embedding
arbitrary other plugins, revealing native terminals, and controlling the host's
drawer geometry require the relevant bb APIs. Once bb exposes a supported
cross-plugin surface contract, adapt that contract into a new view type; do not
load another plugin's private components or imitate its UI.

The current host API exposes static, non-closable fixed-tab declarations, so the
Views host tab is also present on desktop. Individual views inside it are
closable. Neither the plugin nor this API can guarantee audio while the OS
suspends the app.

## Validation

Automated coverage includes collection behavior, preferences, duplicate and
batch opens, rejected/throwing/missing presenters, runtime isolation, context and
binding cleanup, late call results, event correlation, actual database/log
parity through the SDK fake host, and desktop/mobile UI controls through the SDK
React harness. The harness does not emulate native panel layout or microphones.

Before merging, exercise these in the real app:

1. Start a call from Handsfree. Open two threads in separate tabs, switch,
   close one, dismiss/reopen the drawer, and confirm the call stays live.
2. Repeat from an existing thread composer, including a different project.
   Ask “what thread am I looking at?” after each switch and after dismissal.
3. Dictate a draft, switch tabs, and return; confirm the draft is preserved.
4. Ask to show all running threads; confirm recently finished threads are
   excluded and every requested thread appears once.
5. Change the tab preference by voice and in settings; test explicit reuse/new.
6. Keep another device/window open; its view collection must not change.
7. Inspect that phone session and `bb plugin logs handsfree`: tool call IDs,
   result status, and device/session identity should agree.
