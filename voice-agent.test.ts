import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { VoiceAgent, formatThreadNotices } from "./voice-agent.ts";
import { writeAudioDevicePreferences } from "./audio-devices.ts";

/** A VoiceAgent bound to a spy rpc that records every relayed call. */
function agentWithRpcSpy() {
  const calls: { method: string; args: unknown }[] = [];
  const agent = new VoiceAgent();
  agent.bind({
    rpc: {
      call: (async (method: string, args: unknown) => {
        calls.push({ method, args });
        return { ok: true };
      }) as never,
    },
    context: { threadId: null, projectId: null, onNewThreadScreen: false },
    openNewThread() {},
  });
  // bind() emits a one-time client.hello diagnostic; drop it so tests start clean.
  calls.length = 0;
  return { agent, calls };
}

test("mirrors a call owned by another realm from voice-presence", () => {
  const agent = new VoiceAgent();
  assert.equal(agent.getState(), "idle");

  agent.ingestPresence({ nonce: "call-A", phase: "live", startedAt: 1000 });
  assert.equal(agent.getState(), "live");
  assert.equal(agent.getSessionId(), "call-A");
  assert.equal(agent.getLiveStartedAt(), 1000);

  agent.ingestPresence({ nonce: "call-A", phase: "muted", startedAt: 1000 });
  assert.equal(agent.getState(), "muted");

  // The owner announcing idle clears the mirror on every other surface.
  agent.ingestPresence({ nonce: "call-A", phase: "idle", startedAt: null });
  assert.equal(agent.getState(), "idle");
  assert.equal(agent.getSessionId(), null);
});

test("ignores malformed or nonce-less presence", () => {
  const agent = new VoiceAgent();
  agent.ingestPresence(null);
  agent.ingestPresence({ phase: "live" });
  agent.ingestPresence({ nonce: "x", phase: "bogus" });
  assert.equal(agent.getState(), "idle");
});

test("a mirrored call expires once its heartbeats lapse (no ghost live)", () => {
  mock.timers.enable({ apis: ["Date", "setInterval"] });
  try {
    const agent = new VoiceAgent();
    agent.ingestPresence({ nonce: "call-A", phase: "live", startedAt: 0 });
    assert.equal(agent.getState(), "live");

    mock.timers.tick(10_000); // still within the fresh window
    assert.equal(agent.getState(), "live");

    mock.timers.tick(20_000); // now past PRESENCE_STALE_MS (25s)
    assert.equal(agent.getState(), "idle");
  } finally {
    mock.timers.reset();
  }
});

test("stop/mute from a surface that doesn't own the call is relayed to the owner", () => {
  const { agent, calls } = agentWithRpcSpy();
  agent.ingestPresence({ nonce: "call-A", phase: "live", startedAt: 1000 });

  // Commands also carry client/realm identity (observability); assert the parts
  // that matter for routing.
  const lastArgs = () => calls.at(-1)?.args as { nonce: string; action?: string };

  agent.toggleMuteFromSurface(); // live → mute (relayed to the owner)
  assert.equal(calls.at(-1)?.method, "sendVoiceCommand");
  assert.equal(lastArgs().nonce, "call-A");
  assert.equal(lastArgs().action, "mute");

  agent.ingestPresence({ nonce: "call-A", phase: "muted", startedAt: 1000 });
  agent.toggleMuteFromSurface(); // muted → unmute
  assert.equal(lastArgs().action, "unmute");

  // Stop of a mirrored call is server-authoritative (forceStop) so it works even
  // against a frozen owner, and clears the mirror immediately.
  agent.stopFromSurface();
  assert.equal(calls.at(-1)?.method, "forceStop");
  assert.equal(lastArgs().nonce, "call-A");
  assert.equal(agent.getState(), "idle");

  agent.ingestPresence({ nonce: "call-A", phase: "idle", startedAt: null });
});

test("presence catch-up: a surface requests, a non-owner never answers", () => {
  const { agent, calls } = agentWithRpcSpy();
  agent.requestPresence();
  assert.deepEqual(calls.at(-1), { method: "requestPresence", args: null });

  // We own no call, so a peer's query must NOT make us publish presence.
  calls.length = 0;
  agent.answerPresenceQuery();
  assert.equal(calls.length, 0);
});

test("a relayed command is ignored by a realm that doesn't own that call", () => {
  const { agent, calls } = agentWithRpcSpy();
  // Idle here: we own nothing, so an incoming command must be a no-op.
  agent.applyVoiceCommand({ nonce: "call-A", action: "stop" });
  assert.equal(agent.getState(), "idle");
  assert.equal(calls.length, 0);
});

test("reloads audio preferences saved by another browser window", () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { localStorage: storage },
  });

  try {
    const agent = new VoiceAgent();
    writeAudioDevicePreferences(storage, {
      inputDeviceId: "mic-from-window-a",
      inputLabel: "Window A Mic",
    });

    agent.refreshAudioPreferences();

    assert.deepEqual(agent.getAudioPreferences(), {
      inputDeviceId: "mic-from-window-a",
      inputLabel: "Window A Mic",
    });
  } finally {
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else delete (globalThis as { window?: unknown }).window;
  }
});

test("grounds a thread notification in the latest completed result", () => {
  const { logText, instruction } = formatThreadNotices([
    {
      kind: "idle",
      threadId: "thr_settings",
      title: "Install BB Handsfree version",
      detail: "Updated the notification prompt and reloaded Handsfree.",
    },
  ]);

  assert.match(logText, /Updated the notification prompt/);
  assert.match(instruction, /latest_result: "Updated the notification prompt/);
  assert.match(instruction, /Ground the summary only in latest_result/);
  assert.match(instruction, /Never guess from earlier conversation/);
  assert.match(instruction, /every announcement must name its thread: start with the title/);
});

test("names every thread in a multi-thread digest so 'it finished' is never ambiguous", () => {
  const { logText, instruction } = formatThreadNotices([
    {
      kind: "idle",
      threadId: "thr_review",
      title: "Review recent GitHub pull requests",
      detail: "Both pull requests landed on main.",
    },
    {
      kind: "failed",
      threadId: "thr_vsix",
      title: "Enable one-click plugin distribution",
      detail: "Build script exited with status 1.",
    },
  ]);

  assert.match(logText, /finished: Review recent GitHub pull requests/);
  assert.match(logText, /failed: Enable one-click plugin distribution/);
  assert.match(instruction, /title: "Review recent GitHub pull requests"/);
  assert.match(instruction, /title: "Enable one-click plugin distribution"/);
  assert.match(instruction, /every announcement must name its thread: start with the title/);
  assert.match(instruction, /"<title> finished: <summary>" or "<title> failed: <summary>"/);
  assert.match(instruction, /Never say just "it finished"/);
  assert.match(instruction, /one short sentence per update/);
});

test("requires reading the thread when a completion has no result", () => {
  const { instruction } = formatThreadNotices([
    {
      kind: "idle",
      threadId: "thr_missing",
      title: "Background task",
      detail: null,
    },
  ]);

  assert.match(instruction, /latest_result: unavailable/);
  assert.match(instruction, /call read_thread with that thread_id before speaking/);
});

test("stopping during the SDP exchange closes the mic and cancels startup", async () => {
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const originalPeerConnection = Object.getOwnPropertyDescriptor(globalThis, "RTCPeerConnection");
  const originalAudio = Object.getOwnPropertyDescriptor(globalThis, "Audio");
  const track = {
    enabled: true,
    stopped: false,
    stop() {
      this.stopped = true;
    },
  };
  const stream = {
    getTracks: () => [track],
    getAudioTracks: () => [track],
  } as unknown as MediaStream;
  let resolveCall!: () => void;
  let announceCallStarted!: () => void;
  const callStarted = new Promise<void>((resolve) => {
    announceCallStarted = resolve;
  });
  const callPending = new Promise<void>((resolve) => {
    resolveCall = resolve;
  });
  let peer: FakePeerConnection | null = null;

  class FakePeerConnection {
    iceGatheringState = "complete";
    connectionState = "new";
    localDescription: RTCSessionDescriptionInit | null = null;
    closed = false;
    setRemoteCalls = 0;
    ontrack: ((event: RTCTrackEvent) => void) | null = null;
    onconnectionstatechange: (() => void) | null = null;
    oniceconnectionstatechange: (() => void) | null = null;

    constructor() {
      peer = this;
    }

    addTrack() {}
    addEventListener() {}
    removeEventListener() {}
    close() {
      this.closed = true;
    }
    createDataChannel() {
      return { readyState: "connecting", close() {}, send() {}, onopen: null, onclose: null, onmessage: null };
    }
    async createOffer() {
      return { type: "offer" as const, sdp: "offer" };
    }
    async setLocalDescription(description: RTCSessionDescriptionInit) {
      this.localDescription = description;
    }
    async setRemoteDescription() {
      this.setRemoteCalls += 1;
    }
  }

  class FakeAudio {
    autoplay = false;
    srcObject: MediaStream | null = null;
    async play() {}
    remove() {}
  }

  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      mediaDevices: {
        getUserMedia: async () => stream,
        enumerateDevices: async () => [
          { deviceId: "mic-1", kind: "audioinput", label: "Built-in Mic" },
        ],
      },
    },
  });
  Object.defineProperty(globalThis, "RTCPeerConnection", {
    configurable: true,
    value: FakePeerConnection,
  });
  Object.defineProperty(globalThis, "Audio", {
    configurable: true,
    value: FakeAudio,
  });

  const agent = new VoiceAgent();
  agent.bind({
    rpc: {
      // Pause startup at the SDP exchange so the test can stop mid-flight.
      call: (async (method: string) => {
        if (method === "createCall") {
          announceCallStarted();
          await callPending;
          return { sdp: "answer" };
        }
        return { ok: true };
      }) as never,
    },
    context: { threadId: null, projectId: null, onNewThreadScreen: false },
    composer: { setText() {}, updateText() {} },
    openNewThread() {},
  });
  agent.setAudioPreferences({ inputDeviceId: "", inputLabel: "" });

  try {
    agent.toggle();
    await callStarted;
    agent.stop();

    assert.equal(track.stopped, true);
    assert.equal((peer as FakePeerConnection | null)?.closed, true);

    resolveCall();
    await new Promise((resolve) => setImmediate(resolve));
    // Stopped mid-exchange: the answer must never be applied.
    assert.equal((peer as FakePeerConnection | null)?.setRemoteCalls, 0);
    assert.equal(agent.getState(), "idle");
  } finally {
    resolveCall();
    agent.stop();
    if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator);
    else delete (globalThis as { navigator?: unknown }).navigator;
    if (originalPeerConnection) Object.defineProperty(globalThis, "RTCPeerConnection", originalPeerConnection);
    else delete (globalThis as { RTCPeerConnection?: unknown }).RTCPeerConnection;
    if (originalAudio) Object.defineProperty(globalThis, "Audio", originalAudio);
    else delete (globalThis as { Audio?: unknown }).Audio;
  }
});

test("accepting an invite greets first with the call reason on open", async () => {
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const originalPeerConnection = Object.getOwnPropertyDescriptor(globalThis, "RTCPeerConnection");
  const originalAudio = Object.getOwnPropertyDescriptor(globalThis, "Audio");
  const track = { enabled: true, muted: false, readyState: "live", stop() {}, onmute: null, onunmute: null, onended: null };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream;
  const sent: string[] = [];
  let dc: { readyState: string; send(message: string): void; close(): void; onopen: (() => void) | null; onclose: (() => void) | null; onmessage: ((message: unknown) => void) | null } | null = null;

  class FakePeerConnection {
    iceGatheringState = "complete";
    connectionState = "new";
    localDescription: RTCSessionDescriptionInit | null = null;
    ontrack: ((event: RTCTrackEvent) => void) | null = null;
    onconnectionstatechange: (() => void) | null = null;
    oniceconnectionstatechange: (() => void) | null = null;
    addTrack() {}
    addEventListener() {}
    removeEventListener() {}
    close() {}
    createDataChannel() {
      dc = {
        readyState: "open",
        send: (message: string) => sent.push(message),
        close() {},
        onopen: null,
        onclose: null,
        onmessage: null,
      };
      return dc;
    }
    async createOffer() {
      return { type: "offer" as const, sdp: "offer" };
    }
    async setLocalDescription(description: RTCSessionDescriptionInit) {
      this.localDescription = description;
    }
    async setRemoteDescription() {}
  }

  class FakeAudio {
    autoplay = false;
    srcObject: MediaStream | null = null;
    async play() {}
    remove() {}
  }

  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      mediaDevices: {
        getUserMedia: async () => stream,
        enumerateDevices: async () => [{ deviceId: "mic-1", kind: "audioinput", label: "Built-in Mic" }],
      },
    },
  });
  Object.defineProperty(globalThis, "RTCPeerConnection", { configurable: true, value: FakePeerConnection });
  Object.defineProperty(globalThis, "Audio", { configurable: true, value: FakeAudio });

  const agent = new VoiceAgent();
  agent.bind({
    rpc: { call: (async (method: string) => (method === "createCall" ? { sdp: "answer" } : { ok: true })) as never },
    context: { threadId: null, projectId: null, onNewThreadScreen: false },
    openNewThread() {},
  });

  try {
    agent.acceptInvite("Morning brief", "Plan the day");
    // Read through a call so control-flow narrowing (from the loop's !dc
    // check) can't pin the variable to null.
    const currentDc = () => dc;
    for (let i = 0; i < 20 && !currentDc(); i++) await new Promise((resolve) => setImmediate(resolve));
    const channel = currentDc();
    assert.ok(channel, "expected the data channel to be created");
    channel.onopen?.();
    assert.equal(agent.getState(), "live");
    assert.equal(sent.length, 2);
    const greeting = JSON.parse(sent[0]);
    assert.equal(greeting.type, "conversation.item.create");
    assert.equal(greeting.item.role, "system");
    assert.match(greeting.item.content[0].text, /Morning brief/);
    assert.match(greeting.item.content[0].text, /Plan the day/);
    assert.deepEqual(JSON.parse(sent[1]), { type: "response.create" });
    // A later open must not greet again.
    channel.onopen?.();
    assert.equal(sent.length, 2);
  } finally {
    agent.stop();
    if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator);
    else delete (globalThis as { navigator?: unknown }).navigator;
    if (originalPeerConnection) Object.defineProperty(globalThis, "RTCPeerConnection", originalPeerConnection);
    else delete (globalThis as { RTCPeerConnection?: unknown }).RTCPeerConnection;
    if (originalAudio) Object.defineProperty(globalThis, "Audio", originalAudio);
    else delete (globalThis as { Audio?: unknown }).Audio;
  }
});

test("a greeting owed to a call that never goes live is dropped, not reused", async () => {
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const originalPeerConnection = Object.getOwnPropertyDescriptor(globalThis, "RTCPeerConnection");
  const originalAudio = Object.getOwnPropertyDescriptor(globalThis, "Audio");
  let micAvailable = false;
  const track = { enabled: true, muted: false, readyState: "live", stop() {}, onmute: null, onunmute: null, onended: null };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream;
  const sent: string[] = [];
  const dcs: { readyState: string; send(message: string): void; close(): void; onopen: (() => void) | null; onclose: (() => void) | null; onmessage: ((message: unknown) => void) | null }[] = [];

  class FakePeerConnection {
    iceGatheringState = "complete";
    connectionState = "new";
    localDescription: RTCSessionDescriptionInit | null = null;
    ontrack: ((event: RTCTrackEvent) => void) | null = null;
    onconnectionstatechange: (() => void) | null = null;
    oniceconnectionstatechange: (() => void) | null = null;
    addTrack() {}
    addEventListener() {}
    removeEventListener() {}
    close() {}
    createDataChannel() {
      const dc = {
        readyState: "open",
        send: (message: string) => sent.push(message),
        close() {},
        onopen: null,
        onclose: null,
        onmessage: null,
      };
      dcs.push(dc);
      return dc;
    }
    async createOffer() {
      return { type: "offer" as const, sdp: "offer" };
    }
    async setLocalDescription(description: RTCSessionDescriptionInit) {
      this.localDescription = description;
    }
    async setRemoteDescription() {}
  }

  class FakeAudio {
    autoplay = false;
    srcObject: MediaStream | null = null;
    async play() {}
    remove() {}
  }

  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      mediaDevices: {
        getUserMedia: async () => {
          if (!micAvailable) throw new DOMException("Permission denied", "NotAllowedError");
          return stream;
        },
        enumerateDevices: async () => [{ deviceId: "mic-1", kind: "audioinput", label: "Built-in Mic" }],
      },
    },
  });
  Object.defineProperty(globalThis, "RTCPeerConnection", { configurable: true, value: FakePeerConnection });
  Object.defineProperty(globalThis, "Audio", { configurable: true, value: FakeAudio });

  const agent = new VoiceAgent();
  agent.bind({
    rpc: { call: (async (method: string) => (method === "createCall" ? { sdp: "answer" } : { ok: true })) as never },
    context: { threadId: null, projectId: null, onNewThreadScreen: false },
    openNewThread() {},
  });
  const settled = () => new Promise((resolve) => setImmediate(resolve));

  try {
    // First accept: mic denied, call never goes live — nothing may be sent.
    agent.acceptInvite("Stale brief", "should never be greeted");
    for (let i = 0; i < 20 && agent.getState() !== "idle"; i++) await settled();
    assert.equal(agent.getState(), "idle");
    assert.equal(sent.length, 0);
    // Second accept with the mic back: only the fresh reason is greeted.
    micAvailable = true;
    agent.acceptInvite("Fresh brief", "greet this one");
    const currentDc = () => dcs[dcs.length - 1] ?? null;
    for (let i = 0; i < 20 && !currentDc(); i++) await settled();
    const channel = currentDc();
    assert.ok(channel, "expected the data channel to be created");
    channel.onopen?.();
    assert.equal(sent.length, 2);
    assert.match(JSON.parse(sent[0]).item.content[0].text, /Fresh brief/);
    assert.doesNotMatch(JSON.stringify(sent), /Stale brief/);
  } finally {
    agent.stop();
    if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator);
    else delete (globalThis as { navigator?: unknown }).navigator;
    if (originalPeerConnection) Object.defineProperty(globalThis, "RTCPeerConnection", originalPeerConnection);
    else delete (globalThis as { RTCPeerConnection?: unknown }).RTCPeerConnection;
    if (originalAudio) Object.defineProperty(globalThis, "Audio", originalAudio);
    else delete (globalThis as { Audio?: unknown }).Audio;
  }
});

test("accepting with greet off starts a normal session that waits for the user", async () => {
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const originalPeerConnection = Object.getOwnPropertyDescriptor(globalThis, "RTCPeerConnection");
  const originalAudio = Object.getOwnPropertyDescriptor(globalThis, "Audio");
  const track = { enabled: true, muted: false, readyState: "live", stop() {}, onmute: null, onunmute: null, onended: null };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream;
  const sent: string[] = [];
  const dcs: { readyState: string; send(message: string): void; close(): void; onopen: (() => void) | null; onclose: (() => void) | null; onmessage: ((message: unknown) => void) | null }[] = [];

  class FakePeerConnection {
    iceGatheringState = "complete";
    connectionState = "new";
    localDescription: RTCSessionDescriptionInit | null = null;
    ontrack: ((event: RTCTrackEvent) => void) | null = null;
    onconnectionstatechange: (() => void) | null = null;
    oniceconnectionstatechange: (() => void) | null = null;
    addTrack() {}
    addEventListener() {}
    removeEventListener() {}
    close() {}
    createDataChannel() {
      const dc = {
        readyState: "open",
        send: (message: string) => sent.push(message),
        close() {},
        onopen: null,
        onclose: null,
        onmessage: null,
      };
      dcs.push(dc);
      return dc;
    }
    async createOffer() {
      return { type: "offer" as const, sdp: "offer" };
    }
    async setLocalDescription(description: RTCSessionDescriptionInit) {
      this.localDescription = description;
    }
    async setRemoteDescription() {}
  }

  class FakeAudio {
    autoplay = false;
    srcObject: MediaStream | null = null;
    async play() {}
    remove() {}
  }

  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      mediaDevices: {
        getUserMedia: async () => stream,
        enumerateDevices: async () => [{ deviceId: "mic-1", kind: "audioinput", label: "Built-in Mic" }],
      },
    },
  });
  Object.defineProperty(globalThis, "RTCPeerConnection", { configurable: true, value: FakePeerConnection });
  Object.defineProperty(globalThis, "Audio", { configurable: true, value: FakeAudio });

  const agent = new VoiceAgent();
  agent.bind({
    rpc: { call: (async (method: string) => (method === "createCall" ? { sdp: "answer" } : { ok: true })) as never },
    context: { threadId: null, projectId: null, onNewThreadScreen: false },
    openNewThread() {},
  });

  try {
    agent.acceptInvite("Quiet brief", "no greeting please", { greet: false });
    const currentDc = () => dcs[dcs.length - 1] ?? null;
    for (let i = 0; i < 20 && !currentDc(); i++) await new Promise((resolve) => setImmediate(resolve));
    const channel = currentDc();
    assert.ok(channel, "expected the data channel to be created");
    channel.onopen?.();
    assert.equal(agent.getState(), "live");
    assert.equal(sent.length, 0);
  } finally {
    agent.stop();
    if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator);
    else delete (globalThis as { navigator?: unknown }).navigator;
    if (originalPeerConnection) Object.defineProperty(globalThis, "RTCPeerConnection", originalPeerConnection);
    else delete (globalThis as { RTCPeerConnection?: unknown }).RTCPeerConnection;
    if (originalAudio) Object.defineProperty(globalThis, "Audio", originalAudio);
    else delete (globalThis as { Audio?: unknown }).Audio;
  }
});
