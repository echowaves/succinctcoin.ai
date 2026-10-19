/**
 * `core/discovery/crawler` — the bounded BFS peer-book crawl (ticket 9.3).
 *
 * One invite dials ONE peer; that peer's response teaches more peers; the
 * crawl follows them under HARD bounds until the book fills or the frontier
 * runs quiet:
 *
 *  - depth ≤ 3 (seeds are depth 1 — three hops of learning from the door);
 *  - concurrency ≤ 8 in-flight peers (a worker pool, never a fan-out storm);
 *  - ONE dial attempt per address (the injected dial carries the time budget
 *    — AD-3 keeps wall-clock timeouts out of the pure machine);
 *  - book cap = `maxEntries` (100): at cap the crawl stops; storage-side
 *    eviction + /64 floor are the BOOK's rules (9.2/9.3), never re-decided
 *    here;
 *  - quarantine is honoured THROUGH the book: dial outcomes go to
 *    `recordDialFailure`/`recordDialSuccess`, so a flaky identity goes dark
 *    for every consumer, exactly like the 8.5 ladder.
 *
 * THE CRAWL TRUST RULE (pinned — the poison row depends on it): a learned
 * record is crawl-dialable ONLY when the response carried a witness for its
 * subject signed by an identity THIS crawl dialled and heard back from
 * (introducer-corroboration chain, crawl-local). Records without such a
 * witness are stored — at their ingested class, usually hint — and are NEVER
 * dialed. Book trust classes stay untouched: block-grade only via blocks, the
 * three-vouch upgrade stays the book's own path. Verify-before-connect holds
 * at every hop: nothing is dialed that was not signature-verified at ingest,
 * and nothing is followed without a live introducer's vouch.
 *
 * Pure state machine: `request`/`dial`/`currentSlot` are injected (the core
 * wires the adapter; tests wire a synthetic mesh), zero timers, zero RNG —
 * deterministic given the same inputs (AD-3/AD-10).
 */
import { MAX_BOOK_ENTRIES } from './address-book.js'
import type { AddressBook } from './address-book.js'
import { verifyIntroductionSignature } from './introductions.js'
import type { PeerBookServed } from '../net/peerbook.js'

// ---------------------------------------------------------------------------
// bounds (named constants; the tests pin these numbers, not literals)
// ---------------------------------------------------------------------------

/** Hops of learning from the door: seeds (the invited peers) are depth 1. */
export const CRAWL_MAX_DEPTH = 3
/** In-flight peers at any moment (the worker pool size). */
export const CRAWL_CONCURRENCY = 8

// ---------------------------------------------------------------------------
// the machine
// ---------------------------------------------------------------------------

export interface CrawlerDeps {
  /** Ask `address` for up to `limit` records. REJECTS on transport failure
   * (dial-OK-but-request-failed counts the same as a dial failure). */
  request(address: string, limit: number): Promise<PeerBookServed>
  /** Explicit dial (the adapter's; carries the time budget). Rejects fail. */
  dial(address: string): Promise<void>
  /** The book: ingest target AND the quarantine ledger — outcomes are
   * recorded here so every consumer sees one failure history. */
  book: AddressBook
  expectedChainId: string
  /** Sync chain-head getter (AD-3 — injected time). */
  currentSlot(): bigint
  maxEntries?: number
  maxDepth?: number
  concurrency?: number
  /** Cooperative stop (node shutdown): checked between dequeues. */
  stopped?(): boolean
}

/** Counts only (AD-9): no addresses, no records, no keys in the report. */
export interface CrawlReport {
  /** Records accepted at ingest (any class; stored ≠ dialable). */
  stored: number
  /** Successful dials (each preceded by a policy-valid address). */
  dialed: number
  /** Dial or request failures (each recorded against the identity). */
  failed: number
  /** Records learned but never followed (no trusted witness — poison rows). */
  uncorroborated: number
  /** Responses consumed (peers actually crawled). */
  served: number
  maxDepthReached: number
  maxConcurrency: number
  stoppedBy: 'cap' | 'quiet' | 'stopped'
}

interface FrontierItem {
  address: string
  identityId: string
  depth: number
}

/**
 * Run the crawl from `seeds` (the addresses already dialed for the invite /
 * artifact stage, with their identities). Resolves when the frontier drains
 * ('quiet'), the book hits cap ('cap'), or `stopped()` flips ('stopped').
 */
export async function runCrawl(
  deps: CrawlerDeps,
  seeds: readonly { address: string; identityId: string }[],
): Promise<CrawlReport> {
  const maxEntries = deps.maxEntries ?? MAX_BOOK_ENTRIES
  const maxDepth = deps.maxDepth ?? CRAWL_MAX_DEPTH
  const concurrency = Math.max(1, deps.concurrency ?? CRAWL_CONCURRENCY)

  const report: CrawlReport = {
    stored: 0,
    dialed: 0,
    failed: 0,
    uncorroborated: 0,
    served: 0,
    maxDepthReached: 0,
    maxConcurrency: 0,
    stoppedBy: 'quiet',
  }

  const queue: FrontierItem[] = []
  const queuedAddresses = new Set<string>()
  const crawledIdentities = new Set<string>()
  /** Identities we dialed AND got a response from — the ONLY signers whose
   * witnesses make a learned record crawl-dialable. */
  const corroborators = new Set<string>()
  let active = 0

  const enqueue = (item: FrontierItem): void => {
    if (queuedAddresses.has(item.address)) return
    if (crawledIdentities.has(item.identityId)) return
    queuedAddresses.add(item.address)
    queue.push(item)
  }
  for (const seed of seeds) enqueue({ address: seed.address, identityId: seed.identityId, depth: 1 })

  const atCap = (): boolean => deps.book.size() >= maxEntries

  /** One peer: dial → request → ingest records → bind witnesses → enqueue. */
  async function crawlOne(item: FrontierItem): Promise<void> {
    // Dial the specific address (one attempt — the book keeps the score).
    try {
      await deps.dial(item.address)
      report.dialed += 1
      deps.book.recordDialSuccess(item.identityId)
    } catch {
      report.failed += 1
      deps.book.recordDialFailure(item.identityId, deps.currentSlot())
      return
    }
    if (item.depth > report.maxDepthReached) report.maxDepthReached = item.depth

    // Ask for its book — capped by OUR remaining room (min 1: one response
    // still teaches even when nearly full).
    const limit = Math.max(1, maxEntries - deps.book.size())
    let served: PeerBookServed
    try {
      served = await deps.request(item.address, limit)
    } catch {
      report.failed += 1
      deps.book.recordDialFailure(item.identityId, deps.currentSlot())
      return
    }
    report.served += 1
    // From here on, THIS identity vouches: its witnesses count.
    corroborators.add(item.identityId)

    // Ingest EVERY record at hint grade (trust classes preserved — block-
    // grade comes from blocks, never from a response). The book validates
    // sig/freshness/chain/policy and enforces cap + /64 floor itself.
    //
    // THE FOLLOW GATE (9.3 review, hardened): a record is enqueue-able ONLY
    // when it (a) PASSED ingest verification — so its addresses are the
    // subject's own signature-verified, policy-valid multiaddrs — AND (b)
    // carries a witness whose SIGNATURE VERIFIES and whose signer is a
    // corroborator. An unsigned/forged witness object in the response buys
    // nothing: dial targets only ever come from verified records.
    const currentSlot = deps.currentSlot()
    interface Learned {
      identityId: string
      addrs: readonly string[]
      corroborated: boolean
    }
    const learned: Learned[] = []
    for (const record of served.records) {
      const result = deps.book.ingestAnnouncement(record, {
        currentSlot,
        expectedChainId: deps.expectedChainId,
        sourceClass: 'hint',
      })
      if (!result.ok) continue // rejected at ingest: never stored, never followed
      report.stored += 1
      const identityId = String((record as { identityId?: unknown }).identityId ?? '')
      // Signature-valid witnesses for THIS subject from corroborators: each
      // vouches the subject in the book (the normal introductions path) and
      // opens the follow gate. Every valid one is ingested — a responder
      // cannot suppress a genuine co-vouch by ordering junk ahead of it.
      let corroborated = false
      for (const w of served.witnesses) {
        if (String((w as { subjectIdentityId?: unknown }).subjectIdentityId ?? '') !== identityId) continue
        if (!corroborators.has(String((w as { signerIdentityId?: unknown }).signerIdentityId ?? ''))) continue
        if (!verifyIntroductionSignature(w as never, w.signature)) continue
        corroborated = true
        deps.book.ingestIntroduction(w as never, { currentSlot, expectedChainId: deps.expectedChainId })
      }
      const addrs: readonly string[] = Array.isArray((record as { multiaddrs?: unknown }).multiaddrs)
        ? ((record as { multiaddrs: readonly string[] }).multiaddrs as readonly string[])
        : []
      learned.push({ identityId, addrs, corroborated })
    }

    // The crawl dial set: INGESTED records a corroborator validly vouched,
    // at the next depth. (Poison rows — no valid witness — stop here.)
    if (item.depth >= maxDepth) {
      // Depth budget spent: everything learned is stored but not followed.
      report.uncorroborated += learned.filter((l) => !l.corroborated).length
      return
    }
    for (const l of learned) {
      if (l.identityId === '' || crawledIdentities.has(l.identityId)) continue
      if (!l.corroborated) {
        report.uncorroborated += 1
        continue
      }
      for (const address of l.addrs) enqueue({ address, identityId: l.identityId, depth: item.depth + 1 })
    }
  }

  // The worker pool: FIFO dequeue, at most `concurrency` in flight.
  await new Promise<void>((resolveAll) => {
    let settled = false
    const settle = (): void => {
      if (settled) return
      settled = true
      resolveAll()
    }
    const pump = (): void => {
      if (settled) return
      // Hard stops: no new dequeues; IN-FLIGHT workers still finish (their
      // book writes are validated either way), then the run settles.
      const hardStop: CrawlReport['stoppedBy'] | null =
        deps.stopped?.() === true ? 'stopped' : atCap() ? 'cap' : null
      if (hardStop !== null) {
        report.stoppedBy = hardStop
        if (active === 0) settle()
        return
      }
      while (queue.length > 0 && active < concurrency) {
        const item = queue.shift() as FrontierItem
        // CLAIM at dequeue: a second address of an already-claimed identity
        // can never spawn a parallel crawl of the same peer.
        if (crawledIdentities.has(item.identityId)) continue
        crawledIdentities.add(item.identityId)
        // Addresses stay in `queuedAddresses` forever: one dial attempt per
        // address, ever (the per-address budget — the book keeps the score).
        active += 1
        if (active > report.maxConcurrency) report.maxConcurrency = active
        void crawlOne(item).finally(() => {
          active -= 1
          pump()
        })
      }
      // Quiet AFTER the fill: a drain of stale items (every queued identity
      // already claimed) ends the run too — checked only once nothing is in
      // flight and nothing remains.
      if (active === 0 && queue.length === 0) {
        report.stoppedBy = 'quiet' // the natural end
        settle()
      }
    }
    // Kick the pool; the while-loop fills up to `concurrency` immediately and
    // completions top it back up — the observed bound, never exceeded.
    pump()
  })

  return report
}
