import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { loadPluginApp, mountPluginContentScripts } from "@get-bb/plugin-sdk/testing/app";

test("the actual app registers drawer surfaces only on mobile clients", async () => {
  // Bundle source only to handle CSS/TSX, retaining the real SDK registration
  // harness and all actual app registration code. No microphone is started.
  const directory = mkdtempSync(join(process.cwd(), ".handsfree-registration-test-"));
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost" });
  const descriptors = ["window", "document", "navigator", "AbortController"].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  try {
    // jsdom listeners accept only jsdom's AbortSignal (the content-script harness mints one).
    for (const [name, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, AbortController: dom.window.AbortController })) {
      Object.defineProperty(globalThis, name, { value, configurable: true });
    }
    const file = join(directory, "app.mjs");
    await build({ entryPoints: ["app.tsx"], outfile: file, bundle: true, platform: "node", format: "esm", packages: "external", loader: { ".css": "empty" }, jsx: "automatic", logLevel: "silent" });
    for (const mobile of [false, true]) {
      Object.defineProperty(dom.window.navigator, "userAgent", { value: mobile ? "Mozilla/5.0 (iPhone) Mobile Safari" : "Mozilla/5.0 (Macintosh; Intel Mac OS X) Chrome", configurable: true });
      const app = await loadPluginApp(() => import(`${pathToFileURL(file).href}?mobile=${mobile}`));
      const page = app.navPanels.find(panel => panel.id === "sessions");
      assert.ok(page);
      assert.equal(page.fixedTabs?.length ?? 0, mobile ? 1 : 0);
      assert.equal(app.threadPanelActions.some(action => action.id === "thread-workspace"), mobile);
      assert.equal(app.appOverlays.filter(overlay => overlay.id === "presence-sync").length, 1, "one window-lifetime presence listener");
    }
    // The lifecycle script owns the display-only root attributes: it clears a
    // stale value on mount and removes them when the frontend generation ends.
    const app = await loadPluginApp(() => import(`${pathToFileURL(file).href}?lifecycle`));
    const root = dom.window.document.documentElement;
    root.setAttribute("data-handsfree-voice", "live");
    const scripts = await mountPluginContentScripts(app, { pluginId: "handsfree" });
    assert.ok(scripts.inspection.mountedIds.includes("aide-voice-lifecycle"));
    assert.equal(root.hasAttribute("data-handsfree-voice"), false);
    root.setAttribute("data-handsfree-voice", "live");
    await scripts.lifecycle.dispose();
    assert.equal(root.hasAttribute("data-handsfree-voice"), false);
  } finally {
    for (const [name, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
    dom.window.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
