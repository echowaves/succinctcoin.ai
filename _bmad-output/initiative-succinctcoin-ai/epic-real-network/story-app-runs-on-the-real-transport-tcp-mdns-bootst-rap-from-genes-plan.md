---
title: 'App runs on the real transport: tcp + mDNS, bootstrap from genesis (memory test-only)'
type: 'feature'
ticket: '2'
created: '2026-10-16'
status: 'in-progress'
route: 'full'
route_source: 'auto'
review: 'quick'
review_source: 'pinned'
lenses_ran: []
review_loop_iteration: 0
baseline_revision: '8856bc8762bb8068987eb25943c4ba1247c55774'
context:
  - '_bmad-output/initiative-succinctcoin-ai/epic-real-network/epic-real-network.md'
  - '_bmad-output/initiative-succinctcoin-ai/epic-real-network/tickets.toml'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** `packages/app/src/main/index.ts` hardcodes `transport: 'memory'` with a `/memory/...` listen address — every app instance is a complete, isolated one-node network, so LAN peers can never find each other. The core adapter already supports the real stack (`transport: 'tcp'`, `mdns`, `bootstrap`, circuit relay always wired — epic 5), and 7.1 made genesis carry an (empty-by-default) bootstrap list; nothing selects them.

**Approach:** Extract a PURE net-config seam in the app's main folder — `defaultNetConfig(genesis, protocolIdentityId)` returning the real-stack config (`tcp`, ephemeral listen `/ip4/0.0.0.0/tcp/0`, `mdns: true`, `bootstrap` from genesis) — and have `boot()` pass its result to `createNetAdapter`. The literal `'memory'` disappears from the boot path; tests keep injecting memory configs explicitly (AD-10). Zero new imports/deps: the tcp/mdns/bootstrap code paths already exist in the core and are already inlined in the app bundle.

## Boundaries & Constraints

**Always:** the seam is pure (type-only imports, no electron, no I/O) so tests run it under plain Node; `protocolIdentityId` passes through unchanged (AD-11 — identity stays in main); every existing test keeps its own injected memory net config (E2E_MEMORY_TRANSPORT_PIN pins the harness's config, not main's).

**Never:** no change to `packages/core` (adapter or otherwise); no new runtime dependency; no literal `'memory'` reintroduced into the boot path; no wall clock/RNG in app source; no change to IPC surface, renderer, or preload.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| LAN-only genesis | `bootstrap: []` | config `{ transport: 'tcp', listenAddress: '/ip4/0.0.0.0/tcp/0', mdns: true, bootstrap: [], protocolIdentityId }` | No error expected |
| Public peers listed | `bootstrap: ['/ip4/…/p2p/…']` | list passed through verbatim | No error expected |
| Identity passthrough | any `protocolIdentityId` | returned unchanged; no key material in config | No error expected |
| Boot-path scan | comment-stripped `src/main/index.ts` + seam source | no `'memory'` string literal anywhere | Test asserts absence |

</frozen-after-approval>

## Code Map

- `packages/app/src/main/index.ts` (L73-83) — the hardcoded memory net config to replace with `createNetAdapter(defaultNetConfig(genesis, identity.identityId))`; doc comment updated (real transport; memory = test-only).
- `packages/app/src/main/net-config.ts` — NEW pure module: `LAN_LISTEN_ADDRESS` const + `defaultNetConfig(genesis: Pick<GenesisConfig,'bootstrap'>, protocolIdentityId: string): NetAdapterConfig`. Type-only imports from `@succinctcoin/core` (both types are exported from the barrel).
- `packages/app/test/net-config.test.ts` — NEW vitest file: pure rows (per I/O matrix) + source-scan row using the established `stripComments` pattern (copy the two-regex helper from `epic6-end-to-end.test.ts` L358).
- `packages/core/src/net/adapter.ts` — READ-ONLY reference: config contract (`transport`, `listenAddress` tcp form `/ip4/0.0.0.0/tcp/<port>`, `bootstrap?` gate length>0, `mdns?`). DO NOT CHANGE.
- `packages/app/test/epic6-end-to-end.test.ts` — verified-safe: its main-source scan only asserts the `electron` import; E2E_MEMORY_TRANSPORT_PIN checks the harness's own netConfig.

## Tasks & Acceptance

**Execution:**
- [x] `packages/app/src/main/net-config.ts` — new pure seam module with repo-style doc comments (AD-10 note: memory stays test-only; ephemeral port rationale from the epic Notes).
- [x] `packages/app/src/main/index.ts` — import + use the seam in `boot()`; remove the literal config block; refresh the surrounding comment.
- [x] `packages/app/test/net-config.test.ts` — pure unit rows + boot-path source scan (no `'memory'` literal in stripped source of index.ts and net-config.ts).

**Acceptance Criteria:**
- Given any validated genesis, when `defaultNetConfig` runs, then transport is `tcp`, listen is `/ip4/0.0.0.0/tcp/0`, mdns is true, bootstrap is the genesis list verbatim, identity id passes through — and memory is never returned.
- Given comment-stripped `src/main/index.ts` and `src/main/net-config.ts`, then neither contains a `'memory'` string literal.
- Given the app + root suites, then all pass headless with zero real sockets (tests inject their own memory configs; nothing in CI opens tcp).
- Given the app build, then `pnpm build` (Vite main bundle) + typecheck still pass — the seam adds only a type-only core import.

## Implementation Notes

- Built 2026-10-17 at baseline `8856bc8` (7.1 already landed: empty-bootstrap
  relaxation + emptied `config/genesis.json` — verified before starting).
- Seam is exactly the Code Map shape: `LAN_LISTEN_ADDRESS` +
  `defaultNetConfig(Pick<GenesisConfig,'bootstrap'>, string): NetAdapterConfig`,
  type-only core imports. Bootstrap passes by REFERENCE (verbatim — the test
  pins `toBe`); identity id passes unchanged; exact five-key result (AD-11).
- Scan row pins `\bmemory\b` ABSENCE in comment-stripped `index.ts` +
  `net-config.ts` (catches both the `'memory'` literal and a `/memory/...`
  listen address), with a non-vacuity guard: both RAW sources still name it
  in comments, so the scan would catch a regression.
- Gates: app typecheck clean; app suite 21/21 (5 files; +4 new rows); root
  `pnpm build` clean; app `pnpm build` clean — main bundle contains
  `transport: "tcp"` and zero `succinctcoin-app`; root suite 279/279
  (43 files) headless, zero real sockets. Diff scope: `index.ts` + the two
  new files only; `packages/core` untouched.

## Plan Change Log

- (none — implemented as planned)
