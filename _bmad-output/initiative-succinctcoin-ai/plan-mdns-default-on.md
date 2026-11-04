---
title: 'T-A: LAN multicast discovery default-on'
type: 'plan'
status: built
review: quick
lenses_ran: ['quick']
created: '2026-11-04'
initiative: 'initiative-succinctcoin-ai'
intent: 'change-ledger-dials/change-ledger-dials.md — stage T-A (accepted 2026-11-04)'
---

# Plan — mDNS default-on (T-A of change-ledger-dials)

## Intent (from the accepted stage)

Two nodes on one Wi-Fi, running the app exactly as shipped, must find each
other with zero configuration. Flip LAN multicast (mDNS) discovery from the
9.1 opt-in (`SUCCINCTCOIN_MDNS=1`) to default-ON with a kill switch
(`SUCCINCTCOIN_MDNS=0`). Strictly additive: the invitation stays rung 0 and
the load-bearing join path; whatever mDNS discovers, the CAP-9 address law is
untouched — local addresses never enter an announcement, an invitation, or a
block (enforced independently by `address-policy.ts` at every boundary; this
change touches no policy code).

## Never (frozen)

- No changes to core (`packages/core/**`) — the adapter already honors
  `config.mdns === true`; only the app's default input flips.
- No changes to address policy, announce construction, invite encoding, or
  boot-line honesty logic.
- No new dependencies, no new env vars (the existing knob's polarity inverts).
- `SUCCINCTCOIN_LAN=1` semantics unchanged (v4 bind + forced multicast +
  lanMode filter); legacy `SUCCINCTCOIN_MDNS=1` keeps working (stays on).

## Changes

| File | Change |
|---|---|
| `packages/app/src/main/net-config.ts` | Seam default: `mdns: lan || opts.mdns !== false` (absent ⇒ ON; explicit false respected except under `lan`, which forces multicast as the local testnet's only discovery mechanism). Doc comments updated. |
| `packages/app/src/main/index.ts` | App boot glue: `mdns: process.env.SUCCINCTCOIN_MDNS !== '0'`. |
| `packages/app/src/main/run-node.ts` | Runner glue: same inversion; `--help` env text documents the new polarity. |
| `packages/app/src/main/discovery-ladder.ts` | Review F1: seam input + port `mdnsEnabled` so the honest `[discovery-ladder]` rung-1 report mirrors the real knob (both glues read the env ONCE and pass it to net config AND ladder ports). |
| `packages/app/test/net-config.test.ts` | Exact-config pins `mdns:false → true` (NET_TCP_MDNS_LAN_ONLY, RELAY_SERVER shape); `MDNS_OPT_IN` rewritten as `MDNS_DEFAULT_ON` (default true; false only on explicit false; `lan` overrides explicit false). |
| `packages/app/test/run-node.test.ts` | New row `MDNS_DEFAULT_ON (T-A)`: default boots `mdns:true`; `=0` ⇒ false; legacy `=1` ⇒ true. |
| `README.md` | "Bootstrap lists" mDNS sentence rewritten (default-on, additive, kill switch); discovery-ladder sample line `"mdns":true`; transports bullet updated. |
| `deferred-work.md` | Decision-reversal record appended (supersedes the 9.1 default-off half; spec amendment pointer left for `bmad-spec`). |

## Notes

- The 9.1 middlebox-hostility evidence is not contradicted: on hostile
  networks the multicast simply stays silent and discovery remains what it
  already was (invitation-first). Default-on only helps friendly LANs, which
  is exactly where users hit "nodes never find each other."
- Eclipse/privacy: mDNS adds LOCAL peers only; cross-boundary trust paths
  (announces, invites, blocks) are policy-gated elsewhere and unchanged.
- Instrumentation row of the change doc (dial-outcome counters) NOT included
  — deferred to its own small ticket as the acceptance record allows.

## Gates

- Root: `corepack pnpm build` → `corepack pnpm typecheck` → `corepack pnpm exec vitest run --maxWorkers=2`
- App: `corepack pnpm exec tsc --noEmit -p tsconfig.json` + own vitest

## Review Triage Log

Quick lens (subagent, 2026-11-04). Constraints verified clean: no
`packages/core/**` changes; no policy/announce/invite code touched.

| ID | Sev | Finding | Verdict | Disposition |
|---|---|---|---|---|
| F1 | major | `[discovery-ladder]` rung-1 `mdns` always printed `true` — the app never fed `DiscoveryPorts.mdnsEnabled`, so the kill switch was invisible in the honest log (`core/src/index.ts` defaults `?? true`) | **Accepted, fixed in-plan** | `LadderSeamInputs.mdnsEnabled` added; BOTH glues read the knob ONCE (`const mdnsEnabled = env.SUCCINCTCOIN_MDNS !== '0'`) and pass it to net config AND ladder ports (run-node threads it through `bootOverTransport`). Pinned by a new `discovery-ladder.test.ts` describe. Core untouched — port was already optional. |
| F2 | minor | index.ts glue inversion unpinned (electron main, no boot tests) | Accepted | `MDNS_GLUE_SYMMETRY` row in `net-config.test.ts`: comment-stripped scan pins `SUCCINCTCOIN_MDNS !== '0'` present and `=== '1'` absent in both glues. |
| F3 | minor | `SUCCINCTCOIN_MDNS=''` now means ON (was OFF); junk too | Rejected as-is | Matches the immediate neighbor convention (`resolveRelayAuto`: only literal `'0'` kills — pinned `'' ⇒ auto`) and the documented contract "kill switch =0". Consistent, intentional. |
| F4 | nit | runner-level `MDNS=0 + LAN=1` combo unpinned | Deferred | Seam pins the force (`{mdns:false,lan:true}→true`); glues pass plain booleans. |
| F5 | nit | stale "opt-in mDNS" comment at `core/src/net/adapter.ts:1231` | Deferred | Core frozen by this plan's constraints; fix rides the next core-touching ticket. |

Lens verdict: safe to commit (F1 bookkeeping satisfied by an actual fix).

## Gates — results

- Root: BUILD-OK · TYPECHECK-OK · vitest **561/70**
- App: tsc 0 · vitest **80/10** (new rows: `MDNS_DEFAULT_ON` runner,
  `MDNS_GLUE_SYMMETRY`, ladder `mdnsEnabled` passthrough)

