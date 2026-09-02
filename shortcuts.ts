// Keyboard shortcuts for the voice call. bb's keybinding registry is a fixed
// enum of host commands, so the plugin listens on the window from its content
// script instead. Mod = Cmd on macOS, Ctrl elsewhere.

export type ShortcutAction = "toggle" | "mute";

export const SHORTCUTS: Record<ShortcutAction, { key: string; label: string }> = {
  toggle: { key: "h", label: "Mod+Shift+H" },
  mute: { key: "u", label: "Mod+Shift+U" },
};

export interface ShortcutKeyEvent {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  repeat?: boolean;
  isComposing?: boolean;
}

export function isMacPlatform(platform: string): boolean {
  return /^(mac|iOS|iPhone|iPad)/i.test(platform);
}

/** Map a keydown to a shortcut action, or null when it isn't one of ours. */
export function matchShortcut(event: ShortcutKeyEvent, mac: boolean): ShortcutAction | null {
  if (event.repeat || event.isComposing || event.altKey || !event.shiftKey) return null;
  const mod = mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  if (!mod) return null;
  const key = event.key.toLowerCase();
  for (const action of Object.keys(SHORTCUTS) as ShortcutAction[]) {
    if (SHORTCUTS[action].key === key) return action;
  }
  return null;
}

export function shortcutLabel(action: ShortcutAction, mac: boolean): string {
  return SHORTCUTS[action].label.replace("Mod", mac ? "⌘" : "Ctrl");
}
