import test from "node:test";
import assert from "node:assert/strict";
import {
  audioCaptureConstraint,
  describeAudioSupport,
  deviceDisplayLabel,
  queryMicPermission,
  readAudioDevicePreferences,
  resolveDevice,
  shouldRetryWithDefaultDevice,
  writeAudioDevicePreferences,
} from "../shared/audio-devices.ts";

const MIC = { deviceId: "mic-1", kind: "audioinput" as const, label: "Built-in Mic" };
const SPEAKER = { deviceId: "spk-1", kind: "audiooutput" as const, label: "Built-in Speaker" };

test("uses the browser default microphone when no preference is saved", () => {
  assert.equal(audioCaptureConstraint(""), true);
});

test("requests a saved microphone by exact device id", () => {
  assert.deepEqual(audioCaptureConstraint("input-123"), {
    deviceId: { exact: "input-123" },
  });
});

test("provides readable labels before browser permission reveals device names", () => {
  assert.equal(
    deviceDisplayLabel({ deviceId: "in", kind: "audioinput", label: "" }, 2),
    "Microphone 3",
  );
  assert.equal(
    deviceDisplayLabel({ deviceId: "out", kind: "audiooutput", label: "" }, 0),
    "Speaker 1",
  );
});

test("persists the chosen microphone with its label", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };

  assert.equal(writeAudioDevicePreferences(storage, {
    inputDeviceId: "input-123",
    inputLabel: "Shure MV7",
  }), true);

  assert.deepEqual(readAudioDevicePreferences(storage), {
    inputDeviceId: "input-123",
    inputLabel: "Shure MV7",
  });
});

test("keeps storage failures from breaking in-memory device selection", () => {
  const storage = {
    getItem: () => null,
    setItem: () => {
      throw new DOMException("Storage denied", "SecurityError");
    },
  };

  assert.equal(writeAudioDevicePreferences(storage, {
    inputDeviceId: "input-123",
    inputLabel: "Shure MV7",
  }), false);
});

test("ignores invalid persisted audio preferences", () => {
  const storage = {
    getItem: () => "not json",
    setItem: () => undefined,
  };

  assert.deepEqual(readAudioDevicePreferences(storage), {
    inputDeviceId: "",
    inputLabel: "",
  });
});

test("only retries capture failures caused by an unavailable selected device", () => {
  assert.equal(shouldRetryWithDefaultDevice({ name: "OverconstrainedError" }), true);
  assert.equal(shouldRetryWithDefaultDevice({ name: "NotFoundError" }), true);
  assert.equal(shouldRetryWithDefaultDevice({ name: "NotAllowedError" }), false);
  assert.equal(shouldRetryWithDefaultDevice(new Error("unknown")), false);
});

test("describes full support when a mic and speaker are present", () => {
  assert.deepEqual(describeAudioSupport([MIC, SPEAKER], { inputDeviceId: "", inputLabel: "" }), {
    hasInput: true,
    hasOutput: true,
    inputValid: true,
    labelsHidden: false,
  });
});

test("reports no input/output when the device list is empty", () => {
  const support = describeAudioSupport([], { inputDeviceId: "", inputLabel: "" });
  assert.equal(support.hasInput, false);
  assert.equal(support.hasOutput, false);
});

test("keeps the saved mic valid when its label still matches after an id change", () => {
  const rotated = { deviceId: "mic-new", kind: "audioinput" as const, label: "Built-in Mic" };
  const support = describeAudioSupport([rotated, SPEAKER], {
    inputDeviceId: "mic-1",
    inputLabel: "Built-in Mic",
  });
  assert.equal(support.inputValid, true);
});

test("marks the saved mic invalid only when neither id nor label matches", () => {
  const support = describeAudioSupport([SPEAKER], { inputDeviceId: "mic-1", inputLabel: "Gone Mic" });
  assert.equal(support.inputValid, false);
});

test("flags privacy-gated devices whose labels are still hidden", () => {
  const gated = [{ deviceId: "mic-1", kind: "audioinput" as const, label: "" }];
  assert.equal(describeAudioSupport(gated, { inputDeviceId: "", inputLabel: "" }).labelsHidden, true);
});

test("resolves a saved mic by id, then by label, else the system default", () => {
  assert.deepEqual(resolveDevice([MIC], "audioinput", "mic-1", "Built-in Mic"), {
    deviceId: "mic-1",
    matchedBy: "id",
  });
  // id rotated across a restart, but the label still matches → recover it
  const rotated = { deviceId: "mic-9", kind: "audioinput" as const, label: "Built-in Mic" };
  assert.deepEqual(resolveDevice([rotated], "audioinput", "mic-1", "Built-in Mic"), {
    deviceId: "mic-9",
    matchedBy: "label",
  });
  // genuinely gone → system default
  assert.deepEqual(resolveDevice([SPEAKER], "audioinput", "mic-1", "Built-in Mic"), {
    deviceId: "",
    matchedBy: "default",
  });
  // no saved selection → system default
  assert.deepEqual(resolveDevice([MIC], "audioinput", "", ""), {
    deviceId: "",
    matchedBy: "default",
  });
});

test("reads programmatic mic permission, degrading to unknown", async () => {
  assert.equal(await queryMicPermission(undefined), "unknown");
  assert.equal(
    await queryMicPermission({ query: async () => ({ state: "granted" }) as PermissionStatus }),
    "granted",
  );
  assert.equal(
    await queryMicPermission({
      query: async () => {
        throw new Error("unsupported name");
      },
    }),
    "unknown",
  );
});
