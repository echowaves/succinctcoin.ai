---
type: epic
title: "Real network: the app joins a LAN + internet network"
parent: initiative-succinctcoin-ai
covers: ["CAP-3", "CAP-6"]
after: []
assignee: ""
risk: medium
estimate: "3 stories, S each"
estimate_basis: "The tcp/mdns/bootstrap/relay code paths already exist in the core (epic 5) and are already inlined in the app bundle (verified at 0bba993); this epic is app-side selection (a pure config seam), one named core validation relaxation + three test pins, genesis data, docs, and an on-device two-instance proof."
status: done
---

# Real network: the app joins a LAN + internet network

## Description

The desktop app currently boots its net adapter on `transport: 'memory'` — a
per-process in-memory libp2p network (`packages/app/src/main/index.ts`). Two
running instances are each a complete, isolated one-node network and can never
see each other. This is the recorded deferral **deferred-work.md 6.4 item (4)**
("LanMultiaddrNetworks ... deferred to the real-network epic") — this epic lifts
it.

The core already has everything needed: `createNetAdapter` supports
`transport: 'tcp'`, `bootstrap` (real `@libp2p/bootstrap`) and `mdns` (real
`@libp2p/mdns`), with circuit-relay transport always wired (epic 5, D9) — all
built and tested headless under AD-10. This epic makes the **app** select that
real stack: tcp + noise + yamux by default, mDNS on for LAN discovery, the
bootstrap list from genesis for joining wider networks. The one core change is
named and minimal (7.1): `validateGenesis` currently rejects an empty bootstrap
array, which forbids a LAN-only genesis; relaxing it matches the adapter's own
gate (the bootstrap service is only wired when the list is non-empty).

Everything stays headless in CI: tests keep using the memory transport or pure
seams (AD-10); the real-network proof runs on the user's machine, not in CI.

## Outcome

Two app instances on the same LAN find each other with no manual configuration
and exchange blocks/tickets; a node can join a wider network by listing public
peers in `config/genesis.json`; the full test suite still passes headless in CI.

## Requirements

Reuses the parent's ids — epic 5 delivered the core's network capability
headless (memory transport in CI); this epic delivers the app-side selection of
it, plus the genesis data and one named core-config relaxation.

- **R1** (CAP-3) The app selects the real network stack: net config is produced
  by a pure seam defaulting to `transport: 'tcp'`; memory transport is never
  selected on the boot path — only injected explicitly by tests.
- **R2** (CAP-3) LAN discovery works out of the box: two instances on one LAN
  discover each other via mDNS with no manual multiaddrs and gossip blocks/
  tickets both ways. *(Verified on-device — cannot run in CI, AD-10.)*
- **R3** (CAP-3) Joining a wider network is data + docs, not code: bootstrap
  peers come from `config/genesis.json`; an empty bootstrap list validates as a
  LAN-only testnet (the named `validateGenesis` relaxation + its three test
  pins); the repo genesis carries no unreachable placeholder peers; README.md
  documents how to add public-peer multiaddrs and run two instances.
- **R4** (CAP-6) The full suite stays green headless: CI adds zero real sockets,
  zero LAN prerequisites (AD-10).

## Done when

1. On a real LAN, two app instances discover each other and gossip blocks/
   tickets (7.3, hitl); the CI-verifiable shape is pinned by the pure config test
   — boot-time net config selects tcp + mdns + genesis bootstrap.
2. A pure seam in `packages/app` produces the boot net config from the bundled
   genesis (tcp default, ephemeral listen address, mDNS on, bootstrap from
   genesis); no literal `'memory'` remains in the app's boot path, and memory
   stays available only via explicit test injection.
3. `config/genesis.json` contains no unreachable placeholder peers; README.md
   shows how to add a public peer (`/ip4/<ip>/tcp/<port>/p2p/<peerId>`) and run
   two instances; the suite is green headless.
4. Full root + package suites pass with zero real sockets / zero LAN
   prerequisites (AD-10). The only core change in this epic is the named
   `validateGenesis` bootstrap-emptiness relaxation and its three test pins
   (7.1); no other core behavior moves.

## Boundaries

In scope: app-side net-config selection + wiring (`packages/app`), genesis data
(`config/genesis.json`), the single named core-config validation relaxation +
its three test pins (`packages/core/src/config/genesis.ts`, two core test
files), README docs, and the on-device LAN proof. The core net adapter itself
is untouched — its tcp/mdns/bootstrap/relay paths exist and stay as built.
Out of scope: DHT or peer-exchange discovery (the 5.8 decision stands — known-
list model: genesis bootstrap + mDNS), public bootstrap infrastructure (we
document how to join; we do not host a node), relay deployment (transport stays
wired, no announced public relay), and any change to consensus, identity, or
privacy rules.

## Notes

- **Source:** lifts deferred-work.md 6.4 item (4) (LanMultiaddrNetworks → real-
  network epic). User report 2026-10-16: multiple peers on a LAN cannot find
  each other — root cause is the app's `transport: 'memory'` pin, not mDNS.
- **Waits on epic 5 because:** its adapter's tcp/mdns/bootstrap code paths are
  exactly what this epic selects; without them there is nothing to flip to.
- **Waits on epic 6 because:** the change target is the bootable desktop app,
  and the LAN proof runs the built app.
- **Decision 2026-10-16 (autonomous directive):** tcp is the app default — this
  is the deferred item's own plan ("flip it when real-network wiring lands"),
  and AD-10 constrains tests/CI, not production runtime. Listen address:
  `/ip4/0.0.0.0/tcp/0` (ephemeral port) so multiple instances coexist on one
  machine; the public multiaddr is read back from the started node. **Assump-
  tion to review:** ephemeral listen ports are acceptable for a testnet; fixed
  ports can be added with public-bootstrap infrastructure later.
- **Open question (non-blocking):** no real public SuccinctCoin peer exists
  yet, so R3 ships as a documented empty bootstrap list (LAN-only testnet);
  wiring the first public bootstrap node is a follow-up ticket after this epic
  and needs a user-supplied public multiaddr. Reviewer note: this app-side epic
  deliberately carries one small core diff (the validation relaxation) — that
  is the only core change, named in R3/done-when.
- **Ownership:** from 7.1 onward epic `epic-real-network` owns
  `config/genesis.json`; epic-platform-baseline's touch point stands as history.
- **Surfaced by 7.2 (review, 2026-10-17):** the pinned per-install identity
  seed (deferred-work 6.2(3)) means two instances share one protocol identity;
  on a real network the node-loop dedupes their tickets as same-identity
  duplicates. Discovery + block gossip still prove R2; ticket interplay needs
  the per-install seed (human-owned reversal of 6.2(3)). Recorded in
  deferred-work.md and in 7.3's unknown — not silently fixed here.
- **Evidence 2026-10-17 (pre-7.3 smoke, PASS twice):** two separate processes
  on one machine, real `defaultNetConfig` (tcp + mDNS, empty bootstrap),
  discovered each other and gossiped a block both ways —
  `mdns-smoke.mjs` + `evidence-two-process-smoke.md` beside these tickets.
  The user-reported failure is fixed at transport level; 7.3's remaining
  scope is the packaged/Electron path across real devices.
