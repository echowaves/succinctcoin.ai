---
title: 'Workspace + headless test harness'
type: 'feature'
ticket: 1
created: '2026-10-01'
status: 'built'
baseline_revision: '3bf6016a8d8644172ce7faef8fa21f0d83904475'
route: 'full'
route_source: 'auto'
review: 'quick'
review_source: 'pinned'
lenses_ran: ['quick']
review_loop_iteration: 0
context:
  - _bmad-output/initiative-succinctcoin-ai/architecture-succinctcoin/architecture-succinctcoin.md
  - _bmad-output/initiative-succinctcoin-ai/spec-succinctcoin/testing.md
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The repo is greenfield (bench/ harness + planning docs only); nothing can be built, typechecked, or tested. Stories 1.2–1.6 and every capability epic need a working pnpm + TypeScript workspace with a plain-Node test harness.

**Approach:** Convert the root into a pnpm workspace root (`packages/*`), add `packages/core` as the first skeleton package with a strict TS 5.x config, and stand up the Vitest 5 + fast-check harness on plain Node with one `@libp2p/memory` in-process smoke test proving the headless, no-real-sockets test path (AD-10).

## Boundaries & Constraints

**Always:**
- One language: TypeScript 5.x (not the 7.x tsgo opt-in), ESM (NodeNext).
- Tests run in plain Node with no desktop shell and no real sockets; memory transport is in-process only (AD-10).
- No import of `electron` or any UI library anywhere in the workspace (AD-1).
- Dependency versions per spine Stack (libp2p 3.3.11, @libp2p/memory 2.0.28, vitest 5.0.3, fast-check 4.10.2).
- The existing bench/ harness keeps working (root big.js + js-sha3 deps preserved).

**Never:**
- No capability logic — no consensus/ledger/identity/net/store code (ports land in 1.2, schema in 1.4).
- No real-socket transports (tcp, mdns) in the test suite.
- No DHT, no browser targets, no Tauri (spec non-goals).
- No hand-written protocol types or `.proto` files (1.4, AD-12).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| FRESH_INSTALL | fresh clone, no node_modules | `pnpm install` succeeds; `pnpm-lock.yaml` created and committed | registry failure is a hard stop, no silent skip |
| GREEN_SUITE | installed workspace | `pnpm test` passes: ≥1 trivial test + memory smoke test | failing test fails the command |
| MEMORY_DIAL | two nodes, memory transport only | B dials A; connection established; every node address is `/memory/*` | dial timeout fails the test |
| TYPECHECK | workspace sources | `pnpm typecheck` passes under strict TS | tsc errors exit non-zero |

</frozen-after-approval>

## Code Map

- `package.json` — existing root (devDeps: big.js ^7.0.1, js-sha3 ^0.13.0 for bench/). Convert to workspace root: private, `packageManager` pin, scripts, keep bench deps.
- `package-lock.json` — existing npm lockfile. DELETE; `pnpm-lock.yaml` replaces it (pnpm is the workspace manager).
- `pnpm-workspace.yaml` — new. `packages: ["packages/*"]`.
- `tsconfig.base.json` — new. Strict TS 5.x, NodeNext ESM, shared compilerOptions.
- `tsconfig.json` — new. Root editor config extending base.
- `packages/core/package.json` — new. `@succinctcoin/core`, ESM, scripts (test/typecheck/build), devDeps (libp2p, @libp2p/memory, vitest, fast-check).
- `packages/core/tsconfig.json` — new. Extends base, includes src + test.
- `packages/core/src/index.ts` — new. Trivial placeholder export (package needs an entry point; no logic).
- `packages/core/test/trivial.test.ts` — new. Trivial green test.
- `packages/core/test/memory-transport.test.ts` — new. Two in-process nodes over @libp2p/memory; dial; assert connection + `/memory/*` addresses.
- `vitest.config.ts` (root) — new. Node environment, include `packages/*/test/**/*.test.ts`.
- `bench/` — existing, untouched; must still work after the conversion.
- `_bmad-output/` — planning artifacts only; never a workspace package or test target.

## Tasks & Acceptance

**Execution:**
- [ ] `package.json` — convert to pnpm workspace root (private, `packageManager` pin, scripts test/typecheck/build); keep big.js + js-sha3 for bench/ — one root install covers bench + packages.
- [ ] `pnpm-workspace.yaml` — create with `packages: ["packages/*"]` — defines workspace members.
- [ ] `package-lock.json` — delete (npm→pnpm migration; commit `pnpm-lock.yaml` instead) — one lockfile per manager.
- [ ] `tsconfig.base.json` + `tsconfig.json` — create strict TS 5.x NodeNext configs — single compiler config for the repo.
- [ ] `vitest.config.ts` — root config, node environment, include `packages/*/test/**/*.test.ts` — single `pnpm test` entry point.
- [ ] `packages/core/package.json` + `packages/core/tsconfig.json` + `packages/core/src/index.ts` — create skeleton package with a trivial export — first workspace member; entry point for 1.2's ports.
- [ ] `packages/core/test/trivial.test.ts` — trivial green test — proves the harness runs.
- [ ] `packages/core/test/memory-transport.test.ts` — two nodes over the memory transport, dial, assert connected + `/memory/*` addresses — proves the AD-10 headless path (exact libp2p 3.x API shape verified against installed source after `pnpm install`).

**Acceptance Criteria:**
- Given a fresh clone, when `pnpm install` then `pnpm test` runs, then the suite passes in plain Node with no shell and no real sockets, including at least one trivial green test and one @libp2p/memory smoke test.
- Given the workspace, when `pnpm typecheck` runs, then TypeScript (strict) reports no errors.
- Given the memory smoke test, when node B dials node A, then the connection is established and both nodes' listen addresses are `/memory/*` multiaddrs.

## Implementation Notes

- **libp2p 3.x requires explicit crypto + muxer** — there is no default `connectionEncrypters`/`streamMuxers`, so dialing failed with `EncryptionFailedError: At least one protocol must be specified`. Added `@libp2p/noise@17.0.3` + `@libp2p/yamux@8.0.3` (versions match spine Stack) as core devDeps. **Deviates from the plan Code Map** (which listed only libp2p + @libp2p/memory + vitest + fast-check); the extra two are mandatory, not optional.
- **`@multiformats/multiaddr@13.0.3` added as a direct core devDep** — pnpm's strict layout does not hoist transitive deps, so the test's `import { multiaddr }` needs its own entry.
- **Verified libp2p 3.3.11 API shape** (from installed dist types, not docs): options are `connectionEncrypters`/`streamMuxers`; `node.peerId` is a property; `peerStore.has(id)` is async; `getMultiaddrs()` replaces the removed `getAddrs()`; the memory transport does not advertise multiaddrs via peer records, so the no-real-sockets assertion checks the listener's own `getMultiaddrs()`.
- **Root npm scripts call `packages/core/node_modules/.bin/...` directly** — `pnpm` is not on PATH inside npm script execution, so `pnpm -r`-style delegation is not possible from the root. `corepack pnpm <script>` from the shell works and is the canonical entry point.
- **Registry reachable via `corepack pnpm`** — the hitl "user runs pnpm install" ticket step is unnecessary; the agent ran install + test. The ticket entry's `unknown` is stale (bmad-ticket to update, not this build).
- **`node bench/bench.js` hangs to its 120s watchdog (exit 124)** — pre-existing behavior (script writes results then has no `process.exit()`); bench source untouched, `git diff --stat bench/` shows only `bench-results.json` regenerated. Out of scope for this story.

## Plan Change Log

(empty)

## Review Triage Log

Quick lens (subagent, model = session model; first launch failed on backend, retry succeeded) — 5 findings, triaged 2026-10-01:

1. `packages/core/package.json` `main`/`types` → `dist/index.js` but build emitted `dist/src/…` + shipped compiled tests in `dist/test/`. **Verdict: medium — patched.** Verified: `find packages/core/dist` post-build listed `dist/src/index.js`, `dist/test/*.js`, no `dist/index.js`. Fix: split `packages/core/tsconfig.json` (now noEmit typecheck, includes src+test) from new `packages/core/tsconfig.build.json` (rootDir `src`, outDir `dist`, src only); core + root `build` scripts point at the build config. Re-verified: `dist/` now contains exactly `dist/index.js`, `dist/index.d.ts`, `dist/index.js.map`.
2. `vitest.config.ts` `import { defineConfig } from 'vitest/config'` unresolved at root (pnpm strict: no root `node_modules/vitest`; no `"type":"module"` at root) — every `pnpm test` printed `[UNRESOLVED_IMPORT]` + "ESM syntax in a file loaded as CommonJS … configLoader:'native' planned to become the default" warning. **Verdict: medium — patched.** Verified: `ls node_modules/vitest` → absent; warning reproduced. Fix: added root devDeps `typescript 5.9.2` + `vitest 5.0.3` (root scripts now call root `node_modules/.bin/…`), renamed config to `vitest.config.mjs`. Re-verified: `pnpm test` output clean of both warnings, 2/2 pass.
3. AC "both nodes' listen addresses are `/memory/*`" unmet — dialer node was created with no `addresses.listen`, so `dialer.getMultiaddrs()` was `[]` (probe-verified against installed libp2p 3.3.11). **Verdict: medium — patched.** Fix: dialer now listens on `/memory/address-b`; test asserts `/memory/*` on both nodes' own listen sets (peer records don't advertise memory addrs — noted in test). Re-verified: suite green.
4. `.gitignore` modified but not in the plan Code Map (appended `_bmad/render/` ignore block). **Verdict: low — rejected.** The ignore block is a sensible guard (runtime per-run snapshots, see step-03 incident where `git add -A` swept them in); intent does not exclude it, and the "fix" (deleting the line) would re-introduce the sweep. No harm to users/developers in everyday use; kept.
5. `node bench/bench.js` exits 124 via its 120s watchdog after writing results. **Verdict: defer (pre-existing, baseline `3bf6016`).** Recorded in `deferred-work.md`; frozen boundary "bench/ must still work after the conversion" is satisfied (it runs, results write, source untouched).

## Design Notes

- **pnpm is available and the npm registry IS reachable from the agent sandbox** — probe-verified: `corepack pnpm --version` = 12.8.1 and a scratch-dir `corepack pnpm install` fetched big.js successfully. So the ticket's hitl step ("user runs pnpm install") is not needed — the agent runs install + test itself. The ticket entry's `unknown` is now stale (the entry is bmad-ticket's to update, not this build's). Pin `"packageManager": "pnpm@12.8.1"` in the root package.json so corepack is deterministic.
- TypeScript 5.9.2 (registry-verified 2026-10-01; spine: 5.x default, 7.0.2 tsgo is a documented opt-in only).
- The memory-transport smoke test is the template for every libp2p test in this repo: no tcp, no mdns, no real sockets (AD-10).

## Verification

**Commands:**
- `corepack pnpm install` — expected: exit 0, `pnpm-lock.yaml` created, node_modules present.
- `corepack pnpm test` — expected: exit 0, ≥2 tests pass (trivial + memory smoke), no real sockets.
- `corepack pnpm typecheck` — expected: exit 0, no tsc errors.
- `node bench/bench.js` — expected: the existing bench harness still runs after the conversion.
