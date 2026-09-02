import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_SHORTCUTS,
  canonicalShortcut,
  comboFromEvent,
  formatShortcut,
  isMacPlatform,
  isValidShortcut,
  matchShortcut,
  normalizeShortcuts,
  parseShortcut,
  shortcutLabel,
  shortcutLabelParts,
  shortcutProblem,
} from "./shortcuts.ts";

const base = { metaKey: false, ctrlKey: false, shiftKey: false, altKey: false };

test("Cmd+Shift+H toggles on mac, Ctrl+Shift+H elsewhere", () => {
  assert.equal(matchShortcut({ ...base, key: "H", metaKey: true, shiftKey: true }, true), "toggle");
  assert.equal(matchShortcut({ ...base, key: "h", ctrlKey: true, shiftKey: true }, false), "toggle");
  // Wrong modifier for the platform is not ours.
  assert.equal(matchShortcut({ ...base, key: "h", ctrlKey: true, shiftKey: true }, true), null);
  assert.equal(matchShortcut({ ...base, key: "h", metaKey: true, shiftKey: true }, false), null);
});

test("Mod+Shift+U mutes; plain/alt/repeat/composing keys are ignored", () => {
  assert.equal(matchShortcut({ ...base, key: "u", metaKey: true, shiftKey: true }, true), "mute");
  assert.equal(matchShortcut({ ...base, key: "h", shiftKey: true }, true), null);
  assert.equal(matchShortcut({ ...base, key: "h", metaKey: true }, true), null);
  assert.equal(matchShortcut({ ...base, key: "h", metaKey: true, shiftKey: true, altKey: true }, true), null);
  assert.equal(matchShortcut({ ...base, key: "h", metaKey: true, shiftKey: true, repeat: true }, true), null);
  assert.equal(matchShortcut({ ...base, key: "h", metaKey: true, shiftKey: true, isComposing: true }, true), null);
  assert.equal(matchShortcut({ ...base, key: "x", metaKey: true, shiftKey: true }, true), null);
});

test("custom bindings are honored and defaults stop matching", () => {
  const custom = { toggle: "Mod+Alt+K", mute: "F9" };
  assert.equal(matchShortcut({ ...base, key: "k", metaKey: true, altKey: true }, true, custom), "toggle");
  assert.equal(matchShortcut({ ...base, key: "F9" }, false, custom), "mute");
  assert.equal(matchShortcut({ ...base, key: "h", metaKey: true, shiftKey: true }, true, custom), null);
  assert.equal(matchShortcut({ ...base, key: "u", ctrlKey: true, shiftKey: true }, false, custom), null);
});

test("letters and digits match by physical key, so Alt/Shift symbols still work", () => {
  // Alt+K on macOS reports key "˚"; Shift+1 reports "!".
  const custom = { toggle: "Mod+Alt+K", mute: "Mod+Shift+1" };
  assert.equal(matchShortcut({ ...base, key: "˚", code: "KeyK", metaKey: true, altKey: true }, true, custom), "toggle");
  assert.equal(matchShortcut({ ...base, key: "!", code: "Digit1", metaKey: true, shiftKey: true }, true, custom), "mute");
});

test("capture: bare modifiers and the off-platform modifier are not combos", () => {
  assert.equal(comboFromEvent({ ...base, key: "Shift", shiftKey: true }, true), null);
  assert.equal(comboFromEvent({ ...base, key: "Meta", metaKey: true }, true), null);
  assert.equal(comboFromEvent({ ...base, key: "x", ctrlKey: true }, true), null);
  assert.equal(comboFromEvent({ ...base, key: "x", metaKey: true }, false), null);
  const combo = comboFromEvent({ ...base, key: "ArrowUp", ctrlKey: true, altKey: true }, false);
  assert.deepEqual(combo, { mod: true, shift: false, alt: true, key: "ArrowUp" });
  assert.equal(formatShortcut(combo!), "Mod+Alt+ArrowUp");
  assert.equal(formatShortcut(comboFromEvent({ ...base, key: " ", metaKey: true }, true)!), "Mod+Space");
});

test("parse/format round-trip and canonical spelling", () => {
  assert.deepEqual(parseShortcut("Mod+Shift+H"), { mod: true, shift: true, alt: false, key: "h" });
  assert.equal(canonicalShortcut("shift+mod+h"), "Mod+Shift+H");
  assert.equal(canonicalShortcut("Mod+Alt+ArrowLeft"), "Mod+Alt+ArrowLeft");
  assert.equal(canonicalShortcut("F5"), "F5");
  assert.equal(parseShortcut(""), null);
  assert.equal(parseShortcut("Mod+"), null);
  assert.equal(parseShortcut("Ctrl+H"), null);
  assert.equal(parseShortcut("Mod+Shift"), null);
});

test("validity: needs Mod or Alt unless it's a function key", () => {
  assert.equal(isValidShortcut("Mod+Shift+H"), true);
  assert.equal(isValidShortcut("Alt+J"), true);
  assert.equal(isValidShortcut("F9"), true);
  assert.equal(isValidShortcut("Shift+H"), false);
  assert.equal(isValidShortcut("H"), false);
  assert.equal(isValidShortcut(42), false);
  assert.equal(isValidShortcut("Mod+Foo+H"), false);
});

test("problems: unusable, reserved, and colliding combos are explained", () => {
  const current = { ...DEFAULT_SHORTCUTS };
  assert.match(shortcutProblem("Shift+H", "toggle", current, true) ?? "", /⌘ or ⌥/);
  assert.match(shortcutProblem("H", "toggle", current, false) ?? "", /Ctrl or Alt/);
  assert.match(shortcutProblem("Mod+Shift+P", "toggle", current, true) ?? "", /command palette/);
  assert.match(shortcutProblem("Mod+Shift+M", "mute", current, false) ?? "", /model picker/);
  assert.match(shortcutProblem("Mod+Shift+U", "toggle", current, true) ?? "", /already used to mute/);
  assert.match(shortcutProblem("mod+shift+h", "mute", current, true) ?? "", /already used to start or stop/);
  assert.equal(shortcutProblem("Mod+Shift+H", "toggle", current, true), null); // rebinding to itself is fine
  assert.equal(shortcutProblem("Mod+Alt+K", "toggle", current, true), null);
  assert.equal(shortcutProblem("F9", "mute", current, false), null);
  assert.match(shortcutProblem("Escape", "mute", current, false) ?? "", /Escape/);
});

test("normalize: garbage falls back per action, spelling is canonicalized, collisions break toward toggle", () => {
  assert.deepEqual(normalizeShortcuts(undefined), DEFAULT_SHORTCUTS);
  assert.deepEqual(normalizeShortcuts("nope"), DEFAULT_SHORTCUTS);
  assert.deepEqual(normalizeShortcuts({ toggle: "alt+k", mute: 7 }), { toggle: "Alt+K", mute: "Mod+Shift+U" });
  assert.deepEqual(normalizeShortcuts({ toggle: "Shift+H", mute: "F9" }), { toggle: "Mod+Shift+H", mute: "F9" });
  assert.deepEqual(normalizeShortcuts({ toggle: "Mod+Alt+K", mute: "Mod+Alt+K" }), { toggle: "Mod+Alt+K", mute: "Mod+Shift+U" });
  assert.deepEqual(normalizeShortcuts({ toggle: "Mod+Shift+U", mute: "Mod+Shift+U" }), DEFAULT_SHORTCUTS);
});

test("platform detection and labels", () => {
  assert.equal(isMacPlatform("macOS"), true);
  assert.equal(isMacPlatform("iOS"), true);
  assert.equal(isMacPlatform("Windows"), false);
  assert.equal(isMacPlatform(""), false);
  assert.equal(shortcutLabel("Mod+Shift+H", true), "⌘+Shift+H");
  assert.equal(shortcutLabel("Mod+Shift+U", false), "Ctrl+Shift+U");
  assert.deepEqual(shortcutLabelParts("Mod+Alt+ArrowUp", true), ["⌘", "⌥", "↑"]);
  assert.deepEqual(shortcutLabelParts("F9", false), ["F9"]);
});
