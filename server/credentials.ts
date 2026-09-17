// OpenAI credential resolution: the stored API key, the OPENAI_API_KEY
// environment variable, and the ChatGPT-subscription OAuth token that Codex
// CLI stores in ~/.codex/auth.json (its audience is literally
// https://api.openai.com/v1). The subscription token is refreshed via the
// Codex OAuth client when expired, and persisted back like Codex CLI does so
// both tools stay in sync.
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CredentialPreference } from "./config.ts";

const CODEX_AUTH_PATH = join(homedir(), ".codex", "auth.json");
const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

/** Which auth mechanism a resolved credential is, for the realtime-auth memory. */
export type AuthMechanism = "apiKey" | "subscription";

function jwtExp(token: string): number {
  try {
    const payload = token.split(".")[1];
    const json = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return typeof json.exp === "number" ? json.exp : 0;
  } catch {
    return 0;
  }
}

export interface CredentialsDeps {
  /** The stored openaiApiKey secret, or undefined/empty when not set. */
  openaiApiKey(): Promise<string | undefined>;
  /** The user's credential preference from config. */
  credentialPreference(): Promise<CredentialPreference>;
  logError(message: string): void;
}

export interface Credentials {
  /** The subscription access token, refreshed if expired; null when unusable. */
  codexToken(): Promise<string | null>;
  /** Resolve the credential a new voice session should use. Throws when none. */
  apiKey(options?: { requireKey?: boolean }): Promise<{ key: string; mechanism: AuthMechanism }>;
}

export function createCredentials(deps: CredentialsDeps): Credentials {
  async function codexToken(): Promise<string | null> {
    let auth: { tokens?: { access_token?: string; refresh_token?: string } };
    try {
      auth = JSON.parse(readFileSync(CODEX_AUTH_PATH, "utf8"));
    } catch {
      return null;
    }
    const access = auth.tokens?.access_token;
    const refresh = auth.tokens?.refresh_token;
    if (!access) return null;
    if (jwtExp(access) - 60 > Date.now() / 1000) return access;
    if (!refresh) return null;
    try {
      const response = await fetch("https://auth.openai.com/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_type: "refresh_token",
          client_id: CODEX_CLIENT_ID,
          refresh_token: refresh,
          scope: "openid profile email",
        }),
      });
      if (!response.ok) {
        deps.logError(`codex token refresh failed: ${response.status}`);
        return null;
      }
      const fresh = (await response.json()) as { access_token?: string; refresh_token?: string; id_token?: string };
      if (!fresh.access_token) return null;
      // Persist back like Codex CLI does, so both tools stay in sync.
      const updated = {
        ...auth,
        tokens: {
          ...auth.tokens,
          access_token: fresh.access_token,
          refresh_token: fresh.refresh_token ?? refresh,
          ...(fresh.id_token ? { id_token: fresh.id_token } : {}),
        },
        last_refresh: new Date().toISOString(),
      };
      try {
        writeFileSync(CODEX_AUTH_PATH, JSON.stringify(updated, null, 2));
      } catch {
        // Read-only auth file is fine; the token still works for this session.
      }
      return fresh.access_token;
    } catch (error) {
      deps.logError(`codex token refresh error: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  async function apiKey(options?: { requireKey?: boolean }): Promise<{ key: string; mechanism: AuthMechanism }> {
    const openaiApiKey = await deps.openaiApiKey();
    const credentialPreference = await deps.credentialPreference();
    const key = openaiApiKey || process.env.OPENAI_API_KEY;
    // GPT-Live rejects ChatGPT-subscription tokens (403 "Voice session access
    // denied"), so live sessions must use a real API key regardless of the
    // user's credential preference.
    if (options?.requireKey) {
      if (key) return { key, mechanism: "apiKey" };
      throw new Error(
        "gpt-live-1 needs an OpenAI API key — the Live API does not accept ChatGPT-subscription sign-in. Add a key in Handsfree settings, or pick a gpt-realtime model.",
      );
    }
    // When the user pinned the subscription, try it first and only fall back to
    // a key. Otherwise (auto / apiKey) a key wins, then the subscription.
    if (credentialPreference === "subscription") {
      const codex = await codexToken();
      if (codex) return { key: codex, mechanism: "subscription" };
      if (key) return { key, mechanism: "apiKey" };
    } else {
      if (key) return { key, mechanism: "apiKey" };
      const codex = await codexToken();
      if (codex) return { key: codex, mechanism: "subscription" };
    }
    throw new Error(
      "No OpenAI credentials. Set an API key in the Handsfree settings, or sign in with `codex login` to use your ChatGPT subscription.",
    );
  }

  return { codexToken, apiKey };
}
