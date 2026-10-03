---
title: 'Chainstore + exclusive lock'
type: 'feature'
ticket: 5
created: '2026-10-03'
status: 'built'
baseline_revision: '53b3a1e13ab721873767d24f66c50d997ad73b3d'
route: 'full'
route_source: 'auto'
review: 'quick'
review_source: 'pinned'
lenses_ran: ['quick']
review_loop_iteration: 0
context:
  - _bmad-output/initiative-succinctcoin-ai/architecture-succinctcoin/architecture-succinctcoin.md
  - _bmad-output/initiative-succinctcoin-ai/spec-succinctcoin/testing.md
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** `StorePort` exists (1.2) but has no implementation — the core has nowhere to persist blocks, and nothing prevents two core instances from writing the same data directory and corrupting state (AD-9: two-process write corruption + UI bypass). The story's verify: a block's canonical wire bytes persist and reload byte-identical through the store, and starting a second core against the same store directory fails at boot with a clear error.

**Approach:** Implement a file-based `ChainStore` adapter (`FileChainStore`) in `packages/core/src/store/` — a zero-new-dependency engine (per-slot block files, atomic tmp+rename writes, `O_CREAT|O_EXCL` PID lockfile on the data directory) — add the read path (`getBlock(slot)`) the port is missing, wire store open/close into `createCore`'s boot path so a contended directory rejects `start()` with `SC-STORE-1`, and cover it with a test matrix including the ticket's end-to-end boot-failure verify.

## Boundaries & Constraints

**Always:**
- The store persists **canonical wire bytes** (the 1.4 generated `Block.encode` form) and hands back exactly those bytes — byte-identity is the contract, no re-serialization.
- One writer: all mutations go through `commit`; block files are written atomically (tmp + rename); the data directory is locked with an exclusive `O_CREAT|O_EXCL` lockfile (AD-9).
- Errors carry the spine's `{ code: 'SC-<DOMAIN>-<n>', message }` shape — store errors are `SC-STORE-1` (lock contention) with a clear message naming the directory.
- A stale lockfile left by a crashed process (dead PID) is detected and taken over, not a permanent brick.
- Tests run plain-Node (AD-10): temp dirs under `os.tmpdir()`, no real sockets, no new runtime deps.

**Never:**
- No new runtime dependency (no SQLite/LevelDB — engine is a zero-dep custom store; the ticket reserves the engine as a code-level choice per AD-9, decided here).
- No consensus/ledger/identity/net logic — the store persists bytes and reports `headSlot`; ordering, validation, and the single-writer loop are epic 3.
- No UI imports (AD-1); no hand-written protocol types (AD-12) — the adapter uses the generated `Block` codec only.
- No push; the store directory layout is not part of the wire protocol (no genesis-bump implications).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| PERSIST_RELOAD | commit the golden Block (1.4 vector) → close → open | `getBlock(slot)` returns bytes byte-identical to `Block.encode(input)` | a mismatch fails the test |
| HEAD_SLOT | empty store / after commits (incl. out-of-order) | `-1` / highest committed slot | — |
| EXCLUSIVE_LOCK | a second `FileChainStore.open()` on the same dir while the first is open | rejects `SC-STORE-1` with a clear message naming the directory (and holder PID) | the reject IS the expected behavior |
| STALE_LOCK_TAKEOVER | lockfile present with a dead PID | `open()` succeeds (takes over the lock) | — |
| BOOT_FAIL | a second `createCore` against the same dir; `core2.start()` after `core1.start()` | `start()` rejects `SC-STORE-1`; after `core1.stop()`, the second core's `start()` succeeds | the reject IS the expected behavior |

</frozen-after-approval>

## Code Map

- `packages/core/src/store/file-chain-store.ts` — **new.** `FileChainStore implements StorePort` + `StoreError` (code `SC-STORE-1`). Layout under `<dir>`: `.lock` (O_EXCL lockfile holding the holder PID) + `blocks/<slot>.block` (canonical wire bytes, written via `<slot>.block.tmp-<pid>-<rand>` then rename). `open()`: mkdir -p, acquire lock (EEXIST → read holder PID; dead PID via `process.kill(pid, 0)` → unlink + retry once; live PID → reject SC-STORE-1), scan `blocks/` for max slot (absent/empty → -1). `close()`: unlink `.lock`. `commit(block)`: `Block.encode(block as Block)`, atomic write to `blocks/<slot>.block`, update in-memory head. `getBlock(slot)`: read `blocks/<slot>.block` → `Uint8Array`, or `null` if absent. `headSlot()`: in-memory max.
- `packages/core/src/store/index.ts` — **new.** Re-export `FileChainStore`, `StoreError`.
- `packages/core/src/ports.ts` — `StorePort` gains `getBlock(slot: number): Promise<Uint8Array | null>` (read path the verify requires; the port stays storage-agnostic — 1.2's own comment anticipates 1.5 completing it). Everything else unchanged.
- `packages/core/src/events/types.ts` — `CoreCommands.start()/stop()` become `Promise<void>` (AD-9: every command resolves its promise — boot can now fail on lock contention).
- `packages/core/src/index.ts` — `createCore`: `start()` = `await ports.store.open()` **then** emit `CoreStarted` (open failure rejects before any event); `stop()` = emit `CoreStopped` **then** `await ports.store.close()`. Additive re-export of `FileChainStore`/`StoreError`. `createCore` itself stays sync (opening happens at `start()`).
- `packages/core/test/store.test.ts` — **new.** Matrix rows PERSIST_RELOAD (golden Block from 1.4's vector, close+reopen byte-identity), HEAD_SLOT, EXCLUSIVE_LOCK, STALE_LOCK_TAKEOVER, BOOT_FAIL (two `createCore` instances, same dir).
- `packages/core/test/core-surface.test.ts` — update `start()`/`stop()` call sites to `await` (now Promise-typed).
- `packages/core/test/ports.test.ts` — store fake gains `getBlock`.
- Unchanged: `proto/`, `config/`, `events/` (except the `CoreCommands` signatures), all other tests, root package.json (no new deps anywhere).

## Tasks & Acceptance

**Execution:**
- [x] `packages/core/src/store/file-chain-store.ts` — FileChainStore + StoreError: lockfile acquire/release/takeover, atomic per-slot block writes, head tracking, getBlock read path.
- [x] `packages/core/src/store/index.ts` — re-export the store surface.
- [x] `packages/core/src/ports.ts` — add `StorePort.getBlock(slot)`.
- [x] `packages/core/src/events/types.ts` — `start`/`stop` → `Promise<void>`.
- [x] `packages/core/src/index.ts` — wire store open/close into boot path; re-export store surface.
- [x] `packages/core/test/store.test.ts` — the five matrix rows incl. the end-to-end BOOT_FAIL verify.
- [x] `packages/core/test/core-surface.test.ts` + `ports.test.ts` — adapt fakes/call sites to the async lifecycle + new port method.

**Acceptance Criteria:**
- Given a `FileChainStore` on a temp dir, when the golden Block is committed and the store is closed then reopened, then `getBlock(slot)` returns bytes byte-identical to the canonical encoding and `headSlot()` reflects the highest committed slot (`-1` when empty).
- Given an open store, when a second store (or a second core's `start()`) targets the same directory, then it fails at boot with a clear `SC-STORE-1` error; after the first store closes, the directory opens again.
- Given a stale lockfile from a dead PID, when the store opens, then it takes over the lock and functions normally.

## Design Notes

- **Engine decision (the ticket's reserved code-level choice, AD-9): custom, zero new deps.** Per-slot files (`blocks/<slot>.block`) + one `O_CREAT|O_EXCL` PID lockfile. Rejected: `node:sqlite` (still experimental on Node 24 — Stability 1.1, not for a baseline the whole chain depends on), better-sqlite3/LevelDB (native/heavy deps for a store whose entire state is append-only block bytes; conflicts with the user's "simplicity for any developer" + the spine's no-second-toolchain precedent). The `O_EXCL` lockfile IS the AD-9 "write lock + data-directory lockfile": the holder is the sole writer and every block write is atomic (tmp + rename), so a crash cannot corrupt an existing block file.
- **Lockfile semantics.** `.lock` contains the holder PID. Contention: read PID, `process.kill(pid, 0)` — throws `ESRCH` (dead) → unlink + one `O_EXCL` retry (the retry, not the delete, is the atomic arbiter under concurrent stale-takeover); `EPERM` (alive, other user) or no throw (alive) → reject `SC-STORE-1` naming dir + PID. `close()` unlinks best-effort.
- **`commit(block: unknown)` stays the port signature.** The adapter treats it as the generated `Block` (the consensus loop is the only caller, epic 3), encodes with `Block.encode` → canonical bytes, uses `block.slot` (bigint) for the file name. The store never re-derives bytes from a decoded object on read — `getBlock` returns the stored file bytes verbatim, which is what makes PERSIST_RELOAD a true byte-identity check.
- **Boot wiring.** `start()` opens the store before emitting `CoreStarted`; a contended dir rejects `start()` with `SC-STORE-1` and emits nothing. `stop()` emits `CoreStopped` then closes (releases the lock). `createCore()` remains sync — the store is opened at `start()`, so constructing a second core against a locked dir is harmless until `start()`.
- **headSlot** is tracked in memory: scanned once at `open()` (max numeric file name in `blocks/`, absent → -1) and updated on `commit`. Out-of-order commits are stored; `headSlot` = max (ordering enforcement is epic 3's applyBlock, AD-2).
- **Test hygiene.** Each test uses a fresh `fs.mkdtempSync(join(os.tmpdir(), 'succinctcoin-store-'))` dir, removed in `afterEach`. STALE_LOCK_TAKEOVER writes a `.lock` containing a PID guaranteed dead (`pid 3`-style probe: pick a high PID, verify `process.kill(pid, 0)` throws before writing). BOOT_FAIL exercises the real `createCore` × 2 with real `FileChainStore`s — the ticket's verify verbatim.

## Verification

**Commands:**
- `corepack pnpm test` — expected: exit 0; the 5 new store matrix tests pass; existing suite (incl. updated core-surface/ports fakes) green.
- `corepack pnpm typecheck` — expected: exit 0, strict tsc clean across the new store module + updated port/command signatures.
- `corepack pnpm build` — expected: exit 0 (protons regen byte-identical, tsc emits the store module into dist).

## Implementation Notes

- **Two store error codes (added in review, `patch` route).** The frozen rule names `SC-STORE-1` as the *lock-contention* code (boot failure). Review found `commit`/`getBlock` on a not-open store also threw `SC-STORE-1`, which would misroute a programming error through any "directory in use" handler. Not-open now throws `SC-STORE-2` (same `StoreError` class, distinct code); `SC-STORE-1` remains exclusively the contention/boot code. Callers in epic 3 should treat `SC-STORE-2` as a bug (store used before `open`), never as contention.
- **`isAlive()` dead signal = `ESRCH` only** (per the plan). EPERM (other-user holder) and any unexpected errno are treated as alive — the store never steals a lock it cannot prove dead. A stale lock from a *crashed* process always probes ESRCH, so takeover is unaffected.
- **`close()` only unlinks a lockfile that still holds this process's PID.** If a stale-takeover already replaced it, the new holder's lock is left intact (AD-9 single-writer). Normal close (lock still ours) is unchanged.
- **`deadPid()` test helper** spawns a real `node -e process.exit(0)` child and waits for its exit — a guaranteed-dead PID (no high-PID collision flake on busy machines).

## Plan Change Log

(empty)

## Review Triage Log

- **medium — `patch`** — `StoreError` hardcoded `SC-STORE-1` and `commit`/`getBlock` on a not-open store threw it, contradicting the plan's Always rule that `SC-STORE-1` = lock contention; a boot path special-casing `SC-STORE-1` ("directory in use") would misread a not-open programming error. Verified against the class + both guard sites. Fix: not-open now throws `SC-STORE-2` (distinct code, same error class); `SC-STORE-1` reserved for contention. Added a NOT_OPEN test pinning both codes.
- **medium — `patch`** — `isAlive()` returned `code === 'EPERM'`, i.e. ANY non-EPERM errno (incl. unexpected ones) classified the holder as dead → steal, the inverse of the plan's documented conservative bias and its own docstring; the plan names `ESRCH` as the only dead signal. Verified: the catch block inverted the bias. Fix: `return code !== 'ESRCH'` — only a provably-dead PID is stolen; EPERM and any other errno keep the lock.
- **low — `patch`** — `close()` unlinked `.lock` unconditionally. The filed cross-holder race (old holder's deferred close deleting the new holder's lock) is not demonstrable — the holder would have to be alive while its PID probes dead — so the claimed corruption is `maybe-false`; but the unconditional unlink is a real latent gap against the AD-9 single-writer invariant and the fix is trivial. Fix: `close()` now unlinks only when the lockfile still names this process's PID (re-read via `readHolderPid`); a lock already taken over is left for the new holder.
- **false — rejected** — "`close()` is a no-op when `open()` failed partway, leaving directories behind." Verified: a contended directory must already exist (the live holder created it), so the store's own `mkdirSync` never precedes a contended lock in a way that leaves new directories — `mkdirSync(recursive)` on the existing dir is a no-op; the only "leftover" is an empty `blocks/` subdir in a dir that already existed, with no correctness impact. The cleanup pattern the reviewer imagines does not leak state.
