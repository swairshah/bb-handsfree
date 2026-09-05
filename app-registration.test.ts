import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";

test("the actual app registers distinct native desktop tabs and mobile drawers", async () => {
  // Bundle source only to handle CSS/TSX, retaining the real SDK registration
  // harness and all actual app registration code. No microphone is started.
  const directory = mkdtempSync(join(process.cwd(), ".handsfree-registration-test-"));
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost", pretendToBeVisual: true });
  const descriptors = ["window", "document", "navigator", "HTMLElement", "IS_REACT_ACT_ENVIRONMENT"].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  try {
    for (const [name, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })) {
      Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
    }
    const file = join(directory, "app.mjs");
    await build({ stdin: { contents: 'export { default } from "./app"; export { voiceAgent } from "./voice-agent"; export { desktopViews } from "./desktop-views";', resolveDir: process.cwd(), loader: "ts" }, outfile: file, bundle: true, platform: "node", format: "esm", packages: "external", loader: { ".css": "empty" }, jsx: "automatic", logLevel: "silent" });
    for (const mobile of [false, true]) {
      Object.defineProperty(dom.window.navigator, "userAgent", { value: mobile ? "Mozilla/5.0 (iPhone) Mobile Safari" : "Mozilla/5.0 (Macintosh; Intel Mac OS X) Chrome", configurable: true });
      let loaded: any;
      const app = await loadPluginApp(async () => (loaded = await import(`${pathToFileURL(file).href}?mobile=${mobile}`)));
      const page = app.navPanels.find(panel => panel.id === "sessions");
      assert.ok(page);
      assert.equal(page.fixedTabs?.length ?? 0, 1);
      assert.equal(page.fixedTabs?.[0].id, mobile ? "companion" : "desktop-thread");
      assert.equal(app.threadPanelActions.some(action => action.id === "desktop-thread"), !mobile);
      assert.equal(app.threadPanelActions.some(action => action.id === "thread-workspace"), mobile);
      if (!mobile) {
        // Exercise the actual live composer control, not an idle-only ref.
        const originalRects = dom.window.HTMLElement.prototype.getClientRects;
        dom.window.HTMLElement.prototype.getClientRects = () => [new dom.window.DOMRect(0, 0, 100, 30)] as unknown as DOMRectList;
        loaded.voiceAgent.state = "live";
        const slot = renderSlot(app.composerCustomizations[0].actions![0], {}, {
          context: { threadId: "source", projectId: "project" },
          composer: { scope: { kind: "thread", threadId: "source" } },
          openThreadPanel: () => true,
          rpc: { getConfig: () => ({ shortcuts: { toggle: "Mod+Shift+H", mute: "Mod+Shift+U" } }), logEvent: () => ({ ok: true }), requestPresence: () => ({ ok: true }) },
        });
        try {
          assert.ok(slot.getByRole("button", { name: "Mute Aide microphone" }));
          loaded.desktopViews.open([{ kind: "thread", id: "thread:target", threadId: "target", projectId: "project", title: "Target" }], "new", "new");
          assert.deepEqual(slot.inspection.navigateCalls.at(-1), { method: "openThreadPanel", options: { actionId: "desktop-thread", title: "Target", params: { threadId: "target" } } });
          slot.container.setAttribute("data-handsfree-desktop-thread", "embedded");
          assert.throws(() => loaded.desktopViews.open([{ threadId: "other" }], "new", "new"), /no available side panel/);
        } finally {
          slot.lifecycle.unmount();
          loaded.voiceAgent.state = "idle";
          dom.window.HTMLElement.prototype.getClientRects = originalRects;
        }
      }
    }
  } finally {
    for (const [name, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
    dom.window.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
