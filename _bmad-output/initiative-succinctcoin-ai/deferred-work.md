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


<!-- OPEN 2026-10-19 (ticket 9.5, epic-ipv6-invite-network closing): RELAY-TIER
     OPEN QUESTION. Since 9.1 the policy is IPv6-only global unicast end to
     end, which structurally excludes (a) IPv4-only peers and (b) v6 peers
     whose router firewall drops inbound (the common consumer-NAT64 case —
     outbound joins work, inbound never arrives). The join story absorbs (b)
     for the JOINER (an invite rides the reachable peer's outbound side), but
     a peer nobody can reach inbound still cannot SERVE as an entry point.
     Undecided: whether/when a community relay tier ships (libp2p circuit
     relay v2 is already in the dependency graph; dial-manual + assertDialable
     messages name this parking spot). Revisit when real-network field data
     (epic-real-network) shows inbound-blocked nodes hurting propagation. -->

<!-- DECISION 2026-10-19 (ticket 9.5): IPv4 IS NOT SUPPORTED — recorded, not
     an oversight. `isGlobalIp6Multiaddr`/`assertDialable` (SC-NET-1) reject
     /ip4 at announce, dial, and ingest; the discovery lint test bans /ip4
     literals in shipped src; wire-golden tests keep /ip4 fixtures only where
     bytes never pass the validator. Rationale: global v6 removes the
     double-stack address logic, matches the invite-first join design, and
     keeps the diversity floor (/64) meaningful. Reversal cost is HIGH by
     design (policy + validators + lint + epic-9 proofs), which is the point:
     any future dual-stack support must be an explicit architecture decision
     with its own relay/privacy analysis, not a policy tweak. -->


<!-- OPEN 2026-10-22 (post-9.5 user report): DEV-ONLY ANNOUNCE ALLOWANCE.
     The machine that reported "No invite yet forever" has no global IPv6 at
     all (fe80:: only, no v6 route) — the panel now SAYS so (b6d3679), but
     such a machine still cannot produce an invite or two-node-test the join
     flow: 9.5's SUCCINCTCOIN_ALLOW_LOOPBACK=1 relaxes ONLY dialing
     (assertDialable); announce stays strict by design (filterPolicyAddresses
     in node-loop). Undecided: whether to make that flag symmetric — under an
     explicit env allowance, let the app announce ::1 (loopback-only mesh on
     one machine, dev/test use) without touching default policy. Design bar
     if built: default-off per-call env read exactly like the dial side; the
     invite text itself must remain honestly non-routable (a friend dialing
     ::1 dials themselves — worth a UI warning); announce/ingest/bootstrap
     rows pin the flag boundary. Origin story plan: epic-ipv6-invite-network/
     story-invite-panel-tells-you-why-no-invite-ipv6-diagnos-plan.md ("NOT in
     scope"). -->
