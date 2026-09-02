// Browser-side mirror of the shortcut bindings. The authoritative copy is the
// plugin's kv config (server.ts, edited under Settings → Keyboard shortcuts);
// this mirror exists so the window keydown listener in the content script —
// which runs outside React — can read the bindings synchronously, and so
// tooltips update the moment a binding changes. A localStorage cache seeds the
// mirror on page load, before any rpc round-trip has completed.
import { useEffect, useSyncExternalStore } from "react";
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import { clientDescriptor } from "./client-identity";
import { DEFAULT_SHORTCUTS, isMacPlatform, normalizeShortcuts, type Shortcuts } from "./shortcuts";

export const SHORTCUT_STORAGE_KEY = "bb-handsfree.shortcuts";

/** Whether Mod means ⌘ (macOS/iOS) or Ctrl on this client. */
export const MAC = isMacPlatform(clientDescriptor.platform);

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function readCache(): Shortcuts {
  try {
    return normalizeShortcuts(JSON.parse(storage()?.getItem(SHORTCUT_STORAGE_KEY) ?? "null"));
  } catch {
    return { ...DEFAULT_SHORTCUTS };
  }
}

class ShortcutStore {
  private value: Shortcuts = readCache();
  private recording = false;
  private listeners = new Set<() => void>();

  readonly get = (): Shortcuts => this.value;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Adopt the authoritative bindings (validated server-side) and cache them for the next page load. */
  set(next: unknown) {
    const normalized = normalizeShortcuts(next);
    if (normalized.toggle === this.value.toggle && normalized.mute === this.value.mute) return;
    this.value = normalized;
    try {
      storage()?.setItem(SHORTCUT_STORAGE_KEY, JSON.stringify(normalized));
    } catch {
      // Private mode or a full quota: the mirror still works for this page.
    }
    for (const listener of this.listeners) listener();
  }

  /** Another window saved new bindings (storage event): pick them up. */
  refresh() {
    this.set(readCache());
  }

  /** While the settings page captures a new combo, the global listener stands down. */
  isRecording(): boolean {
    return this.recording;
  }

  setRecording(on: boolean) {
    this.recording = on;
  }
}

export const shortcutStore = new ShortcutStore();

/** The live bindings, re-rendering when they change. */
export function useShortcuts(): Shortcuts {
  return useSyncExternalStore(shortcutStore.subscribe, shortcutStore.get);
}

/**
 * Pull the bindings from the kv config and keep them fresh across windows via
 * the `config-changed` signal. Mounted from the composer button, which is on
 * nearly every page, so the content-script listener sees edits promptly.
 */
export function useShortcutSync() {
  const rpc = useRpc<typeof rpcContract>();
  useEffect(() => {
    rpc.call("getConfig", null).then((config) => shortcutStore.set(config.shortcuts), () => undefined);
  }, [rpc]);
  useRealtime("config-changed", () => {
    rpc.call("getConfig", null).then((config) => shortcutStore.set(config.shortcuts), () => undefined);
  });
}
