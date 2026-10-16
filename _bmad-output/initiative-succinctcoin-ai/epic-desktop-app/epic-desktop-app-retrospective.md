---
epic: epic-desktop-app
date: 2026-10-16
verdict: accepted-with-open-items
criteria: declared
headless: true
---

# Retrospective — epic-desktop-app

## Epic summary

**Epic:** `epic-desktop-app` (id 6) — "Desktop app: Electron shell, IPC bridge, React UI, packaging". Covers CAP-4 + CAP-6. Parent: `initiative-succinctcoin-ai`. Risk: medium.

**Tickets (build order, all finished — none unfinished; all four still at `built`, not yet marked `done` by a human):**

| ref | title | status | commit |
|-----|-------|--------|--------|
| 6.1 | Core: the running node (slot loop) + the UI data source (events + real read-API) | built | `6978bc0` |
| 6.2 | App: Electron shell + preload/IPC bridge (AD-11) + core-suite headless parity | built | `7661a89` |
| 6.3 | App: React renderer (balance, mining status, network peers) + the AD-11 renderer check | built | `53178f8` |
| 6.4 | App: electron-forge packaging + the closing end-to-end suite (full Done-when) | built | `42564e6` |

`pending_tickets`: empty. No story files (no ticket was refined — `story_file: null` for all four).

**Plan ranges (baselines from each plan's frontmatter; linear history, one commit per range, no merges, no binary churn):**

| plan | baseline → end | commits |
|------|----------------|---------|
| 6.1 `story-core-node-loop-ui-data-source-plan.md` | `53a9493` → `6978bc0` | 1 |
| 6.2 `story-electron-shell-ipc-bridge-headless-parity-plan.md` | `6978bc0` → `7661a89` | 1 |
| 6.3 `story-react-renderer-ad11-check-plan.md` | `7661a89` → `53178f8` | 1 |
| 6.4 `story-electron-forge-packaging-closing-e2e-plan.md` | `53178f8` → `42564e6` (inferred end, cut) | 1 |

Cut recorded: HEAD (`1ff084e`) postdates the epic's last ticket commit. The two later commits — `0bba993` (packaged-app boot fix; a separate user-requested plan `plan-packaged-app-boot.md` in the initiative folder, not an epic ticket) and `1ff084e` (README rewrite, docs) — are excluded from the epic ranges. They remain in scope for the Phase 2 behavior check only where the epic's Done-when is concerned (they repair, and do not alter, the epic's as-built state).

**Per-range change volume (git_evidence.py; non-merge files summed):**

- **6.1** — 9 files: core `node-loop.ts` +365, `events/types.ts` +73/−22, `index.ts` +168/−27, `ports.ts` +12, `consensus/index.ts` +11; tests `core-node-loop.test.ts` +637, `core-surface.test.ts` +31/−22, `identity-key-surface.test.ts` +13/−1; plan +136.
- **6.2** — 12 files: new `packages/app` — `main/core-host.ts` +145, `main/index.ts` +148, `main/ipc-channels.ts` +58, `preload.ts` +55, `preload.d.ts` +38, `renderer/index.html` +13, `package.json` +20, `test/core-host.test.ts` +365, tsconfigs +9/+7, `pnpm-lock.yaml` +111; plan +103.
- **6.3** — 14 files: renderer — `App.tsx` +117, `ui-state.ts` +163, `useSuccinctcoin.ts` +94, `main.tsx` +15, `renderer/index.html` +2/−3, `test/renderer.test.ts` +251, `vite.config.ts` +32, `vitest.config.mjs` +18, `main/index.ts` +11/−7, `package.json` +6/−1, tsconfigs +10/−2, `pnpm-lock.yaml` +68/−11; plan +211.
- **6.4** — 7 files: `forge.config.ts` +34, `test/epic6-end-to-end.test.ts` +572, `pnpm-lock.yaml` +1002/−10 (forge toolchain), `package.json` +4/−1, `main/index.ts` +11, `deferred-work.md` +22; plan +148.

**Evidence inventory:**

- Epic file — present (`epic-desktop-app.md`); **Done when is DECLARED** (5 criteria); the Notes record a source conflict resolved at inception (the core was not end-to-end runnable after epic 5 → story 6.1 landed the integrated slot loop in the core first).
- Initiative requirements — present (`initiative-succinctcoin-ai.md` §Requirements: CAP-1…CAP-6; the epic's R1/R2/R3 map to CAP-4, E1/E2/E3 to AD-1/AD-11/AD-9).
- Entries — all four `tickets.py find` entries read (description + verify + covers for each).
- Story files — none (no ticket refined).
- Plans — all four present, `status: built`, `review: quick` (pinned), `review_loop_iteration: 1`, `lenses_ran: ["quick"]`.
- Previous retrospective — none: `epic-node-network/` (the previous epic's folder) contains no `epic-node-network-retrospective.md`.
- Session logs — **absent**: no per-ticket session records exist for the epic's builds. Process-lesson analysis is therefore limited to what the plans themselves recorded (Review Triage Log / Plan Change Log sections). This is a recorded gap, not a "checked and clean."

## Findings

25 raw findings from the three lenses (adversarial 14, edge-case-hunter 6, verification-gap 5) consolidated by root cause into 11. Every item below was re-checked against the source at HEAD before routing. Dispositions: **fix now** = proposed remediation (action item); **defer** = tracked with context; **accept** = recorded so later retros stop re-flagging.

### Aggregate views (deterministic derivation)

- **Architecture delta — CLEAN.** AD-1 holds across all four tickets: zero `electron`/`react` imports in `packages/core/src` (grep, HEAD); electron imports in the app are exactly `src/preload.ts` + `src/main/index.ts`; the renderer imports neither `@succinctcoin/core` nor electron. The dependency graph gained one edge (`app → core`, workspace link) and no cycles; the core remains the leaf. No layering violation any single ticket tripped.
- **God-class / size growth — NONE.** Largest source file at HEAD is `packages/core/src/index.ts` (539 lines) — a 175-line `createCore` factory plus a 267-line public-surface re-export barrel (verified by structure grep), which is legitimate barrel + factory, not accumulation. The largest files overall are self-contained test files (`core-node-loop.test.ts` 637, `epic6-end-to-end.test.ts` 572, `packaged-boot.test.ts` 435) — the house convention.
- **Duplication map — one accepted deviation.** The app test harness (memory net + pinned seed + `FileChainStore` + `createOfflineGateVerifier`) is re-created in three test files (`core-host.test.ts`, `epic6-end-to-end.test.ts`, `packaged-boot.test.ts`) with no shared helper. The core's 38 test files follow the identical self-contained style (no helper module exists anywhere in `packages/core/test/`), so the duplication is the established convention, not drift. **Accept** — recorded so later retros stop re-flagging.
- **Pattern divergence — minimal.** One deliberate `throw` (`renderer/main.tsx:12`, missing-`#root` boot guard — a renderer invariant, not a consensus reject path) and one `console.error` (`main/index.ts:170`, boot-failure handler — the shell's only output sink). Test structure parity holds (single `describe` + matrix rows in all four app test files). **Accept.**

### Consolidated findings

**F-1 — The packaged artifact was never booted while the closing proof verified only the code path.** [adversarial #1, #2; edge-case #6 (claim); verification-gap #1, #2]
At the epic tip (`42564e6`) the packaged app could not boot, for three reasons: (a) `genesisPath()` (`main/index.ts:50-66` at the tip) resolved the repo-root `config/genesis.json`, which is not in the package; (b) `@succinctcoin/core: workspace:*` (`packages/app/package.json`) is a pnpm symlink unresolvable in the packaged app (core's deps are all devDependencies → the transitive libp2p graph is not in `packages/core/node_modules`); (c) the ESM preload was emitted as `dist/preload.js` and Electron ≥ v28 parses preloads as CJS → `window.succinctcoin` undefined → the renderer's data source dead while main booted and mined. The closing e2e (`epic6-end-to-end.test.ts:367-420`, E2E_FORGE_CONFIG_RESOLVES) proved Done-when #1 by static shape only (forge-config object, the `main` string, a source scan) — `electron-forge package` was never run and no test imported `src/main/index.ts` or `src/preload.ts`. The build KNEW: the 6.4 plan's own Review Triage Log (F2/F3) recorded "the packaged layout would crash at boot" as DEFERRED, and `deferred-work.md` (6.4 carried items, in the diff) carries it — yet the epic closed `built`. **Fixed post-epic in `0bba993`** (bundled genesis, self-contained Vite bundles with externals exactly `{electron, node builtins}`, `dist/preload.mjs`) and pinned by `packages/app/test/packaged-boot.test.ts` (5 rows); the Phase 2 behavior check re-verified the suite green.
Disposition: instance **accept (reconciled — fixed post-epic, evidence `0bba993` + 17/17 app suite)**; process: the closing e2e named an artifact it did not exercise, and a deferred item naming a Done-when criterion closed the epic without a human decision (→ action items 9, 10).

**F-2 — The React hook is never executed; the closing e2e integrates a replica.** [adversarial #13; verification-gap #3]
`epic6-end-to-end.test.ts:301-356` (`makeBridge` + `driveUi`) re-implements the hook's merge semantics inline; `useSuccinctcoin.ts` is referenced only as a source-scan path (`:139` HOOK_SRC_PATH) — no test at HEAD imports or executes it (grep-verified; the 6.4 triage F4 conceded this). Deleting the hook's event-driven re-read blocks leaves all 16 app/e2e rows green while the real UI freezes balances/peers/totalSupply at the `CoreStarted` snapshot. The `makeBridge` listener map is dead code in the e2e (events are replayed, never delivered through the bridge).
Disposition: **fix now** (→ action item 1). Still open at HEAD.

**F-3 — Shutdown is not atomic and is unexercised: no quit handler, in-flight window not awaited, `CoreStopped` payload unasserted.** [adversarial #4, #5; edge-case #2; verification-gap #4]
`node-loop.ts:359-365` — `stop()` is a flag + timer clear; an in-flight `window()` is not tracked or awaited, and `createCore.stop()` (`core/src/index.ts:160-172`) proceeds to `store.close()` — the in-flight commit can hit a closed store (SC-STORE-2), swallowed by the bare catch, block silently dropped; a `BlockApplied` can also land after `CoreStopped`. The app has no `before-quit`/`will-quit` handler (`main/index.ts:176` is only the non-darwin `app.quit()`) — Cmd-Q kills the process mid-loop: the store is closed by process death, `CoreStopped` never delivered, the transport torn down without `stop()`. And no test inspects the `CoreStopped` payload after mining (`core-host.test.ts` stops in `afterEach` without assertions; the cache's only writer, `core-host.ts:105-115`, is unverified — deleting `slotCache = p.slot` fails no test).
Disposition: **fix now** (→ action item 2). Still open at HEAD.

**F-4 — Unbounded growth in a long-running node: `minedSlots` never pruned, whole set spread every tick, 15 ms cadence hardcoded.** [adversarial #7; edge-case #4]
`node-loop.ts:194,289,331` — `minedSlots: Set<bigint>` is added per won slot, spread in full into `computeUptimeWeight([...minedSlots], ...)` every tick, and never evicted (O(n²) total work, unbounded memory). The module doc (`:6`) confirms the slot advances per loop iteration, and `NODE_LOOP_TICK_MS = 15` (`core/src/index.ts:73`) is hardcoded — a single node wins every window, so a multi-day run writes a block file per ~15 ms tick with no host way to change the cadence.
Disposition: **fix now** (→ action item 3). Still open at HEAD.

**F-5 — Persistent window failures are invisible: bare catch, no backoff, no halt, no diagnostics.** [adversarial #6; edge-case #1]
`node-loop.ts:204-218` — `runWindow()` catches every error (retry-by-rerun is documented and deliberate: `applyBlock` is atomic, the next tick re-derives the same slot) but a PERSISTENT failure (closed store, disk error) hot-spins 40 windows/s against the same slot forever with zero observability — no failure count, no stall event, no backoff — while the renderer keeps showing "running".
Disposition: **fix now** (→ action item 4). Still open at HEAD.

**F-6 — The gossiped-ticket path is wired but unvalidated, and the deferral points at a story that does not exist.** [adversarial #8]
`node-loop.ts:258-264` — gossiped tickets are admitted by `windowIndex === slot` only: no challenge match against `deriveWindowChallenge`, no `verifyTicketSignature` (4.3), no AD-4 gate check; `net.received` is also re-scanned in full every tick without draining. The 6.1 plan triage (#2) DEFERRED this explicitly, as the precondition of "that multi-node story" — no such story exists in the ticket tree (the real-transport choice is itself deferred, deferred-work 6.4 item 4). Latent while the transport is single-node `@libp2p/memory` (no gossiped producer can exist); it fires the moment a second producer appears.
Disposition: **defer (recorded)** — correct for the single-node testnet; the validation precondition must be a hard gate on the first multi-node story (→ action item 8). Still open at HEAD.

**F-7 — UI snapshot-merge edge cases: stale-snapshot regression, `CoreStarted` full-replace, empty-peers conflation.** [adversarial #11, #12; edge-case #5]
`useSuccinctcoin.ts:66-72` — `BlockApplied` re-snapshots are last-resolving-wins (an earlier-fired, later-resolving snapshot can regress `head` to an older slot); the `CoreStarted` re-snapshot is a FULL replace (unlike the `?? s.head` merge on `BlockApplied`), so a rejecting read mid-replace wipes good state; `:71` conflates a fulfilled empty `peers` read with a failed one (the keep-stale branch), so the peers panel can never show "no peers" again after a peer disconnects. deferred-work 6.4 carried (1) DEFERRED the snapshot race as "benign — the next event self-corrects"; that premise breaks under F-5 (a stalled loop emits no next event).
Disposition: **fix now** (→ action item 5; revisit the deferral's premise). Still open at HEAD.

**F-8 — `createCore.start()` has no started guard, and the renderer bridge exposes `start`.** [adversarial #9; edge-case #3]
`core/src/index.ts:129-158` — `start()` re-runs `mineAndApply` unconditionally (re-open is a no-op, but a second `start()` mines another tracer block and emits a second `CoreStarted`; `startMining()` is documented idempotent — `start()` is not). `preload.ts:29-31` exposes `start`/`stop`/`startMining` on the renderer bridge although `main/index.ts:159` documents that the renderer never calls them (the app auto-starts) and AD-9 makes the UI display-only.
Disposition: **fix now** (→ action item 6). Still open at HEAD.

**F-9 — Empty-chain sentinel conflation in the read-API.** [adversarial #14]
`core/src/index.ts:236-247` — `getChainHead` on an opened-but-blockless store returns `{slot: 0, hash: '0'×64, winnerIdentityId: ''}` — "no chain" is indistinguishable from "head is slot 0", and the event side says the opposite (`CoreStarted {slot: -1}`).
Disposition: **defer (accepted)** — the UI handles both states; reshaping a pinned read-API projection is low-value against its cost. Recorded so later retros stop re-flagging.

**F-10 — Restart against a persisted chain reports slot −1: the host's clock cache is fresh-process-only.** [adversarial #10]
`core-host.ts:95-113` — `slotCache`/`lastHashCache` initialize to −1/zero-hash per process; on a restart with head slot N>0, `CoreStarted` carries `{slot: -1}` + zero `lastBlockHash` until the first loop block. All tests pin the fresh-start path only — the restart path is wrong and untested.
Disposition: **fix now** (→ action item 7). Still open at HEAD.

**F-11 — Pinned identity seed: every install has the same protocol identity; the key is public in the repo.** [adversarial #3]
`main/index.ts:42` — `IDENTITY_SEED` is a committed 32-byte constant; anyone with repo read access derives the private key. AD-11's key secrecy is vacuous in the shipped app (the key never crosses IPC, but it is public knowledge); a multi-user testnet collapses to one peer ID. Recorded deferred (deferred-work 6.4 item 3), but the deferral's risk note understates this.
Disposition: **accept as-is (deferred, recorded)** with a sharpened risk note — this is launch-blocking, not testnet-blocking (→ action item 10).

### Wins the evidence confirms

- **The ticket-level review loop worked.** The 6.1 quick review caught three real defects before close — including the post-`stop()` `startMining()` infinite silent tick loop (fixed + pinned in `core-surface.test.ts` LIVE_START_MINING) and an over-stated "byte-identity is pinned" claim (the row now recomputes the pinned commitment) — 6.1 plan Review Triage Log #3, #4.
- **The AD-1/AD-11 seams held across all four tickets** with zero cross-ticket drift (aggregate views above).
- **The contemporaneous deferral record made the post-epic fix fast.** `deferred-work.md` (6.4 carried items) named two of the three boot blockers before the epic closed; `0bba993` resolved all three and re-pinned the boundary.
- **The self-contained test convention held** across 42 test files; the root suite is green on a fresh tree (behavior check below).

## Behavior verification

- **Executed:** the full workspace suite at HEAD — `corepack pnpm test` → **273/273 tests, 42 files, 32.2 s** (2026-10-16). This covers Done-when #4 (the core's 256-test suite passes unchanged under plain Node, no shell, zero real sockets — CAP-6) and the app's 17-test suite: core-host parity (the real core wired with real ports over `@libp2p/memory` mines and forwards `BlockApplied`), the renderer checks, the closing e2e, and the post-epic packaged-boot matrix, which BUILDS the real bundles (clean → all four artifacts), asserts the bundle is self-contained (externals exactly `{electron, node builtins}`), copies the genesis byte-identical, and boots the host from the BUNDLED genesis (→ `BlockApplied`, chain head matches) — the closest executable approximation of Done-when #1 available in this environment.
- **Not exercised (recorded, not "checked and clean"):** launching the actual electron `.app` GUI — the Electron binary is install-skipped in this environment (`ELECTRON_SKIP_BINARY_DOWNLOAD`), so `electron-forge package` + a real launch is a local operation for the user (Open questions). Real multi-node behavior (single-node memory transport only). Long-running operation — F-4/F-5 (growth, silent stall) are static findings, not runtime observations.

## Previous-retro follow-through

No previous retrospective exists: the previous epic's folder (`epic-node-network/`) contains no `epic-node-network-retrospective.md`. This is a **missing file**, not "no outstanding items" — there was nothing to follow through on because no prior retro was ever run.

## Action items

All items are **proposed, not applied** — the retrospective does not run the dev loop. Owner of every item: the human dev loop (the user), via the normal ticket/plan flow.

1. **Execute the real renderer** (F-2, remediation): add a React-runtime row that mounts `<App />` against a mock `window.succinctcoin` (jsdom + `react-dom/client`), driving a LIVE bridge event stream — assert panels update from events, the F6 missing-bridge error panel renders, the `CoreStarted`/`BlockApplied` re-reads fire, and unmount unsubscribes. Must fail if the re-read blocks in `useSuccinctcoin.ts` are deleted.
2. **Make shutdown atomic** (F-3, remediation): track the in-flight window in the node loop and await it in `stop()` before `store.close()`; add `app.on('before-quit')` in `packages/app/src/main/index.ts` that stops the host before quitting; add a row asserting `CoreStopped {slot: <last mined slot>}` after mining.
3. **Bound the slot history** (F-4, remediation): evict `minedSlots` entries older than the active lookback window each tick (O(L) spread, bounded memory); expose `tickMs` as a host-tunable option instead of the hardcoded 15 ms constant.
4. **Surface persistent loop failure** (F-5, remediation): count consecutive window failures; after N, emit a key-free stall/error status event through the `uiSink` seam (or halt the loop) and back off between retries instead of a fixed 15 ms re-arm.
5. **Harden the renderer snapshot merge** (F-7, remediation): a monotonic sequence guard on re-snapshots (last-resolving-wins → last-INITIATED-wins); always adopt fulfilled reads including an empty `peers` (reserve keep-stale for rejections only); make the `CoreStarted` re-snapshot merge never regress `head`. Revisit deferred-work 6.4 carried (1): its "benign — self-corrects" premise fails under item 4's failure mode.
6. **Guard `start()` and shrink the bridge** (F-8, remediation): make `createCore.start()` a no-op (or a normal `{ code }` reject) when already started; remove `start`/`startMining` from the renderer bridge surface (the app auto-starts; AD-9 makes the UI display-only) or document them as host-only controls.
7. **Fix the restart-path clock cache** (F-10, remediation): after `start()` resolves, initialize the host's `slotCache`/`lastHashCache` from the persisted chain head; add a restart-against-existing-chain row asserting `CoreStarted` carries the real slot.
8. **Gate the first multi-node story on ticket validation** (F-6, spec/process reconciliation): when the real-transport / multi-node story is sliced, its definition of done must include gossiped-ticket validation (`challenge` match against `deriveWindowChallenge`, `verifyTicketSignature`, the AD-4 gate check) plus draining `net.received` after consumption. The current deferral (6.1 triage #2) points at a story that does not exist in the ticket tree — deferrals should name a real ticket.
9. **Closing-e2e rule** (F-1, process lesson): when an epic's Done-when names an artifact (a packaged app, a bundle, a config), the closing suite must EXERCISE that artifact — static shape checks do not count. A deferred item that names a Done-when criterion requires an explicit human decision before the epic may close `built`.
10. **Sharpen the pinned-seed deferral** (F-11, spec reconciliation): update the deferred-work entry (6.4 item 3) to state that the committed seed makes the identity key publicly derivable — AD-11 secrecy is vacuous in the shipped app — and mark it launch-blocking.

## Acceptance verdict

**`accepted-with-open-items`** — criteria **declared** (the epic file carries a 5-criterion Done-when). Machine verdict, rendered headless without a human decision; a human decision overrides.

`pending_tickets` is empty (all four tickets `built`) — no unfinished-ticket forced rejection. Judged against the epic's final state at HEAD (`1ff084e`), criterion by criterion:

1. *"The packaged (electron-forge) app starts a node on a testnet and shows blocks being mined in the UI."* — **NOT met at the epic tip** (`42564e6`; F-1: the packaged artifact could not boot — three blockers — and the closing proof was static/code-path only). **Met at HEAD** by the post-epic fix `0bba993` + the packaged-boot matrix, which builds the real bundles and boots the host from the bundled genesis over the testnet transport → `BlockApplied` (re-verified in the Phase 2 behavior check). Caveat: a real electron GUI launch was not exercised here (binary install-skipped) — see Open questions.
2. *"The React UI shows balance, mining status, and network peers, driven by the core event stream + read-API (no polling)."* — **Met** (renderer rows + the closing e2e; the no-poll static check holds). Open: the actual hook is never executed (F-2, action item 1) — the criterion's UI half is proven by the reducer + a replica, not the mounted component.
3. *"Identity keys are absent from the renderer; the IPC bridge exposes only signed artifacts and status."* — **Met** (AD-11 static scans + surface tests; verified again in the aggregate views).
4. *"The same `packages/core` test suite passes unchanged under a plain-Node runner with no shell and no sockets."* — **Met** (256/256 within the 273/273 run, 2026-10-16).
5. *"The `@libp2p/memory` `electron-main` test target covers the in-app path."* — **Met** (verified present in `@libp2p/memory` 2.0.28 at 6.4; the e2e's in-app rows run on it).

Open named findings at HEAD: F-2, F-3, F-4, F-5, F-7, F-8, F-10 (proposed remediations, action items 1–7) and F-6 (deferred, action item 8) — none blocking: the product runs at the bundle level and all five criteria are demonstrably met in the evidence. Hence `accepted-with-open-items`, not `accepted` (findings open) and not `rejected` (no blocking finding unresolved at the final state; no unfinished ticket).

## Open questions

- **Criterion 1's standard.** Did the 6.4 plan's code-path interpretation of "the packaged app starts a node" satisfy the criterion at close, or should an epic with a recorded boot-blocker naming its own Done-when have held `built` until the artifact booted? (F-1; the retro judges the final state, where it is met — but a human may want the standard tightened, per action item 9.)
- **The final local confirmation.** Run `cd packages/app && corepack pnpm package` and launch the `.app` on a machine with the Electron binary installed — the one Done-when exercise this environment cannot perform (install-skipped binary).
- **The 15 ms cadence (F-4).** Is a block per ~15 ms an intended testnet cadence or a placeholder? If the latter, it is a protocol parameter decision (genesis/host option) for the user — action item 3 implements the tunability either way.
- **Scope of the wrap-up retro.** This run covered `epic-desktop-app` only (the last epic). Epics 1–5 (`epic-platform-baseline`, `epic-exact-money-ledger`, `epic-equal-node-mining`, `epic-operator-identity`, `epic-node-network`) are all finished and retro-eligible — one `bmad-retrospective` run each.

## Assumptions

Every choice made without the user in this headless run:

- **Epic selection.** The invocation was the user's "go ahead" over the 3-step wrap-up proposal ("run the bmad-retrospective") with no epic named. It resolved to the LAST epic, `epic-desktop-app` (id 6): the most recent build, the one whose as-built state the user most recently reviewed (the packaged-boot fix `0bba993` landed directly on top of it), and the one with the richest process evidence (the 6.4 deferral record, the post-epic loopback, the renegotiated frozen block). Epics 1–5 were left for separate runs (Open questions).
- **Going-in concerns.** The interactive invitation ("anything you want weighted") was skipped — headless mode takes no confirmations.
- **Team discussion (Phase 3).** Not run — it is opt-in and never runs headless.
- **Session logs.** Absent for the epic's tickets; process-lesson analysis drew only on what the plans and `deferred-work.md` recorded (Review Triage Logs, Plan Change Logs, carried items). Recorded as a gap, not "checked and clean".
- **The machine verdict** (`accepted-with-open-items`) was rendered with no human decision; a human decision always overrides, and an epic failing its criteria with no human decision would be recorded as *not accepted* — that is not the case here.
- **All ten action items are proposed**, not applied: no status changed, no tree file edited, no `tickets.py mark` run — this document is the run's only write.
