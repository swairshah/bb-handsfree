# Node.js security audit — 2026-10-22

Sources read: [October advisory](https://nodejs.org/en/blog/vulnerability/october-2026-security-releases)
and [22.23.4 release notes](https://nodejs.org/en/blog/release/v22.23.4).
Patched floors are 22.23.4, 24.22.1 and 26.12.1. EOL lines, including
everything below 22, remain exposed and must move to 24.x LTS with major-upgrade testing.

## Inventory and environment verdict

All tracked files, including hidden files and the npm lockfile, were inspected.

| Environment / location | Finding and verdict |
| --- | --- |
| Development and tests | Previously unpinned. `package.json` runs tests through `node`; `scripts/text-session.mjs` has an env-node shebang. The audit shell supplied affected **22.23.0**. `.nvmrc` now selects **22.23.4**, and manifest/lockfile engine constraints exclude pre-fix supported releases and EOL/odd majors. Selecting the pin is required; npm engines normally only warn. |
| CI | No tracked workflows or CI container configuration. No CI runtime can be verified from this repo. Any external CI must explicitly select a patched runtime. |
| Production / plugin backend | `package.json` declares `bb.server: ./server.ts`. BB supplies its runtime; no independent service or deployment exists in this repo. Actual deployed host versions are unverified and remain an external patch requirement. The development pin does not patch running BB processes. |
| Desktop | No Electron dependency, Tauri sidecar, or bundled Node is maintained here. `shared/client-identity.ts` detects Electron; it does not select its version. As a read-only local observation, installed BB's Electron framework reports **44.3.0**. Its [release metadata](https://releases.electronjs.org/release/v44.3.0) lists **Node 24.20.0**, an affected baseline. |
| Electron follow-up | The [stable release list](https://releases.electronjs.org/) and [44.9.3 notes](https://releases.electronjs.org/release/v44.9.3) were checked. The listed stable lines still report Node 24.22.0; 44.9.3's notes do not document these Node fixes. No patched Electron release was verified. BB must ship an Electron update with confirmed fixes; changing `.nvmrc` cannot update embedded Node. |

No `.node-version`, `.tool-versions`, mise, Volta, packageManager runtime pin,
Dockerfile/base image, distroless image, Cloud Run/Cloud Build config, devcontainer,
SEA configuration, startup-snapshot build, or Permission Model flags were found.
`@types/node` (22.x) and `undici-types` (6.21.0) are declarations, not runtimes.
There is no direct or locked npm `undici` implementation. Built-in `fetch` uses
the host implementation; the verified Node 22.23.4 binary reports Undici 6.29.1.
Third-party dependency engine ranges are compatibility metadata, not runtime pins.

## Vulnerable paths

| CVE / path | Repository exposure |
| --- | --- |
| CVE-2026-111497 — Brotli OOB write / RCE | No explicit decoder, but backend `fetch` consumes remote bodies in `server/realtime-call.ts` and `server/credentials.ts`. Node fetch can automatically decompress Brotli responses. Fixed OpenAI origins limit attacker control; malicious compressed upstream responses remain relevant. The text harness also fetches a caller-selected `--bb-url`. |
| CVE-2026-106069 / CVE-2026-106072 — IP hostname / SAN validation | Backend HTTPS origins are fixed `api.openai.com` and `auth.openai.com`; no user-selected TLS hostname there. The text harness accepts an arbitrary `--bb-url`, including HTTPS/IP forms. `server/tools.ts` fetches the BB-supplied loopback URL. Runtime patching is still required. |
| CVE-2026-105481 — HTTP keep-alive | Built-in fetch uses pooled connections, including loopback RPCs. No explicit `http.Agent` client was found; reachability of this particular core HTTP defect through fetch was not established. Install/build dependencies also perform network requests. |
| CVE-2026-105482 — DNS NUL truncation | No direct `dns.resolve` calls or user-input resolver was found. Ordinary fetch hostname lookup does not by itself prove this resolver path. |
| CVE-2026-106074 — cached entropy in snapshots/SEAs | Browser-side UUIDs occur in `voice/agent.ts` and `shared/client-identity.ts`. No Node SEA or user-land snapshot build was found. No demonstrated trigger. |
| CVE-2026-106073 — Permission Model realpath bypass | No Node Permission Model configuration was found. BB's own host policy is outside this repo. |
| CVE-2026-105483 — fullwidth IP digits | Affects 24/26, not the chosen Node 22 development line. Relevant to affected BB/Electron Node 24 baselines; fixed backend hosts limit direct reachability. |
| CVE-2026-106070 / CVE-2026-106071 — ZipFile / wildcard permissions | Advisory lists these on Node 26 only. No use of either facility was found. |

Node 22.23.4 also delivers the upstream c-ares, certificate trust, OpenSSL,
SQLite and Undici changes. Node's SQLite update does not update the separately
packaged `better-sqlite3` dependency. No dependency upgrades are claimed here.

## Changes and validation

- Added exact `.nvmrc` 22.23.4 and patched-major engine ranges in manifest/lockfile.
- Documented runtime selection in the README. Lockfile root version was also
  synchronized with the existing package version 0.1.7; dependency resolutions
  were preserved.
- Downloaded the official macOS arm64 Node 22.23.4 binary and verified its SHA-256
  against the upstream SHASUMS256.txt before running it, without replacing the
  machine's Node installation.

Validation on Node 22.23.4:

- `npm ci --no-audit --no-fund`: passed (223 packages). The first attempt hit
  sandbox-denied user cache writes; rerunning with npm/node-gyp caches under
  `/tmp` succeeded. Existing dependency deprecation warnings remain.
- `npm test`: passed, 82 tests, zero failures or skips.
- `npm run typecheck`: passed.
- `bb plugin build .`: passed for backend and frontend. It warned that the
  project's SDK 0.4.47 differs from installed BB SDK 0.6.37; the SDK pin was
  intentionally preserved.
- `git diff --check`: passed. No lint script is defined.

No production changes, plugin installation/reload, merge, release or deployment
are part of this audit. Upgrading the running BB/Electron host remains required
before declaring deployed environments remediated.
