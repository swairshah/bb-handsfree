export interface AudioDeviceLike {
  deviceId: string;
  kind: MediaDeviceKind;
  label: string;
}

/**
 * Only the microphone is user-selectable. Speaker output always uses the system
 * default (routing a specific sink via `setSinkId` proved unreliable in the bb
 * webview and added little over the OS default). We remember the chosen mic's
 * label as well as its id so a restart that rotates device ids can re-match it.
 */
export interface AudioDevicePreferences {
  inputDeviceId: string;
  inputLabel: string;
}

interface PreferenceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): unknown;
}

export const AUDIO_DEVICE_STORAGE_KEY = "bb-handsfree.audio-devices";
const DEFAULT_PREFERENCES: AudioDevicePreferences = {
  inputDeviceId: "",
  inputLabel: "",
};

export function readAudioDevicePreferences(storage: PreferenceStorage): AudioDevicePreferences {
  try {
    const parsed = JSON.parse(storage.getItem(AUDIO_DEVICE_STORAGE_KEY) ?? "null") as Record<string, unknown> | null;
    return {
      inputDeviceId: typeof parsed?.inputDeviceId === "string" ? parsed.inputDeviceId : "",
      inputLabel: typeof parsed?.inputLabel === "string" ? parsed.inputLabel : "",
    };
  } catch {
    return { ...DEFAULT_PREFERENCES };
  }
}

export function writeAudioDevicePreferences(
  storage: PreferenceStorage,
  preferences: AudioDevicePreferences,
): boolean {
  try {
    storage.setItem(AUDIO_DEVICE_STORAGE_KEY, JSON.stringify(preferences));
    return true;
  } catch {
    return false;
  }
}

export function audioCaptureConstraint(deviceId: string): true | MediaTrackConstraints {
  return deviceId ? { deviceId: { exact: deviceId } } : true;
}

export function shouldRetryWithDefaultDevice(error: unknown): boolean {
  const name = typeof error === "object" && error !== null && "name" in error
    ? String(error.name)
    : "";
  return name === "OverconstrainedError" || name === "NotFoundError";
}

export function deviceDisplayLabel(device: AudioDeviceLike, index: number): string {
  if (device.label) return device.label;
  return `${device.kind === "audioinput" ? "Microphone" : "Speaker"} ${index + 1}`;
}

export type MicPermission = "granted" | "denied" | "prompt" | "unknown";

/**
 * A deterministic snapshot of what the browser can actually do right now,
 * derived purely from an enumerated device list and the saved preferences.
 * The UI grays out controls from this; the session decides fallbacks from it.
 */
export interface AudioSupport {
  /** At least one usable input device is present. */
  hasInput: boolean;
  /** At least one output device is present (playback uses the system default). */
  hasOutput: boolean;
  /** The saved mic is empty (system default) or still resolvable (by id or label). */
  inputValid: boolean;
  /**
   * Inputs exist but every label is blank — the browsing context has not been
   * granted mic access yet, so ids/labels are still privacy-gated.
   */
  labelsHidden: boolean;
}

export function describeAudioSupport(
  devices: AudioDeviceLike[],
  preferences: AudioDevicePreferences,
): AudioSupport {
  const inputs = devices.filter((device) => device.kind === "audioinput" && device.deviceId);
  const outputs = devices.filter((device) => device.kind === "audiooutput" && device.deviceId);
  const inputMatch = resolveDevice(
    devices,
    "audioinput",
    preferences.inputDeviceId,
    preferences.inputLabel,
  );
  return {
    hasInput: inputs.length > 0,
    hasOutput: outputs.length > 0,
    inputValid: !preferences.inputDeviceId || inputMatch.matchedBy !== "default",
    labelsHidden: inputs.length > 0 && inputs.every((device) => !device.label),
  };
}

/** How a saved device was resolved against the currently present devices. */
export type DeviceMatch = "id" | "label" | "default";

export interface ResolvedDevice {
  /** The device id to use; "" means the system default. */
  deviceId: string;
  matchedBy: DeviceMatch;
}

/**
 * Resolve a saved device against what is actually present, without ever
 * throwing. Prefer an exact id; if the id has rotated across an app restart,
 * fall back to a device with the same remembered label (so a saved mic keeps
 * working); otherwise use the system default. This replaces the old "request
 * an exact id, catch the failure, retry" dance with one up-front decision.
 */
export function resolveDevice(
  devices: AudioDeviceLike[],
  kind: MediaDeviceKind,
  savedId: string,
  savedLabel: string,
): ResolvedDevice {
  if (!savedId) return { deviceId: "", matchedBy: "default" };
  const ofKind = devices.filter((device) => device.kind === kind && device.deviceId);
  if (ofKind.some((device) => device.deviceId === savedId)) {
    return { deviceId: savedId, matchedBy: "id" };
  }
  const byLabel = savedLabel
    ? ofKind.find((device) => device.label && device.label === savedLabel)
    : undefined;
  if (byLabel) return { deviceId: byLabel.deviceId, matchedBy: "label" };
  return { deviceId: "", matchedBy: "default" };
}

/** Programmatic mic permission state; "unknown" when the API is unavailable. */
export async function queryMicPermission(
  permissions: Pick<Permissions, "query"> | undefined,
): Promise<MicPermission> {
  if (!permissions?.query) return "unknown";
  try {
    const status = await permissions.query({ name: "microphone" as PermissionName });
    const state = status.state;
    return state === "granted" || state === "denied" || state === "prompt" ? state : "unknown";
  } catch {
    return "unknown";
  }
}
