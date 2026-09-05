import test from "node:test";
import assert from "node:assert/strict";
import { isMobileClient } from "./client-identity.ts";

test("mobile routing includes iPads with desktop Safari while preserving real desktop detection", () => {
  assert.equal(isMobileClient("Mozilla/5.0 (Macintosh; Intel Mac OS X) Safari/605", false, 5), true);
  assert.equal(isMobileClient("Mozilla/5.0 (iPad; CPU OS 18) Safari/605"), true);
  assert.equal(isMobileClient("Mozilla/5.0 (iPhone; CPU iPhone OS) Mobile Safari"), true);
  assert.equal(isMobileClient("Mozilla/5.0 (Linux; Android 15) Chrome", false), true);
  assert.equal(isMobileClient("Mozilla/5.0 (Macintosh; Intel Mac OS X) Safari/605", false, 0), false);
  assert.equal(isMobileClient("Mozilla/5.0 (Windows NT 10.0) Chrome", false, 10), false);
});
