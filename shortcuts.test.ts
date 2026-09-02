import test from "node:test";
import assert from "node:assert/strict";
import { isMacPlatform, matchShortcut, shortcutLabel } from "./shortcuts.ts";

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

test("platform detection and labels", () => {
  assert.equal(isMacPlatform("macOS"), true);
  assert.equal(isMacPlatform("iOS"), true);
  assert.equal(isMacPlatform("Windows"), false);
  assert.equal(isMacPlatform(""), false);
  assert.equal(shortcutLabel("toggle", true), "⌘+Shift+H");
  assert.equal(shortcutLabel("mute", false), "Ctrl+Shift+U");
});
