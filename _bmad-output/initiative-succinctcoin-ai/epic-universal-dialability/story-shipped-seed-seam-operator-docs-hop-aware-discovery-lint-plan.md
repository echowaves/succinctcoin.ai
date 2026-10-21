---
title: '11.3 Shipped seed seam + operator docs + hop-aware discovery lint'
type: 'feature'
ticket: '3'
created: '2026-10-21'
status: 'built'
baseline_revision: 'e96af477bf6f98ba0b68e2dd9d9d8e74813df2ea'
route: 'full'
route_source: 'auto'
review: 'quick'
review_source: 'pinned'
lenses_ran: ['quick']
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** 11.1/11.2 made v4-hop circuits legal chain data and dialable, but nothing ships a seed to reach one: `defaultNetConfig` passes `relaySeeds: opts.relaySeeds ?? []` (env-only), the README still states IPv4-only nodes "stay unserved by design", the renderer's no-invite copy points only at global IPv6, and the discovery lint bans every `/ip4` literal in shipped code — so the 11.5 seed flip would fail CI.

**Approach:** net-config gains an exported `DEFAULT_RELAY_SEEDS` constant (EMPTY today, a pinned constant not an absence; provisioned by 11.5's flip) merged BEFORE env seeds via a pure exported merge (env additive, dedupe exact-string like bootstrap). Both boot paths tag seed HOLD/FAIL lines with the hop family dialed. README reachability ladder rewritten for the post-11.2 truth; ipv6-hint/App copy stops implying global IPv6 is the only path (AD-1: no core import). Discovery lint relaxes `hardwired-ip4` ONLY for the seed-config file; every other source keeps the hard ban.

## Boundaries & Constraints

**Always:**
- `DEFAULT_RELAY_SEEDS` stays `[]` in this story — provisioning is 11.5's flip after 11.4 lands; a config test pins the empty constant itself (absence of seeds ≠ pinned empty).
- Merge precedence documented + tested: defaults first, env additive, dedupe by exact string; with the empty constant today every existing exact-config pin passes through unchanged (`relaySeeds: []` default stays byte-identical).
- Boot lines report each seed hold/failure WITH the family dialed for both transports (app boot `src/main/index.ts` and headless runner `run-node.ts`); derive from the seed's first IP component — no DNS, no new adapter events.
- Lint relaxation is EXACTLY: `hardwired-ip4` may fire-clean in `packages/app/src/main/net-config.ts` (hop/seed config position). `hardwired-dns4`, `ipfs-peer-id`, `seed-endpoint` unchanged everywhere; every OTHER path keeps the `/ip4` ban, and a planted direct-v4 fixture still fires.
- Docs/copy state only what 11.2 proved: IPv4-only nodes are served THROUGH a relay hop (invite starts `/ip4/…` or `/ip6/…` then `/p2p-circuit`); until seeds ship by default, name `SUCCINCTCOIN_RELAY_SEEDS` as today's channel. Volunteer-relay config text stays.

**Never:**
- No provisioning of real seed values, no domain/DNS (11.4/11.5), no adapter/core policy change (11.2 shipped the laws), no changes to announcements/address-book, no new deps, no core import in renderer, no touching `describeLoopbackInvite` or `describeCircuitInvite` semantics.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Default config | no env seeds | `relaySeeds` = `[]`; constant exported, pinned empty | — |
| Env additive | env seeds `[X]`, constant `[]` | merge → `[X]` (order: defaults then env) | — |
| Merge math (synthetic) | defaults `[A,B]` + env `[B,C]` | `[A,B,C]` deduped, defaults-first | — |
| Boot line v4 seed | `relaySeeds:['/ip4/…/p2p/R']`, HOLD event | log names family: `[boot] relay HOLD (v4) …` | FAIL line keeps error |
| Boot line non-IP seed | dns-named seed (future) | no family tag, line still prints | — |
| Lint: hop position | `/ip4/1.2.3.4/tcp/9/p2p/QmR` literal in net-config.ts | NOT a finding (seed config) | — |
| Lint: direct ban | same literal in adapter.ts or listenAddress source | still `hardwired-ip4` fires | fixture row pinned |

</frozen-after-approval>

## Code Map

- `packages/app/src/main/net-config.ts` — add exported `DEFAULT_RELAY_SEEDS: readonly string[] = []` (comment: provisioned by 11.5 flip, empty is the pin) + exported pure `mergeRelaySeeds(defaults, envSeeds)` (defaults-first concat, `new Set` dedupe — same shape as bootstrap merge ~L64); use in `defaultNetConfig` L78; update the 10.2 comment block (~L75) to name the constant + precedence.
- `packages/app/src/main/run-node.ts` (~L157) and `packages/app/src/main/index.ts` (~L120) — identical boot-line change: derive family from seed string (helper exported from net-config: `seedHopFamily(seed): 'v4'|'v6'|null` — regex on leading `/ip4/` / `/ip6/` only), print `[boot] relay HOLD (v4) <seed>` etc.; null → no tag.
- `README.md` — rewrite the two stale claims: L98 parenthetical ("pure IPv4 cannot join even through a relay, and that is deliberate") and L114 tail ("The relay hop itself must be global /ip6 … those stay unserved by design") per ticket copy ("served through a relay hop — your invite starts /ip4/… or /ip6/…"); adjust L106 dev-flag sentence (loopback-family hops now dial-side-allowed under flag; announce/record law unchanged); mention defaults ship empty (`DEFAULT_RELAY_SEEDS`) where `SUCCINCTCOIN_RELAY_SEEDS` is introduced. Do NOT restructure the volunteer-relay section (L117).
- `packages/app/src/renderer/ipv6-hint.ts` — extend the two no-global rows of `describeIpv6` (uniqueLocal, linkLocal) and the fallback with the honest second path: "…or reach the network through a relay hop — pin a dual-stack relay in SUCCINCTCOIN_RELAY_SEEDS; your invite then runs /ip4/… or /ip6/… through /p2p-circuit." Keep sentences one-per-state, pure, React-free.
- `packages/app/src/renderer/App.tsx` (~L190) — "No invite yet — this node announces once it has a global IPv6 address." → name both paths (global IPv6 or a held relay-hop circuit). No core import (AD-1).
- `packages/core/test/discovery-lint.test.ts` — relax scanner: skip `hardwired-ip4` findings when path is the net-config seed-config file; keep other patterns/paths hard. Update header comment + NON-VACUITY rows; NEW row: hop-position `/ip4` in net-config clean, same literal elsewhere fires.
- Tests: `packages/app/test/net-config.test.ts` (constant pinned empty + exported; merge order/dedupe synthetic; existing default pins unchanged), `packages/app/test/ipv6-hint.test.ts` + `renderer.test.ts` (updated copy rows), boot-line family tag via existing run-node/index log-injection tests (`run-node.test.ts`).
- Do NOT touch: adapter/address-policy/core, discovery-lint patterns other than ip4, `describeLoopbackInvite`, `describeCircuitInvite`.

## Tasks & Acceptance

**Execution:**
- [x] `packages/app/src/main/net-config.ts` — constant + merge + `seedHopFamily` + comment updates.
- [x] `packages/app/src/main/run-node.ts`, `packages/app/src/main/index.ts` — family-tagged boot lines (both boot paths).
- [x] `packages/core/test/discovery-lint.test.ts` — hop-aware relaxation + new rows.
- [x] `packages/app/test/net-config.test.ts` + `run-node.test.ts` — config/merge/boot-line pins.
- [x] `packages/app/src/renderer/ipv6-hint.ts`, `App.tsx` — honest copy; update `ipv6-hint.test.ts`, `renderer.test.ts`.
- [x] `README.md` — ladder rewrite (L98/L106/L114 + seeds intro), reviewed line-by-line against shipped behavior.

**Acceptance Criteria:**
- Given a plain install, when config builds, then `relaySeeds` is `[]` and `DEFAULT_RELAY_SEEDS` is an exported empty constant pinned by test; given env seeds, they arrive additive after defaults, deduped.
- Given a v4 seed holding, boot prints HOLD with `(v4)` in both runner and app paths (log-injection tests).
- Lint green on the real repo while a planted direct-v4 fixture still fires; README ladder reviewed against actual behavior lines; full root + app suites green headless.

## Implementation Notes

2026-10-21 — built on baseline e96af47, working tree (uncommitted). Gates: `corepack pnpm build` ✓, `corepack pnpm typecheck` ✓, root `corepack pnpm exec vitest run --maxWorkers=2` → 69 files / **545 passed** (538 baseline + 7 new rows), `packages/app` `tsc --noEmit -p tsconfig.json` ✓ and `vitest run` → 10 files / 72 passed.

Lint-matrix row note: the "Lint: direct ban … adapter.ts **or** listenAddress source" row was read against the frozen boundary (net-config is the ONE exempt path, so its own bind fixture cannot be the firing side) — the firing rows pin `packages/core/src/net/adapter.ts` AND a `/ip4/0.0.0.0` bind planted in `index.ts`; the same hop literal in net-config stays clean and `/dns4` still fires there.

Boot-line format shipped: `[boot] relay HOLD (v4) <seed>` / `[boot] relay FAIL (v6) <seed>: <error>`; dns-named seeds print untagged. Runner path pinned live (`RELAY_SEED_FEEDBACK`), electron path by source pin (no headless harness for `index.ts`). README L94 direct-address framing amended alongside the four planned spots — its flat "rejected at every boundary" claim is what 11.2 disproved, so leaving it would have violated "docs state only what 11.2 proved".

**Review-fix batch (supersedes parts of the above, see triage log):** the lint exemption went POSITION-scoped (only the `DEFAULT_RELAY_SEEDS` declaration region reads clean; a v4 bind in net-config fires again — the deleted 9.1 row restored); `seedHopFamily` now takes the first IP component wherever it sits (parity with core's seed law, triage F4); and both boot paths print through ONE exported pure formatter `relaySeedLine(event)` — live-pinned in net-config.test.ts, call sites pinned to use it (F1). Post-batch gates: root 546/546, app tsc + 73/73.

## Plan Change Log

## Review Triage Log

Quick lens (pass 1), 4 findings — all verified at the cited code, grouped into two root causes, both patched:

| # | Finding | Verdict → Route | Evidence / Action |
|---|---------|-----------------|--------------------|
| F1 | AC "both runner and app paths (log-injection tests)" met on electron path only by source-substring pin — future divergence between the two handler copies possible | medium (patch) → fixed | Extracted THE shared pure formatter `relaySeedLine(event)` (net-config); both boot paths are now one-liners calling it; pinned live (family tags, FAIL error, untagged dns) in net-config.test.ts + call-site source pin. Electron `boot()` itself cannot run headless (no harness exists for the electron main) — AC parenthetical honored as strongly as physically possible: what index.ts prints IS the live-tested formatter at its pinned call site. **Autonomous call, flagged** (standing delegation): no frozen text changed. |
| F2 | Frozen matrix "listenAddress source" row felt unpinned (firing fixture planted in index.ts, not the bind's file) | low (patch, grouped with F3 root cause) → fixed | With F3's position-scoped exemption the literal reading holds: a v4 bind IN net-config now fires again (restored 9.1 row). |
| F3 | Lint exemption was FILE-scoped: `/ip4/0.0.0.0` bind planted in net-config passed silently; the deleted 9.1 row guarded exactly that | medium (patch) → fixed | Scanner now exempts ONLY the `DEFAULT_RELAY_SEEDS` declaration region (regex past the type annotation to the array's closing bracket); restored bind-fires row + hop-inside-constant-clean row; other patterns/paths unpinned-hard unchanged. |
| F4 | `seedHopFamily` led on the FIRST COMPONENT only while core's seed law takes the first IP ANYWHERE — dns-prefixed seeds would print untagged, two "first IP" definitions in one repo | low (patch) → fixed | Derivation now `/\/ip(4\|6)\//` first-match = first IP wherever it sits (parity with `firstIpIsGlobalScope`); rows pinned incl. dns-prefixed ⇒ v4 and family-order tie-break. |

Post-patch gates: build ✓, typecheck ✓, root 546/546, app tsc ✓ + 73/73.
