# D3 deepening — desktop shell (Electron vs Tauri vs Wails) + bundler (webpack vs Vite vs Rolldown)

Shape: select. Decision served: which desktop runtime + bundler for a JS cryptocurrency node
whose network core is libp2p and whose money accounting is big.js.

## Load-bearing constraint discovered (reframes the whole question)
- ref=[D3.1] status=verified class=versions-compat pub=2026-09 — js-libp2p ships separate
  transports per runtime: `@libp2p/tcp`, `@libp2p/mdns` are Node-only; `@libp2p/websockets`,
  `@libp2p/webrtc`, `@libp2p/webtransport` are the browser/webview set. The README lists `npm
  run test:node` and `npm run test:chrome` as distinct suites. Source: github.com/libp2p/js-libp2p
  (README), accessed 2026-09-29. => The node core (libp2p + big.js + consensus) MUST run in a
  Node.js process. The desktop shell is a UI client on top, not the runtime for the core.
- ref=[D3.2] status=verified class=architecture pub=2026-09 — Tauri v2's backend is Rust; the
  webview is a frontend (React) that talks to Rust via commands. Node.js is NOT available inside
  the webview; the official "Embedding External Binaries" (sidecar) doc says sidecars exist "to
  prevent users from installing additional dependencies (e.g., Node.js or Python)" and are run via
  `Command.sidecar(...)` / `app.shell().sidecar(...)`, with per-`-$TARGET_TRIPLE` binaries.
  Source: tauri.app/develop/sidecar/ (Tauri docs), accessed 2026-09-29. => Tauri needs a bundled
  Node.js sidecar process to host the node core; the core becomes a separate process the React UI
  talks to over IPC (and the Rust layer sits in between).

## Shell candidates — evidence
- ref=[D3.3] status=verified class=versions pub=2026-09-29 — Electron latest = 44.5.0, 45.0.0
  alpha.13 in flight; @electron-forge/cli 8.0.1 (2026-09-29). npmjs.org registry, accessed
  2026-09-29. Electron main process IS Node.js (long-standing, widely known — unverified here but
  load-bearing and stable).
- ref=[D3.4] status=verified class=versions pub=2026-09-29 — @tauri-apps/cli latest = 2.12.0
  (2026-09-26); 3.0.0-alpha.3 (2026-09-26). npmjs.org registry, accessed 2026-09-29.
- ref=[D3.5] status=unverified class=performance pub=2026-09 — Tauri binaries are smaller and use
  less memory than Electron because Tauri uses the OS webview + a Rust core instead of bundling
  Chromium; the Tauri docs ship an "App Size" page and a comparing-to-electron page (page bodies
  JS-rendered, not captured this run). Source: tauri.app (App Size / Comparing to Electron).
  Confidence medium — direction is well established, exact MB numbers not captured.
- Wails (wails.io) — Go backend + webview frontend, same shape as Tauri (second non-JS language +
  a Node sidecar for the core). Not deeply sourced this run; included as the third candidate in
  the matrix, same reasoning as Tauri applies.

## Bundler candidates — evidence
- ref=[B1.1] status=verified class=versions pub=2026-09-29 — vite 8.3.1 (2026-09-24), weekly
  cadence; esbuild 0.28.2 (2026-08-08); rollup 4.63.5 (2026-09-24); rolldown 1.2.11 (2026-09-24)
  weekly; webpack 5.111.1 (2026-09-18) still patched but 5.x line. npmjs.org, accessed 2026-09-29.
- ref=[B1.2] status=verified class=ecosystem pub=2026-09 — Rolldown: "Rust-based bundler",
  "Rollup Compatible" API + esbuild feature parity, and explicitly "Designed for Vite — The
  unified bundler powering Vite 8+". Source: rolldown.rs, accessed 2026-09-29. => Vite 8 build =
  Rolldown; Vite is the integration point, not a competing choice against Rolldown.
- ref=[B1.3] status=verified class=ecosystem pub=2026-09 — Vite site: 80k+ GitHub stars, 80m+
  weekly npm downloads, "trusted by" OpenAI/Shopify/Stripe/Linear. Source: vite.dev, accessed
  2026-09-29.
- ref=[B1.4] status=verified class=performance pub=2025-12 — Rolldown benchmark (19k modules,
  Ubuntu, 2025-12-21): rolldown 1.61s / esbuild 1.70s / rspack 4.07s / rollup+esbuild 40.10s.
  Source: rolldown.rs + github.com/rolldown/benchmarks, accessed 2026-09-29. (Vendor-published;
  treat as directional.)

## What the core should be (the actual answer to "cover by tests properly")
- ref=[D3.6] status=decision class=architecture pub=2026-09 — Keep the node core (libp2p + big.js
  + consensus + chain store) as a pure Node.js package with ZERO UI/shell imports. Then it is
  testable with a plain Node test runner (node:test or Vitest) with no desktop shell involved, and
  the shell (Electron/Tauri/Wails) is a thin, swappable client. This makes the "covered by tests
  properly" requirement tractable and makes the shell choice low-stakes.

## Leads / not-found
- Did not capture exact Tauri-vs-Electron MB/RAM numbers (page bodies are client-rendered; fetch
  tool 404s on the SPA routes, curl returns only the nav). Flagged unverified.
- Did not source Wails repo metrics or a Wails-specific Node-sidecar writeup this run.
