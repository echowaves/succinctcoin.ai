---
ticket: "3"
epic: epic-node-network
status: done
review: quick
review_source: pinned
covers: ["R1"]
baseline_revision: "e8ec2b86de32f08e78c68362f6d91d13fd1a8bfc"
lenses_ran: ["quick"]
review_loop_iteration: 1
context:
  - _bmad-output/initiative-succinctcoin-ai/epic-node-network/epic-node-network.md
  - _bmad-output/initiative-succinctcoin-ai/architecture-succinctcoin/architecture-succinctcoin.md
  - packages/core/src/net/adapter.ts
  - packages/core/src/net/topics.ts
  - packages/core/src/net/index.ts
  - packages/core/src/config/genesis.ts
  - packages/core/src/index.ts
  - packages/core/test/net-adapter.test.ts
  - config/genesis.json
  - packages/core/package.json
---

# 5.3 — Discovery: bootstrap (genesis list) + mDNS (LAN)

## Story of truth

Wire peer **discovery** into the libp2p net adapter so a node that starts with the
validated genesis bootstrap config finds its peers, and a LAN node discovers peers
that announced themselves. This is the 5.1 "D4 defers bootstrap/mdns to 5.3" follow-through:
the deps (`@libp2p/bootstrap 12.0.32`, `@libp2p/mdns 12.0.32`) were pinned in 5.1;
**5.3 wires the SERVICES** into the adapter.

The hard rules (from the ticket):
- **R1** — bootstrap from the genesis bootstrap list + mDNS for LAN discovery.
- **AD-10** — no real sockets in CI: the real `tcp`/`mdns` services are *present in code*
  but CI exercises the **memory** path. The real `@libp2p/mdns` (UDP multicast) cannot run
  headless, so CI exercises the mDNS *mechanism* through a **`PeerDiscovery` service test
  double** over the memory transport (see D3 — this is the ticket's `unknown` resolved to the
  "test double behind the same flag" option, NOT a no-op).

What is **not** in scope: routing discovered peers into the core (5.5), the sync path (5.4),
relay (5.7), DHT (5.8 — explicitly not wired). Discovery here *connects* nodes (dials
them) so their gossipsub mesh forms; it does not yet drive the consensus loop.

## Acceptance criteria (the ticket's `verify`, made concrete)

- **AC-1 (bootstrap wired to the genesis list).** A node configured with the **validated
  genesis bootstrap list** runs the **real** `@libp2p/bootstrap` service against that list
  and starts cleanly over the memory transport. (LOOPBACK correction — see Plan Change
  Log: the real bootstrap service's `P2P` multiaddr matcher *structurally rejects*
  `/memory/…` multiaddrs, so it cannot be pointed at in-process memory nodes in CI. CI
  therefore proves the service is WIRED against the real genesis list — the production
  `/ip4/…/tcp/…/p2p/<id>` shape the matcher accepts — and that the node comes up; the
  production peers are not present headless, so `peers()` staying empty is the correct
  AD-10 outcome, not a failure. The discover→dial→connect→**receive** MECHANISM is proven
  headless by the mDNS rows (AC-2/AC-3) over the identical libp2p discovery bridge.)
- **AC-2 (mDNS discovers a self-announced peer).** An mDNS-enabled node (the memory
  double, behind the same `mdns` flag) on the same (memory) network **discovers** a peer
  that announced itself — the announced peer appears in the node's `peers()`.
- **AC-3 (discovery → subscribe → receive).** A fresh node that discovers existing nodes
  starts **receiving their gossip**: discover → dial → connect → (already-subscribed)
  gossipsub mesh → a gossiped message is received. Headless, zero real sockets.
- **AC-4 (additive / additive-config).** The existing 11 `net-adapter` rows stay green
  unchanged; discovery is OFF by default — an adapter with no `bootstrap`/`mdns` config
  does NOT auto-connect to a listening node (the `peer:discovery` dial listener is present
  but inert without a discovery service), so it behaves exactly as it did in 5.2; the proto
  is byte-identical (no proto change); the `src/ledger`/`src/consensus`/`src/identity`
  trees are untouched; the 2.5 no-float guard and 4.7 identity-key-surface guard stay
  green.
- **AC-5 (explicit dial retained).** 5.1's explicit `dial(address)` is unchanged; discovery
  ADDS discovery-driven connecting alongside it (does not replace it).

## Design decisions (settling the ticket's `unknown`)

- **D1 — config grows additively.** `NetAdapterConfig` gains three OPTIONAL fields (all
  default to "off", so every existing call site is unchanged):
  - `bootstrap?: string[]` — the multiaddr list the **real** `@libp2p/bootstrap` service
    dials. In production this is the validated `genesis.bootstrap` (1.3's
    `GenesisConfig.bootstrap: string[]`, each entry `/…` — the `/p2p/<peerId>` form). In
    the CI test it is memory multiaddrs with a `/p2p/<peerId>` component (bootstrap
    *requires* a peer id in each multiaddr — it `filter`s out entries without one).
  - `mdns?: boolean` — when true, the node registers a `PeerDiscovery` service for LAN
    discovery. **Over memory the service is the internal `buildMdnsDiscovery` double (D3);
    over tcp it would be the real `@libp2p/mdns` `mdns()`** (present in code, never
    CI-exercised — AD-10). The flag is the SAME either way (the ticket's "behind the same
    flag").
  - `mdnsAnnounce?: string[]` — **TEST-ONLY**, honored only when `mdns` is true over the
    **memory** transport. The list of `/…/p2p/<peerId>` multiaddrs the double announces
    (stands in for the UDP broadcast a real mdns node answers with). Over tcp it is
    ignored (the real `mdns()` announces the node itself, no list needed). A test-only
    knob on a public config is honest here: it is the only way to drive the memory double
    through the public `createNetAdapter` API without a new public factory.

- **D2 — bootstrap is the REAL service.** `@libp2p/bootstrap`'s `bootstrap({ list })`
  factory is registered in libp2p's `peerDiscovery` array. libp2p 3.3.11 wires every
  `peerDiscovery` service: it listens for the service's `peer` event and calls
  `#onDiscoveryPeer`, which merges the `PeerInfo` into the peer store → a `peer:update`
  (previous `null`) → a node-level `peer:discovery` event. **bootstrap also AUTO-DIALS**
  each list entry (its `_discoverBootstrapPeers` calls
  `connectionManager.openConnection(peerId)`), so a bootstrap peer connects without any
  adapter dial — this is what a bootstrap peer "connects to the peers it is configured
  with" means in production. bootstrap fires after its `timeout` (default **1000 ms**; we
  use the default).
  **LOOPBACK caveat (verified from `@multiformats/multiaddr-matcher@3.0.2` source):**
  bootstrap's constructor filters its list with the `P2P` matcher, whose alternatives are
  each anchored on an IP/DNS first-component (`_TCP = and(_IP_OR_DOMAIN, value(CODE_TCP))`,
  etc.); `CODE_MEMORY` is in NONE of them and `IP_OR_DOMAIN` explicitly rejects a bare
  `/p2p`. So the real service **structurally rejects `/memory/…` multiaddrs** and cannot
  connect to in-process memory nodes in CI. It is wired against the real genesis list
  (production `/ip4/…/tcp/…/p2p/<id>` shape — which the matcher accepts); the headless
  connect→receive is proven by the mDNS rows over the same bridge (AC-1/AD-10).

- **D3 — mDNS over memory = a `PeerDiscovery` service TEST DOUBLE, not a no-op.** The real
  `@libp2p/mdns` is UDP-multicast and cannot run in CI (AD-10). A *no-op* behind the flag
  would fail AC-2/AC-3 (there would be nothing to discover). So over the **memory**
  transport the adapter registers a **`buildMdnsDiscovery(announce: string[])`** service:
  a `TypedEventEmitter<PeerDiscoveryEvents>` (from `main-event`) + `start`/`stop` (Startable,
  so `components.start()` runs it) that, on `start()`, emits one `peer` event per announced
  multiaddr as a `PeerInfo` (`peerIdFromString` the `/p2p/<id>` component, `multiaddrs:
  [multiaddr(str)]`). It is an INTERNAL helper in `adapter.ts` (not exported): the test
  drives it through the public `createNetAdapter` API via `mdns: true` + `mdnsAnnounce`
  (D1). This exercises the **real** libp2p discovery bridge (the same
  `#onDiscoveryPeer` → `peer:update` → `peer:discovery` path the real mdns would drive),
  differing from real mdns only in the *source* of the announcement (the test-supplied
  `mdnsAnnounce` list instead of a UDP query). The real `@libp2p/mdns` `mdns()` is still
  imported and is the service selected when `transport === 'tcp'` (present, not
  CI-exercised). The double filters out a self-announcement (peer id === own) so it never
  "discovers" itself (mirrors libp2p's own self-guard in `#onDiscoveryPeer`).

- **D4 — one discovery listener dials discovered peers.** The adapter registers a SINGLE
  node-level `peer:discovery` listener (in `buildNode`, before `node.start()`, so it cannot
  miss an early event) that, for each discovered `PeerInfo` that is not self, `dial`s the
  first announced multiaddr. This is UNIFORM for bootstrap and mDNS: bootstrap's auto-dial
  already connects bootstrap peers; the listener additionally dials mDNS-discovered peers
  (real mDNS, like real bootstrap's non-bootstrap peers, does NOT auto-dial — the app dials
  discovered peers). This is the "discovery → dial → connect → gossip" step AC-3 needs.
  Dialing is fire-and-forget with the existing 10 s `AbortSignal.timeout` bound (AD-3: a
  timeout, not a wall-clock read); a failed dial is ignored (the peer may already be
  connected via bootstrap's auto-dial, or may be transiently unreachable — both are
  normal, never a throw).
  **CORRECTION (implemented, correct):** `createLibp2p` is called with `start: false`.
  libp2p 3.3.11's `createLibp2p` otherwise `await node.start()`s internally, and
  `components.start()` runs every Startable discovery service's `start()` at that moment
  (the mDNS double emits its `peer` events there → the merge → `peer:update` →
  `peer:discovery` chain completes). The node-level listener must be attached BEFORE
  `node.start()` or it misses the early event — which is exactly D4's own stated intent.
  So: construct (`start: false`) → attach both listeners → the adapter's `start()` calls
  `node.start()`.

- **D5 — discovery is EAGER (on start).** Both bootstrap and the mDNS double run on
  `node.start()` (libp2p's `components.start()` starts every registered Startable
  discovery service; bootstrap additionally schedules its 1 s timer). There is no
  on-demand discovery API — a node discovers as it boots, which is what a genesis-booted
  node needs (it must find peers without an operator dialing each). Settles the ticket's
  "eager vs on-demand" to **eager**.

- **D6 — self guard + idempotence preserved.** The `peer:discovery` listener skips its own
  peer id. `start()`/`stop()` remain idempotent; a `start()` after `stop()` re-creates a
  fresh node (discovery config re-applied). No new RNG / wall-clock in `src` (AD-3); no
  `big.js` (AD-5); no `.secret` read (AD-11).

- **D7 — deps.** Add three devDeps to `packages/core`, all **single-version and already in
  the pnpm store** (so the install dedupes to the existing entries — no version fork):
  - `@libp2p/interface@3.3.0` (type-only: `PeerDiscovery`, `PeerInfo`, `PeerId`,
    `peerDiscoverySymbol`) — already the deduped interface for gossipsub/identify/etc.
  - `@libp2p/peer-id@6.0.15` (`peerIdFromString`) — already the store version.
  - `main-event@1.0.5` (`TypedEventEmitter`) — already the store version.
  The two discovery *services* (`@libp2p/bootstrap`, `@libp2p/mdns`) were added in 5.1 and
  are already in `package.json`. No NEW runtime service is introduced.

- **D8 — no barrel change.** The ONLY public-surface change is `NetAdapterConfig` (three
  optional fields, D1) — already re-exported from `src/net/index.ts` and `src/index.ts`
  in 5.1/5.2, so the new fields flow through automatically. `buildMdnsDiscovery` is
  INTERNAL to `adapter.ts` (not exported) and is driven through the public config. The
  root-barrel-only test rule is preserved: the test imports `createNetAdapter`, the proto
  messages, `TOPICS`, and the net types from `../src/index.js` only — it never imports the
  internal double.

## Code map (the files the implementer touches)

- `packages/core/package.json` — add the 3 devDeps (D7). Run `corepack pnpm install`
  from the repo root (lockfile updates are EXPECTED and are part of the diff).
- `packages/core/src/net/adapter.ts` —
  - imports: `bootstrap` (`@libp2p/bootstrap`), `mdns` (`@libp2p/mdns`),
    `peerIdFromString` (`@libp2p/peer-id`), `TypedEventEmitter` (`main-event`), and the
    `@libp2p/interface` types (`PeerDiscovery`, `PeerDiscoveryEvents`, `PeerInfo`,
    `PeerId`).
  - `NetAdapterConfig`: add `bootstrap?: string[]`, `mdns?: boolean`, `mdnsAnnounce?:
    string[]` (D1).
  - new INTERNAL `function buildMdnsDiscovery(announce: string[]): (components:
    Components) => PeerDiscovery` (D3) — the memory-transport mDNS double (NOT exported).
  - `buildNode`: build the `peerDiscovery` array (D2/D3): the real
    `bootstrap({ list: config.bootstrap })` when `bootstrap` is non-empty, plus — when
    `config.mdns` — the internal double `buildMdnsDiscovery(config.mdnsAnnounce ?? [])`
    over memory or the real `mdns()` over tcp; pass it to `createLibp2p` as
    `peerDiscovery` (empty array when neither is set — discovery off, AC-4).
  - `buildNode` (before `node.start()`): register the single `peer:discovery` listener
    (D4) that dials each non-self discovered peer's first multiaddr (fire-and-forget,
    10 s bound, ignore failures).
- `packages/core/test/net-adapter.test.ts` — add the 5 discovery rows (T4); update the
  `FULL_NETPORT_SURFACE` row to note discovery is off by default (the adapter with no
  `bootstrap`/`mdns` still shows `peers() === []` — already asserted) and the
  `TCP_TRANSPORT_PRESENT` row to pass `mdns: true` to show the factory still stays pure
  (no `start()`). No existing row's assertion changes.

No change to `src/net/index.ts` or `src/index.ts` (D8: `NetAdapterConfig` already
re-exported; the double is internal).

**Do NOT touch:** `src/ledger/**`, `src/consensus/**`, `src/identity/**`, `src/config/**`,
`src/ports.ts`, `src/proto/**`, `proto/protocol.proto` (no proto change), `src/events/**`,
`src/net/topics.ts` (topics unchanged). The 2.5 no-float guard and 4.7 identity-key-surface
guard must stay green (the adapter still never imports `big.js` and never reads `.secret`).

## Tasks

- [x] **T1 — deps.** Add the 3 devDeps (D7) to `packages/core/package.json`; run
  `corepack pnpm install` from the repo root. Confirm `@libp2p/interface@3.3.0` (not a
  second version), `@libp2p/peer-id@6.0.15`, `main-event@1.0.5` are the store versions
  (no fork). The lockfile diff should be additive links only.
- [x] **T2 — config + double.** Add `bootstrap?: string[]` + `mdns?: boolean` +
  `mdnsAnnounce?: string[]` to `NetAdapterConfig` (D1). Implement the INTERNAL
  `buildMdnsDiscovery` (D3) as a `TypedEventEmitter` + Startable that emits one `peer`
  event per announced `/…/p2p/<id>` multiaddr on `start()`, filtering self. (Not exported
  — D8.)
- [x] **T3 — wire discovery.** In `buildNode`, build the `peerDiscovery` array (real
  `bootstrap` over the list; the memory double / real `mdns()` for the `mdns` flag) and
  register the single `peer:discovery` dial listener (D2/D4) before `node.start()`
  (`start: false` on `createLibp2p` — see D4 correction).
- [x] **T4 — tests.** Add the 5 discovery rows (Matrix below) to `test/net-adapter.test.ts`
  (`BOOTSTRAP_WIRED_TO_GENESIS` per the loopback-corrected row). Update
  `FULL_NETPORT_SURFACE` (note discovery off by default) and `TCP_TRANSPORT_PRESENT`
  (pass `mdns: true`, still no `start()`). All existing rows stay green unchanged.
  (Plus the `config/genesis.json` fixture fix — see Plan Change Log.)
- [x] **T5 — gate.** Run the full verification trio + the additive gates (below). The proto is
  byte-identical; `src/ledger`/`consensus`/`identity` empty; no-float + identity-key-surface
  green. (Orchestrator re-ran independently: 224/224, typecheck clean, build clean, PROTO_OK,
  SCOPE_OK, guards green.)

## Matrix (every frozen row → a passing test)

| Row | Proves | Mechanism under test |
| --- | --- | --- |
| `BOOTSTRAP_WIRED_TO_GENESIS` (AC-1) | a fresh node configured with the **real validated `genesis.bootstrap` list** (production `/ip4/…/tcp/…/p2p/<id>` shape, read via `loadGenesis`/`defaultGenesisPath` from the root barrel) runs the REAL `@libp2p/bootstrap` service against that list and **starts cleanly** over memory; the production peers are absent headless, so `peers()` stays empty (the correct AD-10 outcome — no fake sockets, no connect claimed). Proves the bootstrap SERVICE is wired against the genesis list, not a memory substitute. | real `@libp2p/bootstrap` wired to the real genesis list (production shape the `P2P` matcher accepts) |
| `MDNS_DISCOVERS` (AC-2) | a fresh node with `mdns: true` + the memory double announcing the listener's multiaddr DISCOVERS it — `peers()` gains the listener (via the adapter's `peer:discovery` dial). This is the headless proof of the discover→dial→CONNECT mechanism (the bridge the real bootstrap would drive for its production peers). | memory `PeerDiscovery` double → `#onDiscoveryPeer` → `peer:discovery` → dial |
| `DISCOVERY_RECEIVES_GOSSIP` (AC-3) | a fresh node that discovers an existing node (bootstrap or mDNS) RECEIVES its gossip — discover → dial → connect → receive a gossiped block. | discovery → subscribe → receive (headless) |
| `BOOTSTRAP_FROM_GENESIS_SHAPE` (AC-1/AD-10 note) | the `genesis.bootstrap` list (1.3, read via the root-barrel genesis loader) is the EXACT shape the real service requires: every entry a multiaddr STRING starting with `/` and carrying a `/p2p/<id>` component (bootstrap filters out entries without one — the reason the `BOOTSTRAP_WIRED_TO_GENESIS` row can start cleanly with it). Pins the production list shape end-to-end (no `@multiformats/multiaddr` import — root-barrel-only rule; string-shape assertion). | genesis bootstrap list shape (1.3) → real-service requirement |
| `DISCOVERY_OFF_BY_DEFAULT` (AC-4) | an adapter with NO `bootstrap`/`mdns` config, started alongside an already-listening node, does NOT auto-connect — the `peer:discovery` dial listener is present but INERT without a discovery service, so `peers()` stays empty over a bounded wait (discovery is opt-in and additive; the listener changes nothing for a 5.2-style node). | additive-config default (inert listener) |

(The rows map to the three `verify` clauses: `BOOTSTRAP_WIRED_TO_GENESIS` = verify #1's
bootstrap service wired against the genesis list (LOOPBACK-corrected — the connect clause
is un-provable headless, see Plan Change Log); `MDNS_DISCOVERS` + `DISCOVERY_RECEIVES_GOSSIP`
= verify #2 + #3 (mDNS discover + receive over the memory transport); `BOOTSTRAP_FROM_GENESIS_SHAPE`
pins that the genesis-list entries are the exact multiaddr shape the real service requires;
`DISCOVERY_OFF_BY_DEFAULT` pins additivity. All run over the memory transport, zero real
sockets, bounded test-side polling ≤ 10 s, explicit 30 s row timeouts.)

## Verification commands (the acceptance gate)

Run from `packages/core` (or the repo root as noted):

1. `corepack pnpm test 2>&1 | grep -E "Test Files|Tests "` → all green (11 existing net rows
   + 5 new discovery rows + every prior suite: no-float 6, identity-key-surface 5, epic4-e2e
   5, multi-sim 5, …).
2. `corepack pnpm typecheck 2>&1 | tail -1` → clean.
3. `corepack pnpm build 2>&1 | tail -1` → clean.
4. **No proto change:** `git diff --name-only -- packages/core/src/proto/ packages/core/proto/protocol.proto` → EMPTY (echo `PROTO_OK`).
5. **Additive scope:** `git diff --name-only -- packages/core/src/ledger packages/core/src/consensus packages/core/src/identity packages/core/src/config packages/core/src/ports.ts packages/core/src/events` → EMPTY.
6. **Guard suites green** (covered by #1, listed to be explicit): no-float-guard +
   identity-key-surface.
7. **Deps:** `corepack pnpm install` from the repo root succeeds; `git diff --stat --
   packages/core/package.json` shows only the 3 added devDeps.

## Never

- No real sockets in CI (AD-10): the memory transport is the only exercised path; the real
  `mdns()`/`tcp` are present but never started.
- No `big.js` in `src/net` (AD-5); no `.secret` read (AD-11); no RNG / wall-clock in
  `src` (AD-3 — the 1 s bootstrap timer and 10 s dial bound are library/timeout values,
  not clock reads the adapter performs).
- No proto change (the one proto change was 5.2). No re-implementation of any consensus
  seam (5.3 is pure networking). No change to the four topics (AD-8, set in 5.2).
- Do NOT make discovery the ONLY connect path — 5.1's explicit `dial()` stays.
- A discovered-but-unreachable peer is a NORMAL ignore (fire-and-forget dial, no throw) —
  spine "reject = normal false, never a throw".

## Implementation Notes
(filled at build)

### T1 — deps (done)
`packages/core/package.json` gains exactly 3 devDeps, all pinned to versions already in
the pnpm store (no fork): `@libp2p/interface@3.3.0`, `@libp2p/peer-id@6.0.15`,
`main-event@1.0.5` (D7). `corepack pnpm install` from the repo root succeeded; the lockfile
diff is additive (3 new importer entries, no version fork). `git diff --stat --
packages/core/package.json` → `3 insertions(+)`.

### T2 — config + double (done)
`NetAdapterConfig` gains `bootstrap?: string[]`, `mdns?: boolean`, `mdnsAnnounce?:
string[]` (D1 — all optional, default off). The INTERNAL `buildMdnsDiscovery` double
(D3) is a `TypedEventEmitter<PeerDiscoveryEvents>` + Startable; on `start()` it emits one
`peer` event per announced `/…/p2p/<id>` multiaddr, walking `getComponents()` for the last
`/p2p` component (ES2022 target has no `findLast`, so a for-loop), self-guarded. Not
exported (D8).

### T3 — wire discovery (done, with one REQUIRED deviation — see Plan Change Log)
`buildPeerDiscovery` pushes the real `bootstrap({ list })` when `bootstrap` is non-empty,
and the double (memory) / real `mdns()` (tcp) when `mdns === true`. The single node-level
`peer:discovery` dial listener (D4) is registered in `buildNode`.
**Deviating from D4's prose:** `createLibp2p` is called with `start: false`. Root cause —
`createLibp2p` internally does `await node.start()`, and `components.start()` runs every
Startable discovery service's `start()` at that moment (the double emits its `peer` events
there, the merge → `peer:update` (previous `null`) → `peer:discovery` chain completes).
The node-level listener was being attached AFTER `createLibp2p` resolved — i.e. after the
internal start — so it missed the early `peer:discovery` event. With `start: false` the
node is only constructed; both listeners attach in `buildNode`; the adapter's `start()`
then calls `node.start()`. This realizes D4's own stated intent ("registered before
`node.start()`, so it cannot miss an early event") — the prose assumed
`createLibp2p` did not auto-start, but it does. This is a code-level fix to my own
implementation (the double path), NOT a behavior change to the plan.

### T4 — tests (done)
5 discovery rows added (`BOOTSTRAP_CONNECTS`, `MDNS_DISCOVERS`,
`DISCOVERY_RECEIVES_GOSSIP`, `BOOTSTRAP_FROM_GENESIS_SHAPE`, `DISCOVERY_OFF_BY_DEFAULT`)
plus the `peersInclude`/`isBootstrapShaped`/`GENESIS_PATH` helpers. `FULL_NETPORT_SURFACE`
gained a comment (discovery off by default; no assertion change). `TCP_TRANSPORT_PRESENT`
now passes `mdns: true` (still no `start()`). No existing row's assertion was changed.
Root-barrel-only import rule preserved (test imports only from `../src/index.js` + node
builtins for `readFileSync`/path/url).

### Verification (final state)
- `corepack pnpm typecheck` → clean.
- `corepack pnpm build` → clean (protons + tsc, no errors).
- `corepack pnpm test` → **223 passed / 1 failed (224)**. The single failure is
  `BOOTSTRAP_CONNECTS` (see the Plan Change Log entry — a plan-vs-reality disagreement,
  NOT a code defect).
- Proto byte-identical: `git diff --name-only -- packages/core/src/proto/
  packages/core/proto/protocol.proto` → EMPTY.
- Additive scope: `git diff --name-only -- packages/core/src/{ledger,consensus,identity,
  config} packages/core/src/ports.ts packages/core/src/events` → EMPTY.
- Guard suites: `no-float-guard` + `identity-key-surface` → **11/11 green**.
- Diffs: `M packages/core/package.json`, `M packages/core/src/net/adapter.ts`,
  `M packages/core/test/net-adapter.test.ts`, `M pnpm-lock.yaml`. No temp files remain.

### Post-resolution pass — `BOOTSTRAP_CONNECTS` → `BOOTSTRAP_WIRED_TO_GENESIS` (done, 1 new blocker)
Per the ORCHESTRATOR RESOLUTION (options 1+2), the failing row was replaced exactly per the
corrected matrix row. Change is confined to `packages/core/test/net-adapter.test.ts`:
- header comment row updated; `loadGenesis` added to the root-barrel import (root-barrel-only
  rule preserved — no `@multiformats/multiaddr`, no `src/net` path; node builtins only);
- new INTERNAL test helper `peersStaysEmpty(adapter)` (bounded poll, ≤10s, async `peers()`)
  alongside the existing `peersInclude`;
- the old `BOOTSTRAP_CONNECTS` describe/it (memory bootstrap list → connect → receive) is
  removed and replaced by `BOOTSTRAP_WIRED_TO_GENESIS`: the node is configured with the REAL
  validated `genesis.bootstrap` list read via `loadGenesis(GENESIS_PATH)` (the same
  `defaultGenesisPath` convention the barrel uses; `GENESIS_PATH` mirrors its 3-levels-up
  resolve), started over the memory transport, and asserted to come up cleanly with
  `peers()` STAYING EMPTY over a bounded wait — the AD-10-correct outcome. The describe/it
  text now states what it proves (bootstrap SERVICE wired against the real genesis list; node
  boots; empty `peers()` is correct headless; the discover→dial→connect→receive MECHANISM is
  proven by the mDNS rows over the identical bridge). No other row, no `adapter.ts`, no other
  file changed.
- **NEW BLOCKER (distinct from the resolved loopback, NOT fixed — needs a fixture or a
  decision):** the row now fails, but not on the wiring. The real `@libp2p/bootstrap`
  constructor decodes every entry's `/p2p/<id>` via `peerIdFromString` (line 125 of
  `@libp2p/bootstrap@12.0.32` src), which throws `Non-base58btc character` for the current
  `config/genesis.json` fixture peer ids — they contain the letter **`O`**
  (`12D3KooWPLACEHOLDERA`/`…B`), which base58btc excludes (like `0`, `I`, `l`). So
  `createLibp2p` throws during `start()` before any timer fires. This is a FIXTURE defect in
  `config/genesis.json` (a placeholder id that is not a valid base58btc peer id), NOT a defect
  in the adapter wiring or the row logic. Fix = replace the two `/p2p/<id>` fixture ids with
  valid base58btc peer ids (out of the protected `config/` scope I was told not to touch);
  alternatively the orchestrator may direct the row to use a valid-shaped production list.
  Left as-is (red) rather than silently editing a fixture outside the authorized scope.

## Plan Change Log
(filled at build)

### ⚠ PLAN-PROSE DISAGREEMENT — `BOOTSTRAP_CONNECTS` (AC-1 / D2 / Matrix row 1) — NEEDS ORCHESTRATOR DECISION
**Status: reported, NOT resolved by a behavior change.** This is the one row that is
failing, and the failure is a disagreement between the plan's prose and the actual
`@libp2p/bootstrap@12.0.32` behavior — not a code bug I introduced, and not fixable
without changing either behavior or the test (both forbidden by the guardrails).

**What the plan says (AC-1 / D1 / D2 / Matrix):** "A node started with a (memory)
bootstrap list runs the **real** `@libp2p/bootstrap` service against that list and
**connects**… The CI test uses memory multiaddrs; the production genesis
`/ip4/…/tcp/4001/p2p/…` entries are the same mechanism, just not connectable headless
(AD-10)." D2: "bootstrap **also AUTO-DIALS** each list entry… so a bootstrap peer
connects without any adapter dial." D1: "the `/p2p/<peerId>` form… bootstrap *requires*
a peer id in each multiaddr — it `filter`s out entries without one."

**What the real `@libp2p/bootstrap@12.0.32` does (verified by reading its dist + running
the factory):** its constructor runs
`options.list.map(str => multiaddr(str)).filter(ma => { if (!P2P.matches(ma)) { log.error('invalid multiaddr', ma); return false } … return true })`.
`P2P` is from `@multiformats/multiaddr-matcher@3.0.2`, whose `P2P.matches` requires the
**FIRST** multiaddr component to be a recognized transport — one of
`_WebSockets`, `_WebSocketsSecure`, `and(_TCP, optional(/p2p))`, `and(QUIC, optional
(/p2p))`, `and(_IP_OR_DOMAIN, optional(/p2p))`, `_WebRTCDirect`, `_WebTransport` — or a
**bare** `/p2p/<id>`. A `/memory/<name>/p2p/<id>` multiaddr's first component is `memory`
(code 7766), which matches **none** of those → `P2P.matches` returns `false` → the entry
is filtered out.

**Empirical proof (ran the real factory in-process, no sockets):**
`bootstrap({ list: ['/memory/x/p2p/<id>'] })(components)` → surviving `list` length **0**
("invalid multiaddr" logged for the entry). `bootstrap({ list: ['/ip4/127.0.0.1/tcp/4001/p2p/<id>'] })(components)` → surviving
`list` length **1**. And end-to-end through the real adapter with the D4 listener:
`bootstrap: ['/memory/a/p2p/<A>']` → `peers()` stays empty (no merge, no auto-dial, no
`peer` event) because the list was filtered to empty before any timer fires.

**Consequence:** `BOOTSTRAP_CONNECTS` as written (a memory bootstrap list driving the
REAL bootstrap service to connect over the memory transport) cannot pass: the real
bootstrap service structurally refuses memory multiaddrs, so it never merges or dials.
The mechanism the plan relies on (auto-dial + `peer:discovery` from bootstrap) is
correct for the PRODUCTION `/ip4/…/tcp/4001/p2p/…` shape (and `BOOTSTRAP_FROM_GENESIS_SHAPE`
pins exactly that shape) — but that shape is not connectable headless (AD-10), which is
precisely why the plan's CI row uses memory multiaddrs, the one shape the real service
rejects. The plan's AC-1 premise ("the CI test uses memory multiaddrs… same mechanism")
is the disagreement: for the memory shape, the real bootstrap service is inert, so the
"connects" clause has nothing to drive it.

**Options for the orchestrator (I did NOT pick one, per the guardrail):**
1. **Re-point AC-1's CI row at the mechanism that IS exercisable headless** — i.e. have
   `BOOTSTRAP_CONNECTS` prove the bootstrap *wiring* (real `bootstrap({ list })` is
   registered in `peerDiscovery` and would auto-dial a well-shaped entry) while the
   *connect* clause is proven over memory by the same `peer:discovery`→dial bridge the
   mDNS rows already prove (or an adapter-level dial of the bootstrap-shaped multiaddr).
   This keeps "real bootstrap service is wired" true and "a discovered peer connects"
   true, but changes what the row asserts.
2. **Relax AC-1 to assert the production shape is wired + shape-validated** (already
   covered by `BOOTSTRAP_FROM_GENESIS_SHAPE`) and drop the headless memory *connect*
   clause as un-provable under AD-10 (bootstrap's own filter + no real sockets).
3. **Accept the row as red and document it** as a known AD-10 limitation (real
   bootstrap cannot run over memory; the tcp path is "present, never CI-exercised"),
   carrying it as a deferred/known-fail with this note.
4. **Add a tiny adapter-side pre-filter or a memory-compatible bootstrap variant** —
   rejected as a behavior change to the real service's contract; not appropriate for
   5.3 (would also weaken the "REAL service" claim in D2).

**What is definitively WORKING (no change needed):** `MDNS_DISCOVERS` and
`DISCOVERY_RECEIVES_GOSSIP` (the double path, fixed per the T3 note) now pass end-to-end
through the real libp2p discovery bridge (`#onDiscoveryPeer` → `peer:update` →
`peer:discovery` → adapter dial → connect → gossip received). `BOOTSTRAP_FROM_GENESIS_SHAPE`
and `DISCOVERY_OFF_BY_DEFAULT` pass. Explicit `dial()` (AC-5) is intact. So the
discovery *mechanism* the story is really about (a discovered peer appears in `peers()`
and starts receiving gossip) is proven by the mDNS rows; only the bootstrap-specific
headless-connect premise was wrong.

### ✅ ORCHESTRATOR RESOLUTION (2026-10-10) — BAD-PLAN LOOPBACK CLOSED: options 1+2
**Verdict: the implementer's analysis is CORRECT and independently re-verified from
`@multiformats/multiaddr-matcher@3.0.2` source** (`P2P = or(_WebSockets, _WebSocketsSecure,
and(_TCP, optional /p2p), QUIC, QUIC_V1, and(_IP_OR_DOMAIN, optional /p2p), _WebRTCDirect,
_WebTransport)`; `_TCP = and(_IP_OR_DOMAIN, value(CODE_TCP))`; `CODE_MEMORY` is in none;
`IP_OR_DOMAIN` rejects a bare `/p2p`). The real `@libp2p/bootstrap` service structurally
rejects `/memory/…` multiaddrs. **This is a ticket-premise defect, not a code defect**:
the ticket's `verify` #1 assumes "memory-transport multiaddrs in the CI test," which is
impossible for the real service. **Option 4 (a memory-compatible bootstrap variant) is
rejected** — it would falsify D2's "REAL service" claim.

**Resolution = options 1+2 combined, with the row re-pointed at the REAL genesis list:**
- **`BOOTSTRAP_CONNECTS` → `BOOTSTRAP_WIRED_TO_GENESIS`.** The failing test is replaced:
  the node is configured with the **real validated `genesis.bootstrap` list** (read via
  `loadGenesis`/`defaultGenesisPath` from the root barrel — production
  `/ip4/…/tcp/…/p2p/<id>` shape, which the `P2P` matcher ACCEPTS, so the real service is
  genuinely wired against the genesis list, not a memory substitute). The node is started
  over the memory transport and must come up cleanly (no throw). The production bootstrap
  peers are absent headless, so `peers()` stays empty over a bounded wait — that is the
  **correct AD-10 outcome** (no fake sockets, no connect claimed). This proves the
  bootstrap SERVICE is wired against the genesis list and the node boots — the honest
  headless form of AC-1.
- **The headless connect→receive MECHANISM is proven by the mDNS rows** (`MDNS_DISCOVERS`
  + `DISCOVERY_RECEIVES_GOSSIP`), which drive the IDENTICAL libp2p discovery bridge
  (`#onDiscoveryPeer` → `peer:update` → `peer:discovery` → adapter dial) the real bootstrap
  would drive for its production peers. This satisfies verify #2 and #3 and the "a fresh
  node that discovers existing nodes starts receiving their gossip" clause.
- **`BOOTSTRAP_FROM_GENESIS_SHAPE`** now asserts the **real** genesis-list entries are the
  `/…/p2p/<id>` multiaddr shape the real service requires (pinning why `BOOTSTRAP_WIRED_TO_GENESIS`
  can start cleanly with it).
- **Plan prose corrected** (AC-1, D2 loopback caveat, D4 `start: false` correction, matrix
  rows 1/2/4 + note). This is a BAD-PLAN loopback: the plan's AC-1/D2 premise disagreed with
  the real service's behavior; the CODE (real `bootstrap` wiring + `start: false` + mDNS
  double + dial listener) is correct and stays. Only the test row changes.

**Action for the implementer (on the next pass):** replace the `BOOTSTRAP_CONNECTS` test
with `BOOTSTRAP_WIRED_TO_GENESIS` per the corrected matrix row (real genesis list via the
root-barrel loader; start cleanly over memory; `peers()` empty over a bounded wait is the
asserted outcome). Do NOT change `adapter.ts` (the wiring is correct). Re-run the full
gate; expect 224/224.

### ✅ ORCHESTRATOR RESOLUTION (2026-10-10) — the second defect: a FIXTURE fix (option 1)
The implementer's second-pass report surfaced a DISTINCT, genuine defect: the real
`@libp2p/bootstrap` constructor calls `peerIdFromString` on every `/p2p/<id>` component,
and `config/genesis.json`'s two placeholder ids (`12D3KooWPLACEHOLDERA`/`…B`) contain the
letter **`O`**, which base58btc excludes — so `createLibp2p` throws `Non-base58btc
character` during `start()`. **Independently re-verified**: (a) both ids' only invalid
char is `O`; (b) 1.3's `validateGenesis` only checks `startsWith('/')`, so it never caught
this — the real bootstrap service is the FIRST consumer to decode the ids; (c) **no test
asserts the exact placeholder values** (`genesis.test.ts`/`boot-path.test.ts` check only
`length>0`/`startsWith('/')`; the one `12D3KooWPLACEHOLDER` string in `net-adapter.test.ts`
is a generic token in a *shape* assertion, not a value pin); (d) `config/genesis.json` is at
the REPO ROOT — it is NOT `packages/core/src/config/**` (the protected module) and NOT in
the additive-scope gate, so fixing it is in-scope.

**Resolution = the implementer's option 1 (fix the fixture), which is the RIGHT fix:** a
real deployment has real, valid peer ids, so the placeholders were always going to be
replaced. Replaced the two `/p2p/<id>` values with two REAL, valid base58btc Ed25519 peer
ids (generated via a real in-memory libp2p node's `peerId`, i.e. the same form real nodes
use): `12D3KooWNKvzczEMvDFqog1qcZrxdTtmsiNktZ7af3sNsBUGHg7E` and
`12D3KooWBj5ew35r7mtJD5prxp2Y31FPBLumb8kJTsT6QfhGtfXx`. Both verified to parse through
`peerIdFromString` (the service's exact function). No other file changed for this fix.
`BOOTSTRAP_WIRED_TO_GENESIS` now starts cleanly (the real service decodes the valid ids)
and `peers()` stays empty (the production peers are absent headless — the AD-10-correct
outcome). **Gate re-run (orchestrator, independent): 224/224, typecheck clean, build
clean, PROTO_OK, SCOPE_OK, guards green.**

## Review Triage Log

### Quick lens (iteration 1) — 10/10 scrutiny PASS, 0 code findings
The reviewer independently re-verified every load-bearing claim against the installed
library sources (`libp2p@3.3.11`, `@libp2p/interface@3.3.0`, `@multiformats/multiaddr-matcher@3.0.2`,
`@libp2p/bootstrap@12.0.32`, `main-event@1.0.5`) and the full `adapter.ts`/test/`genesis.ts`.
All 10 scrutiny points **PASS** (mDNS double is a faithful `PeerDiscovery` driving the REAL
bridge; `start: false` is correct & necessary; real bootstrap wired to the real genesis list
with an honest AD-10-correct `peers()`-empty assertion; `mdnsAnnounce` memory-only + ignored
over tcp + eager discovery; dial listener self-guarded + fire-and-forget, cannot throw;
3 devDeps single-version + all used; `genesis.json` fixture change safe — no test pins the old
values; the 11 prior rows' assertions unchanged + root-barrel-only imports; hygiene clean —
no big.js/.secret/RNG/wall-clock/debug, proto byte-identical, protected trees untouched;
type-safety sound). **No code changes required.**

Two NON-BLOCKING observations, triaged (no action):
- **OB-1 (inherent AD-10 limit, acknowledged).** `BOOTSTRAP_WIRED_TO_GENESIS`'s `peers()`-empty
  part cannot distinguish "bootstrap fired, dials failed" from "bootstrap never fired"
  (`peers()` maps `getConnections()` = established connections only; the memory transport
  rejects `/ip4/…` dials). The "starts cleanly" part IS load-bearing — `createLibp2p` threw
  `Non-base58btc character` with the old placeholder ids (223/224 before the fixture fix →
  224/224 after), so the row is not vacuous. The discover→dial→connect→receive MECHANISM is
  proven headless by the mDNS rows over the identical bridge. Matches the plan's AC-1 LOOPBACK
  note. No action.
- **OB-2 (documented trade-off).** `mdnsAnnounce` is a test-only knob on the public
  `NetAdapterConfig`; documented (adapter.ts JSDoc), ignored over tcp, and justified in D1 as
  the only way to drive the internal double through the public API without a new factory. No
  action.
