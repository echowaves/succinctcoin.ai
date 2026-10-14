---
ticket: "3"
epic: epic-desktop-app
status: "built"
route: full
review: quick
review_source: pinned
covers:
  - "R1"
  - "E1"
  - "E2"
  - "E3"
baseline_revision: "7661a897086bf0fc498a337418b3c55c8615a6c6"
lenses_ran:
  - "quick"
review_loop_iteration: 1
context:
  - "/Users/dmitry/hacks/succinctchain/succinctcoin.ai/_bmad-output/initiative-succinctcoin-ai/architecture-succinctcoin/architecture-succinctcoin.md"
  - "/Users/dmitry/hacks/succinctchain/succinctcoin.ai/_bmad-output/initiative-succinctcoin-ai/epic-desktop-app.md"
  - "/Users/dmitry/hacks/succinctchain/succinctcoin.ai/_bmad-output/initiative-succinctcoin-ai/epic-desktop-app/tickets.toml"
  - "/Users/dmitry/hacks/succinctchain/succinctcoin.ai/_bmad-output/initiative-succinctcoin-ai/epic-desktop-app/story-electron-shell-preload-ad11-parity-plan.md"
  - "/Users/dmitry/hacks/succinctchain/succinctcoin.ai/packages/app/package.json"
  - "/Users/dmitry/hacks/succinctchain/succinctcoin.ai/packages/app/tsconfig.json"
  - "/Users/dmitry/hacks/succinctchain/succinctcoin.ai/packages/app/tsconfig.build.json"
  - "/Users/dmitry/hacks/succinctchain/succinctcoin.ai/packages/app/src/main/ipc-channels.ts"
  - "/Users/dmitry/hacks/succinctchain/succinctcoin.ai/packages/app/src/main/index.ts"
  - "/Users/dmitry/hacks/succinctchain/succinctcoin.ai/packages/app/src/preload.ts"
  - "/Users/dmitry/hacks/succinctchain/succinctcoin.ai/packages/app/src/preload.d.ts"
  - "/Users/dmitry/hacks/succinctcoin/succinctcoin.ai/packages/app/src/renderer/index.html"
  - "/Users/dmitry/hacks/succinctchain/succinctcoin.ai/packages/app/test/core-host.test.ts"
  - "/Users/dmitry/hacks/succinctchain/succinctcoin.ai/packages/core/src/index.ts"
  - "/Users/dmitry/hacks/succinctchain/succinctcoin.ai/packages/core/src/events/types.ts"
---

# Story 6.3 plan — React renderer (balance / mining status / peers) + the AD-11 renderer check

> Story of truth: `_bmad-output/initiative-succinctcoin-ai/epic-desktop-app/tickets.toml` `[[entry]] id = 3`
> ("App: React renderer (balance, mining status, network peers) + the AD-11 renderer check" — covers R1,E1,E2,E3; after 6.2; risk medium).
> The 6.2 shell + preload/IPC bridge (AD-11) + the headless core-host are DONE (`7661a89`). This story builds the React
> (Vite) renderer that consumes the bridge: a balance display, a mining-status panel (slot + last-block winner + ticket
> count), and a network-peers list — driven by the core event stream (the `BlockApplied`/`CoreStarted`/`CoreStopped`
> subscriptions) + the read-API for snapshots (`getChainHead`/`getBalances`/`getPeers`), **never polling** (E1 / AD-9: the
> event stream + read-API is the complete UI data source). The renderer is a **thin client** (AD-1): it imports ONLY the
> bridge's typed surface (`window.succinctcoin`), never `@succinctcoin/core` internals. The **AD-11 renderer check**: the
> identity keys are ABSENT from the renderer (a static check).

## 1. Scope + design

### 1.1 The spine rules this story upholds
- **E1 / AD-9 — event stream + read-API, no polling:** the renderer subscribes to the core event stream (via the bridge's
  `on(...)`) + calls the read-API for the initial snapshot. **No `setInterval`/`setTimeout`-driven data fetch** — the data
  flows from the events + the one-time snapshot read.
- **AD-1 — thin client:** the renderer imports ONLY the bridge's typed surface (`window.succinctcoin`, the `preload.d.ts`
  global). It **never imports `@succinctcoin/core`** (no core internals, no bypass of applyBlock).
- **AD-11 — no keys in the renderer:** the renderer source references NO key material (no `keypair` / `.secret` /
  `deriveIdentityKeypair` / `privateKey`) — only peer IDs, status, and signed artifacts.
- **AD-9 — read-only:** the renderer reads via the read-API + the event stream; it never mutates state.
- **CAP-6 — core unchanged:** the core package (`packages/core/src` + `proto` + `package.json`) is UNTOUCHED; the core
  package-local suite stays 256/256; the root suite + core typecheck/build stay green.
- **AD-3 — chain-time only (the renderer is chain-time-agnostic):** the renderer displays the chain state (slot, winner,
  ticket count) — it never uses a wall clock or RNG (it just renders what the core reports).

### 1.2 The renderer architecture (the thin client)
- **`src/renderer/ui-state.ts`** (PURE — no DOM, no electron, no `@succinctcoin/core`): the state-management. It defines
  the UI state shape (the chain head, the balances, the peers, the mining flag) + a **reducer** (event-driven: `BlockApplied`
  updates the head/winner/ticket-count; `CoreStarted`/`CoreStopped` set the mining flag) + an **initial snapshot** builder
  (calls the read-API: `getChainHead`/`getBalances`/`getPeers`). The bridge is **dependency-injected** (the module takes the
  bridge as an argument — the runtime provides `window.succinctcoin`; the test provides a mock). The read-model types are
  **derived from the bridge surface** (`Window['succinctcoin']`, the `preload.d.ts` global) — NEVER imported from
  `@succinctcoin/core` (AD-1). This module is the headless-testable core of the story.
- **`src/renderer/useSuccinctcoin.ts`** (the React hook): wires the bridge (`window.succinctcoin`) to the `ui-state` module
  — on mount, builds the initial snapshot (the read-API); subscribes to the event stream (the `on(...)` calls); returns the
  current `UiState` + re-renders on each event. No timers.
- **`src/renderer/App.tsx`** (the React component): renders the `UiState` — the balance display, the mining-status panel
  (slot + last-block winner identity id + ticket count), and the network-peers list. A thin render of the state.
- **`src/renderer/main.tsx`** (the React entry): mounts `<App />` into the `#root` element.
- **`src/renderer/index.html`** (the Vite entry / the HTML shell): the `#root` div + a `<script type="module" src="/main.tsx">`
  + the CSP (`default-src 'self'; script-src 'self'` — the bundle is same-origin, so no `'unsafe-inline'`/`'unsafe-eval'`).
- **`vite.config.ts`** (the Vite config): builds the renderer. `base: './'` (the bundle is loaded from `file://` in the
  BrowserWindow — relative asset paths). The React 19 JSX via esbuild's **automatic runtime** (`esbuild: { jsx: 'automatic' }`
  — no `@vitejs/plugin-react` dep, staying on the spine pins: react 19.3.0 + vite 8.3.2). Output to `dist/renderer/`.
- **`src/main/index.ts`** (UPDATED — the thin electron glue): the BrowserWindow loads the Vite-built renderer
  (`dist/renderer/index.html`) instead of the 6.2 placeholder (the asset-copy step: the build produces the renderer bundle;
  the shell loads it). The `data:` fallback is kept (a missing bundle is a startup error, not a silent blank window).

### 1.3 The toolchain (the spine pins, added to `packages/app` devDeps)
- `react` 19.3.0 + `react-dom` 19.3.0 (the renderer runtime — `react-dom/client` for the `createRoot` mount) — devDeps
  (the renderer is bundled by Vite; it's not a runtime dep of the main process).
- `vite` 8.3.2 (the renderer bundler — Rolldown engine).
- `@types/react` + `@types/react-dom` (the React type declarations — the spine has no explicit pin; the impl picks the
  React-19-compatible majors; recorded in the Plan Change Log if the exact version is a judgment call).
- No other new deps (NO `@vitejs/plugin-react` — the esbuild automatic runtime handles the React 19 JSX; NO `jsdom`/testing
  DOM — the `ui-state` module is PURE + the static checks are source-scans; the React components are verified by the
  typecheck + the Vite build + the 6.4 e2e).

### 1.4 The tsconfig + build changes
- `packages/app/tsconfig.json`: the `include` gains `.tsx` (`src/**/*.ts` → `src/**/*`) so the React components + the
  `ui-state`/hook are typechecked. The `preload.d.ts` (the `window.succinctcoin` global) is already in `src/`, so the
  renderer sees the bridge types.
- `packages/app/package.json`: the `build` script becomes the tsc (main + preload → `dist/`) **and** the Vite build (renderer
  → `dist/renderer/`): `tsc -p tsconfig.build.json && vite build`. The `typecheck` script (`tsc -p tsconfig.json`) now covers
  the `.tsx` files too. The devDeps gain react/react-dom/vite/@types/react/@types/react-dom.

## 2. Acceptance criteria
- **AC1 — the renderer shows the data (driven by the event stream + read-API):** the React UI renders a balance, a
  mining-status (slot + last-block winner identity id + ticket count), and a peers list. The state is built from the
  read-API snapshot (on mount) + updated by the event stream (the `BlockApplied` subscription). A test drives the PURE
  `ui-state` module with a mock bridge (snapshot + a `BlockApplied` event) and asserts the resulting `UiState` is correct —
  and the module is event-driven (no timers).
- **AC2 — no polling (E1):** the renderer contains NO `setInterval`/`setTimeout`-driven data fetch. A static check over the
  renderer source (the `ui-state`/hook/`App`/`main`) asserts there is no `setInterval` and no `setTimeout` used for
  data-fetching (the only timers allowed are none — the data flows from the events + the one-time snapshot).
- **AC3 — thin client (AD-1):** the renderer imports ONLY the bridge's typed surface. A static check asserts the renderer
  source (the `.ts`/`.tsx` files under `src/renderer/`) has NO `@succinctcoin/core` import.
- **AC4 — AD-11 renderer check:** the identity keys are ABSENT from the renderer. A static check asserts the renderer source
  references NO key material (no `keypair` / `.secret` / `deriveIdentityKeypair` / `privateKey` / `secretKey`) — only peer
  IDs, status, and signed artifacts.
- **AC5 — the app's typecheck + build are green:** the app's `tsc -p tsconfig.json` (now covering the `.tsx`) is clean; the
  Vite build produces the renderer bundle (`dist/renderer/index.html` + the JS).
- **CAP-6 — the core suite is unchanged:** the core package-local suite stays 256/256; the root suite stays green (now 259/259
  + the new app rows); the core typecheck + build (PROTO_OK) are clean; the core `src/` + `proto` + `package.json` are
  UNTOUCHED.

## 3. Gates (the acceptance checks)
- **G1 — the core trio (CAP-6, FIRST — the app imports the core dist):** the core build is `PROTO_OK`; the core
  package-local suite is **256/256** (38 files); the root suite is **green** (259/259 + the new app rows); the core
  typecheck (`tsc -p packages/core/tsconfig.json`) is clean. (The core build precedes the app gates — the app resolves
  `@succinctcoin/core` to the dist.)
- **G2 — the app package-local test:** the app's `vitest run` is green — the 6.2 rows (3) + the new renderer rows (the
  `ui-state` reducer/snapshot + the static checks: no-poll, thin client, AD-11).
- **G3 — the app typecheck:** the app's `tsc -p tsconfig.json` is clean (the `.tsx` components + the `ui-state`/hook
  typecheck against the bridge types; the react + vite + core dist `.d.ts` resolve).
- **G4 — the app build (the asset copy step):** the app's `tsc -p tsconfig.build.json && vite build` is green — the main +
  preload compile to `dist/` + the renderer bundle is produced in `dist/renderer/` (the `dist/` is gitignored — never
  committed).
- **G5 — the git-diff gate (scope):** the diff vs `7661a89` touches ONLY `packages/app/` (the renderer + the vite config +
  the package.json + the tsconfig + the index.ts BrowserWindow load + the test) + `pnpm-lock.yaml` (the react/vite devDeps) +
  this plan. The core `src/` + `proto` + the core `package.json` + the root config are UNTOUCHED. NO `@libp2p/kad-dht`, NO
  `@libp2p/peer-id`, NO `big.js` in the app. The renderer has NO `@succinctcoin/core` import.

## 4. Tasks
- [x] **T1 — the toolchain:** add `react` 19.3.0 + `react-dom` 19.3.0 + `vite` 8.3.2 + `@types/react` + `@types/react-dom` to
  `packages/app/package.json` devDeps (the spine pins; record the `@types/*` versions in the Plan Change Log). Update the
  `build` script (`tsc -p tsconfig.build.json && vite build`).
- [x] **T2 — the tsconfig:** the `packages/app/tsconfig.json` `include` gains the `.tsx` files (`src/**/*`).
- [x] **T3 — the `ui-state.ts` (PURE):** the UI state shape + the event reducer + the initial-snapshot builder (the read-API)
  + the bridge-injected types (derived from `Window['succinctcoin']`, NEVER `@succinctcoin/core`). No timers, no DOM, no
  electron, no key material.
- [x] **T4 — the React renderer:** `useSuccinctcoin.ts` (the hook — snapshot + event subscription + state), `App.tsx` (the
  balance / mining-status / peers views), `main.tsx` (the `createRoot` mount), the real `index.html` (the `#root` + the
  `<script type="module" src="/main.tsx">` + the CSP).
- [x] **T5 — the Vite config:** `vite.config.ts` (`base: './'`, the esbuild automatic JSX runtime, the renderer entry + the
  `dist/renderer/` output).
- [x] **T6 — the index.ts BrowserWindow load:** the thin electron glue loads the Vite-built renderer
  (`dist/renderer/index.html`) instead of the placeholder (the asset-copy step; the `data:` fallback is kept).
- [x] **T7 — the test:** `test/renderer.test.ts` — (a) the `ui-state` reducer + snapshot (a mock bridge: the snapshot + a
  `BlockApplied` event → the correct `UiState`); (b) the no-poll static check (no `setInterval`/`setTimeout` data-fetch in the
  renderer source); (c) the thin-client static check (NO `@succinctcoin/core` import in the renderer source); (d) the AD-11
  static check (NO key material in the renderer source).
- [x] **T8 — the gates:** run G1–G5 (the core trio FIRST, then the app test/typecheck/build, then the git-diff gate).

## 5. Verification (the closing check)
- G1–G5 are green (the core trio for CAP-6; the app test/typecheck/build for the renderer; the git-diff gate for scope).
- The renderer is a thin client (no `@succinctcoin/core` import), no-poll (no data-fetch timers), and key-free (AD-11).
- The core `src/` + `proto` + `package.json` + the root config are UNTOUCHED (CAP-6).
- NO `@libp2p/kad-dht`, NO `@libp2p/peer-id`, NO `big.js` in the app; the renderer has NO key material.

## 6. Risks + decisions (recorded)
- The React component rendering is verified by the typecheck + the Vite build NOW + the 6.4 e2e (the packaged app SHOWS the
  balance/mining/peers) — consistent with the 6.2 approach (the headless logic test + the typecheck/build now; the actual
  launch in 6.4). The `ui-state` module (the testable core) is fully tested headless.
- The Vite 8 (Rolldown) + the esbuild automatic JSX runtime is a build decision — if the automatic runtime needs an extra
  config (or `@vitejs/plugin-react`), the impl records it in the Plan Change Log (staying on the spine pins is the
  preference; a new dep is a deviation to flag).
- The `@types/react`/`@types/react-dom` versions (React-19-compatible) are a build decision (recorded).

## 7. Implementation Notes

- **T1 (toolchain)** — `packages/app/package.json` devDeps: `react 19.3.0` + `react-dom 19.3.0` + `vite 8.3.2` (spine pins) + `@types/react 19.3.0` + `@types/react-dom 19.3.0` (the latest `@19` on the registry — exact match to react 19.3.0; the spine has no pin, so recorded in the Plan Change Log). `build` script = `tsc -p tsconfig.build.json && vite build`. Install from the repo root (`ELECTRON_SKIP_BINARY_DOWNLOAD=1 corepack pnpm install`, as in 6.2 — the electron binary stays skipped; +9 packages). NO `@vitejs/plugin-react`, NO `@libp2p/kad-dht`/`@libp2p/peer-id`/`big.js` (verified in the lockfile diff: the additions are react, react-dom, scheduler [transitive], @types/react, @types/react-dom, csstype [transitive] — and vitest's indirect vite peer unified 8.3.1 → 8.3.2).
- **T2 (tsconfig)** — `include: ["src/**/*.ts", ...]` → `["src/**/*", "test/**/*"]` as planned, PLUS (recorded in the Plan Change Log): `lib: ["ES2022", "DOM"]` (the renderer's `main.tsx` needs `document`/DOM types; the app package is the shell — the core tsconfig is untouched) + `jsx: "react-jsx"` (tsc's automatic-runtime flag, matching the bundler transform) + **`files: ["src/preload.d.ts"]` — a 6.2 latent defect fixed here**: TS's include-glob walker SILENTLY SKIPS a `.d.ts` that has a same-named `.ts` implementation sibling (`src/preload.d.ts` next to `src/preload.ts`), so `window.succinctcoin` was in NO tsc program before 6.3 (nothing referenced it, so 6.2's green typecheck never noticed). 6.3 is the first code that reads `Window['succinctcoin']`, which exposed it. Verified with a minimal repro; an explicit `include` entry is STILL skipped — only `files:` forces the file in.
- **T3 (`ui-state.ts` — PURE)** — `type Bridge = Window['succinctcoin']` (type-level only — erased at runtime, headless-safe). Read-models DERIVED from the bridge surface: `ChainHead`/`BalanceState`/`Peer` via `Awaited<ReturnType<Bridge['getChainHead' | 'getBalances' | 'getPeers']>>`. The event payloads are LOCAL key-free projections (`BlockAppliedEvent` = slot/hash/winnerIdentityId/ticketCount/txCount; `SlotEvent` = slot) — the renderer names the events only; the bridge's typed `on` enforces the core's real payload types at the subscription site (a core drift fails the app typecheck; the `CoreEvents` owner stays the core, AD-9). `UiState` = `{ head, balances, peers, mining }` (the plan's four fields). Exports: `initialUiState()`, `buildInitialSnapshot(bridge)` (`Promise.allSettled` over the three read-API calls — a read rejection is a GRACEFUL null, e.g. the core not booted yet), and `reduce(state, event)`: `BlockApplied` merges the event's five fields into `head` (the snapshot's `totalSupplyDisplay` preserved — the event carries no supply); a pre-snapshot `BlockApplied` (head still null) leaves head null (the snapshot owns the head read-model; the hook re-snapshots on `CoreStarted`, so the gap is transient); `CoreStarted`/`CoreStopped` set `mining`. No DOM, no electron, no core import, no timers.
- **T4 (React renderer)** — `useSuccinctcoin.ts`: on mount, subscribes the event stream FIRST (the three `on(...)` calls — nothing missed), then builds the one-time snapshot; each event re-renders through the PURE reducer. `CoreStarted` RE-RUNS the snapshot — AD-9: "the event stream + the read-API is the complete UI data source ('no polling' means never poll, not 'events alone suffice')": an event-driven re-read, not a poll; the merge preserves the reducer's `mining` flag. The hook NEVER calls a command (AD-9 read-only — the start/stop/startMining commands stay on the bridge surface for the host; the 6.3 view is display-only per the plan, and 6.4's e2e drives the main-process path). `App.tsx`: three key-free panels — Mining status (running/halted flag + head slot + last-block winner identity id + ticket count), Balance (total supply + identity-id → decimal-string list, rendered AS-REPORTED — no conversion, no big.js, the AD-5 display strings come from the read-models), Network peers (peerId + multiaddrs — the only identity data AD-11 allows); a `shortId` display helper (the full id stays the list key). `main.tsx`: `createRoot` into `#root` (throws on a missing element — a startup error, not a silent blank). `index.html`: the 6.2 placeholder replaced by `#root` + `<script type="module" src="/main.tsx">` + the SAME CSP (`default-src 'self'; script-src 'self'`).
- **T5 (Vite config)** — `vite.config.ts`: `base: './'` (the bundle loads from `file://`), `root: 'src/renderer'` (so the shell's `/main.tsx` resolves), output `dist/renderer/` (`outDir: '../../dist/renderer'`, `emptyOutDir: true` — the tsc build owns `dist/main/` + `dist/preload.js`; no collision). The automatic JSX runtime is set via **`oxc: { jsx: { runtime: 'automatic', importSource: 'react' } }`** — Vite 8 (Rolldown engine) IGNORES the `esbuild` option (verified warning: "Both esbuild and oxc options were set … esbuild options will be ignored"), and oxc's default runtime is already `automatic`/`importSource 'react'` — stated explicitly to pin the intent. Verified in the built bundle: the components call the `react/jsx-runtime` helpers (`jsx`/`jsxs`/`Fragment`), NO `React.createElement` in app code. NEW file `vitest.config.mjs` (app-local, not in the plan's file list — recorded): the vite config's `root: 'src/renderer'` HOOKED the package-local `vitest run` ("No test files found"); a standalone vitest config takes precedence over `vite.config.ts` and mirrors the root config shape (node env, `test/**/*.test.ts`).
- **T6 (index.ts)** — the thin electron glue's load path was ALREADY `new URL('../renderer/index.html', import.meta.url)` from `dist/main/` = `dist/renderer/index.html` — the 6.3 Vite build now produces the file exactly there, so the 6.2 "asset-copy step" lands where the shell already looks. Updated: the comment (placeholder → Vite-built renderer), the variable name, and the `data:` fallback message (no longer "lands in story 6.3" — now points at the build command). The `data:` fallback is kept (a missing bundle is a startup error, not a silent blank window). `index.ts` remains the ONLY main-path electron import (AD-1 — re-verified: `from 'electron'` in exactly `src/main/index.ts` + `src/preload.ts`).
- **T7 (test — `test/renderer.test.ts`, HEADLESS-SAFE)** — 5 rows, no electron import, no DOM: (a) `RENDERER_UI_STATE_SNAPSHOT` — a MOCK bridge (the DI seam: fake `getChainHead`/`getBalances`/`getPeers` returning pinned values; `on` captures the callbacks; the commands THROW — the view never calls one) + `buildInitialSnapshot` → the correct `UiState`; (b) `RENDERER_UI_STATE_REDUCE` — subscribe like the hook, deliver `CoreStarted`/`BlockApplied`/`CoreStopped` through the mock's captured callbacks → the head advances (the event's five fields, the snapshot's `totalSupplyDisplay` preserved), the snapshot fields the event doesn't carry are untouched, the flag flips on/off; (c) `RENDERER_NO_POLL` — the static check: NO `setInterval`/`setTimeout` in the renderer source (comment-stripped, the 6.2-style self-scan) + the file set pinned to the four renderer modules; (d) `RENDERER_THIN_CLIENT` — NO `@succinctcoin/core` import in the renderer source; (e) `RENDERER_AD11_NO_KEYS` — NO key material (`keypair`/`.secret`/`deriveIdentityKeypair`/`privateKey`/`secretKey`) in the renderer source.
- **T8 (gates — all green, 2026-10-14)** — G1 (FIRST): core build PROTO_OK (the protons regen is a no-op — `git status` on `packages/core/` empty) + core package-local **256/256** (38 files) + root suite **264/264** (40 files = the 256 core + the 8 app rows — the plan's "259/259 + the new app rows" = 259 + 5 new = 264) + root typecheck clean. G2: app `vitest run` = **8/8** (the 6.2 rows (3) + the new renderer rows (5)). G3: app `tsc -p tsconfig.json` clean (now covering the `.tsx` + the `files:` fix). G4: app build clean — `dist/main/{core-host,index,ipc-channels}.{js,d.ts,js.map}` + `dist/preload.{js,d.ts,js.map}` (tsc) + `dist/renderer/index.html` (CSP kept, relative `./assets/...` module script) + `dist/renderer/assets/index-<hash>.js` (222 kB — the React bundle); `dist/` is gitignored (never committed). G5: the diff vs `7661a89` touches ONLY `packages/app/` (5 modified: `package.json`, `src/main/index.ts`, `src/renderer/index.html`, `tsconfig.json` + 7 new: the four renderer modules, `test/renderer.test.ts`, `vite.config.ts`, `vitest.config.mjs`) + `pnpm-lock.yaml` (+68/−11 — the toolchain only) + this plan; the core `src/` + `proto/` + core `package.json` + the root config are UNTOUCHED; NO `@libp2p/kad-dht`/`@libp2p/peer-id`/`big.js` anywhere in the app (code or lockfile); the electron imports are exactly `src/main/index.ts` + `src/preload.ts`.
- **Execution note (self-inflicted, no plan impact):** a `*/` inside a block COMMENT (`the packages/*/test/**` glob) in the first draft of `vitest.config.mjs` terminated the comment early → `ReferenceError: test is not defined` at config load. Rewrote the comment (no glob literal). Lesson: a comment-stripping scanner (like the story's static checks) would NOT catch this — a `*/` inside a comment is a parse-level bug.
- **Review fixes (F1/F3/F5/F6 — see the Review Triage Log):** the Quick lens found 6 findings. F1 (no recovery if `CoreStarted` is missed), F3 (balance/peers/total-supply frozen after the `CoreStarted` snapshot), F5 (the `dist/renderer/` ownership relied on script order), and F6 (a missing bridge produced a silent blank window) are FIXED in code — the reducer now sets `mining: true` on `BlockApplied`; the hook re-reads the read-API on each `BlockApplied` (event-driven, not polling); the build tsconfig excludes the renderer from the tsc emit; the hook guards the bridge read + the App renders an error panel. F2 (a benign snapshot race) is DEFERRED to 6.4; F4 (the lockfile re-resolves the core importer's tooling) is a NON-ISSUE (CAP-6's letter holds). The re-gate after the code patches is green (root 264/264, app 8/8, app typecheck/build clean, core untouched).

## 8. Plan Change Log

- **@types versions (T1 — the plan's judgment call):** `@types/react 19.3.0` + `@types/react-dom 19.3.0` (the latest `@19` on the npm registry at install time — an exact match to the spine pin react 19.3.0).
- **Vite 8 JSX config (T5 — deviation from the plan's `esbuild: { jsx: 'automatic' }`):** Vite 8.3.2 runs the Rolldown engine, whose oxc transform IGNORES the `esbuild` option (verified: the build warns "Both esbuild and oxc options were set. oxc options will be used and esbuild options will be ignored"). The automatic runtime is set via `oxc: { jsx: { runtime: 'automatic', importSource: 'react' } }` — which is ALSO oxc's default (`runtime: 'automatic'`, `importSource: 'react'`), stated explicitly to pin the intent. NO `@vitejs/plugin-react` added (stayed on the spine pins). Verified in the built bundle (the `react/jsx-runtime` helpers; no `React.createElement` in app code).
- **App tsconfig `lib` + `jsx` (T2 — beyond the plan's include change):** `lib: ["ES2022", "DOM"]` (the renderer needs the DOM types — `document` in `main.tsx`; the app package is the shell, the core tsconfig is untouched and stays DOM-free) + `jsx: "react-jsx"` (tsc's automatic-runtime flag — required to typecheck the `.tsx`).
- **6.2 latent defect fixed (T2 — the `files:` entry):** `src/preload.d.ts` was NEVER in any tsc program — TS's include-glob walker skips a `.d.ts` that has a same-named `.ts` implementation sibling (`preload.ts`), so the `window.succinctcoin` global declaration was dead weight in 6.2 (nothing referenced `Window` before 6.3). Added `files: ["src/preload.d.ts"]` to the app tsconfig (an explicit `include` entry is still skipped — verified; only `files:` works). This is a FIX, not a behavior change: the declared surface is exactly what 6.2 authored, and 6.3's renderer + tests now typecheck against it as intended.
- **New file `packages/app/vitest.config.mjs` (T5 — not in the plan's file list):** required — `vite.config.ts` sets `root: 'src/renderer'`, and the package-local `vitest run` inherits the vite config → "No test files found". A standalone vitest config takes precedence over the vite config; it mirrors the root `vitest.config.mjs` shape (node environment, the package's `test/` only). The root run (repo-root config, the `packages/*/test/**` glob) is unaffected.
- **Lockfile side effect:** the app's direct `vite 8.3.2` devDep unified vitest's INDIRECT vite peer resolution in the lockfile (8.3.1 → 8.3.2). Lockfile-only — no manifest change to vitest or the core.
- **Review fixes (F1/F3/F5/F6 — see the Review Triage Log):** four of the six Quick lens findings are FIXED in code (not plan deviations — they correct the renderer's state approach + the build config to uphold the epic's Done-when + the plan's own robustness principles). The re-gate after the code patches is green (root 264/264, app 8/8, app typecheck/build clean, core untouched).

## Review Triage Log

**Quick lens (review_loop_iteration 1)** — 6 findings. Gates re-verified live by the reviewer (core build PROTO_OK + core 256/256 + root 264/264 + app 8/8 + app typecheck/build green; the comment-stripped scans confirm no-poll / thin-client / AD-11 / no-electron in the renderer source + bundle). No broken spine rules (E1/AD-9, AD-1, AD-11, AD-3, CAP-6 all hold).

- **F1 — no recovery path if `CoreStarted` is missed (FIXED).** The hook re-ran the snapshot only on `CoreStarted`, and the reducer dropped a `BlockApplied` while `head` was null — so a missed `CoreStarted` (the node booted before the renderer's `useEffect` subscribed) left the UI stuck (mining false, head null, balances/peers never re-read). FIXED: the reducer now sets `mining: true` on `BlockApplied` (a block was just applied → the core is running — recovers the flag if `CoreStarted` was missed; `CoreStopped` still clears it) + the hook re-reads the read-API on EACH `BlockApplied` (see F3), so a pre-snapshot `BlockApplied` recovers `head`/`balances`/`peers`. A new assertion in `RENDERER_UI_STATE_REDUCE` verifies the `mining` recovery after a halt.
- **F2 — snapshot race in the hook (DEFERRED to 6.4).** A `CoreStarted`/`BlockApplied` firing while a snapshot is in flight yields two concurrent `buildInitialSnapshot` calls; the later-RESOLVING (not later-fired) wins. Benign: each snapshot reads the current read-API state, so the last-resolving is the most recent, and the next event self-corrects any transient. Recorded for 6.4 (the e2e is bounded; a snapshot-sequence guard can be added if it proves flaky).
- **F3 — balance/peers/total-supply frozen after the `CoreStarted` snapshot (FIXED).** `BlockApplied` carries only the five head fields (no supply/balances), and the reducer updated only `head`, so the balance/peers/supply went stale from the first mined block after start. FIXED: the hook re-reads the read-API on EACH `BlockApplied` (event-driven, NOT polling — the event triggers the re-read, no timer; consistent with AD-9/E1 "no polling means never poll, not 'events alone suffice'"). The re-read merge preserves the existing `head`/`balances`/`peers` if a read fails (a graceful null/empty). The `RENDERER_NO_POLL` static check still passes (no `setInterval`/`setTimeout` — the re-read is an event-triggered async call).
- **F4 — lockfile re-resolves the core importer's tooling (NON-ISSUE).** The vite peer 8.3.1 → 8.3.2 applies under the `packages/core` + root importer sections too (not just `packages/app`). CAP-6's letter holds (core `src/`+`proto/`+`package.json` verifiably untouched, 0 diff vs baseline; core suite 256/256) + G5's lockfile allowance covers it. Recorded; no action.
- **F5 — the `dist/renderer/` ownership relied on script order (FIXED).** The build tsconfig's `include: ["src/**/*.ts"]` picked up the renderer `.ts` modules (`ui-state.ts`, `useSuccinctcoin.ts`), so the tsc build emitted them into `dist/renderer/` before the Vite build wiped the directory (`emptyOutDir`). The final artifact was correct (tsc first, Vite second), but the ownership was fragile. FIXED: the build tsconfig now `exclude: ["src/renderer"]` (the tsc owns `dist/main/` + `dist/preload.js`; only the Vite build owns `dist/renderer/`), and the `vite.config.ts` comment is corrected.
- **F6 — a missing bridge produced a silent blank window (FIXED).** The hook read `const bridge = window.succinctcoin` at module top level; if the preload surface was absent (a preload failure, or the page opened outside the shell), the module threw at import → a blank page with no diagnostic. FIXED: the bridge is read INSIDE the effect + guarded (a missing bridge sets a VISIBLE `error` state — the App renders an error panel with `role="alert"` — instead of throwing at import). The `UiState` gains an `error: string | null` field (`buildInitialSnapshot` + `initialUiState` set it null).

**Re-gate after the code patches (F1/F3/F5/F6):** G1 root **264/264** (40 files) + core trio unchanged (core build PROTO_OK, core 256/256, core typecheck clean); G2 app test **8/8** (the new F1 assertion + the error-field updates pass); G3 app typecheck clean; G4 app build green (`dist/renderer/index.html` + 222.6 kB bundle); G5 the core `src/`+`proto/`+`package.json` UNTOUCHED + the app scope correct (12 files). All green.
