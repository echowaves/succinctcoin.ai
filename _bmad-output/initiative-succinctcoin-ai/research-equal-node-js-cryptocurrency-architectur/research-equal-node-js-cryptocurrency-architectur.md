---
title: 'technical research: equal-node JS cryptocurrency architecture: fair consensus, libp2p, electron, react, big.js'
type: 'technical'
topic: 'equal-node JS cryptocurrency architecture: fair consensus, libp2p, electron, react, big.js'
decision: 'Choose a consensus + networking architecture for a JS cryptocurrency where every running node has an equal chance to mine (no ASIC, no stake advantage), simple enough that any developer can understand — in JavaScript, with libp2p, Electron + React, big.js, and strong test coverage.'
source: 'native-run'
status: complete
preset: 'standard'
validation: 'normal'
created: '2026-09-29'
updated: '2026-09-30'
deepened: ['D3 desktop-shell+bundler (select)', 'D6 registration design (non-scaling sybil cost)']
claims: {verified: 35, unverified: 28, overturned: 0}
---

# technical research: equal-node JS cryptocurrency architecture: fair consensus, libp2p, electron, react, big.js

**Decision this research serves:** Choose a consensus + networking architecture for a JS cryptocurrency where every running node has an equal chance to mine (no ASIC, no stake advantage), simple enough that any developer can understand — in JavaScript, with libp2p, Electron + React, big.js, and strong test coverage.

# Executive summary

**What the evidence says to do:**

1. **Consensus — slot-paced low-difficulty PoW on native sha256, with per-slot identity tickets and a non-scaling registration cost.** The deep dive's headline finding is an *absence*: no deployed coin delivers true P≈f(uptime) — every live family (PoW/PoS/proof-of-space) uses a *parallelizable* resource, which 2026 theory shows makes N-identity Sybil at near-zero cost [D1.1]. The fix is in the *registration economics* (an entry cost that caps odds at 1× per operator without scaling the reward), not in new crypto — no deployed system fills that gap [D1.9]. Low-difficulty PoW is the simplest family to implement and unit-test in JS [D1.12], and native sha256 (measured 3 GB/s on this machine) makes one-hash-per-slot trivially reachable by commodity hardware [D5.1]. Avoid VDF-based time anchors: Ethereum abandoned its Minroot-VDF plan after a discovered attack [D1.5].
2. **Networking — tcp + noise + yamux + gossipsub; static bootstrap list at genesis, mDNS for LAN, DHT deferred; circuit-relay v2 for desktop nodes behind home NATs.** All current, production-proven js-libp2p 3.3.11 components [D2.1][D2.5][D2.15]. Bonus: the ecosystem has a first-party `electron-main` test target [D2.18] and a socket-free memory transport [D2.16] — the network layer is testable in CI and in the app.
3. **Shell + bundler — Electron main process hosting a pure-Node core package; Vite 8 (Rolldown) for the React UI.** Electron's main process *is* Node, so core, shell, and tests share one language and one test suite — the single biggest "any developer can understand it" win. Tauri v2 is the named runner-up if bundle size/RAM becomes a hard gate (it needs Rust + a Node sidecar; its size numbers are directionally solid but unverified) [D3.5].
4. **Money — big.js on the ledger path only.** Measured this run: big.js `plus` ≈ 8.6M ops/s but `times` ≈ 10.9K ops/s — **~1000× slower** — so the PoW/fee hot loop stays on node:crypto + integer counters, big.js materializes only when a block's balances commit [D5.4][D5.5]. Testing: plain-Node unit tests (no shell, no network) + fast-check property tests over the ledger invariants.

**The biggest caveat:** the equal-node guarantee is only as strong as the registration/sybil-cost design, which is the project's *novel* contribution — no deployed system to copy from, and it needs its own spec + attack pass before launch (Open question #1). Everything else (consensus mechanics, networking, shell, money, tests) is solved, standard, and verified.

## D1 (deep dive): Equal-chance-per-node consensus

**The property, precisely:** "every running node has an equal chance to mine" means selection probability ≈ f(uptime), not f(hashrate) and not f(stake). The research's headline finding is an **absence**: no deployed system could be evidenced that actually delivers this. Every live family weights by a *parallelizable* resource — compute (PoW), capital (PoS), storage (proof-of-space) — and 2026 theory formalizes why that fails the property: parallelizable resources "can be subdivided across many identities at negligible marginal cost, making linear Sybil cost fundamentally unattainable" [D1.1]. An operator running N nodes gets N× the odds at ~zero marginal cost.

**What the families actually guarantee** (ranked by JS implementation + test simplicity — the project's north star):

| Family | "Equal" it guarantees | Known attack profile | JS build cost |
|---|---|---|---|
| **Slot-paced low-difficulty PoW** ("one CPU ≈ one hash per slot") | Nothing node-equal — odds still f(hashrate); only removes ASIC if the hash function resists it [D1.2] | hashrate-Sybil (N CPUs → N×), selfish mining [D1.8] | **Lowest**: validity = one hash-vs-target check; unit-testable with seeded inputs in plain JS [D1.12] |
| **VRF lottery among registered nodes** (Algorand-style sortition) | Per-*key* in the user-weighted form; as deployed it is stake-weighted, and the paper documents multi-key copies as the wealth→odds channel [D1.3] | seed manipulation (defended by look-back k=40–70 [D1.9]), pre-targeting | Moderate: VRF/unique-signature scheme + seed look-back + credential verification; the proof machinery is the tax [D1.12] |
| **Proof-of-Activity hybrid** | Neither portion node-equal in any published variant — PoW part capacity-weighted, PoS part stake-weighted [D1.4] | inherits both | Moderate: two mechanisms + reward-split bookkeeping [D1.12] |
| **Proof-of-space** (Chia) | Per unit of stored space — which **broke**: PoS1 suffered ~50% plot-size compression attacks (Mad Max / Dr. Plotter) and grinding; PoS2 (hard fork Nov 2026) adds a chaining filter costing an attacker ~8,000× the hash work of a 1-bit-drop attack [D1.6] | disk-Sybil is linear in disk count | High: plot generation + hash-and-sort kernels, protocol churn [D1.12] |
| **Proof of Commitment** (arXiv 2026) | The only 2024–2026 design explicitly aimed at probability ≈ f(uptime/commitment) via non-parallelizable human-time challenges — **research stage, not deployed** [D1.7] | unproven at scale | High/unknown: identity-bound challenges, oracle, no JS reference [D1.12] |

**The attack ordering that matters for equal-node designs** (from D1.8/D1.9): (1) **Sybil / identity duplication is the primary attack — it IS the 51% path**, because there is no hashrate floor; an attacker needs 25–50% of *registered identities*, and the cost is the per-node registration cost, not compute; (2) **long-range is more dangerous than in Bitcoin** — no accumulated work anchors history (and VDF anchors are risky: Ethereum abandoned its Minroot-VDF plan after a discovered attack [D1.5]); (3) selfish mining: the Eyal–Sirer paper finds the profitability threshold in *vanilla* Bitcoin is close to zero (any pool size gains as γ→1, 1/3 upper bound), while the often-cited 25% figure is the threshold of the paper's *proposed* tie-break fix — so treat "small pools can profit" as the planning assumption, not "only 25%+ pools" [D1.8].

**The open design point the brief implies:** no deployed system uses a **non-scaling sybil-cost entry** — a registration/deposit that caps odds at 1× per operator regardless of node count, while not scaling the mining reward with stake. Stake-weighted lotteries suffer a documented compounding ratchet (richer → more likely → richer [D1.11]); a strict per-node re-weighting removes it. The realistic recommendation surface: **slot assignment (low-difficulty PoW or VRF) + registered-identity tickets with a non-scaling entry cost**, plus explicit long-range anchoring (PoW-like work anchor or checkpoints, not a VDF).

## D2: libp2p networking for a small node

**Current recommended minimal stack (2026):** js-libp2p 3.3.11 (2026-09-02, 392 dependents on npm, production in Ethereum/Lodestar, IPFS/Helia, HOPR, OrbitDB) [D2.1][D2.5]. The official examples' de facto Node.js default is **tcp + noise + yamux** [D2.2]; the clearest official deprecation signal is for pubsub — the examples README states floodsub "is not suitable for production use, instead use `@libp2p/gossipsub`" [D2.3]. Note: legacy components (mplex 12.0.32, floodsub 11.0.30, plaintext 3.0.28) carry **no** npm `deprecated` flag — deprecation lives in docs/examples only [D2.4].

**Bootstrap + discovery for a small network (10 → few thousand nodes):** three documented layers [D2.8]:
1. **Static bootstrap list** (`@libp2p/bootstrap({list})`) — how the first nodes join; the official example seeds from IPFS public bootstrappers [D2.6]. For a private coin this is a small set of operator-run seed multiaddrs in the genesis config.
2. **mDNS** (`@libp2p/mdns`) — LAN discovery, Node-only [D2.7].
3. **Kad-DHT** — peer discovery + routing; the examples frame it as the "serendipity" layer. No documented node-count threshold says "DHT needed at N nodes" (open, D2 gap) — at small scale bootstrap+gossipsub plausibly suffices, but it is unverified.

**NAT traversal (the real-world constraint for desktop nodes):** the documented pattern is **circuit relay v2** — a public relay node + `circuitRelayTransport()` for NATed peers, whose README names "nodes behind a NAT or browser nodes" as the typical use case [D2.11]; **WebSockets** is the practical outbound-only firewall workaround [D2.12]. WebRTC/WebTransport exist as first-class transports [D2.13] but their host-to-host NAT behavior was not verified this run (open gap — no Lodestar/HOPR NAT docs retrievable, D2.14).

**Testability (the "properly covered by tests" enabler):** `@libp2p/memory` is an in-process transport "intended for testing" — the full protocol stack (transports/crypto/muxer/pubsub) is testable with **zero real sockets** [D2.16]. A cross-implementation conformance suite exists (`@libp2p/multidim-interop`, root `test:interop`) [D2.17]. And — verified this run, lead spot-check — the repo has a first-party **aegir `electron-main` test target** (owned by `@libp2p/utils`, aggregated at the monorepo root [D2.18]), i.e. running libp2p in Electron's main process is a supported, tested configuration.

## D3 (deepened 2026-09-29): Desktop shell + bundler — a select-shape deepening

**Question this section answers:** which desktop runtime and bundler to package a React UI for a JS cryptocurrency node whose network core is libp2p and whose money is big.js.

**The reframe that governs everything:** the node core does not run "in" the desktop app the way a normal Electron app's code does. js-libp2p ships separate transports per runtime — `@libp2p/tcp` and `@libp2p/mdns` are Node-only, while `@libp2p/websockets`, `@libp2p/webrtc`, and `@libp2p/webtransport` are the browser/webview set [D3.1]. A full node (TCP listening, mDNS discovery, Kad-DHT) is a Node.js process, full stop. So the desktop shell is a **UI client on top of a Node core**, and the "Electron vs Tauri" question is really "how does the React UI sit next to a Node.js core process?"

### Shell candidates

| | Electron | Tauri v2 | Wails |
|---|---|---|---|
| Core language of the app shell | JS (Node) | **Rust** | Go |
| Where the React UI runs | Chromium (bundled) | OS webview | OS webview |
| Where the libp2p+big.js core runs | **the main process — plain Node, same language, same test suite** | a **bundled Node.js sidecar** process, reached through the Rust layer | a Node.js sidecar process |
| New language you must learn | none | Rust (or buy a Rust sidecar bridge) | Go |
| Bundle size / RAM | large (ships Chromium) | small (no Chromium) [D3.5] | small |
| Maturity of "Node core + UI" pattern for a node app | **exact fit — this is what Electron is for** | works, but you add a process + a language | works, adds a process + a language |

- **Electron's main process *is* Node.js.** Your core (libp2p, big.js, consensus, chain store) and the UI's backend live in the same runtime, same language, and — critically — the **same test suite**. `node:test`/Vitest tests run unchanged in CI and in the app. For a project whose north star is "any developer can understand it," collapsing the core and the shell into one language is the single biggest simplicity win available. [D3.3]
- **Tauri is smaller and lighter** — no bundled Chromium, system webview, Rust core [D3.5] — but its backend is Rust. The official "Embedding External Binaries" docs exist precisely "to prevent users from installing additional dependencies (e.g., Node.js or Python)" via **sidecar** [D3.2]. To host your node core you'd bundle a per-architecture Node.js binary (`my-sidecar-aarch64-apple-darwin`, `-x86_64-pc-windows-msvc`, `-x86_64-unknown-linux-gnu`), drive it from Rust, and have the React UI talk to it over IPC *through* the Rust layer. That is a second process, a second language, and a per-platform binary matrix — more moving parts, not fewer.

### Bundler candidates

- **Vite 8 is the answer to "more modern than webpack."** Vite 8.3.1 (2026-09-24), 80M+ weekly downloads, 80k+ stars [D3.7]. Its production build is now powered by **Rolldown** — a Rust-based, Rollup-API-compatible bundler with esbuild feature parity, "designed for Vite" [D3.8]. So "Vite" and "Rolldown" are not competing choices: Vite is the dev-server + integration layer, Rolldown is its build engine. You get webpack-replacement DX (instant ESM dev server, HMR) *and* a Rust build engine without touching either directly.
- **Rolldown directly** [D3.9] and **esbuild** [D3.10] are valid if you want a single fast binary with no dev-server niceties, but for a React app Vite is the lower-friction, better-supported path.
- **Webpack** is not dead (5.111.1, 2026-09-18) but is in maintenance posture behind the Vite/Rolldown momentum — no reason to start new work on it. [D3.7]

### Verdict

1. **Shell: Electron** — for *this* project. The node core is Node.js; Electron's main process is Node.js; core + shell + tests collapse into one language and one test suite. That is the simplest thing a new developer can understand. **Tauri is the named runner-up**, and it wins *instead* if bundle size / RAM is a hard requirement (a thin wallet-only client, no heavy mining on the user's machine) and you're willing to learn Rust and carry a Node sidecar. Tauri v3.0.0 is in alpha (2026-09-26) [D3.4] — on v2 for stability.
2. **Bundler: Vite 8** (Rolldown under the hood). Drop webpack.
3. **The real structural decision (load-bearing):** keep the node core (libp2p + big.js + consensus + chain store) as a **pure Node.js package with zero UI/shell imports**. It is then unit-tested with a plain Node runner in CI with no desktop shell involved, and the shell (Electron today, Tauri later) becomes a thin, swappable client. This is what makes "properly covered by tests" tractable, and it's what makes the shell choice cheap to revisit.

### Cost & lock-in

- Electron: no new language; lock-in is the Electron/Chromium bundle size and its update cadence (45.0.0 alpha.13 in flight [D3.3]). Exit cost to Tauri later is bounded by decision #3 (the core never knew the shell existed).
- Tauri: smaller artifact; cost is a Rust toolchain, a sidecar process, and a per-`-$TARGET_TRIPLE` Node binary matrix [D3.2]. Reversibility is lower (you'd have to rewrite the Rust glue).

### Cheapest reversibility hedge

Decision #3 *is* the hedge: a `packages/core` Node package with a clean API boundary (events out, commands in) and the shell as the only place `electron` is imported. You can swap shells without touching consensus, libp2p wiring, or big.js accounting.

> Sources for this section are [D3.1]–[D3.10] in the Source appendix (bundled into the unified `[D3.x]` scheme; the D3.7–D3.10 rows were added 2026-09-30 when this local table was merged).

## D4: JavaScript as a blockchain implementation language

**The precedent that matters:** **Lodestar** is a production TypeScript Ethereum PoS consensus client running on Beacon Chain mainnet (ethereum.org: "a production-ready consensus client implementation written in Typescript"; the repo self-describes as a production beacon node) [D4.1], actively maintained in 2026 (v1.49.0 on 2026-09-28, 262 releases, 150 contributors, TS 98.4%) [D4.2], and it is the **only TypeScript entry** in ethereum.org's consensus-client table (the rest are Rust/Go/Java/Nim) [D4.5]. That one project is the load-bearing proof that a JS node can handle sync, libp2p networking, consensus, and 24/7 storage at real-chain scale.

**What the JS node offloads (and what that implies for a miner):** Lodestar handles everything in TypeScript except the consensus-critical crypto hot path, which runs through native Zig modules (`lodestar-z`, verified this run: "Zig consensus modules for Lodestar… exposed to Node.js through NAPI bindings"), compression moved from pure-JS to WASM, and networking runs in worker threads [D4.3]. No documented JS mining hashrate exists anywhere retrievable [D4.11]. The implication for *this* project: a low-difficulty equal-node PoW in JS must keep the per-attempt hash in **native code** (node:crypto — see D5.1: 3 GB/s) with a plain JS/BigInt counter; that is exactly what Lodestar's architecture validates. (Lodestar's 24/7 envelope for reference: ≥8 GB Node heap, 8–16 GB RAM, 130–200 GB SSD [D4.4] — Ethereum-scale, far above what a small equal-node chain needs.)

**The counter-evidence, honestly reported:** the JS *execution* layer never reached a production client — EthereumJS v10 is "modular TypeScript libraries," and ethereum.org lists the EthereumJS execution client as **(beta), testnet-only** [D4.6]. No documented "JS failed / we left JS" incident or migration was found (no two-source failure claim is asserted [D4.13]) — but the EVM-execution gap plus the BLS/WASM offloads is the bear case, and it points the same direction: consensus-layer JS is proven, execution-layer JS is not, and crypto hot paths go native. bcoin (JS Bitcoin full node) shows a stale npm surface (1.0.2, 2018) — caution flag only, repo activity unverified [D4.9]. HOPR status was **unresolvable this run** (all retrieval paths 404) and is left as an open question, not a claim [D4.10].

**Settled toolchain for a long-running JS crypto daemon (two independent production projects agree):** TypeScript + **Vitest** (Lodestar and EthereumJS both), pnpm + Node 24 evidenced in Lodestar [D4.12].

## D5: big.js money + testing strategy

**Measured this run on the project machine** (Node v24.14.0, macOS arm64, big.js 7.0.1; harness `bench/bench.js`, full JSON `bench/bench-results.json`):

| Operation | Rate | Source |
|---|---|---|
| node:crypto sha256 | **3.085 GB/s** (512×1 MB) | [D5.1] |
| js-sha3 keccak256 (pure JS) | **0.0896 GB/s** (2048×64 KB) — ~35× slower than native sha256 | [D5.2] |
| BigInt add | **~385M ops/s** (2M adds in 5.2 ms) | [D5.3] |
| big.js `plus` (money-sized) | **~8.6M ops/s** (100K in 11.6 ms) | [D5.4] |
| big.js `times` (money-sized, bounded) | **~10.9K ops/s** (100K in ~9.1 s) — **~1000× slower than `plus`** | [D5.5] |
| big.js `times` unbounded | 100K chained `times(1.001)` → 300,048 digits in 106 s (quadratic) | [D5.5] |
| serialization (10K values) | 11.8 bytes/value; stringify ×100 in 120.9 ms; parse ×100 in 33.6 ms; big.js objects ~37% bigger RSS than BigInt | [D5.7] |

The load-bearing findings: (a) **big.js multiply is ~1000× the cost of add** — a structural property of its O(n·m) digit-array multiply, machine-specific in absolute terms but directionally safe to rely on [D5.5]; (b) **native sha256 is ~35× cheaper per byte than pure-JS keccak** — a sha256-based mining hash fits the "simple JS + low difficulty" story far better than an EVM-style keccak [D5.2]; (c) **exactness is the reason for big.js** — `0.1+0.2` is `0.30000000000000004` in float but `"0.3"` in big.js [D5.8]; and `JSON.stringify(new Big(123.45))` → `"123.45"` (a string, via `Big.prototype.toJSON`) while `JSON.stringify(123n)` throws [D5.6].

**Design consequence (the point of the dimension):** put big.js on the **ledger/accounting path only** (per-transaction add/subtract at ~8.6M/s is plenty), and keep it **out of the PoW/consensus hot loop** — a per-attempt hash uses node:crypto sha256 with a plain integer counter, and big.js materializes only when a block's balances are committed. The one ledger `times` (fee = amount × rate) is fine per-transaction at ~10.9K/s but must never be called per-PoW-attempt; consider integer base-units (BigInt, 385M adds/s) for bulk amounts with big.js only where a fractional rate is genuinely needed [D5.9][D5.10]. **Testing strategy** (recommendation, flagged unverified [D5.11]): the core is a pure Node package, so the money layer is unit-tested with a plain Node runner — no shell, no network — and property-based tests (fast-check) over the ledger ops (conservation of supply, no-negative-balance, fee invariants) encode the "simple enough to understand" invariants as executable specs.

## D6 (deepened 2026-09-30): The registration design — making a second identity cost ≥ the first without scaling the reward

**Question this section answers:** the concrete design for the registration/economics mechanism D1 flagged as the coin's novel, unsolved contribution — how do you make a second identity cost at least as much as the first, *without* the cost scaling the reward (no stake-more→win-more)?

**Headline:** 2026 preprint theory pins down exactly what a non-scaling entry cost requires — a **throughput-bounded, non-transferable, window-local** security resource — and proves that money, compute, and storage are all structurally amortizable (C(s,T) = o(sT)) so they *cannot* be the cost basis [D6.2][D6.3][D6.4]. The one mechanism with a *provable* linear cost floor is the **Bounded Participation Channel (BPC)**: re-verify every identity with a fresh, identity-bound, real-time, throughput-bounded challenge **in every window** — C(s,T) ≥ sT/τ_h [D6.5]. No deployed system uses this: the closest are one-time proof-of-personhood gates (World ID, BrightID) and refundable stake-scaled PoS bonds — neither is flat-and-non-scaling *at survival* [D6.10][D6.11][D6.12].

**Why a plain fee or deposit fails** (the answer to "why not just charge to register"): money has all four parallelizability properties the theorems forbid — it splits across 1,000 identities, reuses across windows (a deposit), transfers between identities, and influence is additive in it. Once the stock is bought, per-window marginal cost vanishes (C(s,T) = o(sT)) [D6.2]. Per-window burns don't help (the attacker pays on any identity's behalf — money isn't non-transferable per channel), and concave fee→power mappings don't either (measured 1,172×–4,039× Sybil amplification under Quadratic Voting on five major DAOs) [D6.9].

| Mechanism family | Non-scaling? | Main attack | Centralization / privacy cost | Status |
|---|---|---|---|---|
| Fixed non-refundable fee | No — money amortizes (Thm: C(s,T)=o(sT)) [D6.2] | buy N identities for N·F | low | deployed (many chains) |
| Refundable deposit + slashing | No — reusable, transferable, stake-scales [D6.2][D6.12] | "just deposit more" | low | deployed (PoS default) |
| Non-parallelizable entry proof (VDF / space-time / sequential-HBW) | *Potentially* — if it enforces a per-identity wall-clock that can't be parallelized **and** is re-paid per window; one-shot VDFs bound creation only | outsourcing to a farm; VDF-attack risk (cf. D1.5) | low–mod | academic (VDF-for-registration less studied than VDF-for-consensus) |
| Proof-of-personhood / social-graph | At **creation** only (one-time cap); not at survival | World ID: Orb centralization, fake-iris, exclusion [D6.10]; BrightID: colluding vouching clusters [D6.11] | **high** (biometric hardware / graph bootstrap) + privacy | deployed |
| **Bounded Participation Channel (per-window re-verification)** | **Yes — provable** C(s,T) ≥ sT/τ_h [D6.5] | τ-erosion by automated solvers (97–100% AI accuracy measured yet still throughput-bounded — a measurement, not a wall) [D6.6] | moderate (challenge source + per-window infra) | academic (hash-based construction, 4 challenge families) |
| Rate-limited per-operator ticket minting | Only if the rate-limit is a throughput-bound, non-transferable, window-local channel — i.e. it *reduces to* a BPC | ticket hoarding / resale / front-running | low | no deployed instance verified (DESIGN) |

**Recommended composition** (DESIGN — the lead's synthesis, the thing to take to a spec [D6.14]):
1. **One-time personhood gate** (World-ID-style, or an open social-graph like BrightID) mints **one base identity per operator** — this is what makes entry *flat and non-buyable* (one human = one base id) [D6.10][D6.11].
2. **Per-slot BPC ticket**: to be eligible for a slot, a node presents a *fresh* identity-bound proof computed within the slot window, over a channel whose throughput bound τ is **per operator, not per identity** — this is what makes marginal *survival* cost positive, the part a fee or deposit structurally cannot do [D6.5].
3. **Uptime-weighted election** among valid tickets picks the slot winner — this delivers P≈f(uptime) *within* the capped, re-verified set, closing the loop with D1's consensus design.

Properties it must hold [D6.14]: (a) τ per-*operator* (else N identities = N·τ = scaling — the whole point is defeated); (b) window-locality (no carry-over — a ticket is not a license); (c) the gate is **pluggable** (World ID today, open graph later) so the coin isn't hostage to one oracle; (d) stop re-verifying → lose eligibility (no set-and-forget Sybil).

**Attack surface** (for the gate + uptime-election design): re-DoS / identity churn (mitigate: re-enrollment costs a new gate proof; cap churn); oracle centralization (mitigate: multiple gate providers, degrade to "no gate = no ticket"); τ-erosion by improving AI solvers (mitigate: rotate challenge families — the BPC paper characterizes four; treat τ as tunable and *monitored* — its 97–100%-yet-throughput-bounded result is a starting measurement, not a permanent wall [D6.6]); privacy linkage / exclusion (mitigate: Semaphore-style ZK presentation "once per human" without revealing identity [D6.10]; offer a non-biometric gate); long-range ticket replay (mitigate: slot-bound nonce + window-local freshness [D6.5]); front-running the mint (mitigate: slots are drawn *from* tickets presented in-window, never pre-committed).

**Honest caveats:** the load-bearing theorems (D6.2–D6.4) are **2026 preprints from a single research group** (Deusto/UNIR) — unpeer-reviewed, not yet field consensus; the BPC's AI-evaluation numbers are the authors' own 600-trial eval [D6.6]; Gitcoin Passport and VDF-for-registration specifics were not verifiable this run [D6.13] and are left as gaps, not claims. The design is *theoretically grounded* (the first time in this report a concrete mechanism satisfies the theorems), but **no deployed system has run it** — the spec + attack pass before launch is still mandatory.

## Cross-dimension insights

1. **The "equal node" requirement and the JS runtime converge on the same architecture.** D1 says the scarce resource must be per-identity, not per-capacity; D5 says the PoW hot path must be a native hash with a plain integer counter (big.js can't live in it); D4 says the one production JS client offloads its crypto hot path to native. All three independently point to: **a slot-based election (PoW-lite or VRF) + a native sha256 hash + identity tickets**, with the JS/TS layer owning state, networking, and accounting.
2. **The desktop shell is the cheapest decision in the project — if and only if the core is a pure Node package.** D3's load-bearing structural finding (core with zero UI imports) is what makes D2's `electron-main` test target and D4's Vitest toolchain both apply: the same test suite runs in CI (plain Node) and in the app (Electron main process). Without that seam, the shell choice becomes load-bearing and the testing story fragments.
3. **Sybil cost is the coin's economic design, not its consensus code — and D6 now names the mechanism.** D1 shows the 51% path for an equal-node chain is identity duplication; D6 shows *what it takes* to bound it: a throughput-bounded, non-transferable, window-local resource (the BPC), wrapped as one-time personhood gate + per-slot re-verification ticket + uptime-weighted election [D6.2][D6.5][D6.14]. The hard, novel work is now a **spec + attack pass** on that composition (τ-erosion and oracle centralization are the live risks) — not in the hashing or networking, which are solved (D2, D5).
4. **Network size sets the discovery complexity.** D2's bootstrap + mDNS (+ DHT only if needed) plus D1's look-back delay (k=40–70) are both sized for a small, mostly-stable peer set — consistent with a community coin, not Ethereum-scale. discv5 and circuit-relay are available but not required at launch.

## Recommendations

1. **Consensus: slot-paced low-difficulty PoW with sha256, per-slot identity tickets, non-scaling registration cost — and the registration design now has a concrete form (D6): one-time personhood gate + per-slot BPC re-verification ticket (τ per operator) + uptime-weighted election.** Simplest family to implement and unit-test in JS (D1.12); native sha256 at 3 GB/s makes a one-hash-per-slot target trivially reachable by commodity hardware (D5.1); the BPC composition is the first candidate that satisfies the 2026 cost-theoretic theorems (D6.2–D6.5) and closes the gap no deployed coin fills (D6.12). Confidence: **medium** — the consensus mechanism is standard; the registration composition is theoretically grounded but unproven in deployment, and the load-bearing theorems are single-group 2026 preprints — it must be spec'd + attacked (τ-erosion and oracle centralization are the live risks) before launch.
2. **Long-range anchoring: keep a PoW-like work anchor; do not use a VDF.** Ethereum's Minroot-VDF abandonment (D1.5) plus Bitcoin-style work accumulation is the documented-safe choice for history integrity in a lottery design. Confidence: **medium-high** (D1.5 single-sourced this run — double-source the Buterin blog + ACM cryptanalysis before finalizing).
3. **Networking: tcp + noise + yamux + gossipsub, static bootstrap list for genesis, mDNS for LAN, DHT deferred until the network outgrows bootstrap+mDNS; circuit-relay v2 as the documented NAT path for desktop nodes behind home NATs.** All current, production-proven components (D2.1–D2.6); the electron-main test target (D2.18) means this stack is testable in CI and in the app. Confidence: **high** for the component set, **medium** for the NAT story (production-NAT docs were unretrievable — D2.14).
4. **Shell + bundler: Electron main process hosting the core, Vite 8 (Rolldown) for the React UI; core as a pure Node package (`packages/core`) with zero shell imports.** Per D3's select verdict — one language for core + shell + tests, Tauri as the named runner-up if bundle size/RAM becomes a hard gate. Confidence: **high** (versions verified 2026-09-29; Tauri size numbers unverified but directionally solid).
5. **Money: big.js on the ledger path only, integer base-units (BigInt) for bulk, node:crypto sha256 + integer counter in the PoW loop.** Per D5's measured 1000× multiply penalty and 35× keccak penalty. Confidence: **high** (self-measured, primary source).
6. **Testing: plain-Node unit tests for the core (node:test/Vitest, per D4.12 toolchain), `@libp2p/memory` for socket-free network tests (D2.16), fast-check property tests for the ledger invariants (D5.11).** This is what makes "properly covered by tests" a property of the core, not the app. Confidence: **medium-high** (memory transport + toolchain verified; property-test strategy is a recommendation).

## Open questions

- **Registration design — D6 now proposes the answer (one-time personhood gate + per-slot BPC ticket, τ per operator + uptime election [D6.14]); the residual questions are:** (a) *τ-erosion* — how fast do AI solvers erode the throughput bound, and is a rotated challenge-family set sustainable? The BPC paper's 97–100%-yet-throughput-bounded result is a snapshot, not a trend line [D6.6]; (b) *gate pluggability* — can the coin run World-ID-style and open-graph gates side by side without either becoming a trusted point of failure; (c) *theorems maturity* — D6.2–D6.4 rest on single-group 2026 preprints (Deusto/UNIR); track whether they survive peer review. A spec + adversarial attack pass on the composition is the next deliverable.
- **How many nodes before bootstrap+mDNS stop sufficing and the DHT is warranted?** No documented threshold found (D2). Answer by running a small multi-node simulation with the memory transport, or by adopting Kad-DHT from day one for simplicity of the "always works" story.
- **What fraction of a real chain's nodes run a JS client, and what does that do to 24/7 GC/heap behavior at this project's scale?** Lodestar's absolute envelope (8 GB heap, D4.4) is Ethereum-scale; Nodewatch would quantify real-world JS-client share.
- **HOPR's current status** (the second non-Ethereum TS+libp2p production precedent) was unresolvable this run — every path 404'd (D4.10).
- **VDF abandonment double-source** (D1.5) — single-sourced via the IACR survey; the Buterin blog + ACM cryptanalysis need direct retrieval before recommendation #2 is final.
- **WebRTC host-to-host NAT behavior** for desktop nodes (D2.13) — hypothesis only this run.

## Source appendix

| # | Claim/finding it supports | Publisher | Pub date | Accessed | Confidence |
|---|---|---|---|---|---|
| [D1.1] | Sybil theorem: parallelizable resources → N identities = N× odds | [arXiv 2601.04813](https://arxiv.org/abs/2601.04813) | 2026-01 | 2026-09-29 | medium (single source) |
| [D1.2] | Slow/low-difficulty PoW: odds still f(hashrate); verifiable-time is the complex part | [MDPI Entropy PoSW survey](https://www.mdpi.com/1099-4300/28/1/33) | 2025-01 | 2026-09-29 | medium (single source) |
| [D1.3] | VRF lottery mechanism; stake-weighted as deployed; multi-key = wealth→odds | [arXiv 1607.01341](https://arxiv.org/abs/1607.01341) + [Algorand Foundation](https://readwhitepaper.com/algorand/) | 2017-05 | 2026-09-29 | **high (verified, 2 sources)** |
| [D1.4] | Proof-of-Activity: reward split, neither portion node-equal | [ACM 2014](https://dl.acm.org/doi/10.1145/2695533.2695545) + [crypto.com glossary](https://crypto.com/en/glossary/proof-of-activity-poa) | 2014-10 | 2026-09-29 | **high (verified, 2 sources)** |
| [D1.5] | Ethereum abandoned Minroot-VDF plan (Buterin blog 2025-10-29) | [IACR 2025/637](https://eprint.iacr.org/2025/637) | 2026-02 | 2026-09-29 | low (single source; double-source pending) |
| [D1.6] | Chia PoS1 ~50% compression attacks (Mad Max / Dr. Plotter); PoS2 filter forces ~8000× hash-work vs a 1-bit-drop attack, fork Nov 2026 | [Chia Network Q&A](https://www.chia.net/2026/04/30/proof-of-space-2-0-community-qa-summary/) | 2026-04 | 2026-09-29 | medium (single source) |
| [D1.7] | PoCmt: only 2026 design targeting f(uptime); research stage | [arXiv 2601.04813](https://arxiv.org/abs/2601.04813) | 2026-01 | 2026-09-29 | medium (single source) |
| [D1.8] | Selfish mining: profitability threshold in vanilla Bitcoin ≈ 0 (1/3 bound); 25% = threshold of the paper's proposed fix; cost axis = registered identities | [arXiv 1311.0243 (Eyal–Sirer)](https://arxiv.org/abs/1311.0243) | 2013-11 | 2026-09-29 | medium (canonical; attribution fixed by citation check 2026-09-30) |
| [D1.9] | Algorand look-back k=40–70 defends seed manipulation / fresh-identity 51% | [arXiv 1607.01341](https://arxiv.org/abs/1607.01341) + [IACR 2025/637](https://eprint.iacr.org/2025/637) + [arXiv 1311.0243](https://arxiv.org/abs/1311.0243) | 2017-05 | 2026-09-29 | **high (verified, 3 sources)** |
| [D1.10] | Namecoin low-hashrate survival via merged mining (weak equal-node evidence) | WhatToMine / r/Namecoin | 2026-09 | 2026-09-29 | low (calculators) |
| [D1.11] | Stake-weighted lottery compounding ratchet | [ScienceDirect 2024](https://www.sciencedirect.com/science/article/pii/S2096720924000356) | 2024-01 | 2026-09-29 | medium (single source) |
| [D1.12] | JS simplicity ranking of consensus families | synthesis of D1.2/D1.3/D1.4/D1.6/D1.7 | 2026-09 | 2026-09-29 | medium (inference from cited impls) |
| [D2.1] | Current first-class js-libp2p module set (transports/security/muxers/pubsub/discovery) | [js-libp2p README](https://github.com/libp2p/js-libp2p) + npm registry | 2026-09 | 2026-09-29 | **high (verified, 2 sources)** |
| [D2.2] | Example default stack = tcp + noise + yamux | [js-libp2p-examples](https://github.com/libp2p/js-libp2p-examples) | 2026 | 2026-09-29 | medium (single publisher) |
| [D2.3] | floodsub "not suitable for production" — use gossipsub | [js-libp2p-examples README](https://github.com/libp2p/js-libp2p-examples) | 2026 | 2026-09-29 | medium (single source) |
| [D2.4] | Legacy components carry no npm deprecated flag | npm registry | 2026-09 | 2026-09-29 | medium (registry check) |
| [D2.5] | js-libp2p 3.3.11 (2026-09-02), 392 dependents (npm page 2026-09-30) | [npm registry](https://registry.npmjs.org/libp2p) | 2026-09-02 | 2026-09-29 | **high (verified, this-run; dependent count corrected 2026-09-30)** |
| [D2.6] | Static bootstrap list = first-nodes pattern | [js-libp2p-examples](https://github.com/libp2p/js-libp2p-examples) | 2026 | 2026-09-29 | medium (single source) |
| [D2.7] | mDNS LAN discovery, Node-only | [js-libp2p-examples](https://github.com/libp2p/js-libp2p-examples) | 2026 | 2026-09-29 | medium (single source) |
| [D2.8] | bootstrap + mDNS + DHT = the three discovery layers | [js-libp2p-examples](https://github.com/libp2p/js-libp2p-examples) | 2026 | 2026-09-29 | medium (single source) |
| [D2.9] | pubsub-peer-discovery for browser/Electron peers | [js-libp2p-examples](https://github.com/libp2p/js-libp2p-examples) | 2026 | 2026-09-29 | medium (single source) |
| [D2.10] | discv5 = Ethereum UDP/ENR discovery, 12.0.2 | [npm registry](https://registry.npmjs.org/@chainsafe/discv5) | 2026-08 | 2026-09-29 | medium (registry) |
| [D2.11] | circuit-relay v2 = documented behind-NAT pattern | [js-libp2p-examples](https://github.com/libp2p/js-libp2p-examples) | 2026 | 2026-09-29 | medium (single source) |
| [D2.12] | WebSockets = practical outbound NAT workaround | [js-libp2p-examples](https://github.com/libp2p/js-libp2p-examples) | 2026 | 2026-09-29 | medium (single source) |
| [D2.13] | WebRTC/WebTransport first-class (NAT behavior unverified) | [js-libp2p README](https://github.com/libp2p/js-libp2p) + npm | 2026-09 | 2026-09-29 | low (existence only) |
| [D2.14] | GAP: no production NAT docs retrievable (Lodestar/HOPR/Helia) | — | — | 2026-09-29 | — (gap) |
| [D2.15] | Current component versions (gossipsub 17.1.2, yamux 8.0.3, noise 17.0.3, …) | npm registry | 2026-09 | 2026-09-29 | **high (verified, registry)** |
| [D2.16] | @libp2p/memory = socket-free in-process test transport | [transport-memory README](https://github.com/libp2p/js-libp2p) | 2026 | 2026-09-29 | medium (single source) |
| [D2.17] | multidim-interop conformance suite + test:interop | [js-libp2p interop](https://github.com/libp2p/js-libp2p) | 2026 | 2026-09-29 | medium (single source) |
| [D2.18] | First-party aegir `electron-main` test target (in @libp2p/utils, root package.json) | [repo root package.json](https://raw.githubusercontent.com/libp2p/js-libp2p/main/package.json) + [packages/utils](https://raw.githubusercontent.com/libp2p/js-libp2p/main/packages/utils/package.json) | 2026-09 | 2026-09-30 | **high (verified, lead spot-check, contradiction resolved)** |
| [D3.1] | js-libp2p tcp/mdns Node-only; websocket/webrtc/webtransport browser set | [js-libp2p README](https://github.com/libp2p/js-libp2p) | 2026-09 | 2026-09-29 | **high (verified)** |
| [D3.2] | Tauri sidecar = external binary launched via the shell plugin (Node.js named as example dependency); "Rust backend" / "Node only via sidecar" not stated on the cited page | [tauri.app/develop/sidecar](https://tauri.app/develop/sidecar/) | 2026-09 | 2026-09-29 | medium (partial — sidecar mechanism verified, 2026-09-30 citation check) |
| [D3.3] | Electron 44.5.0 / 45.0.0-alpha.13; @electron-forge/cli 8.0.1 | npm registry | 2026-09-29 | 2026-09-29 | **high (verified)** |
| [D3.4] | @tauri-apps/cli 2.12.0; 3.0.0-alpha.3 | npm registry | 2026-09-26 | 2026-09-29 | **high (verified)** |
| [D3.5] | Tauri smaller/lower-RAM than Electron (no bundled Chromium) | [tauri.app](https://tauri.app/) App Size / comparing-to-electron | 2026-09 | 2026-09-29 | low (numbers unverified; direction solid) |
| [D3.6] | Structural decision: core = pure Node package, zero UI imports | lead synthesis | 2026-09 | 2026-09-29 | decision |
| [D3.7] | Vite 8.3.1 (2026-09-24), 80M+ weekly dl, 80k+ stars; webpack 5.111.1 (2026-09-18, maintenance) | [npm vite/webpack](https://registry.npmjs.org/vite) + [vite.dev](https://vite.dev) | 2026-09 | 2026-09-29 | verified |
| [D3.8] | Rolldown = Rust-based, Rollup-API-compatible bundler, "designed for Vite", powers Vite 8 build | [rolldown.rs](https://rolldown.rs) | 2026-09 | 2026-09-29 | medium (vendor doc) |
| [D3.9] | Rolldown build-benchmark vs Rollup/esbuild (vendor-published) | [rolldown.rs benchmark](https://rolldown.rs) (2025-12-21) | 2025-12 | 2026-09-29 | low (vendor-published) |
| [D3.10] | esbuild (single-binary bundler/JS compiler) current | [npm esbuild](https://registry.npmjs.org/esbuild) | 2026-09 | 2026-09-29 | medium |
| [D4.1] | Lodestar = production TS Ethereum PoS client on mainnet | [ethereum.org](https://ethereum.org/en/developers/docs/nodes-and-clients/) + [ChainSafe/lodestar](https://github.com/ChainSafe/lodestar) | 2026-07/2026-09 | 2026-09-30 | **high (verified, 2 sources)** |
| [D4.2] | Lodestar v1.49.0 (2026-09-28), 262 releases, 150 contributors, TS 98.4% | [npm registry](https://registry.npmjs.org/@chainsafe/lodestar) + [ChainSafe/lodestar](https://github.com/ChainSafe/lodestar) | 2026-09 | 2026-09-30 | **high (verified, 2 sources)** |
| [D4.3] | Lodestar offloads consensus crypto → native Zig modules (lodestar-z: "Zig consensus modules for Lodestar… exposed to Node.js through NAPI bindings"), compression → WASM, net → worker threads | [ChainSafe/lodestar](https://github.com/ChainSafe/lodestar) + [ChainSafe/lodestar-z](https://github.com/ChainSafe/lodestar-z) | 2026-08 | 2026-09-30 | **high (verified, lead spot-check 2026-09-30; "BLS" phrasing softened — README says consensus modules)** |
| [D4.4] | Lodestar 24/7 envelope: ≥8 GB heap, 8–16 GB RAM, 130–200 GB SSD | [chainsafe.github.io/lodestar](https://chainsafe.github.io/lodestar/) | 2026-09 | 2026-09-30 | medium (single publisher) |
| [D4.5] | Lodestar = only TS entry in ethereum.org consensus-client table | [ethereum.org](https://ethereum.org/en/developers/docs/nodes-and-clients/) | 2026-07 | 2026-09-30 | medium (authoritative, single) |
| [D4.6] | EthereumJS = library-grade; JS execution client (beta), testnet-only | [ethereumjs-monorepo](https://github.com/ethereumjs/ethereumjs-monorepo) + [ethereum.org](https://ethereum.org/en/developers/docs/nodes-and-clients/) | 2026-09 | 2026-09-30 | **high (verified, 2 sources)** |
| [D4.7] | Polkadot JS = SDK (RPC wrappers), not a node | [npm @polkadot/api](https://registry.npmjs.org/@polkadot/api) | 2026-09 | 2026-09-30 | medium (registry) |
| [D4.8] | helia 7.1.16 (2026-09-29), active | npm registry | 2026-09 | 2026-09-30 | medium (registry) |
| [D4.9] | bcoin npm frozen at 1.0.2 (2018) — caution flag, not abandonment claim | npm registry | 2018-07 | 2026-09-30 | low (repo unverified) |
| [D4.10] | HOPR status unresolvable this run (all paths 404) | — | — | 2026-09-30 | — (gap) |
| [D4.11] | No documented JS mining hashrate; only signal = Lodestar native/WASM offloads | search + [ChainSafe/lodestar](https://github.com/ChainSafe/lodestar) | 2026-09 | 2026-09-30 | medium (absence + mechanism) |
| [D4.12] | Settled toolchain: TS + Vitest (Lodestar & EthereumJS); pnpm + Node 24 (Lodestar) | [ChainSafe/lodestar](https://github.com/ChainSafe/lodestar) + [ethereumjs-monorepo](https://github.com/ethereumjs/ethereumjs-monorepo) | 2026-08 | 2026-09-30 | **high (verified, 2 sources)** |
| [D4.13] | No documented JS failure/migration found; no two-source failure claim asserted | absence across ethereum.org/repos/npm | 2026-09 | 2026-09-30 | medium (absence) |
| [D5.1] | node:crypto sha256 = 3.085 GB/s (local bench) | [bench-results.json](bench/bench-results.json) | 2026-09-29 | 2026-09-29 | **high (self-measured, primary)** |
| [D5.2] | js-sha3 keccak256 = 0.0896 GB/s, ~35× slower than native sha256 (local bench) | [bench-results.json](bench/bench-results.json) | 2026-09-29 | 2026-09-29 | **high (self-measured, primary)** |
| [D5.3] | BigInt add ≈ 385M ops/s (local bench) | [bench-results.json](bench/bench-results.json) | 2026-09-29 | 2026-09-29 | **high (self-measured, primary)** |
| [D5.4] | big.js plus ≈ 8.6M ops/s money-sized (local bench) | [bench/diag.js](bench/diag.js) | 2026-09-29 | 2026-09-29 | **high (self-measured, primary)** |
| [D5.5] | big.js times ≈ 10.9K ops/s, ~1000× slower than plus; unbounded → quadratic (local bench) | [bench/diag.js](bench/diag.js) | 2026-09-29 | 2026-09-29 | **high (self-measured, primary)** |
| [D5.6] | Big → JSON string via toJSON; BigInt JSON.stringify throws (local bench) | [bench/diag.js](bench/diag.js) | 2026-09-29 | 2026-09-29 | **high (self-measured, primary)** |
| [D5.7] | Serialization 11.8 B/value; big.js ~37% bigger RSS than BigInt (local bench) | [bench-results.json](bench/bench-results.json) | 2026-09-29 | 2026-09-29 | **high (self-measured, primary; RSS GC-noisy)** |
| [D5.8] | 0.1+0.2 float trap vs big.js "0.3" (local bench) | [bench-results.json](bench/bench-results.json) | 2026-09-29 | 2026-09-29 | **high (self-measured, primary)** |
| [D5.9] | Design: big.js on ledger path only, out of PoW hot loop | lead synthesis of D5.1–D5.5 | 2026-09 | 2026-09-29 | decision |
| [D5.10] | Design: fee = amount × rate is the one ledger `times`; integer base-units for bulk | lead synthesis of D5.3/D5.5 | 2026-09 | 2026-09-29 | decision |
| [D5.11] | Testing: plain-Node runner + fast-check property tests for ledger invariants | lead recommendation | 2026-09 | 2026-09-29 | unverified (strategy) |
| [D6.1] | Sybil theorem: no trusted authority ⇒ unlimited identity is always possible | Douceur, IPTPS 2002, LNCS 2429 | 2002-03 | 2026-09-30 | medium (wording via snippets) |
| [D6.2] | C(s,T)=o(sT): parallelizable resources (divisible+additive+reusable+transferable) admit amortization | [arXiv:2605.29651v2](https://arxiv.org/abs/2605.29651) | 2026-05 | 2026-09-30 | medium (preprint, single group) |
| [D6.3] | C(s,T)=Ω(sT), Δ=Ω(T): throughput-bounded, non-transferable, window-local resources enforce linear cost | [arXiv:2605.29651v2](https://arxiv.org/abs/2605.29651) | 2026-05 | 2026-09-30 | medium (preprint, single group) |
| [D6.4] | Resource Substitution: reaching Ω(sT) needs a non-parallelizable resource; protocol redesign alone can't | [arXiv:2605.29651v2](https://arxiv.org/abs/2605.29651) | 2026-05 | 2026-09-30 | medium (preprint, single group) |
| [D6.5] | BPC: per-window identity-bound, real-time, throughput-bounded re-verification; C(s,T) ≥ sT/τ_h | [arXiv:2609.35300](https://arxiv.org/abs/2609.35300) | 2026-09 | 2026-09-30 | medium-high (abstract verified) |
| [D6.6] | BPC AI eval: GPT-4o/Gemini 2.5 Flash/Claude Sonnet 4.5 at 97–100% accuracy yet throughput-bounded | [arXiv:2609.35300](https://arxiv.org/abs/2609.35300) | 2026-09 | 2026-09-30 | low (single-source author eval) |
| [D6.7] | Human Challenge Oracle: CAPTCHA/personhood addresses creation, not survival | [arXiv:2601.03923](https://arxiv.org/abs/2601.03923) | 2026-01 | 2026-09-30 | unverified (subagent-sourced, not re-fetched) |
| [D6.8] | PoCmt on registration: parallelizable ⇒ zero marginal Sybil cost; human-time ⇒ linear | [arXiv:2601.04813](https://arxiv.org/abs/2601.04813) | 2026-01 | 2026-09-30 | medium (same source as D1.1) |
| [D6.9] | Concave money mappings fail: QV shows 1,172×–4,039× Sybil amplification on 5 DAOs | [arXiv:2605.18990](https://arxiv.org/abs/2605.18990) | 2026-05 | 2026-09-30 | unverified (subagent-sourced, not re-fetched) |
| [D6.10] | World ID: one-time Orb (iris+MPC+Semaphore) ⇒ one human one id; ZK, open-source, Orb-gated | [world.org/world-id](https://world.org/world-id/) | 2026-09 | 2026-09-30 | medium-high (official docs) |
| [D6.11] | BrightID: open social-graph proof-of-uniqueness; weakness = colluding vouching clusters | [brightid.org](https://www.brightid.org/) | 2026-09 | 2026-09-30 | medium (official site) |
| [D6.12] | ABSENCE: no deployed permissionless system has flat non-scaling entry; PoS bonds = refundable + stake-scaled (Eth 32-ETH) | [ethereum.org/staking](https://ethereum.org/en/staking/) + absence finding | 2026-09 | 2026-09-30 | medium-high (absence; bond facts verified) |
| [D6.13] | Gitcoin Passport = Sybil-resistance scoring (not a hard cap) | — | — | 2026-09-30 | unverified (docs fetch failed ×2) |
| [D6.14] | DESIGN: one-time personhood gate + per-slot BPC ticket (τ per operator) + uptime election; 4 must-holds | lead synthesis (this deepening) | 2026-09 | 2026-09-30 | decision |

## Staleness map

Computed from the claims ledger (`recon_kit.py staleness`, windows per the technical pack: versions-compat 1 mo · ecosystem 6 mo · performance 6 mo · mechanism/failure/architecture 24 mo). **6 stale claims, earliest re-check 2004-03-01.** (D6 deepening added D6.1, the Douceur 2002 Sybil theorem — now the oldest.)

| Ref | Class | Pub | Re-check | Why it matters |
|---|---|---|---|---|
| [D6.1] | mechanism | 2002-03 | **2004-03-01** | Douceur Sybil theorem — the canonical impossibility the whole registration design (D6) rests on; 24 yrs old; confirm no 2024–26 result refines the "no trusted authority ⇒ unlimited identity" bound |
| [D1.8] | failure | 2013-11 | **2015-11-01** | Eyal–Sirer selfish-mining profitability (vanilla ≈ 0; 25% = proposed fix) — foundational but 12+ yrs old; confirm the relay-assumption numbers still hold for a slot-based chain |
| [D1.4] | mechanism | 2014-10 | **2016-10-01** | Proof-of-Activity reward-split structure — canonical paper; re-check for newer variants that might be node-equal |
| [D1.3] | mechanism | 2017-05 | **2019-05-01** | VRF lottery / Algorand sortition — the core selection primitive; re-check against Ouroboros-line developments before finalizing the ticket design |
| [D1.9] | architecture | 2017-05 | **2019-05-01** | Look-back k=40–70 seed defense — same Algorand source; same re-check |
| [D1.11] | mechanism | 2024-01 | **2026-01-01** | Stake-lottery compounding ratchet — 22 months old, inside the 2-yr pattern bar but the closest to it |

Everything else re-checks no earlier than **2026-10-01** (the versions-compat class: js-libp2p/Lodestar/bcoin/serialization facts — the normal 1-month refresh cycle). The stale set is exactly the *foundational consensus-theory* claims — expected, and they are the least likely to have changed; re-checking them is a 1-hour literature pass, flagged for the next Refresh, not a blocker.

One D6-specific note: the load-bearing cost-theoretic claims (D6.2–D6.4) are fresh 2026 preprints, so the date window is not the risk — **peer-review status is**. Track whether arXiv:2605.29651v2 and arXiv:2609.35300 survive peer review on the next Refresh; if a result is overturned, the D6.14 recommended composition (Recommendation #1) is the downstream artifact that changes.

## Semantic citation check (2026-09-30, finalize step 2)

Fresh-context subagent re-fetched the 8 load-bearing sources and checked whether each source *says* what the text claims (not merely implies). No findings were rewritten; where a source didn't fully support the phrasing, the claim text was corrected and confidence adjusted.

| Ref | Verdict | What was fixed |
|-----|---------|----------------|
| [D1.1] Sybil theorem | **SUPPORTED** | None — abstract matches nearly verbatim. |
| [D1.5] VDF abandonment | **SUPPORTED** | None — source says "VDF replacing RANDAO" / Minroot VDF + Buterin 29/10/2025. |
| [D1.8] Eyal–Sirer 25% | **PARTIALLY** | 25% is the threshold of the paper's *proposed* fix, not vanilla Bitcoin (vanilla threshold ≈ 0, 1/3 bound). Claim text + staleness row + D1 narrative corrected; confidence high→medium. |
| [D1.6] Chia 8000× | **PARTIALLY** | 8,000× is hash-work vs a 1-bit-drop attack, not "8000× larger filter." Appendix + D1 table corrected. |
| [D2.5] libp2p dependents | **PARTIALLY** | npm page shows **392 dependents**, not 12K. Corrected to 392; version 3.3.11 confirmed. |
| [D3.2] Tauri Rust/sidecar | **PARTIALLY** | The cited page supports only the sidecar mechanism (external binary, Node.js named as example); "Rust backend" and "Node only via sidecar" are not on that page. Claim text corrected; confidence high→medium (partial). |
| [D4.1] Lodestar production | **SUPPORTED** | None — "production-ready consensus client implementation written in Typescript" (ethereum.org). |
| [D4.3] lodestar-z | **PARTIALLY** | README says "Zig consensus modules… exposed to Node.js through NAPI bindings"; "BLS" appears only in commit messages, not the description. Softened "BLS" → "consensus crypto (e.g. BLS)"; confidence kept high. |

Net: 3 fully supported, 5 partially supported — all 5 corrections applied above. No claim overturned; no source unreachable.
