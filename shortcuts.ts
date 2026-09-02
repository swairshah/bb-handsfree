// Keyboard shortcuts for the voice call. bb's keybinding registry is a fixed
// enum of host commands, so the plugin listens on the window from its content
// script instead (see app.tsx); the user can rebind them under Settings →
// Handsfree → Keyboard shortcuts.
//
// Shared between server.ts (validation) and the frontend (matching, labels,
// capture): plain data, no browser globals.
//
// A shortcut is stored as a canonical string such as "Mod+Shift+H": zero or
// more of Mod / Shift / Alt, then exactly one key. Mod is ⌘ on macOS and iOS
// and Ctrl elsewhere, so a saved value means the same keystroke on every
// device.

export type ShortcutAction = "toggle" | "mute";
export type Shortcuts = Record<ShortcutAction, string>;

export const SHORTCUT_ACTIONS: readonly ShortcutAction[] = ["toggle", "mute"];

export const SHORTCUT_ACTION_LABELS: Record<ShortcutAction, string> = {
  toggle: "Start or stop the call",
  mute: "Mute or unmute the microphone",
};

export const DEFAULT_SHORTCUTS: Shortcuts = {
  toggle: "Mod+Shift+H",
  mute: "Mod+Shift+U",
};

/**
 * Combinations bb binds itself. Refusing them avoids a tug-of-war where both
 * the host and this plugin react to the same keystroke.
 */
export const RESERVED_SHORTCUTS: Readonly<Record<string, string>> = {
  "Mod+Shift+P": "bb's command palette",
  "Mod+Shift+M": "bb's model picker",
};

export interface ShortcutCombo {
  mod: boolean;
  shift: boolean;
  alt: boolean;
  /**
   * Single characters are lower-cased ("h", "1", "/"); named keys keep their
   * DOM name ("F9", "ArrowUp"). Space and "+" are spelled out so they survive
   * the "+"-joined string form.
   */
  key: string;
}

/** The subset of KeyboardEvent the matcher reads, so tests can pass plain objects. */
export interface ShortcutKeyEvent {
  key: string;
  code?: string;
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

const MODIFIER_KEY_NAMES = new Set([
  "Shift",
  "Control",
  "Alt",
  "AltGraph",
  "Meta",
  "OS",
  "Fn",
  "FnLock",
  "CapsLock",
  "NumLock",
  "ScrollLock",
  "Hyper",
  "Super",
  "Symbol",
  "SymbolLock",
]);

/** A keydown for a modifier on its own (Shift, Control, …), never a full combo. */
export function isModifierKey(key: string): boolean {
  return MODIFIER_KEY_NAMES.has(key);
}

function normalizeKey(key: string): string {
  if (key === " " || key === "Spacebar") return "Space";
  if (key === "+") return "Plus";
  return key.length === 1 ? key.toLowerCase() : key;
}

/** Parse a stored string into its parts; null when it isn't well-formed. */
export function parseShortcut(value: string): ShortcutCombo | null {
  if (typeof value !== "string") return null;
  const parts = value.split("+").map((part) => part.trim());
  const key = normalizeKey(parts.pop() ?? "");
  if (!key || isModifierKey(key)) return null;
  const combo: ShortcutCombo = { mod: false, shift: false, alt: false, key };
  for (const part of parts) {
    const name = part.toLowerCase();
    if (name === "mod") combo.mod = true;
    else if (name === "shift") combo.shift = true;
    else if (name === "alt") combo.alt = true;
    else return null;
  }
  return combo;
}

/** The canonical string form: Mod, Shift, Alt, then the key (upper-cased when it's one character). */
export function formatShortcut(combo: ShortcutCombo): string {
  const parts: string[] = [];
  if (combo.mod) parts.push("Mod");
  if (combo.shift) parts.push("Shift");
  if (combo.alt) parts.push("Alt");
  parts.push(combo.key.length === 1 ? combo.key.toUpperCase() : combo.key);
  return parts.join("+");
}

/** Canonical spelling of a stored value, or null when it isn't well-formed. */
export function canonicalShortcut(value: string): string | null {
  const combo = parseShortcut(value);
  return combo ? formatShortcut(combo) : null;
}

/**
 * Key identity for matching and capture. Letters and digits come from the
 * physical key (`code`) because Alt on macOS turns "k" into "˚" and Shift turns
 * "1" into "!"; everything else uses `key` so named keys read naturally.
 */
export function eventKey(event: ShortcutKeyEvent): string {
  const code = event.code ?? "";
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) return letter[1].toLowerCase();
  const digit = /^Digit(\d)$/.exec(code);
  if (digit) return digit[1];
  return normalizeKey(event.key);
}

/**
 * The combination a keydown represents, or null when it isn't one we could
 * bind: a bare modifier, or the platform's *other* primary modifier (Ctrl on
 * macOS, Meta elsewhere), which isn't part of the Mod/Shift/Alt vocabulary.
 */
export function comboFromEvent(event: ShortcutKeyEvent, mac: boolean): ShortcutCombo | null {
  if (isModifierKey(event.key)) return null;
  if (mac ? event.ctrlKey : event.metaKey) return null;
  return {
    mod: mac ? event.metaKey : event.ctrlKey,
    shift: event.shiftKey,
    alt: event.altKey,
    key: eventKey(event),
  };
}

function sameCombo(a: ShortcutCombo, b: ShortcutCombo): boolean {
  return a.mod === b.mod && a.shift === b.shift && a.alt === b.alt && a.key === b.key;
}

/** Whether two stored values mean the same keystroke (spelling-insensitive). */
export function sameShortcut(a: string, b: string): boolean {
  const canonical = canonicalShortcut(a);
  return canonical !== null && canonical === canonicalShortcut(b);
}

/** Map a keydown to a shortcut action, or null when it isn't one of ours. */
export function matchShortcut(
  event: ShortcutKeyEvent,
  mac: boolean,
  shortcuts: Shortcuts = DEFAULT_SHORTCUTS,
): ShortcutAction | null {
  if (event.repeat || event.isComposing) return null;
  const pressed = comboFromEvent(event, mac);
  if (!pressed) return null;
  for (const action of SHORTCUT_ACTIONS) {
    const combo = parseShortcut(shortcuts[action]);
    if (combo && sameCombo(combo, pressed)) return action;
  }
  return null;
}

/** A combination that can't fire while merely typing: Mod or Alt is held, or it's a function key. */
function usableAlone(combo: ShortcutCombo): boolean {
  return combo.mod || combo.alt || /^F([1-9]|1[0-9]|2[0-4])$/.test(combo.key);
}

/** A well-formed stored value that won't fire while merely typing. */
export function isValidShortcut(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const combo = parseShortcut(value);
  return combo !== null && usableAlone(combo);
}

/**
 * Why `value` can't be bound to `action`, or null when it can. `current` is
 * the full set, so the other actions' bindings are checked for collisions.
 */
export function shortcutProblem(
  value: string,
  action: ShortcutAction,
  current: Shortcuts,
  mac: boolean,
): string | null {
  const combo = parseShortcut(value);
  if (!combo) return "That isn't a usable key combination.";
  if (combo.key === "Escape") return "Escape can't be a shortcut.";
  if (!usableAlone(combo)) {
    return mac
      ? "Include ⌘ or ⌥ (or use a function key) so it can't fire while typing."
      : "Include Ctrl or Alt (or use a function key) so it can't fire while typing.";
  }
  const canonical = formatShortcut(combo);
  const label = shortcutLabel(canonical, mac);
  const reserved = RESERVED_SHORTCUTS[canonical];
  if (reserved) return `${label} is ${reserved}.`;
  for (const other of SHORTCUT_ACTIONS) {
    if (other !== action && sameShortcut(current[other], canonical)) {
      return `${label} is already used to ${SHORTCUT_ACTION_LABELS[other].toLowerCase()}.`;
    }
  }
  return null;
}

/**
 * Coerce whatever was stored into a full, canonical set: each action falls
 * back to its default when its value is missing or unusable, and a collision
 * between the two actions is broken in favor of the toggle.
 */
export function normalizeShortcuts(input: unknown): Shortcuts {
  const source = (input ?? {}) as Partial<Record<ShortcutAction, unknown>>;
  const result: Shortcuts = { ...DEFAULT_SHORTCUTS };
  for (const action of SHORTCUT_ACTIONS) {
    const value = source[action];
    if (isValidShortcut(value)) result[action] = canonicalShortcut(value) ?? DEFAULT_SHORTCUTS[action];
  }
  if (sameShortcut(result.toggle, result.mute)) {
    result.mute = DEFAULT_SHORTCUTS.mute;
    if (sameShortcut(result.toggle, result.mute)) result.toggle = DEFAULT_SHORTCUTS.toggle;
  }
  return result;
}

const KEY_DISPLAY: Readonly<Record<string, string>> = {
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  Escape: "Esc",
  Plus: "+",
};

function displayKey(key: string): string {
  return KEY_DISPLAY[key] ?? (key.length === 1 ? key.toUpperCase() : key);
}

/** Human-readable parts, e.g. ["⌘", "Shift", "H"] — one keycap each in the settings UI. */
export function shortcutLabelParts(value: string, mac: boolean): string[] {
  const combo = parseShortcut(value);
  if (!combo) return [value];
  const parts: string[] = [];
  if (combo.mod) parts.push(mac ? "⌘" : "Ctrl");
  if (combo.shift) parts.push("Shift");
  if (combo.alt) parts.push(mac ? "⌥" : "Alt");
  parts.push(displayKey(combo.key));
  return parts;
}

export function shortcutLabel(value: string, mac: boolean): string {
  return shortcutLabelParts(value, mac).join("+");
}
