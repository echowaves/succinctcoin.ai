---
title: 'Genesis bootstrap hygiene: LAN-only genesis (empty list) + joining-a-network docs'
type: 'feature'
ticket: '1'
created: '2026-10-16'
status: done
route: 'oneshot'
route_source: 'auto'
review: 'quick'
review_source: 'pinned'
lenses_ran: ['quick']
review_loop_iteration: 0
baseline_revision: '07c5a46cb7d588a4f43f4da32f7df468b7b571c5'
context:
  - '_bmad-output/initiative-succinctcoin-ai/epic-real-network/epic-real-network.md'
  - '_bmad-output/initiative-succinctcoin-ai/epic-real-network/tickets.toml'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** `config/genesis.json` lists two unreachable placeholder bootstrap peers (a generic libp2p node that does not run SuccinctCoin, and an RFC 5737 TEST-NET-2 address), and `validateGenesis` rejects an empty bootstrap array — so the testnet can't declare "no hardwired peers", which LAN-only operation (mDNS discovery) needs. The one core change of epic-real-network is exactly this relaxation.

**Approach:** Empty the repo genesis bootstrap list; relax the validator row to accept an empty array (matching the adapter's own gate — the `@libp2p/bootstrap` service is only wired when the list is non-empty); update the three non-empty pins in the core tests; document joining a network in README.md. The app is NOT touched (7.2 flips its transport).

## Boundaries & Constraints

**Always:** keep SC-CONFIG-1 for malformed entries (non-array, non-string, entry not starting with `/`); keep every test headless (AD-10); the two 5.3 bootstrap tests keep their names and positive assertions by driving them from a production-shaped provided list.

**Never:** no changes to `packages/app`; no changes to `packages/core/src/net/adapter.ts`; no new test rows that open real sockets.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Empty list validates | `validateGenesis({...valid, bootstrap: []})` | passes; `cfg.bootstrap` is `[]` | No error expected |
| Malformed entry | `bootstrap: ['/ip4/1.2.3.4', 'not-a-multiaddr']` (entry without `/` prefix) | rejected naming `bootstrap[1]` | SC-CONFIG-1 |
| Non-array bootstrap | `bootstrap: "x"` | rejected | SC-CONFIG-1 |
| Repo genesis boots | every test loading `config/genesis.json` via `loadGenesis` | validates cleanly with empty list | No error expected |

</frozen-after-approval>

## Code Map

- `config/genesis.json` — the data: `bootstrap` becomes `[]`.
- `packages/core/src/config/genesis.ts` (L77-78) — the validator row to relax; the per-entry `/`-prefix loop stays.
- `packages/core/test/genesis.test.ts` (L34 VALID_LOAD; add EMPTY_BOOTSTRAP_OK row) — pin 1.
- `packages/core/test/net-adapter.test.ts` (BOOTSTRAP_WIRED_TO_GENESIS ~L559, BOOTSTRAP_FROM_GENESIS_SHAPE ~L672) — pins 2+3: positive wiring assertions move to a production-shaped synthetic list; the repo-genesis shape check drops only the non-empty line.
- `README.md` — new "Joining a network" section after "Run the desktop app".

## Tasks & Acceptance

**Execution:**
- [ ] `packages/core/src/config/genesis.ts` — accept empty bootstrap array; update message/doc comment.
- [ ] `config/genesis.json` — `"bootstrap": []`.
- [ ] `packages/core/test/genesis.test.ts` — VALID_LOAD asserts array + entries start with `/` (no length); add EMPTY_BOOTSTRAP_OK + keep malformed-entry rejection rows.
- [ ] `packages/core/test/net-adapter.test.ts` — BOOTSTRAP_WIRED_TO_GENESIS wires a synthetic production-shaped list (node starts clean, peers stay empty headless); BOOTSTRAP_FROM_GENESIS_SHAPE drops the repo-list non-empty line, keeps shape loop + CI-analog + negative rows.
- [ ] `README.md` — "Joining a network" section: multiaddr format, example genesis snippet, two-instance LAN note; Notes bullet updated to point at this epic's change (transport flips in 7.2).

**Acceptance Criteria:**
- Given the relaxed validator, when `validateGenesis` gets `bootstrap: []`, then it passes and returns `[]`; malformed entries still throw SC-CONFIG-1 naming the index.
- Given the emptied repo genesis, when any core/app test boots via `loadGenesis(config/genesis.json)`, then it validates cleanly.
- Given README.md, then a join-a-network section exists with `/ip4/<ip>/tcp/<port>/p2p/<peerId>` format and an example.
- Full root suite green headless (was 273/273; row count may grow by the new validation rows).

## Implementation Notes

Oneshot because: ~50 lines across five files, all mechanical once the three pins are located (investigation confirmed no other `genesis.bootstrap` consumers exist in src — the app-side consumer arrives in 7.2).

- Validator row relaxed with an explanatory comment; per-entry `/`-prefix loop untouched (SC-CONFIG-1 kept). Module docstring updated.
- BOOTSTRAP_WIRED_TO_GENESIS: positive wiring now drives a `productionShapedList` fixture — the former genesis entries reused as test data (guaranteed-parseable `/p2p` multiaddrs; headless-absent, so peers() still stays empty). Dropped the now-unused `loadGenesis` import.
- BOOTSTRAP_FROM_GENESIS_SHAPE: dropped only the repo-list non-empty line; shape loop vacuously passes on the LAN-only list and still guards future entries.
- README "Joining a network" section describes the epic's target behavior (mDNS-on-LAN lands with 7.2 in the same run); Notes bullet reworded accordingly.

## Plan Change Log

## Review Triage Log

- **README mDNS/join claims are present-tense before 7.2 lands** — real (low), transient: 7.2 ships in the same session; final README state is accurate. Not patched twice.
- **"entries without /p2p rejected at boot" false** — real (medium): validator only checks the `/` prefix; @libp2p/bootstrap silently filters. Patched: README now says dropped + logged, not rejected.
- **Example genesis snippet omits required fields** — real (medium): copying it fails SC-CONFIG-1 on reattestationK. Patched: snippet is now a `bootstrap` fragment to set inside the existing file.
- **"edit dist/config/genesis.json in an installed build" not actionable** — real (low): packaged genesis lives inside the asar. Patched: now says configure before packaging.
- **Quickstart test counts stale** — real (low): updated 273→275 and 256→258 (README was touched in this diff).
- **net-adapter.test.ts header docblock stale** — real (low), trivial: row description now says production-shaped fixture (7.1).
- **BOOTSTRAP_SHAPE try/unreachable fragility** — rejected (low): pattern is the file's own established convention (MALFORMED_TYPE/MALFORMED_MISSING rows use it); consistency wins.
