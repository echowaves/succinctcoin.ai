# Deferred Work — initiative-succinctcoin-ai

<!-- RESOLVED 2026-10-03 (story 1.6): the `bench/bench.js` 120s-watchdog / exit-124 entry from
     `epic-platform-baseline/story-workspace-headless-test-harness-plan.md` is done — the sweep
     added `clearTimeout(watchdog)` + `process.exit(0)` after the results write (bench now exits 0
     in ~55s). Entry removed during the 1.6 review; kept here as a note only. -->

<!-- RESOLVED 2026-10-06 (story 3.5): the `createCore().start()` / `loadGenesis`
     boot-path gap (source: the 1.6 closing sweep, epic-platform-baseline) is
     resolved in code — `createCore().start()` now runs the real boot path
     (`store.open()` -> `loadGenesis` -> one `mineAndApply` loop block ->
     `CoreStarted`), with `loadGenesis` failing fast `SC-CONFIG-1` on a
     malformed/missing genesis BEFORE any block, emission flowing from the
     validated genesis, and `CorePorts.genesisPath` (default repo-root
     `config/genesis.json`) carrying the path. Pinned by
     `packages/core/test/boot-path.test.ts` (incl. the fail-fast order + resume).
     Kept here as a note only. -->

<!-- RESOLVED 2026-10-05 (story 2.6): the `toJson` `__proto__` drop is fixed — the
     write side (`toJson`, ledger.ts) AND the read side (`assertStateDocument`,
     file-chain-store.ts) now build their projections on `Object.create(null)`, so a
     reserved own-property id becomes a normal own property instead of hitting the
     `Object.prototype.__proto__` setter. Both are pinned by new tests
     (ledger.test.ts DECIMAL_JSON seam row + store-state.test.ts STORE_PROTO_ROUNDTRIP
     real close/open cycle). The earlier note that "the read side accepts it" was
     wrong — `assertStateDocument` had the same plain-object trap and dropped it too;
     that is why 2.6's forced deviation touched the store, not just the ledger. Kept
     here as a note only. -->

<!-- OPEN 2026-10-08 (story 4.9, deferred from 3.8): DRY-extract the shared
     big-endian byte helpers out of `src/consensus/pow.ts` and `src/consensus/draw.ts`
     into one shared module. The genuinely shared surface is `u64be` (identical in
     both); the big-endian byte→bigint reader is duplicated under DIFFERENT names
     (`beBytesToBig` in pow.ts, `bytesToBig` in draw.ts); `concat` is draw-only.
     DEFERRED — not done here: both are pinned AD-6/AD-7 modules with golden vectors
     and import-scan guards (2.5 no-float guard, 3.9 mining-path guard); `u64be`'s
     range guard throws each module's own `PowError`/`DrawError`, so a shared
     extraction would either duplicate those or risk the guards. Defer to a
     dedicated byte-helper sweep or epic 5 (which touches the wire path). Recorded
     at the 4.9 sweep; no code change. -->

<!-- 2026-10-14 OPEN (story 6.4 — carried items, disposition per the plan §3.4;
     none of the four was in the 6.4 ticket `verify`):
     (1) F2 snapshot race in the 6.3 live hook (`useSuccinctcoin.ts`): a
     `CoreStarted`/`BlockApplied` firing while a snapshot is in flight yields
     two concurrent `buildInitialSnapshot` calls; the later-RESOLVING wins.
     Benign — each snapshot reads the current read-API state and the next
     event self-corrects. The 6.4 e2e drives the reducer with a synchronous
     event feed (no concurrent snapshot calls) and was NOT flaky (5
     consecutive green runs), so the optional sequence guard is NOT added.
     DEFERRED.
     (2) The 6.2 F2 genesis-path fix (thread the app's `genesisPath()` into
     `host.start()`): RESOLVED 2026-10-15 (plan-packaged-app-boot): the app
     build now copies the repo `config/genesis.json` into
     `packages/app/dist/config/genesis.json` BYTE-IDENTICAL (the build's
     last step, `scripts/copy-genesis.mjs`), `index.ts`'s `genesisPath()`
     resolves that bundled copy (ONE level up from `dist/main/`), and it is
     threaded into EVERY `host.start` call — the gate registry AND the
     core's boot read the one single source; the core's independent default
     (repo root — NOT in the package) is never relied on (the core is
     UNTOUCHED). Pinned by `packages/app/test/packaged-boot.test.ts`
     (GENESIS_COPY / BOOT_FROM_BUNDLED / PATH_THREADED / MISSING_GENESIS).
     The plan's renegotiated problem statement also names a THIRD boot
     blocker: the ESM preload emitted as `dist/preload.js` — Electron ≥ v28
     parses preloads as CJS (they ignore `"type": "module"`), so the bridge
     never loaded; the emit is now `dist/preload.mjs` (the Electron
     ESM-preload rule) and loaded via `../preload.mjs`.
     (3) Per-install random identity seed (`node:crypto` `randomBytes(32)`
     persisted to `userData`): a real feature (randomness + persistence)
     not in the 6.4 verify — the pinned 32-byte seed (AD-3, key in main)
     stays. DEFERRED.
     (4) Real net transport config choice (tcp+noise+yamux): re-reviewed
     2026-10-15 (plan-packaged-app-boot) — STAYS DEFERRED: still a
     production-deployment concern; `@libp2p/memory` stays the testnet
     default (AD-10); the packaged-app work does not change the transport
     choice. **LIFTED 2026-10-16 → epic `epic-real-network`** (user report:
     LAN peers cannot find each other — the app's `transport: 'memory'` pin
     is the root cause; AD-10 constrains tests/CI, not the app runtime).
     3 stories: 7.1 empty-bootstrap genesis + validation relaxation + join
     docs, 7.2 app selects tcp + mDNS + genesis bootstrap (pure seam),
     7.3 two-instance LAN proof (hitl). Mark this item RESOLVED when 7.3
     completes.
     6.4 F2 blockers note (what kept `electron-forge package` from
     actually running) — dispositioned 2026-10-15 (plan-packaged-app-boot):
     blocker (b) — the `workspace:*` core dep unresolvable outside the
     workspace (pnpm's strict layout, the core's deps all devDependencies)
     → RESOLVED: the main + preload bundles INLINE the whole core graph
     (the vite node/ssr builds, `ssr.noExternal: true` +
     `ssr.external: ['electron']` — bundle externals are exactly
     {`electron`, node builtins}); the package needs no workspace
     node_modules (pinned by BUNDLE_SELF_CONTAINED). Blocker (c) — the
     third boot blocker the 6.4 note did not name: the ESM preload in a
     `.js` file (parsed as CJS by Electron ≥ v28 → `window.succinctcoin`
     undefined, the renderer's data source dead while main booted and
     mined) → RESOLVED by the `dist/preload.mjs` emit + the
     `../preload.mjs` load. Blocker (a) — the install-skipped electron
     binary (`ELECTRON_SKIP_BINARY_DOWNLOAD`) → remains the SOLE residual
     for actually running `electron-forge package` + launching the `.app`;
     the gates prove the package's module graph is self-contained (the
     bundle scan) and the boot inputs are real (the bundled-genesis rows). -->

<!-- RESOLVED 2026-10-17 (ticket 8.1 built; opened 7.2 review): the pinned `IDENTITY_SEED`
     (6.2 — AD-11, per 6.2(3)'s deferral) makes EVERY install derive the
     SAME identity keypair. Harmless while every instance was its own
     memory network; now that ticket 7.2 puts instances on a real LAN it is
     load-bearing: the node-loop's accepted-ticket set dedupes by
     `identityId` (keep-first, local first), so two instances each drop the
     other's gossiped tickets as same-identity duplicates — peer discovery
     and block gossip work, but ticket interplay does not. Blocks the full
     R2 observation in 7.3's two-instance proof until a per-install random
     seed lands (reversing 6.2(3) is a human-owned call: it touches the
     pinned AD-11 seed decision + its test pins). Evidence: consensus/
     node-loop.ts step 6 (`raw = [localTicket, ...gossiped]` dedupe) vs the
     constant seed in app/main/index.ts.
     UPDATE 2026-10-17: RATIFIED + SCHEDULED — the user's go-ahead authorized
     reversing 6.2(3); implemented as ticket 8.1 of epic-bootstrap-free-discovery
     (per-install random seed persisted in userData). This entry goes RESOLVED
     when 8.1 builds.
     BUILT 2026-10-17 (ticket 8.1): `app/main/identity-seed.ts` — per-install
     random seed (`crypto.getRandomValues`, startup key generation only; AD-3's
     no-RNG rule is consensus-scoped) persisted at `<userData>/identity.seed`
     (lowercase hex, mode 0600, atomic temp+link so concurrent first boots
     converge on one seed; corrupt file throws rather than re-roll).
     `index.ts` boot loads it — the constant seed is gone, pinned absent by a
     scan over every src/main source. Headless rows (injected tmp dirs, no
     electron spawn): `packages/app/test/identity-seed.test.ts` (6). -->


<!-- SHIPPED 2026-10-20 (epic 10, stories 10.1–10.3): RELAY TIER. Planned
     2026-10-19 as EPIC-reachability-tier; now built end to end:
     AutoNAT reachability truth — announce never lies (10.1, announceFilter
     on the wire path + adapter honesty view); volunteer circuit-relay v2
     seeds — config list, default EMPTY (10.2: SUCCINCTCOIN_RELAY_SEEDS,
     bounded holds, loss re-hold, circuit addresses through every policy
     boundary); DCUtR punching over live relay connections, tcp-only and
     unconditional (10.3), which also shipped the volunteer server role as
     config: SUCCINCTCOIN_RELAY_SERVER=1 runs the 5.7 relay. The IPv6-only
     invariant survived untouched: a circuit address's relay hop must itself
     be a global /ip6 — HOLDING a seed is dialing one, so an inbound-blocked
     peer needs outbound v6 and an IPv4-only peer stays unserved BY DESIGN
     (DECISION entries below — the relay's operator being dual-stack is how
     such a peer joins, on THEIR side).
     Proofs: core relay-seeds.test.ts (headless memory) + dial-manual.mjs
     relay trio (relay-new / node-behind / invite-use-through-relay, live
     on loopback). README "Reachability ladder" documents it. STILL PARKED
     here: (a) any OFFICIALLY operated relay endpoint — the network ships
     zero default seeds [DECISION 2026-10-22 (user, Correct Course): stays
     parked PERMANENTLY — the project operates NO relay; a single operated
     endpoint is a single point of failure. DEFAULT_RELAY_SEEDS ships empty
     by design (seam + pinned-empty guard from 11.3); volunteer seeds via
     env or future community curation only];
     (b) operator INCENTIVES for volunteers (open spec
     question, not a build blocker); (c) gossip-based RELAY ADVERTISEMENT
     — how peers learn seeds without out-of-band sharing stays unsolved
     by design; discovery only ever verifies addresses, never registers
     relays. -->

<!-- DECISION 2026-10-19 (ticket 9.5): IPv4 IS NOT SUPPORTED — recorded, not
     an oversight. [SUPERSEDED IN PART 2026-10-22 by epic 11 / CAP-8: a
     GLOBAL /ip4 is admitted as the circuit-relay HOP segment only — direct
     addresses stay strict global v6; see the UNIVERSAL DIALABILITY entry
     below. The reversal-cost design held: it took a spec amendment + its
     own epic, not a policy tweak.] `isGlobalIp6Multiaddr`/`assertDialable` (SC-NET-1) reject
     /ip4 at announce, dial, and ingest; the discovery lint test bans /ip4
     literals in shipped src; wire-golden tests keep /ip4 fixtures only where
     bytes never pass the validator. Rationale: global v6 removes the
     double-stack address logic, matches the invite-first join design, and
     keeps the diversity floor (/64) meaningful. Reversal cost is HIGH by
     design (policy + validators + lint + epic-9 proofs), which is the point:
     any future dual-stack support must be an explicit architecture decision
     with its own relay/privacy analysis, not a policy tweak. -->


<!-- SHIPPED 2026-10-20 (post-9.5 user report): DEV-ONLY ANNOUNCE ALLOWANCE.
     The machine that reported "No invite yet forever" has no global IPv6 at
     all (fe80:: only, no v6 route). SUCCINCTCOIN_ALLOW_LOOPBACK=1 is now
     SYMMETRIC: isDialableMultiaddr/filterDialableAddresses (the boolean twin
     of assertDialable) drive announce construction + bootstrap filtering, so
     such a machine announces its ::1 listener and runs the real join flow on
     ONE box. Consensus-safety invariant (code-review BLOCKER fix): record
     VALIDATION is context-gated, NOT env-gated — only NON-consensus ingest
     (gossip receive, invite verify, book ingest, boot-file load) passes
     ctx.allowLoopbackAddresses from loopbackAnnounceAllowed(); block
     candidates, apply-block and introductions production validate STRICTLY
     always, so a ::1 record can never enter a block and flagged/unflagged
     node mixes cannot fork over chain data. fe80/ULA/v4/zones stay rejected
     with the flag set (incl. zone-scoped ::1); all-hop-::1 circuits verify
     only under the dev ctx (same-machine relay shape, pinned). UI honesty:
     describeLoopbackInvite warns when an invite exists while no global IPv6
     is present — dev-loopback OR stale, both readings stated. Live proof
     (invite from the real announce source → full shipped verifyInvite →
     dial → mutual peers) PASSed on this machine; boundary rows pin every
     seam. Plan: epic-ipv6-invite-network/
     story-dev-only-announce-allowance-loopback-dev-mesh-plan.md. -->


<!-- DECISION 2026-10-19 (user connectivity review): UPnP PORT MAPPING IS NOT
     SUPPORTED — recorded, not an oversight. UPnP/IGD port mapping is an
     IPv4-NAT technology: on IPv6 there is no NAT to map through, and the
     inbound blocker on consumer routers is the stateful firewall + missing
     prefix/NDP delegation, which IGD does not manage (v2 "PIN6" exists on
     paper only). @chainsafe/libp2p-upnp could at best hand us a /ip4
     address our policy rejects. The clean IPv6 answers to "make me
     dialable" remain: router firewall setting, relay tier (epic 10), or
     DCUtR punching. Reversal requires an explicit dual-stack architecture
     decision — same high bar as the IPv4 decision above. -->

<!-- DECISION 2026-10-19 (user connectivity review): WEBRTC / QUIC /
     WEBTRANSPORT TRANSPORTS ARE NOT SUPPORTED (yet). Attractive because a
     WebRTC multiaddr IS its own signalling data (fits invite-over-SMS),
     but ICE must still get UDP through the same firewalls, and where it
     cannot, WebRTC's own fallback is TURN — i.e. a relay we would build
     twice (circuit relay v2 is already shipped + in epic 10). QUIC means
     WebTransport in js-libp2p (no raw QUIC): same UDP/policy tax (a new
     address family through assertDialable, /64 floor, lint) for no user-
     visible win over tcp+relay+punching. Revisit ONLY if epic 10's field
     data shows DCUtR punch rates disappointing on TCP — then re-evaluate
     WebRTC-direct as a second transport, not a replacement. -->

<!-- DECISION 2026-10-20 (ticket 8, headless runner): THE RUNNER IS A FLAG/ENV
     SHELL, NOT A DAEMON MANAGER — recorded, not an oversight. `run-node.js`
     takes argv + the app's existing env knobs and nothing else: NO config file
     (a second configuration surface would disagree with genesis.json/env and
     force a precedence debate), NO service installer (`systemd`/launchd units
     are ops opinion; the README ships one unit to copy instead of generating
     it per-distro), NO key import/export/wallet commands (the identity IS
     `<data-dir>/identity.seed`; moving a node means pointing `--data-dir` at
     the desktop app's userData directory, which is byte-for-byte the same
     layout — copying that one 0600 file is the whole migration story). Also
     NOT added: log rotation (a supervisor owns the journal), PID files, and a
     status RPC — a headless node's interface is stdout + exit code, and both
     are pinned by tests. Revisit when an actual fleet exists (multiple relays
     to operate) rather than for one machine. -->

<!-- OBSERVATION 2026-10-20 (ticket 8): ON A PUBLIC HOST, `reachability` CAN
     READ `unknown` FOR A RELAY. AutoNAT probes come from other peers; a
     freshly-booted VPS may have none yet, so boot prints `unknown` while the
     machine is in fact dialable — and `--relay` serves anyway (the auto-relay
     policy from ticket 7 withholds service ONLY on a learned `unreachable`).
     Nothing to fix in code; operators should read that line as "not yet
     observed", and the `[boot] dial me:` line — which comes from the real
     listen addresses, not from probing — is the authoritative answer to "am I
     dialable". -->

<!-- DECISION REVERSED 2026-10-21 (ticket 7, auto-relay): SERVING IS AUTO-
     MATIC WHEN REACHABLE, AND THE PEERBOOK IS THE RELAY DIRECTORY. Two epic-
     10 records are superseded. (1) "the volunteer server role as config:
     SUCCINCTCOIN_RELAY_SERVER=1" — serving is now ON by default for every
     node whose probes do NOT say `unreachable` ('unknown' serves; the flag
     remains as force-on). (2) STILL PARKED item (c), "gossip-based RELAY
     ADVERTISEMENT ... stays unsolved by design" — solved WITHOUT a new wire
     protocol: identify already tells us which direct peers advertise the
     Circuit Relay v2 hop service, so an unreachable node picks up to 3
     candidates deterministically from its own peerbook (sorted PeerIds, all
     nodes converge; MAX_AUTO_RELAYS=3). Rationale for both: the ladder was
     rung 3 existentially useless — relay capacity existed (every reachable
     node) and reachability truth existed (AutoNAT), but wiring them needed a
     human to copy multiaddrs through a forum. NOT reversed: (a) zero OFFICIAL
     endpoints/default seeds (relays are incidental, not operated); (b) relay
     operator incentives (still an open spec question); IPv4-stays-unserved;
     the /ip6-hop rule. Kill switch: SUCCINCTCOIN_RELAY_AUTO=0 → byte-
     identical pre-ticket behavior (seeds only). Known limits pinned by tests:
     serving is decided at construction (a node that LATER measures unreach-
     able keeps its server — SERVES_WHEN_UNREACHABLE row; CircuitRelayServer's
     start/stop are undeclared on the pipeline object, and a mid-run toggle
     would strangle circuits already riding it), and held auto circuits are
     not force-released when reachability returns (the reservation store has
     no release API; TTLs expire them). -->

<!-- SHIPPED 2026-10-22 (epic 11, stories 11.1–11.3 + 11.5; 11.4 DROPPED
     BY DECISION — see below): UNIVERSAL DIALABILITY (CAP-8). The hop law: a /p2p-circuit address may
     carry a GLOBAL-scope HOP of EITHER family (/ip4 admitted for the first
     time — direct addresses stay strict global v6, byte-identical); ONE
     predicate module (address-policy.ts) owns every boundary — record,
     seed, dial-target, announce (11.1, 2982833). The adapter dials v4
     seeds, holds reservations, and flows held circuits through gossip/
     invites/books under the record law; direct /ip4 never announces or
     dials (11.2, e96af47; loopback-family circuits dial under
     SUCCINCTCOIN_ALLOW_LOOPBACK=1 only). Seed seam: DEFAULT_RELAY_SEEDS
     (pinned EMPTY) + mergeRelaySeeds + the [boot] relay HOLD/FAIL (v4|v6)
     boot line + hop-aware discovery lint + operator runbook
     (docs/relay-runbook.md) (11.3, 8d28e41). Honest Boot Proof
     (packages/core/test/honest-boot-proof.test.ts): a v4-only host boots,
     holds, announces EXACTLY its circuit (exact-set leak pin), is dialed
     through the hop, and exchanges chain-level gossip BOTH ways; dual-
     stack unchanged-shape variant green. Live shape: dial-manual.mjs
     relay-new-v4 trio on one machine. Seed FORMAT resolved as a side
     quest: seeds are IP-form multiaddrs — /dns names are rejected by the
     seed law (first IP must be global scope); domain records serve humans,
     not the wire. DECISION (2026-10-22, user,
     Correct Course — change-remove-relay-spof): the project operates NO
     relay — 11.4's provisioning dropped as a single point of failure.
     DEFAULT_RELAY_SEEDS is empty BY DESIGN (pinned-empty test = permanent
     invariant guard); join rides invitation + auto-relay, operators pin
     volunteer IP-form seeds via env. Epic 11 COMPLETE: 11.1/2/3/5 built,
     11.4 dropped. -->

<!-- OPEN 2026-10-21 (story 11.2, PCL-1): MANUAL TRIO TEARDOWN RACE (v6).
     dial-manual.mjs `relay-new` exits the moment it counts two peers, which
     tears the circuit down before `node-behind`'s next 1.5 s poll can observe
     the arrival — an automated trio driver lost that race 12/12 on THIS
     machine for both the classic v6 trio and the new v4 trio. The v4 mode
     (`relay-new-v4`) gained a 20 s post-SERVED settle and passes reliably;
     `relay-new` was left untouched (frozen manual surface). Fix = same settle
     in `relay-new` (or make node-behind print arrival synchronously), then
     the driver can prove both trios unattended. Manual runs with human-paced
     polling never hit it. -->
