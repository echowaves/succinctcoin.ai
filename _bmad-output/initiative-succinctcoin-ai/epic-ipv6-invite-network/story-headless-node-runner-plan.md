---
id: headless-node-runner
status: built
epic: epic-ipv6-invite-network (operator-infrastructure follow-on)
title: Headless node runner — run a mining node on plain Node (VPS), no Electron
---

# Headless node runner — plan

## The operator problem

The reliable way to be dialable is an always-on host with native IPv6 (the
operator has no router control; this laptop has no v6 at all). Two facts make
that impossible today: the only node entry point is Electron's main process,
and mining rewards **uptime** — a laptop that sleeps earns nothing. Running
Electron under Xvfb on a server works but drags window machinery + GUI deps
into an always-on miner. Recorded gap (raised in the reachability discussion,
never ticketed): there is no CLI runner.

## Design — reuse everything, add only the shell

The app's main path was built electron-free on purpose (AD-1): `createCoreHost`,
`defaultNetConfig`, `buildDiscoveryPorts`, `loadOrCreateIdentitySeed`,
`inviteDiagnostics` all take their platform inputs as PARAMETERS. So the runner
is a thin sibling of `index.ts`, not a new implementation:

`packages/app/src/main/run-node.ts` — electron-free, exports
`runNode(opts): Promise<NodeRunHandle>`:

1. `loadGenesis(opts.genesisPath)` → gates + bootstrap (ONE genesis source, as
   everywhere else).
2. `loadOrCreateIdentitySeed(opts.dataDir)` → `deriveIdentityKeypair`. Same
   file format/permissions as the app ⇒ **an existing `<userData>/identity.seed`
   can be copied to a server and the identity is identical**.
3. `createNetAdapter(defaultNetConfig(genesis, identityId, {listenPort,
   extraBootstrap, mdns, relaySeeds, relayServer}))` — the SAME env knobs as
   the app (`SUCCINCTCOIN_LISTEN_PORT`, `_MDNS`, `_RELAY_SEEDS`,
   `_RELAY_SERVER`) plus `<dataDir>/bootstrap.txt`, so operator docs stay
   single-sourced.
4. `FileChainStore(<dataDir>/chain)` + `createOfflineGateVerifier`.
5. `buildDiscoveryPorts({platform, env, userDataDir}, () => net.listenAddresses(),
   undefined, onSelfInvite)` — the full ladder (invite/hints/artifact rungs)
   works headless with no changes.
6. `forwardEvent` → an injectable `log` sink (the app's is `webContents.send`).
7. Returns a handle `{ host, stop() }`; the CLI wrapper (`src/main/cli/run-node.ts`)
   adds argv parsing, `[boot]` lines, and SIGINT/SIGTERM → `stop()` → exit.

**Operator-visible output** (journalctl-friendly, every line through the ONE
injected `log` sink — including the ladder report, which defaults to
`console.info` and would otherwise bypass it; all key-free per AD-11):
`[boot] identity <id8>… data-dir …`; `[boot] dial me: <global v6 addrs>` (or
`no dialable (global IPv6) listen address yet` + the interface-class COUNTS as
JSON from `inviteDiagnostics` — counts, not the renderer's prose sentence; the
renderer module stays unimported by main); `[boot] reachability <state>` (reads
`unknown` at boot — AutoNAT has not probed yet); `[discovery-ladder] {…}`;
`[boot] relay HOLD/FAIL …` (the adapter's seed events, wired exactly as the app
wires them — a hidden-node operator's only feedback); `[boot] to invite a
friend, send them exactly:` + the invite line, once; mining as a HEARTBEAT —
the first block then every 25th (`[mined] N blocks, head slot S`) because the
loop mints a block per poll tick and one line each would bury a journal;
`[stop] core stopped at slot N` (or bare, when the chain is empty). The boot
diagnostics deliberately run BEFORE `startMining()` so a journal opens with
"who am I / where am I", not block noise.

### Emission (no new build concept)

`vite.node.config.ts` → `dist/node/run-node.js` (`ssr` target, `noExternal:
true`, and NO electron external — there is no electron import in this graph to
externalize). `.js`, not the `.mjs` this plan first said: `packages/app` is
`"type": "module"`, so `.js` already parses as ESM (the preload needs `.mjs`
only because preloads ignore `"type"`). Same pipeline pattern as
`vite.main.config.ts`; `copy-genesis.mjs` already lands `dist/config/genesis.json`,
and the runner resolves genesis with the SAME relative expression main uses
(`../config/genesis.json` from `dist/node/` ⇒ `dist/config/`), overridable with
`--genesis`. New script: `"start:node": "node dist/node/run-node.js"`, and the
build script gains the extra vite step. The packaged-boot matrix now pins FIVE
artifacts, and the runner bundle is held to a STRICTER rule than the app's own:
import specifiers ⊆ node builtins — `electron` is not even allowed.

### Explicitly NOT in scope

- No new IPC/UI, no daemon manager (the story ships a systemd unit in docs; it
  does not install one).
- No config file format — env + files stay the operator surface (parity with
  the app; a second config system would be a second truth).
- No key import/export command: copying `identity.seed` is already the
  documented, atomic, verified format. Corrupt content throws (no silent
  re-roll) — unchanged.
- No auto-relay wiring (ticket 7's remaining slice).

## Tests (`test/run-node.test.ts`, plain Node + memory transport by explicit
injection per AD-10; tmp data dirs)

Shipped as `test/run-node.test.ts` (9 rows, all through the real `runNode`):

- RUNNER_BOOTS_AND_MINES: boot line, honest no-dialable line + interface
  counts, reachability line, the ladder report THROUGH the injected sink,
  ≥1 mined line, ordering (`[boot]` lines precede `[mined]`), heartbeat
  arithmetic (every logged count is a multiple of 25), blocks on disk under
  `<dataDir>/chain/blocks`, idempotent stop.
- RUNNER_IDENTITY_IS_PERSISTED: same dir ⇒ same `identityId`; other dir differs.
- RUNNER_INVITE_IS_REAL_DATA: the printed `scinvite:v1:…` verifies through the
  shipped `verifyInvite` and names this node's identity (needs `listenAs`:
  `/memory/…` is off-policy, so no announce — hence no invite — otherwise).
- RELAY_SEED_FEEDBACK: the config carries `onRelaySeed`, and HOLD/FAIL events
  land in the log.
- BOOT_FAILURE_CLEANUP: a second node on the same data dir rejects with
  `SC-STORE-1` AND stops the transport it had already built (0 leaks).
- RUNNER_LOGS_CARRY_NO_KEYS: AD-11 scan; the seed's text and a base64 rendering
  of its bytes appear nowhere; `identity.seed` keeps mode 0600.
- ARGV: flags override env in the BUILT config (port, relay role), `--no-relay`
  refuses an env-set role, junk/`--listen-port 0`/missing value die, defaults
  hold (`mine: true`).
- NO_MINE: an apply-only node holds genesis slot 0 and logs nothing mined —
  paired with a mining node in the same window so the silence cannot pass
  vacuously.
- NO_ELECTRON: source scan of both runner files + the package scripts.

## Docs

README: a "Run a node without the app (headless / VPS)" section — flags, the
log with each line explained (including `dial me:` = relay seed vs
`scinvite:v1:` = invitation, the confusion the review caught), a systemd unit,
the identity/backup rule, and the one-writer lock rule for taking over a
desktop node's data dir. deferred-work: two records — the runner is a flag/env
shell (no config file, no service installer, no key commands, no rotation/PID/
RPC) and the `reachability unknown` observation for public hosts.

## Build log

- Implemented as planned with three deltas, all review-driven:
  1. `.mjs` → `.js` (package is `"type": "module"`; see Emission above).
  2. Mining logs throttled to first + every 25th — one line per block would
     bury a server journal (the loop mints per poll tick, ~130 ms observed).
  3. Boot cleanup: everything after the adapter is built runs inside a
     try/catch that stops the transport before rethrowing. `FileChainStore`
     takes its exclusive lock in the CONSTRUCTOR, so the realistic failure
     (second process on the same dir) lands there with a live libp2p node
     behind it and no handle returned.
- Review (quick lens) findings fixed: adapter built without `onRelaySeed` (the
  plan promised HOLD/FAIL lines — unwired); ladder report bypassed the injected
  sink via its `console.info` default; boot diagnostics ran after mining
  started; signal handlers armed only after boot (systemd's SIGTERM during a
  slow boot was ignored, second signal had no force path); README claimed a
  bundle scan that did not exist (now it does — packaged-boot pins the runner
  bundle) and called `dial me:` "the invite seed" (it is the relay seed).
- Verified: root build/typecheck green; app `tsc` (both configs) clean; app
  suite 61/61 (10 files); core suite unchanged at 445 (58 files) — see the
  verification note below for the two loaded full-root runs. Suite totals:
  root 506/68 = core 445/58 + app 61/10. Live proof on plain Node (this machine, no global v6): boot lines in
  order, honest `no dialable` + `{"globalCount":0,…}`, heartbeat at 1/25/50,
  SIGTERM → `[stop] core stopped at slot 65`. Packaged-boot proves the bundle
  is emitted by `pnpm build` and imports node builtins only.
- Out of scope, recorded: config file, service installer, key import/export,
  log rotation/PID/status RPC (deferred-work.md).

### Verification note — the environment, stated plainly

Gates run green on this story's own surface: root `build` + `typecheck`, app
`tsc -p tsconfig.json` and `-p tsconfig.build.json`, app suite 61/61 (twice),
packaged-boot 5/5 with the new runner-bundle pin, and a live plain-Node run.

Two full root runs afterwards failed 8–11 heavy gossip/PoW rows in
`net-adapter`, `discovery-introduction-loop`, `ticket-tx-propagation`,
`invite-amnesiac-boot`, `circuit-relay-v2`, `epic-end-to-end`, `store-state`.
This commit changes ZERO files under `packages/core/` (`git diff --cached
--name-only` → 0) and those suites import nothing from `packages/app`, so no
code path reaches them; the failures are timing, and the machine explains them:
the resident inference server was holding ~88 GB RSS (66% of RAM), which puts
load average near 9 while CPU sits 85% idle — threads stalled on memory
compression. The same core suite ran 445/445 in 132 s earlier the same day, and
`net-adapter.test.ts` went fully green when re-run alone; a 4-test file that
normally takes seconds measured 913 s under the pressure. Recorded as an
environment flake (repo memory), not a regression.

