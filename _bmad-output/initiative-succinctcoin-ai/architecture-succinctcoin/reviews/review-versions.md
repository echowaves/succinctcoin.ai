# Review — version / fit verification

**Verdict: PASS with one advisory. Every Stack version in the spine matches a live npm-registry `latest` check performed 2026-10-01. One real risk: TypeScript 7.0.2 (`latest`) is the *first stable of the native Go (tsgo) rewrite* — pinning it on a greenfield is a defensible-but-early bet. The [ASSUMPTION] tags are honestly tagged.**

## Confirmed against live registry (2026-10-01)

| Package | Spine claims | Live `latest` | Match |
| --- | --- | --- | --- |
| libp2p | 3.3.11 | 3.3.11 | ✓ |
| @libp2p/gossipsub | 17.1.2 | 17.1.2 | ✓ |
| @libp2p/yamux | 8.0.3 | 8.0.3 | ✓ |
| @libp2p/noise | 17.0.3 | 17.0.3 | ✓ |
| @libp2p/tcp | 11.0.28 | 11.0.28 | ✓ |
| @libp2p/mdns | 12.0.32 | 12.0.32 | ✓ |
| @libp2p/bootstrap | 12.0.32 | 12.0.32 | ✓ |
| @libp2p/circuit-relay-v2 | 4.2.13 | 4.2.13 | ✓ (old name `@libp2p/circuit-relay` correctly noted as 404) |
| @libp2p/memory | 2.0.28 | 2.0.28 | ✓ |
| electron | 44.5.1 | 44.5.1 | ✓ |
| @electron-forge/cli | 8.0.1 | 8.0.1 | ✓ |
| react | 19.3.0 | 19.3.0 | ✓ |
| vite | 8.3.2 | 8.3.2 | ✓ (deps show `rolldown ~1.2.11` — matches the spine's "Rolldown ~1.2.11") |
| vitest | 5.0.3 | 5.0.3 | ✓ |
| fast-check | 4.10.2 | 4.10.2 | ✓ |
| big.js | 7.0.1 | 7.0.1 | ✓ (stable for a long time — `_id big.js@7.0.1`, no newer) |

## Findings

### V1 — ADVISORY · TypeScript 7.0.2 is the native rewrite, not the JS tsc

- Evidence: npm `latest` = typescript@7.0.2; the microsoft/TypeScript repo is **86.7% Go**, has a `tsc/` dir, `go.work`, and the release "TypeScript 7.0.2 · Latest · 2 months ago." This is the **tsgo (Go-based) compiler's first stable line**, not the long-running JS `tsc`.
- Risk: it is *current* (not outdated), but it is *young* — two months of stable releases. A greenfield coin that must be "simple enough that any developer can understand" and that leans on Vitest 5 / Vite 8 may hit tsgo edge cases in emit, declaration output, or editor integration.
- The spine's `[ASSUMPTION]` tag ("pin 5.x if the team wants the JS tsc") is **honest and correct** — it names the real fork.
- **Suggested:** keep the tag, but reframe the default. For a long-lived, simplicity-first, well-tested coin, **TS 5.x (the battle-tested JS tsc) is the lower-risk default**, with TS7 as the opt-in. Swap the Stack row to `TypeScript 5.x (default) · 7.0.2 available (native tsgo)` and move the bet into the [ASSUMPTION] as an opt-in, not the default.

### V2 — INFO · Node 24 timing

- Node 24 entered LTS in Oct 2025; as of 2026-10 it is the current LTS. Node 26 reaches LTS around Oct 2026. Node 24 is the correct pin for now; revisit at the next major. Not a spine change — the recon's Lodestar/Node-24 precedent still holds. No action.

### V3 — CONFIRMED · `electron-main` test target claim

- The spine (AD-10) claims the `@libp2p/memory` package.json carries an `electron-main` test target. Verified: the live `@libp2p/memory@2.0.28` package.json `scripts` block includes `"test:electron-main":"aegir test -t electron-main"`. The claim is accurate. (Also confirmed present in `@libp2p/tcp`, `@libp2p/noise`, `@libp2p/yamux`, `@libp2p/bootstrap`, `@libp2p/mdns` — the whole stack supports the in-app test path.)

### V4 — ADVISORY (minor) · `@electron-forge/cli` vs plain electron

- Forge 8.0.1 is current and is the standard Electron scaffolding/packaging tool. No conflict; the spine lists it correctly. No action.

## Bottom line

No outdated version. One genuine decision the user should own: **TS 7 (new native compiler, `latest`) vs TS 5.x (proven JS tsc)** as the *default* pin. Recommend flipping the default to 5.x for a simplicity-first, long-lived coin and keeping TS7 as a documented opt-in. Everything else is verified and safe to bind.
