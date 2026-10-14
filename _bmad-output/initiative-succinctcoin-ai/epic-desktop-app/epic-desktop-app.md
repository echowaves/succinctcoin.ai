---
type: epic
title: "Desktop app: Electron shell, IPC bridge, React UI, packaging"
parent: initiative-succinctcoin-ai
covers: ["CAP-4", "CAP-6"]
after: []
assignee: ""
risk: medium
estimate: ""
estimate_basis: ""
---

# Desktop app: Electron shell, IPC bridge, React UI, packaging

## Description

Implement `packages/app`: the Electron shell (node hosted in the main process), the preload/IPC bridge, and the React (Vite) UI for balance, mining status, and network peers. The UI is a thin adapter *client* of the core via `core/events/` (commands in, events out, read-API for snapshots) — it never imports the core's internals or bypasses `applyBlock`. electron-forge packages the app. The closing end-to-end suite proves the packaged app runs a node on a testnet while the same core's full test suite still passes unchanged under plain Node.

## Outcome

For the team: a packaged desktop app starts a node on a testnet and shows blocks being mined, while the same core package's test suite passes unchanged under a plain-Node runner with no shell — so the desktop product and the headless core are one code path (the spec's CAP-4 + CAP-6 success signals).

## Requirements

Reuses the parent's ids; the epic adds lines for the IPC bridge, the UI data source, and the headless-parity check.

- R1 (CAP-4) — an Electron shell runs the node in its main process (plain Node) with a React UI for balance, mining status, and network peers.
- R2 (CAP-4) — the packaged app starts a node on a testnet and shows blocks being mined, while the same core package's test suite passes unchanged under a plain-Node runner with no shell.
- R3 (CAP-6) — the core's full test suite (unit + property) runs with a plain-Node runner, no desktop shell, and no real network sockets; all libp2p-dependent tests are on the in-process memory transport.
- E1 (AD-1) — the UI subscribes to the core event stream and uses the read-API for snapshots (no polling); the event stream + read-API is the complete UI data source. The UI is a thin adapter client — it never imports core internals.
- E2 (AD-11) — identity keys never cross the IPC boundary to the renderer in plaintext; the UI receives only peer IDs, status, and signed artifacts.
- E3 (AD-9) — the UI reads state only via the core read-API; it cannot mutate balances or write state directly.

## Done when

- The packaged (electron-forge) app starts a node on a testnet and shows blocks being mined in the UI.
- The React UI shows balance, mining status, and network peers, driven by the core event stream + read-API (no polling).
- Identity keys are absent from the renderer (verified by a test or static check); the IPC bridge exposes only signed artifacts and status.
- The same `packages/core` test suite passes unchanged under a plain-Node runner with no shell and no sockets (CAP-6 parity).
- The `@libp2p/memory` `electron-main` test target (verified present in `@libp2p/memory` 2.0.28) covers the in-app path.

## Boundaries

The desktop-app capability: `packages/app` (main, preload, renderer) + packaging + the headless-parity proof. It does NOT implement consensus, ledger, identity, or networking logic (epics 2–5 — it hosts the finished core and drives it through `core/events/`). Non-goals: no browser-runtime node, no Tauri at launch.

## References

- parent — `_bmad-output/initiative-succinctcoin-ai/initiative-succinctcoin-ai.md`, section Requirements
- architecture — `_bmad-output/initiative-succinctcoin-ai/architecture-succinctcoin/architecture-succinctcoin.md`, sections AD-1, AD-9, AD-10, AD-11, Structural Seed
- spec — `_bmad-output/initiative-succinctcoin-ai/spec-succinctcoin/spec-succinctcoin.md`, sections CAP-4, CAP-6
- testing — `_bmad-output/initiative-succinctcoin-ai/spec-succinctcoin/testing.md`
- stack — `_bmad-output/initiative-succinctcoin-ai/spec-succinctcoin/stack.md`

## Notes

- Waits on epic 5 because: it needs a full, working node core (consensus + ledger + identity + net) to host and drive — the UI has nothing to show until the node runs end to end.
- Assumption: wallet/enrollment UX is a bmad-ux concern; this epic ships the node-status UI (balance, mining, peers) the spec names, not a full wallet flow.
- Decision: 2026-10-01 — this epic owns the closing end-to-end suite (packaged app on a testnet + headless core parity), per `ordering` "one closing end-to-end suite across the epic."
- Source conflict: this epic's Description/Notes say it "needs a full, working node core (consensus + ledger + identity + net) to host and drive — the UI has nothing to show until the node runs end to end," but at inception (2026-10-13) the core is NOT end-to-end runnable: `startMining()` / `getPeers()` / `getBlock()` are `SC-CORE-1` stubs and `CoreEvents` has only `CoreStarted` / `CoreStopped` (the read-API has no chain-head or balance model). The built seams (3.x mine, 4.x identity, 5.x net) exist but no integrated slot loop ties them into a running node, and the AD-9 UI data source (event stream + read-API) is the thin baseline. Resolution: epic 6 story 1 lands the integrated consensus/slot loop + the missing `CoreEvents` + the real read-API IN THE CORE (per AD-9's one-owner rule, `core/events/` owns the event payload types + read-API signatures) before the shell is built.
- Decision: 2026-10-13 — inception (4 stories, build order): (1) core node loop + UI data source (events + real read-API); (2) Electron shell + preload/IPC bridge (AD-11) + core-suite headless parity; (3) React renderer (balance, mining, peers) + AD-11 renderer check; (4) electron-forge packaging + the closing e2e (full Done-when). Tracer bullet = the closing e2e (story 4): the packaged app shows a block being mined. Story 1 is the prerequisite (the shell has nothing to show until the core runs); 2→3→4 are sequential (shell → renderer → packaging+e2e).
- Decision: 2026-10-13 — monorepo wiring: `packages/app` is a NEW pnpm workspace package (picked up by the `packages/*` glob), package-local (its own test/typecheck/build with the spine pins). The ROOT `test` / `typecheck` / `build` scripts STAY core-scoped (unchanged), which preserves the CAP-6 parity (Done-when #4) BY CONSTRUCTION: `packages/core` and its suite are untouched by the app and still pass headless + socket-free under a plain-Node runner. The app links `@succinctcoin/core` as a workspace dependency (resolving `main` -> `dist/index.js`, so a core build is a prerequisite for the app).
