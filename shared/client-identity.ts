// Stable identity for observability across bb's per-surface realms and connect
// clients. The plugin SDK exposes no client/device/connection id (BbContext is
// just { projectId, threadId }), so we mint our own and stamp it onto events and
// presence — this is how we can finally see "which client / which realm is this
// happening from" when a call is mirrored and controlled across surfaces and
// devices.
//
//   - clientId: persisted in localStorage → stable per browser/device. Survives
//     reloads and navigation; shared by same-origin surfaces on one device, so
//     it reads as "this client/device". Different on a phone viewing over connect.
//   - realmId:  fresh per module load → identifies THIS realm/surface instance.
//     A single device holds several (composer, sidebar, page), so this is what
//     exposes the multi-realm behavior behind the mobile call bugs.
//
// Both are best-effort: no localStorage or no crypto simply degrades to an
// in-memory id (still useful within a session).

const CLIENT_ID_KEY = "bb-handsfree:client-id";

function randomId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `r-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
  }
}

function readOrMintClientId(): string {
  try {
    const store = typeof window === "undefined" ? null : window.localStorage;
    if (!store) return randomId();
    const existing = store.getItem(CLIENT_ID_KEY);
    if (existing) return existing;
    const minted = randomId();
    store.setItem(CLIENT_ID_KEY, minted);
    return minted;
  } catch {
    return randomId();
  }
}

/** Stable per browser/device (localStorage-backed). */
export const clientId = readOrMintClientId();

/** Fresh per realm/surface load (in-memory). */
export const realmId = randomId();

/** Compact identity to merge into event/presence payloads. */
export function identityTag(): { client: string; realm: string } {
  return { client: clientId, realm: realmId };
}

/**
 * A human-recognizable description of THIS device/runtime, captured once (on
 * `client.hello`) and keyed to `clientId`. Coarse label for scanning + the raw
 * UA for truth (first-party, local-only). Best-effort: every field degrades to
 * "" / a default when the API is missing (e.g. tests without navigator/window).
 */
export interface ClientDescriptor {
  platform: string;
  mobile: boolean;
  browser: string;
  displayMode: string;
  runtime: string;
  label: string;
  ua: string;
}

function detectDisplayMode(): string {
  try {
    if (typeof window !== "undefined" && window.matchMedia) {
      for (const mode of ["standalone", "fullscreen", "minimal-ui"]) {
        if (window.matchMedia(`(display-mode: ${mode})`).matches) return mode;
      }
    }
    // iOS Safari "Add to Home Screen" reports here rather than via matchMedia.
    if (typeof navigator !== "undefined" && (navigator as { standalone?: boolean }).standalone) {
      return "standalone";
    }
  } catch {
    /* ignore */
  }
  return "browser";
}

/** Include iPads using desktop Safari's user agent in mobile call routing. */
export function isMobileClient(ua: string, uaMobile = false, maxTouchPoints = 0): boolean {
  return uaMobile || /\b(iPhone|iPad|iPod|Android)\b|Mobile/.test(ua) ||
    (/Macintosh/.test(ua) && maxTouchPoints > 1);
}

function describeClient(): ClientDescriptor {
  const nav = typeof navigator !== "undefined" ? navigator : undefined;
  const ua = nav?.userAgent ?? "";
  const uaData = (nav as { userAgentData?: { platform?: string; mobile?: boolean; brands?: { brand: string }[] } } | undefined)
    ?.userAgentData;

  const desktopIPad = /Macintosh/.test(ua) && (nav?.maxTouchPoints ?? 0) > 1;
  const platform = desktopIPad ? "iOS" :
    uaData?.platform ||
    (/\b(iPhone|iPad|iPod)\b/.test(ua)
      ? "iOS"
      : /\bMacintosh\b/.test(ua)
        ? "macOS"
        : /\bWindows\b/.test(ua)
          ? "Windows"
          : /\bAndroid\b/.test(ua)
            ? "Android"
            : /\bLinux\b/.test(ua)
              ? "Linux"
              : "");

  const mobile = isMobileClient(ua, uaData?.mobile, nav?.maxTouchPoints);

  const brand = uaData?.brands?.map((b) => b.brand).find((b) => b && !/Not.?A.?Brand/i.test(b));
  const browser =
    brand ||
    (/\bElectron\b/i.test(ua)
      ? "Electron"
      : /\bEdg\//.test(ua)
        ? "Edge"
        : /\bOPR\/|Opera\b/.test(ua)
          ? "Opera"
          : /\bFirefox\//.test(ua)
            ? "Firefox"
            : /\bCriOS\/|Chrome\//.test(ua)
              ? "Chrome"
              : /\bSafari\//.test(ua)
                ? "Safari"
                : "");

  const displayMode = detectDisplayMode();

  const win = typeof window !== "undefined" ? (window as { process?: { versions?: { electron?: string } }; webkit?: { messageHandlers?: unknown } }) : undefined;
  const runtime =
    /\bElectron\b/i.test(ua) || win?.process?.versions?.electron
      ? "electron"
      : win?.webkit?.messageHandlers
        ? "native-webview" // best-effort: a WKWebView with a native bridge (e.g. the bb iOS app)
        : displayMode === "standalone"
          ? "pwa"
          : "browser";

  const label = [platform || "?", browser].filter(Boolean).join(" · ") + (mobile ? " (mobile)" : "");

  return { platform, mobile, browser, displayMode, runtime, label, ua };
}

/** Computed once at module load; stable for this realm. */
export const clientDescriptor: ClientDescriptor = describeClient();

/** Compact device summary to stamp on session.started (no raw UA). */
export function deviceSummary(): {
  label: string;
  mobile: boolean;
  platform: string;
  browser: string;
  runtime: string;
} {
  const d = clientDescriptor;
  return { label: d.label, mobile: d.mobile, platform: d.platform, browser: d.browser, runtime: d.runtime };
}
