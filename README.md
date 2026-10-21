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
corepack pnpm test        # the full workspace test suite (516 tests / 69 files)
corepack pnpm typecheck   # core typecheck
```

The root `test` runs every package's suite: the core's 445-test suite (58 files) plus the app's 61-test suite (10 files). The app's packaged-boot rows are self-sufficient — they build what they scan — so a fresh `install → build → test` is all that's needed.

## Run the desktop app

```sh
cd packages/app
corepack pnpm build       # clean → typecheck → renderer → main bundle → preload bundle → node runner → genesis copy
corepack pnpm exec electron .
```

On boot the app opens the window, loads the bundled renderer, and **auto-starts the node and mining** — the UI shows blocks being mined, balances, and peers (driven by the event stream, never polling). The chain is persisted under Electron's `userData` directory. The node runs on the real network stack (tcp + noise + yamux, IPv6-only); joining rides invitations, not multicast — see "Joining a network" below.

## Run a node without the app (headless / VPS)

The same node, minus Electron. `dist/node/run-node.js` is a plain-Node bundle of the **real** boot path — `createCoreHost`, the tcp/noise/yamux transport, the discovery ladder, the file chain store — and nothing else: no Electron import anywhere in it (the packaged-boot suite pins that bundle too, and holds it to a stricter rule than the app's own bundles — node builtins only). It exists for machines that are always on and dialable, which in practice means an IPv6 VPS: a home box cannot be dialed (see "Joining a network"), so the machine that holds the line for a group belongs in a datacentre.

```sh
cd packages/app
corepack pnpm build                       # also emits dist/node/run-node.js
node dist/node/run-node.js --data-dir /srv/succinctcoin
#   --listen-port <n>            override SUCCINCTCOIN_LISTEN_PORT
#   --genesis <path/genesis.json> default: bundle's own dist/config/genesis.json
#   --relay / --no-relay         volunteer as a circuit relay, or refuse to
#                                (else SUCCINCTCOIN_RELAY_SERVER=1)
#   --no-mine                    apply blocks only, never race for one
```

The log is the operator interface, and it is honest about reachability — on a machine without a global address it says so rather than pretending:

```
[boot] identity 084269cd… data-dir /srv/succinctcoin
[boot] dial me: /ip6/2001:db8:…/tcp/4001/p2p/12D3Koo…   ← what hidden nodes dial through
[boot] reachability unknown                              ← AutoNAT has not probed yet; "dial me" is the fact
[discovery-ladder] {"mdns":false,…}                      ← how this node found its way
[mined] 1 blocks, head slot 1 winner 084269cd…           ← heartbeat: first block, then every 25th
[boot] to invite a friend, send them exactly:
scinvite:v1:…                                            ← THE invitation to hand out, printed once
```

Two lines are easy to confuse: `dial me:` is a raw multiaddr — the **relay seed** you share with firewalled nodes (`SUCCINCTCOIN_RELAY_SEEDS`); `scinvite:v1:…` is the signed **invitation** a new node joins with. Reachability prints `unknown` at boot because AutoNAT has had no time to probe yet; it is not a claim that the machine is unreachable — the listen addresses above it are.

(No global address → `[boot] no dialable (global IPv6) listen address yet` plus the v6 interface classification. Mining is throttled to one line per 25 blocks so a server journal stays readable; `SIGINT`/`SIGTERM` stops the core and exits cleanly, and a second signal exits immediately.)

**Keeping it running** (`systemd`; the unit restarts on crash, and an address change after a VPS reboot only needs a restart — the identity survives):

```ini
# /etc/systemd/system/succinctcoin-node.service
[Unit]
Description=SuccinctCoin node
After=network-online.target
[Service]
User=succinctcoin
ExecStart=/usr/bin/node /srv/succinctcoin-app/dist/node/run-node.js --data-dir /srv/succinctcoin
Restart=always
RestartSec=5
[Install]
WantedBy=multi-user.target
```

Two facts worth knowing before the first boot. The node's identity is `<data-dir>/identity.seed` — 64 hex characters, mode `0600`, created on first boot and never logged; **back that file up**, because deleting it means a different node (and an unspent ticket does not move). And when the node finally has a dialable address it prints its own invitation exactly once — `to invite a friend, send them exactly:` followed by the one-line `scinvite:v1:…` — so with `systemd` that line is in `journalctl -u succinctcoin-node`, and there is no need to open a UI to read it. (`<data-dir>/invite.txt` is the **inbound** file — invitations *this* node should join, one per line. It is not your invite: never write your own into it.) `--relay` force-serves relay hops even if the machine's own probes say it is unreachable (a reachable machine already serves automatically); boot prints its dialable multiaddr, peer id included, and *that line* is what hidden nodes can put in `SUCCINCTCOIN_RELAY_SEEDS`.

The runner writes exactly what the desktop app writes (`identity.seed`, `chain/blocks/`, `chain/state/`, plus the `chain/.lock` holder file), so pointing `--data-dir` at the app's userData directory **continues that node** — same identity, same chain — on a machine with no display. That is also how a home node hands its identity over to a VPS instead of becoming a second node by accident. One directory, one writer: the lock is exclusive, so if the desktop app is still running the runner refuses to boot (`SC-STORE-1`) rather than corrupting it — stop one before starting the other.

## Joining a network

**Direct addressing on this network is IPv6-only.** Nodes announce and dial global-unicast `/ip6` addresses over TCP; a *direct* `/ip4`, ULA (`fd00::/8`) or link-local (`fe80::/…`) address is rejected by the address policy at every boundary (announce, dial, ingest). An IPv4-only machine still joins — but only **through a relay hop**, whose address may be `/ip4` or `/ip6` (see "Reachability ladder" below). Two practical caveats:

- **Inbound needs a route.** Your node listens on all interfaces, but home routers rarely advertise your global v6 address via NDP and stateful firewalls/NAT64 middleboxes (consumer routers — Norton-class ones in particular) can silently drop *inbound* v6 connections even when outbound works. Outbound joins always work; that is exactly why joining rides an **invitation**, not a public listen port.
- **Inbound blocked but outbound works?** The relay tier still carries you, and since epic 10 it carries you **automatically**: a node that measures itself unreachable holds circuits through up to three reachable peers that advertise the relay service, with no configuration. `SUCCINCTCOIN_RELAY_SEEDS` remains for pinning specific relays — env seeds merge **additive after** the built-in default list, and that list (`DEFAULT_RELAY_SEEDS`) ships **empty** today, so until a release provisions it this env var is the channel — see "Reachability ladder" below. (You still need working *outbound* connectivity. A machine with **no** IPv6 at all — pure IPv4 — is served too, THROUGH a relay hop: it dials out to a dual-stack relay and holds a circuit, so its invite starts `/ip4/…` or `/ip6/…` and runs through `/p2p-circuit`. Until seeds ship by default, point `SUCCINCTCOIN_RELAY_SEEDS` at such a relay. Direct `/ip4` addresses are still never announced or dialed.)

### Join with an invitation (the primary path)

1. **Generate** — the running node shows its own invite in the app (the *MY INVITE* panel; the same string lands in `<userData>/invite.txt`-compatible form). It is one line: `scinvite:v1:…`. If it never appears, the panel says why — it classifies this machine's IPv6 interfaces (link-local only, VPN-overlay `fd00::`, or no IPv6 at all) so a missing invite reads as a network fact, not an app bug.
2. **Send** — pass that line to the joining person any way you like (it is public data, already signed).
3. **Paste** — on the new machine, paste it into the *JOIN* panel (or write it as one line into `<userData>/invite.txt` before first boot). The app verifies it fully — signature, chain id, and ticket liveness of the inviter against applied blocks — **before dialing anything**, then dials through it and lets the peer-book crawl fill out the rest of the network (bounded: depth ≤ 3, book ≤ 100 entries, ≥3 distinct /64s by design).

A wiped machine with an empty config needs nothing else: one verified invitation is a proven complete join (the amnesiac-invite boot proof runs it headless in CI). For the manual two-machine version see `_bmad-output/initiative-succinctcoin-ai/epic-real-network/dial-manual.mjs` (`invite-new` / `invite-use`); single-machine loopback proofs set `SUCCINCTCOIN_ALLOW_LOOPBACK=1` on both commands — an explicit, default-off **dev** exemption: with it a machine that has no global IPv6 at all may announce, relay, verify and dial pure-`::1`, and loopback-family **relay hops** (`::1` or `127/8` before `/p2p-circuit`) are dial-side-allowed; the announce/record law is unchanged — a `127/8` hop never enters a record (everything else — `fe80::`, ULA, *direct* IPv4, zones — stays rejected exactly as before). Such an invite is honest but local: a friend dialing `::1` reaches their own machine, never yours, and the app panel says so. Consensus paths ignore the flag entirely — loopback records can never enter a block.

### Reachability ladder

Every node climbs the same four rungs, automatically and in order — each one only kicks in where the previous one leaves off:

1. **Direct TCP over global IPv6** — the happy path, what an invitation carries.
2. **AutoNAT honesty.** A probe tells each node whether it is actually reachable from the outside; a node that learns it is *not* stops advertising the dead address (and re-advertises if reachability returns). Peers never get lied to, so nobody wastes dials on addresses that cannot answer.
3. **Circuit relay — zero config.** A node whose *inbound* is blocked (firewall, router — but whose outbound IPv6 works) holds relayed connections and advertises its circuit address alongside — or instead of — its direct one. It picks the relays itself: once a probe says *unreachable*, the node offers to hop through up to three of the peers it is **directly** connected to that advertise the Circuit Relay v2 service (a deterministic sorted pick, so all nodes converge on the same small set instead of stampeding one machine), retrying every fifteen seconds until a circuit holds, and standing down when reachability returns. `SUCCINCTCOIN_RELAY_SEEDS` (comma-separated relay multiaddrs carrying `/p2p/<relayId>`, a `/ip6/…` or `/ip4/…` hop) stays as a manual **additive** override, merged after the shipped default list (empty today — `DEFAULT_RELAY_SEEDS`) and deduped — pinned seeds are held alongside the automatic ones and re-held on drop; `SUCCINCTCOIN_RELAY_AUTO=0` turns the automatic half off, back to seeds-only. The relay hop itself is one **global** address of either family — `/ip6` or `/ip4` (the 2026-10-21 dual-stack-hop amendment): this is how *unreachable* peers join, and since the amendment also how *IPv4-only* ones do — pin a dual-stack relay in `SUCCINCTCOIN_RELAY_SEEDS` and the invite runs `/ip4/…` or `/ip6/…` through `/p2p-circuit`.
4. **DCUtR hole-punching.** Peers connected only *through* a relay keep trying to punch a direct connection between themselves; where both firewalls allow it, the relayed link silently upgrades to direct. No configuration — it rides the relay connections you already have.

**Serving as a relay.** Any node whose probes say it is *reachable* serves relay hops automatically — no flag, no opt-in; an open port is the only qualification, and the cost to a home node is small. `SUCCINCTCOIN_RELAY_SERVER=1` force-serves on a node even when its own probe says otherwise; its boot log then prints its dialable multiaddr, peer id included — that whole line **is** a seed you can share out-of-band (a forum, a group chat) for hidden nodes to pin in `SUCCINCTCOIN_RELAY_SEEDS`. There is still deliberately **no official relay endpoint**: relays are just whichever peers happen to be reachable, discovered through the peerbook — direct connections already carry whether each peer advertises the hop service, so no new wire protocol was needed. The end-to-end circuit path has a manual proof: `dial-manual.mjs` modes `relay-new`, `node-behind <seed>`, and `invite-use-through-relay <scinvite>` (one machine under `SUCCINCTCOIN_ALLOW_LOOPBACK=1` is enough).

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
| `corepack pnpm build` | `packages/app` | Clean emit → typecheck → renderer Vite → main Vite bundle → preload Vite bundle → headless runner bundle → genesis copy. |
| `corepack pnpm start:node` | `packages/app` | Run the headless node (plain Node, no Electron) — needs `--data-dir`; see "Run a node without the app". |
| `corepack pnpm test` | `packages/app` | App suite (core-host parity, renderer, closing e2e, packaged-boot matrix, headless runner). |
| `corepack pnpm package` | `packages/app` | `electron-forge package` → distributable zip in `out/`. |

## Architecture & documentation

- **The architecture spine** (the rule set for the codebase — decisions AD-1…AD-12): `_bmad-output/initiative-succinctcoin-ai/architecture-succinctcoin/architecture-succinctcoin.md`
- **Epic & story plans** (the full build history, 62 story plans across 10 epics): `_bmad-output/initiative-succinctcoin-ai/epic-*/`
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
