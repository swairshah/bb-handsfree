# Mobile thread views beside a call

This PR changes mobile thread presentation. Desktop `focus_thread` retains the
existing `bb.sdk.threads.open` navigation, whether the call starts from the
composer or Handsfree page. Desktop destination preferences are a separate
proposal in [desktop-navigation-plan.md](desktop-navigation-plan.md).

On mobile, the merged implementation refused `focus_thread` during a live call
and told the user what to tap, because navigating away could suspend the owning
webview's microphone. The drawer replaces that refusal without navigating away.
The previous phone test confirmed opening and swapping threads with a live call.
This implementation still needs a device regression test before merging.

## Mobile behavior

- `focus_thread({ thread_id, disposition? })` shows or selects one thread.
  The default replaces the shown thread; `new` preserves existing views, and
  `auto` uses the saved mobile preference.
- `focus_threads({ thread_ids })` adds a batch and selects the first requested
  thread. Existing views remain available; repeated IDs are deduplicated.
- `manage_views({ action: "list" | "select" | "close" | "clear", view_id? })`
  controls the same mobile collection as the UI. Closing a view does not stop
  its thread or the call.
- `set_view_behavior({ behavior: "reuse" | "new" })` saves a preference only
  when the user asks for a lasting mobile change. Settings → Behavior → Mobile
  thread drawer exposes the same `mobileViewBehavior` preference.

The drawer shows one thread with a selector when retaining several. These are
views inside one host drawer, **not separate native bb tabs**. A batch always
keeps all requested threads. To show all running threads, the model uses
`list_live_threads`, excludes `recently-finished` entries, and passes the IDs to
`focus_threads` (up to 100 per batch, splitting larger lists).

Metadata is resolved before revealing the collection. A failed lookup rejects
the batch without changing the current views. Only the active chat mounts; bb
owns drafts scoped to their threads. The collection survives drawer remounts
within the loaded app session, but not refresh/restart/plugin reload.

## Desktop compatibility

The frontend sends its mobile classification at call creation. Desktop sessions
receive the original navigation-oriented `focus_thread` schema, without a tab
disposition parameter or mobile view-management tools. Mobile settings cannot
change desktop navigation. The client also rejects mobile-only tools from stale
desktop sessions that may still know about them.

App registration runs in each client. Only mobile clients register the Handsfree
fixed drawer tab and thread-page panel action. Desktop therefore gains no new
Views tab or panel launcher entry. This is supported with static registrations
chosen at client initialization; it does not imply an API for dynamically
creating arbitrary native tabs on a plugin page.

## Local surfaces and context

- Handsfree page: its fixed drawer view through `experimental_useAppPanel`.
- Existing mobile thread page: a reusable local panel through `openThreadPanel`.
- Embedded chats never register recursive panel destinations.
- A runtime with no available local presenter reports the limitation. It does
  not broadcast navigation or fall back to navigating away from a mobile call.

Ordinary web slots share their plugin module. Separate native webviews/windows
may have separate runtimes. Call presence does not establish that another
runtime is a valid destination, so the old server-wide view relay is removed.

On mobile, the selected visible view supplies voice thread/project context.
After the drawer is hidden/unmounted, ordinary surface bindings supply context.
Embedded composers use their actual composer scope, bindings unregister on
unmount, and voice refuses edits into a composer belonging to a different
thread. Desktop continues to use normal surface context.

A host boolean confirms acceptance, not completed rendering. Declines and
exceptions return a tool error; a late lookup after the call stops cannot open
anything. The host chat handles loading/deleted-thread states, with a local
error boundary containing rendering exceptions.

## Shared event consistency

`tool.call` and `tool.result` describe local and server-handled actions. They
share call IDs, session/device identity, and explicit success/error outcomes.
Results pair by call ID; a compatibility reader handles historical sessions.

`logEvent` persists an event and mirrors that same event with its database ID
and timestamp into the plugin log. The separate server-only `voice tool:` line
is removed. Failed tool results also mark the session's error filter.

Client writes are ordered without blocking audio. They still depend on the RPC
connection; failed persistence is reported in the client console. Plugin logs
rotate independently of the durable database. Historical retention differs,
and old events are not copied retroactively.

## Validation

Tests cover desktop navigation from both call entry points, device-specific
registration and tool schemas, mobile preferences/batches/switching, rejected
opens, runtime isolation, context and binding cleanup, late results, database/log
parity using the SDK fake host, and drawer controls using its React harness.
The harness does not reproduce native microphone or drawer behavior.

Before merging:

1. On mobile, start from Handsfree; open/swap threads, dismiss/reopen the drawer,
   and keep talking. Repeat from a thread composer.
2. Switch across projects, ask what thread is shown, then dismiss the drawer and
   verify context returns to the underlying surface.
3. Draft text, switch away and return; verify the draft is preserved.
4. Show all running threads; verify recently finished entries are excluded and
   each requested thread appears once in the switcher.
5. Change the mobile preference in settings and by voice. On desktop, verify
   `focus_thread` still navigates from both Handsfree and a composer regardless.
6. Keep another window/device open; a mobile drawer request must not change it.
7. Match tool call IDs and outcomes in the session transcript and plugin logs.
