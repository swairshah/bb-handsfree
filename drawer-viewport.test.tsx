import test, { after } from "node:test";
import assert from "node:assert/strict";
import React, { useRef } from "react";
import { JSDOM } from "jsdom";
import { useDrawerViewport } from "./hooks/useDrawerViewport";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
for (const [name, value] of Object.entries({ window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })) {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}
after(() => dom.window.close());
// React DOM detects input-event support at import time.
const { act, render } = await import("@testing-library/react");

function Drawer() {
  const root = useRef<HTMLDivElement>(null);
  useDrawerViewport(root);
  return <div ref={root}><textarea aria-label="Reply" defaultValue="Draft" /></div>;
}

test("drawer fits above an overlay keyboard, accounts for panning, and restores on dismissal", (t) => {
  const viewport = Object.assign(new dom.window.EventTarget(), { height: 800, offsetTop: 0, scale: 1 });
  Object.defineProperty(window, "visualViewport", { value: viewport, configurable: true });
  let top = 160;
  t.mock.method(dom.window.HTMLElement.prototype, "getBoundingClientRect", () => ({ top, height: 640 }) as DOMRect);
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  t.mock.method(window, "requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++nextFrame, callback); return nextFrame; });
  t.mock.method(window, "cancelAnimationFrame", (id: number) => { frames.delete(id); });
  const flush = () => act(() => {
    for (const [id, callback] of frames) { frames.delete(id); callback(0); }
  });
  const resize = (height: number) => {
    viewport.height = height;
    viewport.dispatchEvent(new dom.window.Event("resize"));
    flush();
  };
  const slot = render(<Drawer />);
  const root = slot.container.firstElementChild as HTMLElement;
  try {
    assert.equal(root.style.maxHeight, "640px");
    const input = slot.getByRole("textbox", { name: "Reply" }) as HTMLTextAreaElement;
    input.focus();
    resize(480);
    assert.equal(root.style.maxHeight, "320px");
    assert.equal(document.activeElement, input);
    assert.equal(input.value, "Draft");

    viewport.offsetTop = 30;
    viewport.dispatchEvent(new dom.window.Event("scroll"));
    flush();
    assert.equal(root.style.maxHeight, "350px");

    // If BB also moves/resizes the host, measure the new top instead of
    // subtracting a keyboard inset from a height that's already reduced.
    top = 100;
    window.dispatchEvent(new dom.window.Event("resize"));
    flush();
    assert.equal(root.style.maxHeight, "410px");

    viewport.scale = 2;
    resize(240);
    assert.equal(root.style.maxHeight, "");
    viewport.scale = 1;
    viewport.offsetTop = 0;
    top = 160;
    resize(800);
    assert.equal(root.style.maxHeight, "640px");

    viewport.dispatchEvent(new dom.window.Event("resize"));
    assert.equal(frames.size, 1);
  } finally {
    slot.unmount();
    assert.equal(frames.size, 0);
    assert.equal(root.style.maxHeight, "");
    viewport.dispatchEvent(new dom.window.Event("resize"));
    assert.equal(frames.size, 0);
    Reflect.deleteProperty(window, "visualViewport");
  }
});

test("drawer uses host sizing when visualViewport is unavailable", () => {
  const slot = render(<Drawer />);
  try {
    assert.equal((slot.container.firstElementChild as HTMLElement).style.maxHeight, "");
  } finally { slot.unmount(); }
});
