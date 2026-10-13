---
ticket: "7"
epic: epic-node-network
status: "built"
review: quick
review_source: pinned
covers: ["E1"]
baseline_revision: "fbe14a820a7bd7e0e708c781a3a130fd339535fe"
lenses_ran: ["quick"]
review_loop_iteration: 1
context:
  - _bmad-output/initiative-succinctcoin-ai/epic-node-network/epic-node-network.md
  - _bmad-output/initiative-succinctcoin-ai/architecture-succinctcoin/architecture-succinctcoin.md
  - packages/core/src/net/adapter.ts
  - packages/core/src/net/topics.ts
  - packages/core/test/net-adapter.test.ts
  - packages/core/test/block-propagation.test.ts
  - packages/core/package.json
  - config/genesis.json
---

# Story 5.7 — circuit-relay-v2: a NATed node connects through a relay

## Story of Truth

This story adds the **behind-NAT** capability (spine E1 / AD-10): a node that has no
direct inbound listener (a "NATed" node) becomes **reachable through a relay** — a second
node connects to it **via the relay** and a message **round-trips** over the real NetPort
gossip path. The relay itself is an **ordinary libp2p node over the memory transport**
(zero real sockets). The relay is an **optional capability, not a requirement**: a direct
node (and the relay node) works without any relay hop.

This is the **first story to add net capability code** (the 5.1 scaffold deferred
circuitRelay here — `adapter.ts` line ~56: "circuitRelayTransport is 5.7"). The change is
confined to `src/net/adapter.ts`: the relay role is a new `NetAdapterConfig` field, the
`circuitRelayTransport` is always wired (it dials through relays AND, on the client side,
reserves a circuit + advertises the node's proxied address when it is connected to a
relay), and `circuitRelayServer` is registered for the relay-role node. **No new deps**
(`@libp2p/circuit-relay-v2@4.2.13` is already a devDep — the all-devDeps private-package
convention means the src import needs no `package.json` change), **no proto change**.

**The "simulated NAT" model (the ticket's `unknown`):** the memory transport has no NAT.
The relay path is exercised by wiring `circuitRelayTransport` (client) +
`circuitRelayServer` (relay) over memory and **proving the hop happens** — the second node
dials the NATed node's **relay-proxied multiaddr**
(`/memory/relay/p2p/<relayId>/p2p-circuit/p2p/<natedId>`), never a direct address. A real
NATed node dials **out** through the NAT; so the NATed node keeps an **outbound**
transport (memory) to reach the relay but has **no direct listen** (inbound) — reachable
only through the relay. The ticket's "no direct transport" is read as "no direct **listen**
/ not directly reachable" (a NATed node can always dial out).

## Acceptance Criteria

- **AC-1 (the relay hop).** In a memory-transport network with a relay node
  (`relayRole: 'relay'`, listen `/memory/relay`), a NATed node (`relayRole: 'client'`,
  **no direct listen**) that dials the relay is reachable **through the relay**: a second
  node (`relayRole: 'none'`) dials the NATed node's relay-proxied multiaddr and connects —
  `secondAdapter.peers()` **includes the NATed node's peer id** (the hop happened via the
  relay, not a direct address).
- **AC-2 (message round-trips over the NetPort path).** After the relay connection +
  mesh settle, the NATed node publishes a ticket (`sendTicket`); the second node
  **receives it on the `tickets` topic** with `sourcePeerId === natedId` — the gossip
  flowed **through the relay** (AD-8, AD-10), using the existing NetPort surface.
- **AC-3 (the NATed node is not directly reachable).** The NATed node was built with
  **no direct listen** (`relayRole: 'client'` → `addresses.listen` empty); the
  **relay-proxied multiaddr is the only path** to it. The relay node and the second node
  are ordinary nodes (direct listen) — only the NATed node lacks a direct listener.
- **AC-4 (relay is a capability, not a requirement).** The relay node is a **normal,
  directly-reachable node**: a node dials the relay node's direct address (`/memory/relay`)
  with **no relay hop** and they exchange a message (gossip). A `relayRole: 'none'`
  (direct) node works as an ordinary node. The relay is optional.
- **AC-5 (ADDITIVE).** The `src` diff is **exactly** `packages/core/src/net/adapter.ts`
  (the relay wiring — nothing else); the `proto` diff is **EMPTY**; the
  `package.json`/`pnpm-lock.yaml` diff is **EMPTY** (no new deps); the four class topics
  are pinned; the prior suite stays green; every wait is a **bounded poll** (no
  wall-clock/RNG in the cadence — AD-3); **no real sockets** (memory transport only —
  AD-10).

## Design Decisions

- **D1 — the relay capability is wired into the adapter, not composed in the test.**
  `src/net/adapter.ts` gains a `relayRole` config and wires the relay components.
  Rationale: 5.1 deferred circuitRelay here (the adapter line-~56 note); the relay is a
  **net capability** the NetPort surface should own (a node operator configures
  `relayRole`; the test drives it). Composing the relay purely in the test (bypassing the
  adapter) would leave the adapter without the capability — a real node could not be
  relayed.
- **D2 — `relayRole: 'none' | 'relay' | 'client'` (+ `relayAddress` for the client).**
  - `'relay'`: register `circuitRelayServer()` as the `circuitRelay` service; listen
    normally (direct memory/tcp transport). The relay is an ordinary node that **also**
    serves circuits.
  - `'client'` (the NATed node): `addresses.listen = []` (**no direct listen** — inbound
    only via the relay). The `circuitRelayTransport` reserves a circuit + advertises the
    proxied address when the node dials the relay. `relayAddress` is the relay's multiaddr
    the **test** dials (the adapter does **not** auto-dial — the operator drives the
    connection, matching 5.1's explicit-`dial` model).
  - `'none'` (default, unchanged): direct memory/tcp transport + listen.
- **D3 — `circuitRelayTransport` is ALWAYS wired** (every `relayRole`). It is the
  dial-through-relay capability: a node that is NOT itself relayed (the second node,
  `relayRole: 'none'`) still needs it to **dial** the NATed node through the relay. It is
  inert for a node that never connects to a relay (no `circuitRelayServer` peer → no
  circuit reservation), so the existing 5.1–5.6 nodes are unaffected (the full-suite gate
  verifies this).
- **D4 — the relay-proxied multiaddr is constructed explicitly in the test** (not
  discovered). The test knows the relay's peer id and the NATed node's peer id; it builds
  `/memory/relay/p2p/<relayId>/p2p-circuit/p2p/<natedId>` and dials it on the second node
  (bounded retry until the circuit is reserved/advertised). Deterministic — no reliance on
  libp2p's relay advertisement/discovery.
- **D5 — the message round-trips over the real NetPort gossip path** (a `sendTicket` the
  second node receives on the `tickets` topic), **not** a raw libp2p stream. A raw stream
  would prove the transport hop but bypass the NetPort; gossip **over the relay** is the
  path a real node uses (AD-8).
- **D6 — forward note 1 (send retry / `allowPublishToZeroTopicPeers`) is SETTLED by the
  test, not an adapter change.** The NATed node's publish happens **after** the relay
  connection + `settleMesh`, and the test uses `publishUntilAccepted` (bounded retry). The
  adapter's single-shot `publish` is sufficient — the memory transport + mesh settle make
  the publish deterministic. No `allowPublishToZeroTopicPeers` / retry is added to the
  adapter.
- **D7 — forward note 3 (5.4-F1 framing unit test via exported framing helpers) is
  RE-DEFERRED to 5.9 (the refactor sweep).** 5.7's verify is exclusively the relay; the
  framing unit test (export `encodeFrame`/`FrameAccumulator` + a chunked round-trip)
  belongs in the sweep, which explicitly handles deferred test/DRY items. Re-deferring
  keeps 5.7 focused on the relay capability.

## Matrix Test Plan — `test/circuit-relay-v2.test.ts` (5 rows)

- **RELAY_HOP** (AC-1) — relay (`relayRole: 'relay'`, `/memory/relay`) + NATed
  (`relayRole: 'client'`, `relayAddress: '/memory/relay'`, no listen) + second
  (`relayRole: 'none'`, `/memory/peer`). The NATed node dials the relay (bounded retry) —
  reserving a circuit. The second node dials the NATed node's relay-proxied multiaddr
  (bounded retry until the circuit is advertised). Assert `secondAdapter.peers()`
  **includes `natedId`** (the hop, via the relay).
- **MESSAGE_ROUNDTRIP** (AC-2) — after the relay connection + `settleMesh`, the NATed node
  `sendTicket`s a window-S ticket; the second node **receives it on `tickets`** with
  `sourcePeerId === natedId` (gossip through the relay — AD-8/AD-10).
- **NOT_DIRECTLY_REACHABLE** (AC-3) — the NATed node was built with **no direct listen**
  (the driver constructed it `relayRole: 'client'`; the adapter sets `addresses.listen =
  []`); the **relay-proxied multiaddr is the only path** the test uses to reach it. The
  relay node + second node have direct listens; only the NATed node lacks one.
- **RELAY_OPTIONAL** (AC-4) — a node dials the relay node's **direct** address
  (`/memory/relay`) with **no relay hop** and they exchange a message (gossip). The relay
  node is an ordinary, directly-reachable node; a `relayRole: 'none'` node works without
  relay access.
- **ADDITIVE** (AC-5) — the gates: `src` diff = **exactly** `src/net/adapter.ts`; `proto`
  diff EMPTY; `package.json`/`pnpm-lock.yaml` EMPTY; the four class topics pinned; every
  wait a bounded poll (self-source asserts no `Date.now(`/`Math.random(` in the cadence);
  memory transport only (no real sockets — AD-10); the prior suite stays green.

## Code Map

- **CHANGED:** `packages/core/src/net/adapter.ts` — add `relayRole`/`relayAddress` to
  `NetAdapterConfig`; wire `circuitRelayTransport()` (always) + `circuitRelayServer()`
  (relay role) into `buildNode`; `addresses.listen = []` for the client role; the
  `Services` type gains an optional `circuitRelay`. Import
  `{ circuitRelayServer, circuitRelayTransport }` + `type CircuitRelayService` from
  `@libp2p/circuit-relay-v2`.
- **NEW:** `packages/core/test/circuit-relay-v2.test.ts` — the 5 rows above + a focused
  driver (relay + NATed + second node; `dialWithRetry`; the relay-proxied-multiaddr
  builder; `settleMesh`; `publishUntilAccepted`; `close`).
- **Do NOT touch:** `proto/**`, `package.json`, `pnpm-lock.yaml`, `config/genesis.json`,
  `src/**` **except** `src/net/adapter.ts`, and every existing test file.

## Tasks

- [x] **T1 — Adapter: the relay role.** Add `relayRole`/`relayAddress` to
  `NetAdapterConfig`; wire `circuitRelayTransport()` (always) + `circuitRelayServer()`
  (relay role) into `buildNode`; `addresses.listen = []` for the client role; extend the
  `Services` type with an optional `circuitRelay`. Import from
  `@libp2p/circuit-relay-v2`.
- [x] **T2 — Test driver.** Relay + NATed + second node over memory; dial the relay
  (circuit reservation, bounded retry); the relay-proxied-multiaddr builder;
  `dialWithRetry`; `settleMesh`; `publishUntilAccepted`; `close`.
- [x] **T3 — RELAY_HOP + NOT_DIRECTLY_REACHABLE.** Assert the second node connects to the
  NATed node **through the relay** (`peers()` includes `natedId`); the NATed node has no
  direct listen.
- [x] **T4 — MESSAGE_ROUNDTRIP + RELAY_OPTIONAL.** The NATed node's published ticket
  reaches the second node **via the relay** (`sourcePeerId === natedId`); the relay node
  is directly reachable (no hop).
- [x] **T5 — ADDITIVE + run the full gate (7 commands below); record results in
  Implementation Notes.**

## Verification (run from `packages/core`)

1. `corepack pnpm test 2>&1 | grep -E "Test Files|Tests "` — expect all prior + new green
   (≈ 238 + new relay tests, 35 files).
2. `corepack pnpm typecheck 2>&1 | tail -1` — clean.
3. `corepack pnpm build 2>&1 | tail -1` — clean (proto untouched; protons regen
   byte-identical).
4. `git diff --name-only -- packages/core/src` — **EXACTLY**
   `packages/core/src/net/adapter.ts` (the relay wiring; nothing else).
5. `git diff --name-only -- packages/core/proto` — **EMPTY** (proto untouched).
6. `git diff --stat -- packages/core/package.json pnpm-lock.yaml` — **EMPTY** (no new
   deps).
7. Guards (no-float guard, identity-key surface guard) still pass — covered by the suite.

## Never (this story)

- No real sockets — memory transport only (AD-10).
- No wall-clock / RNG in the cadence — every wait is a **bounded poll**.
- **No new deps** (`@libp2p/circuit-relay-v2` is already a devDep — do NOT move it to
  `dependencies` or bump it; the private-package all-devDeps convention stands).
- No `proto` change.
- Do NOT touch `package.json`, `pnpm-lock.yaml`, `config/genesis.json`, any existing test
  file, or any `src/**` file **other than** `src/net/adapter.ts`.
- The adapter does **not** auto-dial the relay — the **test** dials `relayAddress` (the
  operator drives the connection, matching 5.1's explicit-`dial` model).
- `reject`/drop = a normal outcome, never a throw.
- Do NOT `git commit` or `git push` — the orchestrator commits.

## Implementation Notes

(Fill in at step-03/05: what was wired in `adapter.ts`, the relay-proxied-multiaddr
builder, the gate results, and anything left incomplete or risky.)

### 5.7 implementation (2026-10-13)

**What was wired in `adapter.ts` (T1):**
- `NetAdapterConfig` += `relayRole?: 'none' | 'relay' | 'client'` (default
  `'none'`) + `relayAddress?: string`.
- `buildNode`: `transports` ALWAYS appends `circuitRelayTransport()` after
  the direct transport (D3); `services` = `{ gossip: gossipsub({
  runOnLimitedConnection: true }), identify: identify() }` plus
  `circuitRelay: circuitRelayServer()` when `relayRole === 'relay'`;
  `addresses.listen = []` for the client role (the config's `listenAddress`
  is IGNORED — no direct inbound listener), `[config.listenAddress]`
  otherwise.
- `Services` type extended with optional `circuitRelay: CircuitRelayService`.
- New INTERNAL seam `reserveCircuitOnRelay` (+ structural types
  `NodeWithTransportManager` / `CircuitReservationSeam`): the adapter
  locates the instantiated circuit transport via
  `components.transportManager.getTransports()` + the transport's
  `Symbol.toStringTag` (`@libp2p/circuit-relay-v2-transport`) and calls
  `reservationStore.addRelay(relayPeer, 'configured')`. (The package
  exports the transport FACTORY only, not the class — hence the structural
  seam.)
- `dial()`: when a client-role node dials its configured `relayAddress`,
  the adapter fires the reservation (fire-and-forget, never throws — a
  failed reservation is a normal outcome; a later proxied dial then
  simply fails with NO_RESERVATION and the operator retries).

**Deviations from the plan's mechanism (all empirically root-caused in the
installed dist — libp2p 3.3.11 + @libp2p/circuit-relay-v2 4.2.13 +
@multiformats/multiaddr-matcher 3.0.2; reproduced in throwaway experiments
before touching real files):**

1. **The reservation is ADAPTER-TRIGGERED, not transport-listener-driven**
   (corrects D2's wording "the circuitRelayTransport reserves a circuit +
   advertises the proxied address when the node dials the relay"). A bare
   dial of the relay NEVER reserves: a 'discovered' reservation needs a
   PENDING reservation, which only exists behind a circuit LISTEN — and
   the client role listens on nothing (D2/AC-3), so none can exist. The
   circuit LISTEN path is ALSO unusable over the memory transport: the
   client's `#createReservation` always seeds the reservation `addrs` with
   the DIALED relay addr (`/memory/...`), and the listener's `addedRelay`
   calls `addressManager.confirmObservedAddr` on each — `DNSMappings.has`
   / `IPMappings.has` call `getNetConfig`, which THROWS
   `InvalidParametersError` for non-IP/DNS multiaddrs; thrown inside a
   library-internal event handler (main-event rethrows via nextTick) →
   uncaughtException → process crash. `announceFilter` does NOT help (the
   client adds `connection.remoteAddr` regardless of what the relay
   advertises). Fix: the adapter registers the reservation itself with a
   'configured' `addRelay` (no pending reservation needed; with no circuit
   listener registered, nothing calls `addedRelay` → no crash). No
   advertise/discovery is involved — D4's explicit multiaddr construction
   makes it unnecessary.
2. **The relay-proxied dial multiaddr is the PEER-ID-ONLY form**
   `/p2p/<relayPeerId>/p2p-circuit/p2p/<natedPeerId>` (corrects D4's
   `/memory/relay/p2p/<relayId>/p2p-circuit/p2p/<natedId>`): the circuit
   transport's `dialFilter` (multiaddr-matcher `Circuit.exactMatch`) never
   accepts a `/memory` relay prefix — the plan's form is rejected with
   `NoValidAddressesError`; the bare `/p2p/<relayId>` relay prefix
   exact-matches the matcher's p2p alternative. The second node dials the
   relay DIRECTLY FIRST (the hop reuses that connection — the relay's STOP
   request to the NATed node goes over it).
3. **`gossipsub({ runOnLimitedConnection: true })`** for all nodes:
   relayed circuit connections are "limited", and gossipsub's default
   blocks protocol streams on limited connections; without the flag,
   gossip cannot flow over the relay hop. No-op for direct connections
   (the 5.1–5.6 rows stay green — full-suite gate).

**The relay-proxied-multiaddr builder (test-side, D4):**
`relayProxiedMultiaddr(relayPeerId, natedPeerId)` in
`test/circuit-relay-v2.test.ts` — string construction only (the test
imports no multiaddr/peer-id packages; peer ids come from
`adapter.peerId()`).

**Gate results (run from `packages/core`, 2026-10-13):**
1. `corepack pnpm test` — 35 files / 243 tests, ALL GREEN (238 prior + 5 new).
2. `corepack pnpm typecheck` — clean.
3. `corepack pnpm build` — clean (protons regen byte-identical).
4. `git diff --name-only -- packages/core/src` — EXACTLY
   `packages/core/src/net/adapter.ts`.
5. `git diff --name-only -- packages/core/proto` — EMPTY.
6. `git diff --stat -- packages/core/package.json pnpm-lock.yaml` — EMPTY.

**Risk / flakiness notes:** the hop dial's only timing dependency is the
fire-and-forget reservation that follows the operator's relay dial; the hop
dial retries bounded (120 × 25 ms, NO_RESERVATION until the reservation
exists) and 4 consecutive test-file runs + the full-suite run showed no
flakes. The NOT_DIRECTLY_REACHABLE negative dial (a direct dial of the
NATed node's placeholder address) rejects fast over the memory transport
(no hang observed in any run). The reservation seam touches
`components.transportManager` (the root `libp2p` export is the interface
without `components`; the concrete class carries it at runtime) —
documented in `adapter.ts` (D8/D9 + the seam's doc comment).

## Plan Change Log

- (created) — plan authored at `status: planned`; baseline `fbe14a8` (5.6 built).
- (2026-10-13, 5.7 implementation) — D2 mechanism corrected by experiment:
  the client's circuit reservation is ADAPTER-TRIGGERED (a 'configured'
  `addRelay` fired on the operator's `dial(relayAddress)`), not created by
  the circuit transport's listener (a bare dial never reserves; the
  listener path crashes over memory addrs — see Implementation Notes,
  deviation 1). `addresses.listen = []` for the client role stands as
  written.
- (2026-10-13, 5.7 implementation) — D4's relay-proxied multiaddr corrected
  by experiment to the peer-id-only form
  `/p2p/<relayId>/p2p-circuit/p2p/<natedId>` (the Circuit dialFilter
  rejects a `/memory` relay prefix — deviation 2); the second node dials
  the relay directly first.
- (2026-10-13, 5.7 implementation) — the adapter's gossipsub now runs with
  `runOnLimitedConnection: true` (gossip over limited/relayed connections
  — deviation 3). `status:` unchanged (in-progress).

## Review Triage Log

**Quick lens (step-04, 2026-10-13) — NO unmet ACs, NO broken spine rules.**
The reviewer independently re-ran the full gate (243/243; typecheck/build
clean; src = exactly `adapter.ts`; proto/deps EMPTY), read the installed
`@libp2p/circuit-relay-v2` + `multiaddr-matcher` + `libp2p` internals, and
confirmed the 5 rows are not hollow, the `dial()` change is correctly
scoped, `gossipsub({runOnLimitedConnection:true})` does not perturb 5.1–5.6,
and the three documented deviations are sound. Findings + triage:

- **F1 (latent robustness — NOT a live defect): the `reserveCircuitOnRelay`
  internal-API coupling.** (a) If the transport's `Symbol.toStringTag`
  changes in a future `@libp2p/circuit-relay-v2` release, the `find` returns
  `undefined` and the function silently returns (no reservation, no log);
  (b) the `components.transportManager.getTransports()` access is a
  type-level cast only — a libp2p internals drift would throw a raw
  `TypeError` after a successful dial. **Verified:** both premises hold for
  the PINNED versions (the tag string is present; the concrete `Libp2p`
  class sets `this.components`; `DefaultTransportManager.getTransports()`
  returns the instantiated transports), so this is fragility bounded by the
  pinned stack, not a live bug. The `dial()` path is a connection operation
  (it legitimately rejects on failure — the 5.2/5.3 `ConnectionFailedError`
  pattern), not an acceptance decision, so the spine's "reject = normal,
  never a throw" rule does not govern it. **Disposition: ACCEPTED as
  documented, pinned-stack-bounded fragility.** The coupling is the minimal
  available (the package exports the transport FACTORY only, not the class —
  `instanceof` is impossible); the reservation call itself
  (`reservationStore.addRelay`) is a PUBLIC-API call; a defensive guard
  against a non-occurring (pinned-stack) drift would be speculative dead
  code, contrary to the "verify empirically / no dead code" discipline.
  Documented in `adapter.ts` (D8/D9 + the seam's doc comment); a dependency
  bump re-runs this story's tests.
- **F2 (wording): the `reserveCircuitOnRelay` doc comment misattributed the
  store** the relay's hop handler reads (it said "the client's store"; the
  relay checks its RELAY-side store, populated by the RESERVE handshake).
  **FIXED** (the comment now names the RELAY-side entry + the client-side
  entry's actual role).
- **F3 (wording): the RELAY_OPTIONAL title claimed "no circuit at all"**
  but the circuit transport is wired on both nodes (inert). **FIXED** (the
  title now says "no reservation or hop (the circuit transport is wired but
  inert)").
- **F4 (wording): NOT_DIRECTLY_REACHABLE said the direct dial "fails (bounded
  by the 10s dial timeout)"** but over the memory transport it rejects
  IMMEDIATELY (no listener → immediate reject, not a timeout). **FIXED**
  (title + body comment now say it fails immediately).
- **F5 (wording): the `RelayTopology` comment misattributed the STOP path**
  (the relay's STOP to the NATed node goes over the NATed node's OWN relay
  connection — the relay requires `getConnections(dstPeer)` — not the second
  node's). **FIXED** (the comment corrected).
- **F6 (wording — found in the Matrix Test Audit): the ADDITIVE `it`
  description said "src / proto / deps untouched"** but 5.7 changes the src
  (`adapter.ts`). **FIXED** (it now says "the src diff is exactly
  src/net/adapter.ts, proto and deps untouched").

After the F2–F6 comment/title-only fixes, the full gate was re-run:
243/243, typecheck clean, build clean, src = exactly `adapter.ts`,
proto/deps EMPTY.
