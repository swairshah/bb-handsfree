# Desktop navigation: separate follow-up

Status: design proposal, not enabled by the mobile drawer PR.

The broader prototype is preserved at commit `0755bcf` on
`handsfree/desktop-views-exploration`. It is reference material, not the desired
final desktop behavior: it replaced navigation globally and put multiple views
inside one tab. The mobile PR restores existing desktop navigation.

## Product contract

Desktop must continue supporting “take me to that thread,” which navigates the
main UI and reorients the workspace. Users who prefer keeping their current
workspace in place should be able to choose side-panel presentation instead.
These choices should depend on where the voice call was started.

Proposed defaults and choices:

| Call entry point | Default | Opt-in alternative |
| --- | --- | --- |
| Thread composer | Navigate to the requested thread | Open beside the current work |
| Aide / Handsfree page | Navigate to the requested thread | Open beside the call |
| Sidebar / global shortcut | Navigate | Use the current surface's supported panel |

A direct request such as “open it beside me” or “take me there” overrides the
saved default for that action. A separate tab policy determines whether a
side-panel open reuses a tab or creates/focuses another native tab. Destination
and tab reuse are independent choices; one global “companion mode” toggle does
not express them clearly enough.

An initial settings design can use two explicit rows, “Calls started from the
composer” and “Calls started from Aide,” each with Navigate / Side panel.
Decide whether global/sidebar starts need their own row or inherit the current
surface's preference after trying the flow. Defaults preserve production.

## Implementation boundaries

Capture `callOrigin` once at call creation. Do not infer it from whichever
composer most recently rebinds the voice singleton. Separately resolve the
current available destination when a tool executes; the user can navigate
while the call continues. The owning device/window must receive the action.

For existing thread pages, the installed SDK supports native plugin panel tabs:
`openThreadPanel` opens distinct tabs for distinct parameters and focuses an
existing tab for identical parameters. That can implement “open all my running
threads” as actual host tabs rather than a dropdown inside one tab.

For the Handsfree plugin page, `fixedTabs` is a static declaration. Retargeting a
fixed tab does not create another native tab. A production API for dynamic plugin
page tabs is needed for equivalent host-native behavior there. Avoid predeclaring
an arbitrary pool of empty tabs or silently substituting an internal tab strip.

The existing typed collection and local presenter separation can inform the
follow-up, but the correct native-tab behavior should drive its implementation.
Opening arbitrary other plugins needs a supported cross-plugin surface contract
from bb. Additional first-party renderers can be added as those contracts become
available; no private component imports or speculative plugin registry.

## Mobile remains independent

Desktop destination settings must never permit mobile call-breaking navigation.
Mobile continues using its drawer while a call is live. Its view reuse preference
is separate, and does not control desktop behavior. We should not call switching
items in the mobile drawer “multiple native tabs.”

## Questions to settle before implementing

- How should a temporary voice override interact with a saved per-origin choice?
- Where should a sidebar/global call open a side panel if its current page has
  no supported destination?
- Should a side-panel destination follow current focus or remain attached to the
  surface where the call began?
- What native tab API will bb expose for plugin pages and other plugins?

A separate desktop PR should demonstrate both navigation and side-panel flows
from each supported origin, plus native tab deduplication and batch opens.
