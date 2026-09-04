import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
const browser: Window = new Window();
Object.assign(globalThis, {
  window: browser,
  document: browser.document,
  navigator: browser.navigator,
  HTMLElement: browser.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
});
const exchange = mock(async (): Promise<{ sdp: string }> => ({
  sdp: "answer",
}));
mock.module("@get-bb/plugin-sdk/app", () => ({
  useRpc: () => ({ call: exchange }),
}));
class FakeChannel {
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  send = mock((_message: string): void => {});
  close = mock((): void => {});
}
class FakePeer {
  static instances: FakePeer[] = [];
  channel: FakeChannel = new FakeChannel();
  localDescription: { sdp: string } = { sdp: "offer" };
  connectionState: string = "new";
  ontrack: ((event: { streams: object[] }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  trackStop = mock((): void => {});
  close = mock((): void => {});
  setRemoteDescription = mock(async (): Promise<void> => {});
  addTransceiver = mock(
    (_kind: string, _options: { direction: string }): void => {},
  );
  constructor() {
    FakePeer.instances.push(this);
  }
  createDataChannel(): FakeChannel {
    return this.channel;
  }
  async createOffer(): Promise<{ sdp: string }> {
    return this.localDescription;
  }
  async setLocalDescription(): Promise<void> {}
  getReceivers(): { track: { stop: () => void } }[] {
    return [{ track: { stop: this.trackStop } }];
  }
}
const play = mock(async (): Promise<void> => {});
Object.assign(globalThis, {
  RTCPeerConnection: FakePeer,
  Audio: function (): HTMLAudioElement {
    const audio: HTMLAudioElement = document.createElement("audio");
    audio.play = play;
    audio.pause = mock((): void => {});
    return audio;
  },
});
const { VoicePreview } = await import("./voice-preview");
let root: Root;
let container: HTMLDivElement;
async function render(element: ReactElement): Promise<void> {
  await act(async (): Promise<void> => {
    root.render(element);
  });
}
async function click(): Promise<void> {
  await act(async (): Promise<void> => {
    container.querySelector("button")?.click();
  });
}
function peer(): FakePeer {
  const value: FakePeer | undefined = FakePeer.instances.at(-1);
  if (!value) throw new Error("Expected preview peer");
  return value;
}
beforeEach((): void => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  FakePeer.instances = [];
  exchange.mockReset().mockResolvedValue({ sdp: "answer" });
  play.mockReset().mockResolvedValue();
});
afterEach(async (): Promise<void> => {
  await act(async (): Promise<void> => {
    root.unmount();
  });
  container.remove();
});
test("receive-only sample plays once and stops when playback ends", async (): Promise<void> => {
  await render(<VoicePreview voice="marin" disabled={false} />);
  await click();
  expect(peer().addTransceiver).toHaveBeenCalledWith("audio", {
    direction: "recvonly",
  });
  expect(exchange).toHaveBeenCalledWith("previewVoice", {
    sdp: "offer",
    voice: "marin",
  });
  await act(async (): Promise<void> => {
    peer().channel.onopen?.();
    peer().ontrack?.({ streams: [new browser.MediaStream()] });
    peer().channel.onmessage?.({
      data: JSON.stringify({ type: "output_audio_buffer.started" }),
    });
  });
  expect(play).toHaveBeenCalledTimes(1);
  expect(peer().channel.send).toHaveBeenCalledTimes(1);
  expect(container.textContent).toContain("Playing marin");
  await act(async (): Promise<void> => {
    peer().channel.onmessage?.({
      data: JSON.stringify({ type: "output_audio_buffer.stopped" }),
    });
  });
  expect(peer().close).toHaveBeenCalledTimes(1);
  expect(peer().trackStop).toHaveBeenCalledTimes(1);
  expect(document.querySelectorAll("audio").length).toBe(0);
  expect(container.textContent).toContain("Preview voice");
});
test("Stop prevents a late answer from reviving a cancelled sample", async (): Promise<void> => {
  let resolveAnswer: ((answer: { sdp: string }) => void) | undefined;
  exchange.mockImplementation(
    (): Promise<{ sdp: string }> =>
      new Promise((resolve) => {
        resolveAnswer = resolve;
      }),
  );
  await render(<VoicePreview voice="cedar" disabled={false} />);
  await click();
  expect(container.textContent).toContain("Connecting preview");
  await click();
  await act(async (): Promise<void> => {
    resolveAnswer?.({ sdp: "late" });
  });
  expect(peer().setRemoteDescription).not.toHaveBeenCalled();
  expect(peer().close).toHaveBeenCalledTimes(1);
});
test("voice change stops the previous sample", async (): Promise<void> => {
  await render(<VoicePreview key="marin" voice="marin" disabled={false} />);
  await click();
  const previous: FakePeer = peer();
  await render(<VoicePreview key="cedar" voice="cedar" disabled={false} />);
  expect(previous.close).toHaveBeenCalledTimes(1);
  expect(document.querySelectorAll("audio").length).toBe(0);
  await click();
  expect(exchange).toHaveBeenLastCalledWith("previewVoice", {
    sdp: "offer",
    voice: "cedar",
  });
});
test("connection and speaker failures are visible and release resources", async (): Promise<void> => {
  exchange.mockRejectedValueOnce(new Error("Check your credential"));
  await render(<VoicePreview voice="marin" disabled={false} />);
  await click();
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    "Check your credential",
  );
  expect(peer().close).toHaveBeenCalledTimes(1);
  play.mockRejectedValue(new Error("NotAllowedError"));
  await click();
  await act(async (): Promise<void> => {
    peer().ontrack?.({ streams: [new browser.MediaStream()] });
  });
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    "Check your speaker",
  );
  expect(peer().close).toHaveBeenCalledTimes(1);
});
test("unmount closes the connection and removes hidden audio", async (): Promise<void> => {
  await render(<VoicePreview voice="marin" disabled={false} />);
  await click();
  const previous: FakePeer = peer();
  await render(<div />);
  expect(previous.close).toHaveBeenCalledTimes(1);
  expect(document.querySelectorAll("audio").length).toBe(0);
});
