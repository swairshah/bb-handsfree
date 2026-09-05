# Desktop navigation and native side-panel tabs

The desktop follow-up keeps the mobile drawer independent and uses BB's own
thread-page tabs. There is no custom desktop tab strip or viewport calculation.

## Behavior

| Where the call starts | Default for showing one thread | Setting |
| --- | --- | --- |
| Composer | Navigate to the thread | Navigate / Side panel |
| Handsfree / Aide page | Show in the page's single side-panel view | Navigate / Side panel |
| Sidebar, shortcut, command palette | Navigate | Override for one action by voice |

`callOrigin` is captured before starting the connection and included in the
session log and realtime instructions. Later composer mounts, tab selections,
and navigation do not change it. Settings are read when opening a thread, so a
saved preference takes effect on the next request within an existing call.

`focus_thread` accepts `destination: auto | navigate | panel` and
`disposition: auto | reuse | new`. A direct request overrides the saved default
for that action only. An explicit new/reuse disposition implies a side panel
unless a conflicting navigate destination was explicitly supplied. Conflicting
requests fail rather than guessing.

Ordinary unambiguous requests use saved defaults. Aide is instructed to ask one
short question when navigation, addition, or replacement is ambiguous, offering
only supported choices. "Also/as well" maps to a new separate tab; it must not
silently replace a view. The local dispatcher blocks replacing an already
targeted Handsfree Thread view unless disposition is explicitly `reuse`, returning
an instruction to clarify without changing the view. Natural-language intent
and the reply still depend on the voice model; that guidance needs live testing.

Results and activity labels distinguish workspace navigation, separate tabs,
the reusable preview, and the fixed Thread view. Because BB returns only an
acceptance boolean, a native-tab result says "opened or selected", not "created"
or "selected existing" without evidence. Replacement results name both targets.

Desktop `focus_threads` opens separate native side-panel tabs, regardless of the
single-thread destination/tab preference. Existing tabs remain, duplicates are
focused, and the first requested thread is selected. To show all running threads,
Aide first lists live threads and excludes recently finished entries. Batches
are limited to 100, with metadata verified before the first open. The native
host opens are sequential; a later decline reports which tabs were opened.

The `desktopComposerDestination`, `desktopAideDestination`, and
`desktopTabBehavior` settings are separate from `mobileViewBehavior`.
`set_desktop_behavior` changes them only when the user asks for a lasting
preference. These settings govern thread presentation requests (`focus_thread`
and `focus_threads`); other existing tool actions retain their behavior.

## Native tabs and SDK limits

On an existing thread page, `useBbNavigate().openThreadPanel` opens an actual BB
tab for each distinct `{ threadId }`. Reopening identical parameters selects
that native tab. Titles and project metadata are fetched fresh when rendering.
The optional reusable preview uses a single `{ preview: true }` tab and a
window-local target scoped to its owning thread page. BB persists the tab;
the preview target is intentionally transient, so it asks for a target after
a refresh. Dedicated thread tabs restore their persisted thread IDs.

The Aide page only has `experimental_useAppPanel().openFixedTab`. Its Thread
tab can be retargeted without moving the page. Requests for a batch or an explicit
new tab there fail before opening anything and explain that native multi-tabs
require an existing thread page. No arbitrary fixed-tab pool or internal
collection substitutes for native tabs. A matching dynamic plugin-page API
would be needed to remove this limitation.

BB owns tab closing, reordering, and the panel layout. The SDK does not expose
native-tab enumeration/closure to this plugin, so desktop does not expose the
mobile `manage_views` tool. Arbitrary other plugins also need an appropriate
BB surface API before Aide can open them this way.

## Local routing and context

### Browser, diffs, and other desktop surfaces

`open_browser({ url })` calls the calling surface's `useBbNavigate().openUrl`.
It accepts HTTP(S) URLs and follows BB's client browser preference: built-in or
external. The SDK cannot force the built-in browser or confirm page loading.
The tool reports host acceptance, never page-load success. It cannot inspect,
click, or type into web pages. Mobile rejects this tool even for a stale schema.

Desktop `show_diff({ thread_id?, path? })` opens a diff panel beside the call, independent
of thread-navigation preferences. Existing thread pages get native tabs keyed
by thread ID; the Aide page has one additional fixed Diff tab. The plugin uses
BB's `environments.diffFiles` / `diffPatch` APIs and `experimental_Diff` renderer,
with a file selector, Refresh, binary/large-file notices, and shared call
controls. This is a Handsfree panel using BB's renderer, not programmatic
selection of BB's built-in workspace Changes tab. Patches load one file at a
time. Refresh updates the snapshot; it does not subscribe to filesystem changes.
An optional changed-file path selects that file in the diff. On thread pages,
the tab identity remains the thread ID; a window-local selection request changes
the selected file without making another native tab. On Handsfree, the fixed
Diff tab receives the file path in its transient target. Omitted thread ID uses
the current context. A missing file fails before changing the displayed diff.
Mobile retains its existing spoken-summary behavior without navigation.

`preview_file({ path, thread_id?, line? })` uses BB’s native shared file preview
through `experimental_openFilePreview`. It defaults to the currently shown
thread, resolves that thread’s environment on the server, and passes an explicit
workspace target to the calling window. Paths are workspace-relative; optional
line numbers are one-based. This requests a preview without navigating or
opening an external editor. BB owns rendering and missing-file errors; the tool
reports acceptance, not completed loading. Late resolutions after call teardown
cannot open a preview, and mobile rejects the tool. Preferred external file
opening is also supported by the SDK but is not exposed by this tool.

BB's thread-page workspace preview rejects targets from another environment.
When that happens, Handsfree resolves the same file to its environment's host
and absolute path, then requests the supported native host-file preview. This
was verified for two workspaces on the same machine. The host can still decline
(for example, another machine); no route or external-app fallback occurs.
The error offers navigating to the owning thread or trying from Handsfree.

Terminal backend APIs support create/list/input/output/resize/
close/restart, but no frontend API selects the native Terminal tab or embeds
BB's terminal renderer. Those actions are not added here. Arbitrary third-party
plugin tabs are also outside the owner-scoped panel APIs.

SDK audit: declarations and lockfile now use 0.4.47. Browser destination overrides,
dynamic plugin-page thread tabs, general native-tab management, and native
Terminal-tab intents remain absent from the ordinary navigation hooks. The new
sidebar-navigation renderer receives host items and an activation callback;
that is a possible opt-in route to navigating other plugin pages, but requires
participating as the sidebar renderer and does not expose arbitrary panel tabs.
It has not been enabled as part of this change.

Presenters are registered in the calling window and checked at execution time.
Only the main thread composer can register its thread-page panel destination;
embedded composers cannot recursively register one. The desktop live-call
control retains its DOM reference so the presenter remains available after
Start changes into mute/stop controls. Mobile composer behavior is unchanged.

Navigation uses the calling window's `useBbNavigate().toThread`, with no
server-wide focus broadcast. It waits for the target route/composer binding
before reporting success, avoiding a second tool running during the gap between
old and new composers. Stopped calls cannot deliver late opens. A rejected
side-panel request never falls back to navigation without an explicit request.

The visible desktop thread panel provides thread/project context; closing or
hiding it restores ordinary surface bindings. `get_context` also reports call
origin and currently available side-panel/native-tab capabilities. Composer
text tools refuse to edit a composer that belongs to another shown thread.

## Validation

Automated tests cover device-specific registrations and tool schemas, origin
capture, preference persistence and overrides, native batch sequencing,
reusable preview isolation, rejected and partial opens, window-local routing,
late call results, and the existing mobile behavior.

Desktop UI verification uses the running BB app with a simulated WebRTC data
channel: real voice controls, SDK hooks, thread content, native tabs, and route
transitions; no microphone/OpenAI call is started. This verifies presentation,
not live audio continuity.

Before merging, retest a real voice call:

1. Start from a composer and ask to show another thread. The workspace should
   navigate and the call should continue. Ask about the current thread.
2. Ask to show a thread beside the call, then open all running threads. Confirm
   separate native tabs, no duplicates, and correct context when switching them.
3. Choose reusable previews and open two threads successively. Confirm one
   preview tab is retargeted and other native tabs stay open.
4. Start from the Aide page. Showing one thread should keep that page visible;
   a multiple-tab request should explain the limitation without navigating.
5. Override either default by voice and in settings. Confirm the saved default
   follows the call's original entry point even after navigation.
6. Keep a second window open. Navigation and side-panel opens should affect
   only the calling window. Mute/end controls should stay synchronized.
7. Recheck the mobile Aide drawer; desktop settings must not enable navigation
   or native desktop tab tools during a mobile call.
8. From a new desktop call on each entry point, ask to open a URL and show a
   thread's diff. Check the configured browser destination, switch diff files,
   refresh after an edit, and keep talking. Reopen the same diff to verify it
   selects the existing tab. Confirm call controls remain usable.

9. Ask “Preview README.md in this thread” and “Preview server.ts at line 40.”
   Repeat from Handsfree with a named thread, and with a thread in a different
   workspace. Confirm the correct file opens without changing the route.
10. On Handsfree, show one thread, then ask to show another “as well.” Aide
    should explain the single Thread-view limit and ask about replacement or
    navigation. Confirm the first view remains until you choose replacement.
11. With a diff open, ask “Show the changes to [a changed file],” then name a
    different changed file. Confirm the selected diff file changes in the same
    tab, without opening a full-file preview. A missing file should leave the
    displayed diff unchanged and prompt for a valid changed file.
