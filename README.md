# succinctcoin.ai

An AI-generated cryptocurrency designed around simplicity, with code that engineers can easily understand.

SuccinctCoin is a small, self-contained cryptocurrency: a TypeScript consensus + ledger core, an Electron + React desktop app, and an **uptime-only** mining model — no proof-of-work. The core is deterministic by construction (chain-time only, no wall clock or RNG in consensus), the ledger uses decimal money at exactly two boundaries, and the whole system is testable headless: every test runs under plain Node over an in-memory network transport, with zero real sockets.

## Repository layout

| Path | What it is |
|------|------------|
| `packages/core` | The consensus + ledger core: block production, uptime-weighted draw, signed tickets, the single mutation path (`applyBlock`), identity (Ed25519), a libp2p net adapter, and file-based chain persistence. |
| `packages/app` | The desktop app (Electron 44 + React 19): a thin main process that hosts the core, a `contextBridge` preload, a display-only renderer, and electron-forge packaging. |
| `config/genesis.json` | The ONE genesis source: protocol version, gate registry, and the emission schedule (max supply 21,000,000 / 12.5 block reward). The app build copies it byte-identical into the package. |
| `_bmad-output/` | Project artifacts: the architecture spine, epic/story plans, and the deferred-work ledger. |

## Prerequisites

- **Node.js 24** (the repo pins `packageManager: pnpm@12.8.1` — run everything through `corepack pnpm …`)
- macOS, Linux, or Windows (the dev environment is macOS; packaging targets all three)

## Quickstart

```sh
corepack pnpm install     # installs the workspace (+ the Electron binary)
corepack pnpm build       # builds the core (regenerates the protocol code, then tsc)
corepack pnpm test        # the full workspace test suite (489 tests / 66 files)
corepack pnpm typecheck   # core typecheck
```

The root `test` runs every package's suite: the core's 437-test suite (57 files) plus the app's 52-test suite (9 files). The app's packaged-boot rows are self-sufficient — they build what they scan — so a fresh `install → build → test` is all that's needed.

## Run the desktop app

```sh
cd packages/app
corepack pnpm build       # clean → typecheck → renderer → main bundle → preload bundle → genesis copy
corepack pnpm exec electron .
```

On boot the app opens the window, loads the bundled renderer, and **auto-starts the node and mining** — the UI shows blocks being mined, balances, and peers (driven by the event stream, never polling). The chain is persisted under Electron's `userData` directory. The node runs on the real network stack (tcp + noise + yamux, IPv6-only); joining rides invitations, not multicast — see "Joining a network" below.

## Joining a network

**This network is IPv6-only.** Nodes announce and dial global-unicast `/ip6` addresses over TCP; `/ip4`, ULA (`fd00::/8`) and link-local (`fe80::/…`) addresses are rejected by the address policy at every boundary (announce, dial, ingest). Two practical caveats:

- **Inbound needs a route.** Your node listens on all interfaces, but home routers rarely advertise your global v6 address via NDP and stateful firewalls/NAT64 middleboxes (consumer routers — Norton-class ones in particular) can silently drop *inbound* v6 connections even when outbound works. Outbound joins always work; that is exactly why joining rides an **invitation**, not a public listen port.
- **Inbound blocked but outbound works?** The relay tier still carries you: point `SUCCINCTCOIN_RELAY_SEEDS` at any reachable relay and the rest of the network sees you through it — see "Reachability ladder" below. (You still need working outbound global IPv6 yourself; a machine with **no** IPv6 connectivity at all — pure IPv4 — cannot join even through a relay, and that is deliberate.)

### Join with an invitation (the primary path)

1. **Generate** — the running node shows its own invite in the app (the *MY INVITE* panel; the same string lands in `<userData>/invite.txt`-compatible form). It is one line: `scinvite:v1:…`. If it never appears, the panel says why — it classifies this machine's IPv6 interfaces (link-local only, VPN-overlay `fd00::`, or no IPv6 at all) so a missing invite reads as a network fact, not an app bug.
2. **Send** — pass that line to the joining person any way you like (it is public data, already signed).
3. **Paste** — on the new machine, paste it into the *JOIN* panel (or write it as one line into `<userData>/invite.txt` before first boot). The app verifies it fully — signature, chain id, and ticket liveness of the inviter against applied blocks — **before dialing anything**, then dials through it and lets the peer-book crawl fill out the rest of the network (bounded: depth ≤ 3, book ≤ 100 entries, ≥3 distinct /64s by design).

A wiped machine with an empty config needs nothing else: one verified invitation is a proven complete join (the amnesiac-invite boot proof runs it headless in CI). For the manual two-machine version see `_bmad-output/initiative-succinctcoin-ai/epic-real-network/dial-manual.mjs` (`invite-new` / `invite-use`); single-machine loopback proofs set `SUCCINCTCOIN_ALLOW_LOOPBACK=1` on both commands — an explicit, default-off **dev** exemption: with it a machine that has no global IPv6 at all may announce, relay, verify and dial pure-`::1` (everything else — `fe80::`, ULA, IPv4, zones — stays rejected exactly as before). Such an invite is honest but local: a friend dialing `::1` reaches their own machine, never yours, and the app panel says so. Consensus paths ignore the flag entirely — loopback records can never enter a block.

### Reachability ladder

Every node climbs the same four rungs, automatically and in order — each one only kicks in where the previous one leaves off:

1. **Direct TCP over global IPv6** — the happy path, what an invitation carries.
2. **AutoNAT honesty.** A probe tells each node whether it is actually reachable from the outside; a node that learns it is *not* stops advertising the dead address (and re-advertises if reachability returns). Peers never get lied to, so nobody wastes dials on addresses that cannot answer.
3. **Circuit relay.** A node whose *inbound* is blocked (firewall, router — but whose outbound IPv6 works) holds a relayed connection through a volunteer **relay** and advertises its circuit address alongside — or instead of — its direct one. Set `SUCCINCTCOIN_RELAY_SEEDS` to a comma-separated list of relay seeds (`/ip6/…/tcp/…/p2p/<relayId>`); the node keeps those circuits alive and re-holds them if they drop. The relay hop itself must be global `/ip6`: this is how *unreachable* peers join, not how *IPv4-only* ones do (those stay unserved by design).
4. **DCUtR hole-punching.** Peers connected only *through* a relay keep trying to punch a direct connection between themselves; where both firewalls allow it, the relayed link silently upgrades to direct. No configuration — it rides the relay connections you already have.

**Running a relay (volunteers).** Start any well-connected node with `SUCCINCTCOIN_RELAY_SERVER=1`. Its boot log prints its dialable multiaddr, peer id included — that whole line **is** the seed. Share it out-of-band (a forum, a group chat) and set it on your hidden nodes' `SUCCINCTCOIN_RELAY_SEEDS`. There is deliberately **no official relay endpoint** and no automatic relay discovery yet: relays are machines someone volunteered, and how peers learn about them stays a human/ops question (see `deferred-work.md`). The end-to-end circuit path has a manual proof: `dial-manual.mjs` modes `relay-new`, `node-behind <seed>`, and `invite-use-through-relay <scinvite>` (one machine under `SUCCINCTCOIN_ALLOW_LOOPBACK=1` is enough).

### Bootstrap lists (dev tool)

`config/genesis.json` → `bootstrap` remains as a developer convenience: full multiaddrs (now `/ip6/…`, must include `/p2p/<peerId>`) dialed at start. Configure it **before packaging** (a packaged app reads genesis from inside its archive). Normal users never touch it — invitations and the crawl do the joining.

LAN multicast (mDNS) is OFF by default since 9.1; opt in with `SUCCINCTCOIN_MDNS=1` where a trusted LAN justifies it.

## Package for distribution

```sh
cd packages/app
corepack pnpm package     # electron-forge package → out/ (a platform .zip via maker-zip)
```

The package is self-contained: the main and preload processes are Vite bundles with the entire core (and its libp2p graph) **inlined** — externals are exactly `{ electron, node builtins }` — and the genesis ships inside the package as `dist/config/genesis.json` (a byte-identical copy of the repo genesis). No workspace `node_modules` is needed at runtime. The preload is emitted as `dist/preload.mjs` — Electron's ESM-preload scripts must use the `.mjs` extension (preloads ignore `"type": "module"`).

## Scripts

| Command | Where | What |
|---------|-------|------|
| `corepack pnpm build` | repo root | Core build: protocol codegen + `tsc`. |
| `corepack pnpm test` | repo root | Full workspace test suite (headless). |
| `corepack pnpm typecheck` | repo root | Core typecheck. |
| `corepack pnpm build` | `packages/app` | Clean emit → typecheck → renderer Vite → main Vite bundle → preload Vite bundle → genesis copy. |
| `corepack pnpm test` | `packages/app` | App suite (core-host parity, renderer, closing e2e, packaged-boot matrix). |
| `corepack pnpm package` | `packages/app` | `electron-forge package` → distributable zip in `out/`. |

## Architecture & documentation

- **The architecture spine** (the rule set for the codebase — decisions AD-1…AD-12): `_bmad-output/initiative-succinctcoin-ai/architecture-succinctcoin/architecture-succinctcoin.md`
- **Epic & story plans** (the full build history, 45 stories across 6 epics): `_bmad-output/initiative-succinctcoin-ai/epic-*/`
- **Deferred work** (known, deliberately-deferred items with dispositions): `_bmad-output/initiative-succinctcoin-ai/deferred-work.md`

Key design boundaries worth knowing before reading the code:

- **Single mutation path** — every state change goes through `applyBlock`; the rest of the core is read-only.
- **Chain-time only** — consensus uses the chain's own clock and deterministic draws; no `Date.now()` / `Math.random()` in the core.
- **Decimal money at two boundaries** — `big.js` appears only in the ledger's display conversion and the fee calculation; the wire and the store are integers.
- **Key material boundary** — the identity keypair lives in the app's main process; the renderer sees only peer IDs, status, and key-free signed artifacts.
- **Testability seam** — the network is a port; tests run the real core over `@libp2p/memory` under plain Node (no Electron spawn, no DOM, zero real sockets).

## Notes

- Network transports: the app boots on the real stack (tcp + noise + yamux over global IPv6; invite-first join, optional mDNS behind an env flag — see "Joining a network" above). Tests always run on `@libp2p/memory` (zero real sockets, AD-10); the memory transport is reachable only via explicit test injection.
- The node identity is currently a pinned seed; a per-install random seed is recorded deferred work.
- `electron-forge package` needs the Electron binary; a plain `corepack pnpm install` fetches it. (In this repository's CI/dev environment the download is skipped via `ELECTRON_SKIP_BINARY_DOWNLOAD`, so the package step is a local operation.)
