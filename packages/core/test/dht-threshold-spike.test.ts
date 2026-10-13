/**
 * 5.8 (SPIKE) — DHT threshold: bootstrap + mDNS vs Kad-DHT (epic-node-network,
 * E2; AD-3/AD-10).
 *
 * A TEST-ONLY spike that settles the DHT-threshold open question (E2) with a
 * MEASURED answer: how many peers a fresh node's connect-reach covers as the
 * node count N grows when the fresh node connects to a KNOWN address list
 * (the bootstrap-list model that bootstrap + mDNS reduce to over the memory
 * transport), and how many connect operations that costs. The answer — the
 * measured numbers + the recommendation — is recorded as a dated `Decision:`
 * line in the epic Notes (AC-2). This file wires NOTHING: no production
 * code, no DHT service, no new dependency (AC-3/AC-4 — the NO_DHT_WIRED
 * guard row below pins the absence).
 *
 * THE MODEL (plan D2 — the honest, CI-runnable reading of "bootstrap + mDNS
 * reach"): a fresh node ("joiner") joins an N-node network by dialing the
 * KNOWN address list of the other N−1 nodes — each a real started
 * `createNetAdapter` node listening on a distinct FLAT memory address
 * `/memory/dht-<N>-peer-<i>` (the joiner on `/memory/dht-<N>-joiner`).
 * (Address-shape note: the `@libp2p/memory` multiaddr protocol is a
 * SINGLE-SEGMENT protocol — a nested path like `/memory/dht-10/joiner`
 * fails multiaddr parsing (`UnknownProtocolError`), so the plan's
 * `/memory/dht-<N>/peer-<i>` shape is flattened to
 * `/memory/dht-<N>-peer-<i>`; the per-N namespace + per-node distinctness
 * are unchanged. See the plan's Implementation Notes.)
 * That is exactly what a genesis
 * bootstrap list (5.3) provides — a set of KNOWN addresses to dial — and
 * over the memory transport the mDNS double (5.3) only ANNOUNCES known
 * multiaddrs, so the known-list dial model subsumes it. DISCOVERY-ONLY: no
 * gossip is published, no mesh is settled — the metric is CONNECT cost, not
 * gossip reach (gossip reach is 5.5/5.6's territory).
 *
 * THE METRICS (AC-1, plan D4 — EVENT-BOUNDED, AD-3):
 *   peersReached = `joiner.peers().length` after all dials (bounded-polled
 *                  to absorb async peer-store updates) — the row pins
 *                  `peersReached === N − 1` (the joiner reaches ALL of them);
 *   dialOps      = the joiner's total `dial()` ATTEMPTS (counted inside the
 *                  bounded-retry helper, one increment per attempt) — the
 *                  row pins `dialOps === N − 1` (one successful dial per
 *                  known address: the connect-reach is LINEAR, not
 *                  exponential; no redundant / retry work).
 * Both are event counts (loop counters + bounded `setTimeout` yields) — this
 * file never reads a wall clock and never uses an RNG (AD-3). The per-case
 * wall-clock duration is NOT captured here: it is read from the test
 * runner's own per-test report (informational context for the Decision
 * only — never asserted).
 *
 * MEMORY-HONESTY SCOPE (plan D5): the memory transport models the CONNECT
 * path in-process — no real broadcast, NAT, or link cost. The sweep is a
 * CI-MODEL measurement of the known-list connect cost, scoped to the launch
 * model (small-to-medium, known-list) + the no-DHT non-goal. It does not
 * claim the known-list model scales to arbitrary real-world N.
 *
 * THE N SWEEP: `it.each` over SWEEP = {10, 50, 200} (top-of-file constant —
 * trivially adjustable). The ticket's suggested range was {10, 50, 200,
 * 1000}, but the N=1000 case is INFEASIBLE for this file's full-reach pin
 * (`peersReached === N − 1`): libp2p 3.3.11's ConnectionPruner (default
 * `maxConnections = 300`) closes excess connections as the joiner dials,
 * so the sustained live set settles BELOW N−1. Measured at N=1000 (two
 * independent runs): dialOps = 999 (the full known list IS dialed, at
 * linear cost, zero retries) but peersReached settles at ~652
 * (scheduling-dependent; the pruner only closes connections whose streams
 * are all speculative identify/autonat — not yet gossipsub-established).
 * The pin holds exactly while N − 1 ≤ 300 — verified at N=300 (299/299).
 * Per the plan's contingency, SWEEP is the LARGEST FEASIBLE set and the
 * N=1000 infeasibility is RECORDED, not silently skipped — see the plan's
 * Implementation Notes + the epic's dated Decision line.
 *
 * The driver MIRRORS the 5.5/5.6/5.7 multi-node shape (D1): separate
 * in-process nodes, each with its own net adapter (memory transport, zero
 * real sockets, AD-10) and its own identity keypair (AD-11 — driver-
 * internal, the secret is never read), composing ONLY root-barrel seams.
 *
 * Rows (plan Matrix):
 *   DHT_SWEEP    (AC-1) `it.each` over N ∈ SWEEP: N−1 started memory nodes +
 *                       1 joiner; the joiner dials the N−1 KNOWN addresses
 *                       (bounded retry, attempts counted) → asserts
 *                       `peersReached === N−1` AND `dialOps === N−1`
 *                       (event-bounded, linear).
 *   NO_DHT_WIRED (AC-3/AC-4) the DHT package is absent from package.json
 *                            (deps + devDeps); self-source scan: this file
 *                            imports only the root barrel `../src/index.js`
 *                            (+ vitest + the node:fs / node:path builtins —
 *                            no @libp2p/*, no @multiformats/*, no other
 *                            node builtin), no wall-clock reads, no RNG;
 *                            TRANSPORT === 'memory'.
 *
 * AD-3 discipline: no wall-clock reads, no RNG — pinned 32-byte identity
 * seeds (`seedFor(i)`, a pure function of i) → `deriveIdentityKeypair`
 * (IMPORTED) → a distinct 4.2 PROTOCOL identity id per node.
 * AD-11 discipline: the keypair is a driver-internal value; this file NEVER
 * reads its secret (the spike is discovery-only — no tickets, no signing).
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { createNetAdapter, deriveIdentityKeypair } from '../src/index.js'
import type { NetAdapter } from '../src/index.js'

// ---------------------------------------------------------------------------
// pinned parameters (5.8 — deterministic, AD-3)
// ---------------------------------------------------------------------------

/** The transport flag (AD-10 — zero real sockets in CI). */
const TRANSPORT = 'memory' as const

/**
 * The N sweep — the LARGEST FEASIBLE SET of the ticket's suggested range
 * {10, 50, 200, 1000} (trivially adjustable). N=1000 is EXCLUDED: the
 * full-reach pin `peersReached === N − 1` is unachievable there — libp2p
 * 3.3.11's ConnectionPruner (default `maxConnections = 300`) trims the
 * joiner's excess connections (measured: dialOps = 999 but peersReached
 * settles ~652 < 999 — see the file header). The pin holds exactly while
 * N − 1 ≤ 300 (verified at N=300: 299/299 reached). Only ONE case's nodes
 * are alive at a time (cases run sequentially), bounding peak memory to the
 * largest N.
 */
const SWEEP: number[] = [10, 50, 200]

/** Bounded test-side yield (a timer, not a clock read — the 5.2/5.5 pattern). */
const SLEEP_MS = 25
/**
 * Per-address dial-retry bound (the 5.2 established bound — 40 × 25 ms = 1 s):
 * a safety net. Over the memory transport a dial to a STARTED listener
 * succeeds on the first attempt, so the `dialOps === N − 1` pin proves no
 * retry work happened.
 */
const DIAL_POLLS = 40
/**
 * Bounded bound for the joiner's peer-store settle (200 × 25 ms = 5 s):
 * absorbs async peer-store updates after the last dial — an event bound
 * (loop counter + bounded yields), never a wall-clock read.
 */
const PEER_POLL_POLLS = 200

/**
 * Pinned identity seeds (4.8 convention, no RNG): 32 deterministic bytes,
 * DISTINCT for every index the sweep uses (i up to N−1 ≤ 999): the index i is
 * written little-endian into the first 8 bytes, the remaining 24 bytes are
 * filled with 0x40. (The 4.8 one-byte fill `0x40 + i` wraps mod 256 — a
 * complete 256-value permutation for i ∈ 0..255, so the first repeat is at
 * i = 256; the sweep needs distinct seeds up to i = 999, so the index
 * occupies the full 8 bytes.) `deriveIdentityKeypair` (IMPORTED)
 * maps each seed deterministically to a distinct keypair → a distinct
 * `identityId` per node.
 */
function seedFor(i: number): Uint8Array {
  const seed = new Uint8Array(32).fill(0x40)
  for (let b = 0; b < 8; b += 1) {
    seed[b] = (i >> (8 * b)) & 0xff
  }
  return seed
}

// ---------------------------------------------------------------------------
// helpers (the 5.2/5.4/5.5/5.6/5.7 bounded-wait pattern — test-side only)
// ---------------------------------------------------------------------------

/** A test-side bounded yield (a timer, not a clock read — the 5.2/5.3 precedent). */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Resolve a path relative to THIS test file. Uses `node:path` + the global
 * `URL` constructor only (no `node:url` import — the guard row pins node:fs +
 * node:path as the ONLY node builtins this file uses).
 */
function resolveFromTestFile(relative: string): string {
  const testDir = new URL('.', import.meta.url).pathname
  return join(testDir, relative)
}

/** One memory-transport spike node: its own started net adapter. */
interface SpikeNode {
  name: string
  adapter: NetAdapter
}

/**
 * Build one node (the 5.5/5.6/5.7 node factory, spike shape): a started
 * `createNetAdapter` over the memory transport, stamped with the node's 4.2
 * PROTOCOL identity id (derived from the pinned seed — AD-11: the keypair is
 * a driver-internal value, its secret never read). `relayRole: 'none'` — a
 * plain direct-listen node; discovery is OFF (no bootstrap list, no mDNS:
 * the joiner's KNOWN address list is driven EXPLICITLY, the 5.1 dial model).
 */
async function makeNode(
  name: string,
  seedIndex: number,
  listenAddress: string,
): Promise<SpikeNode> {
  const keypair = deriveIdentityKeypair(seedFor(seedIndex))
  const adapter = createNetAdapter({
    transport: TRANSPORT,
    listenAddress,
    protocolIdentityId: keypair.identityId,
    relayRole: 'none',
  })
  await adapter.start()
  return { name, adapter }
}

/**
 * The joiner's dial-attempt counter — the `dialOps` metric (AC-1). The
 * bounded-retry helper below increments it once per `dial()` ATTEMPT
 * (success or failure). Over memory each peer is reached on the first
 * attempt, so the DHT_SWEEP rows pin `dialOps === N − 1` (one dial per known
 * address — linear connect-reach, no redundant work).
 */
interface DialCounter {
  ops: number
}

/**
 * Dial with the established bounded retry (the 5.2/5.5/5.7 pattern), counting
 * every ATTEMPT in `counter` (the dialOps metric). Over the memory transport
 * a dial to a started listener succeeds on the first attempt — the retry is a
 * safety net (a dial to an unknown listener throws a ConnectionFailedError).
 */
async function dialWithRetry(
  adapter: NetAdapter,
  address: string,
  counter: DialCounter,
  polls: number = DIAL_POLLS,
): Promise<void> {
  let lastErr: unknown = null
  for (let attempt = 0; attempt < polls; attempt += 1) {
    counter.ops += 1
    try {
      await adapter.dial(address)
      return
    } catch (err) {
      lastErr = err
      await sleep(SLEEP_MS)
    }
  }
  throw lastErr
}

/**
 * Bounded poll of `adapter.peers().length` (the peersReached metric, AC-1):
 * resolves as soon as the count reaches `expected` (absorbing async
 * peer-store updates after the last dial), or returns the last observed count
 * after `maxPolls` bounded yields (a failed assertion then shows the actual
 * number). Event-bounded (loop counter + bounded yields) — AD-3.
 */
async function pollPeerCount(
  adapter: NetAdapter,
  expected: number,
  maxPolls: number = PEER_POLL_POLLS,
): Promise<number> {
  let count = 0
  for (let attempt = 0; attempt < maxPolls; attempt += 1) {
    count = (await adapter.peers()).length
    if (count === expected) return count
    await sleep(SLEEP_MS)
  }
  return count
}

// ---------------------------------------------------------------------------
// the sweep-case runner (plan T1)
// ---------------------------------------------------------------------------

/** The two metrics the DHT_SWEEP rows pin (AC-1). */
interface SweepMetrics {
  /** `joiner.peers().length` after all dials — pinned to N − 1. */
  peersReached: number
  /** The joiner's total dial() ATTEMPTS — pinned to N − 1 (linear). */
  dialOps: number
}

/**
 * Run one N case of the sweep (plan T1):
 *  1. start N−1 "existing" memory nodes (each on the FLAT memory address
 *     `/memory/dht-<N>-peer-<i>` — the memory protocol is single-segment)
 *     + 1 fresh "joiner" (on `/memory/dht-<N>-joiner`);
 *  2. the joiner — the ONLY dialer (the realistic bootstrap model, plan D2 —
 *     keeps the connect cost O(N), not O(N²)) — dials each of the N−1 KNOWN
 *     addresses (bounded retry, attempts counted in `dialOps`);
 *  3. measure `peersReached` (bounded poll of `joiner.peers().length`);
 *  4. stop EVERY started node in `finally` — even on a failed dial or an
 *     assertion failure — so no case leaks memory-transport listeners into
 *     the next case.
 */
async function runSweepCase(N: number): Promise<SweepMetrics> {
  const counter: DialCounter = { ops: 0 }
  const joiner = await makeNode('joiner', N - 1, `/memory/dht-${N}-joiner`)
  const peers: SpikeNode[] = []
  try {
    const knownAddresses: string[] = []
    for (let i = 0; i < N - 1; i += 1) {
      const listen = `/memory/dht-${N}-peer-${i}`
      peers.push(await makeNode(`peer-${i}`, i, listen))
      knownAddresses.push(listen)
    }
    // The joiner dials each KNOWN address — the bootstrap-list model (D2).
    for (const address of knownAddresses) {
      await dialWithRetry(joiner.adapter, address, counter)
    }
    // Bounded poll to absorb async peer-store updates (AD-3).
    const peersReached = await pollPeerCount(joiner.adapter, N - 1)
    return { peersReached, dialOps: counter.ops }
  } finally {
    // Stop EVERY started node — even on a failed dial or assertion (the
    // memory listeners release with the node).
    await joiner.adapter.stop()
    for (const peer of peers) {
      await peer.adapter.stop()
    }
  }
}

// ---------------------------------------------------------------------------
// DHT_SWEEP (AC-1)
// ---------------------------------------------------------------------------

describe('DHT_SWEEP (AC-1) — a fresh node connecting to the KNOWN address list of the other N−1 nodes reaches ALL of them, at LINEAR dial cost', () => {
  it.each(SWEEP)(
    'N=%i: N−1 existing memory nodes + 1 joiner — the joiner dials the N−1 KNOWN addresses (bounded retry, attempts counted) → peersReached === N−1 (all reached) AND dialOps === N−1 (one dial per address — linear, event-bounded, AD-3)',
    { timeout: 180_000 },
    async (N: number) => {
      const { peersReached, dialOps } = await runSweepCase(N)
      // AC-1 — the connect-reach covers the WHOLE known list:
      expect(peersReached).toBe(N - 1)
      // And the cost is LINEAR — one successful dial per known address (no
      // redundant / retry work over memory):
      expect(dialOps).toBe(N - 1)
    },
  )
})

// ---------------------------------------------------------------------------
// NO_DHT_WIRED (AC-3, AC-4)
// ---------------------------------------------------------------------------

describe('NO_DHT_WIRED (AC-3/AC-4) — the spike wires nothing: the DHT package is absent from package.json and this file is root-barrel-only, memory-only, and event-bounded', () => {
  it('the DHT package is ABSENT from package.json (dependencies + devDependencies); self-source scan: root-barrel-only ../src/ import (no @libp2p/*, no @multiformats/*), node:fs + node:path are the ONLY node builtins, no wall-clock reads, no RNG; TRANSPORT === memory', () => {
    // AC-4 — the DHT dependency is ABSENT (the deps diff gate is external;
    // this row pins the absence in-repo):
    const pkg = JSON.parse(
      readFileSync(resolveFromTestFile('../package.json'), 'utf8'),
    ) as {
      dependencies?: Record<string, unknown>
      devDependencies?: Record<string, unknown>
    }
    expect(pkg.dependencies ?? {}).not.toHaveProperty('@libp2p/kad-dht')
    expect(pkg.devDependencies ?? {}).not.toHaveProperty('@libp2p/kad-dht')

    // This file's own source (the self-scan — the 5.7 ADDITIVE pattern):
    const selfSource = readFileSync(
      resolveFromTestFile('dht-threshold-spike.test.ts'),
      'utf8',
    )
    // Root-barrel-only imports: every `../src/` import specifier in this file
    // is the root barrel `../src/index.js` (no deep imports):
    const srcImports = [...selfSource.matchAll(/from\s+['"](\.\.\/src\/[^'"]+)['"]/g)].map(
      (m) => m[1],
    )
    expect(srcImports.length).toBeGreaterThan(0)
    expect([...new Set(srcImports)]).toEqual(['../src/index.js'])
    // No transitive-dependency imports (no @libp2p/*, no @multiformats/* —
    // the test drives the network through the root-barrel surface only):
    expect(selfSource).not.toMatch(/from\s+['"]@libp2p\//)
    expect(selfSource).not.toMatch(/from\s+['"]@multiformats\//)
    // node:fs + node:path are the ONLY node builtins (no node:net, no
    // node:child_process, no node:url, …):
    const nodeImports = [...selfSource.matchAll(/from\s+['"](node:[^'"]+)['"]/g)].map(
      (m) => m[1],
    )
    expect([...new Set(nodeImports)]).toEqual(['node:fs', 'node:path'])
    // AD-3 — no wall-clock reads, no RNG, anywhere in this file:
    expect(selfSource).not.toMatch(/Date\.now\s*\(/)
    expect(selfSource).not.toMatch(/\bMath\.random\s*\(/)
    // Memory transport only (AD-10 — zero real sockets in CI): TRANSPORT is
    // the SINGLE transport selector in this file (makeNode passes it to
    // createNetAdapter), so pinning it pins every node's transport:
    expect(TRANSPORT).toBe('memory')
  })
})
