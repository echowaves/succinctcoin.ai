/**
 * `core/discovery/address-book` — the CAP-7 address book (ticket 8.4):
 * keyed by `identityId` (ONE identity, many addresses — DHCP/NAT rotation is
 * natural, identities persist), every entry tagged `(source class,
 * first-seen slot)` with source classes ordered block > log > dns > hint
 * (discovery-design.md's trust taxonomy).
 *
 * Verify-before-connect is THE rule, and it is STRUCTURAL: the only paths
 * into the book run the pinned validators (`validatePeerAnnouncement` /
 * `validateIntroduction`) on the raw decoded record internally — an
 * unsigned, forged, wrong-chain, or expired-at-ingest record CANNOT enter,
 * so `dialEligible(slot)` can never contain one. Callers hand in UNTRUSTED
 * wire data; nothing is trusted until checked.
 *
 * Rules (pinned by the ticket):
 *  - block-grade entries come from 8.3's emission and store their ORIGINAT-
 *    ING BLOCK (`blockRef`); `retractBlock(hash)` removes exactly the
 *    entries whose current provenance is that block (reorg retraction —
 *    key-by-block, not replay-from-head).
 *  - hint/dns-grade entries become dial-eligible only after >= 3 intro-
 *    ductions from DISTINCT signers; log-grade needs >= 1 ("corroborate,
 *    then dial"); block-grade needs none while fresh. Introductions for a
 *    not-yet-known subject are PARKED (validated first) and merged when the
 *    subject's record arrives — gossip order cannot demote a vouch.
 *  - expiry is a function of the CALLER-SUPPLIED slot (AD-3: no clocks,
 *    ever); quarantine-after-3-failed-dials likewise.
 *  - book size cap with deterministic eviction preferring freshest /
 *    highest-class records (the ticket's "under pressure" unknown).
 *
 * Purity (AD-3/AD-10): NO clock, NO net, NO fs — every time-dependent
 * method takes `currentSlot` as a parameter. This module decides who is
 * SAFE TO DIAL; the dialing itself is 8.5's fallback ladder.
 */
import { ip6Slash64 } from '../net/address-policy.js'
import { validatePeerAnnouncement } from './announcements.js'
import { emptyPeerHistory, ewmaUpdate, scorePeer, STABILITY_WINDOW_SLOTS } from './peer-score.js'
import type { PeerHistory } from './peer-score.js'
import type { AnnouncementRejectReason, SignedPeerAnnouncement } from './announcements.js'
import { validateIntroduction } from './introductions.js'
import type { IntroductionRejectReason, SignedIntroduction } from './introductions.js'

// ---------------------------------------------------------------------------
// vocabulary
// ---------------------------------------------------------------------------

/** Trust classes, most trusted first (discovery-design.md taxonomy).
 * `invite` (9.2) sits between block and log: a verified invitation carries
 * signature + freshness + chain scope + TICKET LIVENESS — the door itself is
 * the trust event, so no introductions top it up. It never carries a
 * `blockRef`: that field stays exactly block-provenance (reorg retraction). */
export const ADDRESS_SOURCE_CLASSES = ['block', 'invite', 'log', 'dns', 'hint'] as const
export type AddressSourceClass = (typeof ADDRESS_SOURCE_CLASSES)[number]

/** Higher = more trusted. `block`/`invite` have producers today; `log`/`dns`
 * are enum-only stubs (no producers ship). */
const CLASS_RANK: Record<AddressSourceClass, number> = { block: 4, invite: 3, log: 2, dns: 1, hint: 0 }

/** Introductions required for eligibility per class (pinned table): block /
 * invite none while fresh; log >= 1; dns/hint >= 3 (three-introductions). */
const REQUIRED_INTRODUCTIONS: Record<AddressSourceClass, number> = {
  block: 0,
  invite: 0,
  log: 1,
  dns: 3,
  hint: 3,
}

/** Dial failures before quarantine, and the quarantine's slot window. */
export const DIAL_FAILURES_TO_QUARANTINE = 3
export const DEFAULT_QUARANTINE_SLOTS = 32n

/** Book size cap (entries); eviction prefers freshest/highest-class.
 * 9.3: 64 → 100 — the spec's "other nodes up to 100 total" fill target. */
export const MAX_BOOK_ENTRIES = 100

/** /64 diversity floor (9.3): at most this many entries may share one IPv6
 * /64. At cap it forces ≥ 4 distinct prefixes — a single provider's address
 * block can never monopolise the dial surface (the crawl's eviction honours
 * it; the group is taken from each entry's first policy-valid /ip6). */
export const MAX_ENTRIES_PER_64 = 32

/** Distinct vouches retained per subject (entry OR parked) — the memory
 * bound: one key flooding introductions cannot grow a vouch map without
 * limit. Eviction keeps the FRESHEST vouches (newest slotObserved). */
export const MAX_VOUCHES_PER_SUBJECT = 16

const HEX_ID_64 = /^[0-9a-f]{64}$/

/** Provenance of a block-grade entry — the reorg-retraction key (8.3's
 * emission ctx, verbatim). */
export interface BlockRef {
  /** Hex of the block whose application anchored the record. */
  blockHashHex: string
  /** The block's slot (chain time; informational — provenance keys on hash). */
  slot: bigint
}

/** A book entry as read from outside (immutable snapshot shape). */
export interface AddressBookEntry {
  identityId: string
  multiaddrs: readonly string[]
  observedExternalAddr?: string | undefined
  slotStart: bigint
  slotEnd: bigint
  sourceClass: AddressSourceClass
  /** Slot at which THIS identity first entered the book (never overwritten —
   * replacements preserve it: identities persist across address rotation). */
  firstSeenSlot: bigint
  /** Set exactly when `sourceClass === 'block'`. */
  blockRef?: BlockRef | undefined
  /** Distinct verified introduction signers held for this identity. */
  introductionSigners: readonly string[]
  failedDials: number
  /** While `currentSlot <= quarantineUntilSlot` the entry is ineligible. */
  quarantineUntilSlot?: bigint | undefined
  /** The verified record's ORIGINAL signature bytes (9.3): the peer-book
   * server re-emits served records for OTHER peers and can never re-sign
   * them — only the original holder's bytes verify. Copy on read. */
  signature: Uint8Array
  /** Local reliability history (9.4) — selection signal only, NEVER an
   * eligibility input. Copy on read; corroborations = distinct introduc-
   * tion signers + block provenance. */
  history: PeerHistory
}

/** What the dialer (8.5) consumes — addresses only, never book internals. */
export interface DialTarget {
  identityId: string
  multiaddrs: readonly string[]
  observedExternalAddr?: string | undefined
  sourceClass: AddressSourceClass
}

/** Ingest context: the announcement validator's ctx + provenance tagging. */
export interface BookIngestContext {
  currentSlot: number | bigint
  expectedChainId: string
  /** The class this observation came from (the caller attests the SOURCE;
   * the record itself is validated regardless — the class buys eligibility,
   * never trust in the bytes). */
  sourceClass: AddressSourceClass
  /** REQUIRED for block-grade (reorg retraction key); must be omitted for
   * every other class (a hint claiming a block ref is a programming error). */
  blockRef?: BlockRef | undefined
}

export type BookIngestResult = { ok: true } | { ok: false; reason: AnnouncementRejectReason }
export type BookIntroResult = { ok: true } | { ok: false; reason: IntroductionRejectReason }

export interface AddressBookOptions {
  /** Entry cap (default {@link MAX_BOOK_ENTRIES}). */
  maxEntries?: number
  /** Quarantine window in slots (default {@link DEFAULT_QUARANTINE_SLOTS}). */
  quarantineSlots?: bigint
  /** CAP-7 (8.5): this node's own identity id. When set, records that
   * describe THIS node are accepted-but-ignored — the book is the dial
   * surface, and a node never dials itself, so self-observations must not
   * occupy capacity or appear in {@link AddressBook.dialEligible}. */
  selfIdentityId?: string | undefined
}

export interface AddressBook {
  /** Validate-then-insert a peer announcement record (block-grade ingest
   * consumes 8.3's emission: record + `{ blockHashHex, slot }`). Stale
   * records (older than the held one for that identity) are accepted-but-
   * ignored — they are valid observations, just not better ones. */
  ingestAnnouncement(record: unknown, ctx: BookIngestContext): BookIngestResult
  /** Validate-then-park/merge an introduction (8.4's contract). */
  ingestIntroduction(record: unknown, ctx: { currentSlot: number | bigint; expectedChainId: string }): BookIntroResult
  /** A dial attempt to this identity FAILED at `currentSlot`: 3 failures
   * quarantine the entry for the configured window, and the reliability
   * dial EWMA takes a 0-sample (9.4 — ordering signal only). Unknown id =
   * no-op. */
  recordDialFailure(identityId: string, currentSlot: number | bigint): void
  /** A successful dial clears the failure counter AND any quarantine, and
   * samples the dial EWMA with 1 (plus the latency EWMA when `latencyMs`
   * is measured — 9.4). */
  recordDialSuccess(identityId: string, latencyMs?: number): void
  /** The narrow data-validity sink (9.4): `valid` of `total` records
   * SOURCED FROM this peer verified — ingest VERDICTS, so a stale-but-valid
   * record counts as valid evidence even when the book no longer needs it
   * (the crawler feeds it per peer-book response). Feeds only the
   * reliability score — never eligibility. */
  recordSourcedData(identityId: string, valid: number, total: number): void
  /** The local reliability score in [0,1] (9.4) — an ORDERING signal for
   * crawl/serve/eviction; NEVER read by eligibility or validation. An
   * unknown id scores as a fresh history. */
  score(identityId: string): number
  /** Reorg retraction: remove exactly the entries whose CURRENT provenance
   * is this block. Returns how many entries were removed. Unknown hash =
   * no-op (0). */
  retractBlock(blockHashHex: string): number
  /** THE verify-before-connect surface: identities eligible to dial AT
   * `currentSlot` — fresh, unexpired, un-quarantined, and class-promoted.
   * Sorted by identityId hex (deterministic). */
  dialEligible(currentSlot: number | bigint): DialTarget[]
  /** Full read view (no eligibility/slot filter — slot-scoped reads go
   * through `dialEligible`), sorted by identityId hex — for the
   * read-API/8.5/tests. */
  entries(): AddressBookEntry[]
  /** Drop every entry expired AT `currentSlot`; returns how many went. */
  pruneExpired(currentSlot: number | bigint): number
  size(): number
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

/** Mutable local reliability history (9.4) — see {@link PeerHistory}. */
interface MutableHistory {
  dialEwma?: number | undefined
  latencyEwmaMs?: number | undefined
  /** Distinct recent slots with a valid record for this identity, oldest
   * first, bounded to the stability window. */
  seenSlots: bigint[]
  sourcedValid: number
  sourcedTotal: number
}

function freshHistory(): MutableHistory {
  return { seenSlots: [], sourcedValid: 0, sourcedTotal: 0 }
}

/** Stamp the slot in which this install/update was observed (9.4 stabil-
 * ity): deduped, oldest-evicted beyond the window. */
function stampSlot(history: MutableHistory, currentSlot: bigint): void {
  if (!history.seenSlots.includes(currentSlot)) history.seenSlots.push(currentSlot)
  while (history.seenSlots.length > STABILITY_WINDOW_SLOTS) history.seenSlots.shift()
}

interface MutableEntry {
  identityId: string
  multiaddrs: string[]
  observedExternalAddr?: string | undefined
  slotStart: bigint
  slotEnd: bigint
  sourceClass: AddressSourceClass
  firstSeenSlot: bigint
  blockRef?: BlockRef | undefined
  /** signer identityId -> newest validated slotObserved (distinct signers
   * only — the independence rule; one signer can never mint three vouches). */
  introductions: Map<string, bigint>
  failedDials: number
  quarantineUntilSlot?: bigint | undefined
  /** Original verified signature (9.3 peer-book re-serve; see entry view). */
  signature: Uint8Array
  /** Local reliability history (9.4); never an eligibility input. */
  history: MutableHistory
}

function coerce(v: number | bigint): bigint {
  const b = typeof v === 'bigint' ? v : Number.isSafeInteger(v) && v >= 0 ? BigInt(v) : null
  if (b === null || b < 0n) throw new RangeError(`address-book: ${String(v)} is not a slot`)
  return b
}

/** The reliability view of an entry: history plus corroboration (distinct
 * introduction signers + block provenance). */
function historyView(e: MutableEntry): PeerHistory {
  return {
    dialEwma: e.history.dialEwma,
    latencyEwmaMs: e.history.latencyEwmaMs,
    seenSlots: [...e.history.seenSlots],
    sourcedValid: e.history.sourcedValid,
    sourcedTotal: e.history.sourcedTotal,
    // Independent SOURCES only — distinct verified introduction signers.
    // Block provenance already wins its trust-class tier; adding it here
    // would silently re-rank classes inside one score (9.3 serve order).
    corroborations: e.introductions.size,
  }
}

/** (9.4) Eviction ordering: trust class stays a HARD tier — reliability
 * never rescues a hint over an invite. WITHIN a class the lower score
 * loses its seat first; equal scores fall back to the legacy (slotEnd,
 * firstSeen, id) order. The entry returned LOSES. */
function worseReliability(a: MutableEntry, b: MutableEntry): MutableEntry {
  const ra = CLASS_RANK[a.sourceClass]
  const rb = CLASS_RANK[b.sourceClass]
  if (ra !== rb) return ra < rb ? a : b
  const sa = scorePeer(historyView(a))
  const sb = scorePeer(historyView(b))
  if (sa !== sb) return sa < sb ? a : b
  // Same class, same score: the legacy slot order decides (deterministic).
  if (a.slotEnd !== b.slotEnd) return a.slotEnd < b.slotEnd ? a : b
  if (a.firstSeenSlot !== b.firstSeenSlot) return a.firstSeenSlot < b.firstSeenSlot ? a : b
  return a.identityId <= b.identityId ? a : b
}

/** Frozen rule: QUARANTINE EXPIRY resets the failure counter (as a dial
 * success does) — otherwise one stale failure after the window re-mints a
 * full quarantine instantly, and an occasional-failer never recovers. */
function expireQuarantine(e: MutableEntry, currentSlot: bigint): void {
  if (e.quarantineUntilSlot !== undefined && currentSlot > e.quarantineUntilSlot) {
    delete e.quarantineUntilSlot
    e.failedDials = 0
  }
}

/** Keep the vouch map bounded, evicting the OLDEST slotObserved (ties: the
 * lexicographically-greatest signer id — deterministic). One eviction per
 * insertion is enough: maps only grow one vouch at a time. */
function capVouches(vouches: Map<string, bigint>): void {
  if (vouches.size <= MAX_VOUCHES_PER_SUBJECT) return
  let worstSigner: string | undefined
  let worstSlot: bigint | undefined
  for (const [signer, slot] of vouches) {
    if (
      worstSlot === undefined ||
      slot < worstSlot ||
      (slot === worstSlot && signer > (worstSigner ?? ''))
    ) {
      worstSigner = signer
      worstSlot = slot
    }
  }
  if (worstSigner !== undefined) vouches.delete(worstSigner)
}

function isEligible(e: MutableEntry, currentSlot: bigint): boolean {
  if (e.slotStart > currentSlot || e.slotEnd < currentSlot) return false
  if (e.quarantineUntilSlot !== undefined && currentSlot <= e.quarantineUntilSlot) return false
  let count = 0
  for (const slot of e.introductions.values()) if (slot <= currentSlot) count += 1
  return count >= REQUIRED_INTRODUCTIONS[e.sourceClass]
}

// ---------------------------------------------------------------------------
// the factory
// ---------------------------------------------------------------------------

/**
 * Create an empty address book. Pure state — every time-dependent behavior
 * is parameterized by `currentSlot` (AD-3). Not thread/lock relevant: one
 * per node process, like the loop.
 */
export function createAddressBook(opts: AddressBookOptions = {}): AddressBook {
  const maxEntries = opts.maxEntries ?? MAX_BOOK_ENTRIES
  const quarantineSlots = opts.quarantineSlots ?? DEFAULT_QUARANTINE_SLOTS
  const selfIdentityId = opts.selfIdentityId
  // Safe read of one string field from an untrusted record (pre-validation
  // the shape is unknown; a non-object or non-string field is simply "not
  // self" — validation still judges it afterwards).
  const describesSelf = (record: unknown, field: string): boolean =>
    selfIdentityId !== undefined &&
    typeof record === 'object' &&
    record !== null &&
    (record as Record<string, unknown>)[field] === selfIdentityId

  const entriesById = new Map<string, MutableEntry>()
  /** blockHashHex -> identity ids whose CURRENT provenance is that block. */
  const byBlock = new Map<string, Set<string>>()
  /** Validated intros for subjects not yet in the book (bounded below). */
  const pending = new Map<string, Map<string, bigint>>()

  function detachProvenance(id: string, ref: BlockRef | undefined): void {
    if (ref === undefined) return
    const set = byBlock.get(ref.blockHashHex)
    if (set === undefined) return
    set.delete(id)
    if (set.size === 0) byBlock.delete(ref.blockHashHex)
  }

  function attachProvenance(id: string, ref: BlockRef | undefined): void {
    if (ref === undefined) return
    let set = byBlock.get(ref.blockHashHex)
    if (set === undefined) {
      set = new Set()
      byBlock.set(ref.blockHashHex, set)
    }
    set.add(id)
  }

  function dropEntry(id: string): void {
    const e = entriesById.get(id)
    if (e === undefined) return
    detachProvenance(id, e.blockRef)
    entriesById.delete(id)
  }

  /** The /64 group key of an entry's addresses (9.3 floor): first address
   * whose /ip6 yields a group; null when none does (defensive — validated
   * records always carry a policy-valid /ip6). */
  function slash64Of(multiaddrs: readonly string[]): string | null {
    for (const a of multiaddrs) {
      const g = ip6Slash64(a)
      if (g !== null) return g
    }
    return null
  }

  function snapshot(e: MutableEntry): AddressBookEntry {
    return {
      identityId: e.identityId,
      multiaddrs: [...e.multiaddrs],
      observedExternalAddr: e.observedExternalAddr,
      slotStart: e.slotStart,
      slotEnd: e.slotEnd,
      sourceClass: e.sourceClass,
      firstSeenSlot: e.firstSeenSlot,
      blockRef: e.blockRef === undefined ? undefined : { ...e.blockRef },
      introductionSigners: [...e.introductions.keys()],
      failedDials: e.failedDials,
      quarantineUntilSlot: e.quarantineUntilSlot,
      signature: e.signature.slice(),
      history: historyView(e),
    }
  }

  function mergePending(e: MutableEntry): void {
    const parked = pending.get(e.identityId)
    if (parked === undefined) return
    for (const [signer, slot] of parked) {
      const held = e.introductions.get(signer)
      if (held === undefined || slot > held) e.introductions.set(signer, slot)
    }
    capVouches(e.introductions) // a merge can top the cap even when neither side topped it
    pending.delete(e.identityId)
  }

  return {
    ingestAnnouncement(record: unknown, ctx: BookIngestContext): BookIngestResult {
      const currentSlot = coerce(ctx.currentSlot)
      // Provenance contract is a programming error, not hostile input.
      if (ctx.sourceClass === 'block' && ctx.blockRef === undefined) {
        throw new Error('address-book: block-grade ingest requires a blockRef (reorg key)')
      }
      if (ctx.sourceClass !== 'block' && ctx.blockRef !== undefined) {
        throw new Error(`address-book: ${ctx.sourceClass}-grade ingest must not carry a blockRef`)
      }
      if (ctx.blockRef !== undefined && !HEX_ID_64.test(ctx.blockRef.blockHashHex)) {
        throw new Error('address-book: blockRef.blockHashHex is not 32-byte hex')
      }
      // Self-exclusion (8.5): a node's own announcements are valid observa-
      // tions but never dial targets — accepted-and-ignored, like a stale one.
      if (describesSelf(record, 'identityId')) return { ok: true }

      const verdict = validatePeerAnnouncement(record, {
        currentSlot,
        expectedChainId: ctx.expectedChainId,
      })
      if (!verdict.ok) return verdict
      // Validator-approved: the shape is now a pinned fact (D5 taxonomy).
      const r = record as SignedPeerAnnouncement
      const slotStart = coerce(r.slotStart)
      const slotEnd = coerce(r.slotEnd)

      const existing = entriesById.get(r.identityId)
      if (existing !== undefined) {
        // Newest-slotEnd-wins; tie -> higher class; equal (slotEnd, class)
        // keeps the held entry (stable). A stale-but-valid observation is
        // NOT an error — it simply does not improve the book.
        const better =
          slotEnd > existing.slotEnd ||
          (slotEnd === existing.slotEnd && CLASS_RANK[ctx.sourceClass] > CLASS_RANK[existing.sourceClass])
        if (!better) return { ok: true }
        // Replacement PRESERVES identity-scoped state: firstSeenSlot, the
        // collected introductions, and quarantine (a fresher record may list
        // the same bad addresses — only a successful dial clears that).
        const preservedIntros = existing.introductions
        const preservedFirstSeen = existing.firstSeenSlot
        const preservedFailures = existing.failedDials
        const preservedQuarantine = existing.quarantineUntilSlot
        const preservedHistory = existing.history // 9.4: reliability survives record rotation
        detachProvenance(r.identityId, existing.blockRef)
        entriesById.delete(r.identityId)
        install(r.identityId, slotStart, slotEnd, preservedIntros, preservedFirstSeen)
        const e = entriesById.get(r.identityId) as MutableEntry
        e.failedDials = preservedFailures
        if (preservedQuarantine !== undefined) e.quarantineUntilSlot = preservedQuarantine
        e.history = preservedHistory
        stampSlot(e.history, currentSlot)
        return { ok: true }
      }

      // Capacity + diversity (9.2 contest, 9.3 floor). The rules compose:
      //   (/64 FLOOR) installing must never push the incoming record's /64
      //     group past MAX_ENTRIES_PER_64. When its group is already full:
      //       - book NOT full ⇒ DROP — there is room in the book, but not in
      //         this /64; the floor never churn-evicts inside a quiet book;
      //       - book full ⇒ the victim MUST come from that same group (a
      //         member it strictly beats), else drop. A crowded /64 can never
      //         grow by evicting a different-prefix seat — and pruning that
      //         frees a slot does NOT bypass this (9.3 review finding 7).
      //   (class/slot contest) when the book is full and the floor does not
      //     bind, the incoming record installs only if strictly better than
      //     the weakest entry under the (class, score, slotEnd, firstSeen,
      //     id) order — 9.4: reliability orders seats WITHIN a trust class.
      // The loser is dropped silently: the record stays valid, the book just
      // has no room for it (same ok:true as self-exclusion).
      const challenger: MutableEntry = {
        identityId: r.identityId,
        multiaddrs: [...r.multiaddrs],
        sourceClass: ctx.sourceClass,
        slotStart,
        slotEnd,
        firstSeenSlot: currentSlot,
        introductions: new Map(),
        failedDials: 0,
        signature: r.signature instanceof Uint8Array ? r.signature : new Uint8Array(0),
        history: freshHistory(),
      }
      // 9.4: the challenger was observed THIS slot too — stamp before any
      // seat contest so stability never stacks the deck against it.
      stampSlot(challenger.history, currentSlot)
      const incomingGroup = slash64Of(r.multiaddrs)
      let inGroup = 0
      if (incomingGroup !== null) {
        for (const e of entriesById.values())
          if (slash64Of(e.multiaddrs) === incomingGroup) inGroup += 1
      }

      if (entriesById.size < maxEntries) {
        // Room overall — the floor is the ONLY constraint left standing.
        if (incomingGroup !== null && inGroup >= MAX_ENTRIES_PER_64) return { ok: true }
      } else {
        pruneExpiredInner(currentSlot)
        if (entriesById.size >= maxEntries) {
          // Full book: a seat must be traded. Pick the victim — same-group
          // weakest when the floor binds, else the global weakest.
          let victim: MutableEntry | undefined
          for (const e of entriesById.values()) {
            if (incomingGroup !== null && inGroup >= MAX_ENTRIES_PER_64) {
              if (slash64Of(e.multiaddrs) !== incomingGroup) continue
              victim = victim === undefined ? e : worseReliability(victim, e)
            } else {
              victim = victim === undefined ? e : worseReliability(victim, e)
            }
          }
          if (victim === undefined || worseReliability(victim, challenger) !== victim) {
            return { ok: true } // the incoming record lost the seat — dropped
          }
          dropEntry(victim.identityId)
        } else if (incomingGroup !== null && inGroup >= MAX_ENTRIES_PER_64) {
          return { ok: true } // pruning made room overall — the /64 stays full
        }
      }
      install(r.identityId, slotStart, slotEnd, new Map(), currentSlot)
      return { ok: true }

      function install(
        id: string,
        start: bigint,
        end: bigint,
        intros: Map<string, bigint>,
        firstSeen: bigint,
      ): void {
        const entry: MutableEntry = {
          identityId: id,
          multiaddrs: [...r.multiaddrs],
          observedExternalAddr: r.observedExternalAddr,
          slotStart: start,
          slotEnd: end,
          sourceClass: ctx.sourceClass,
          firstSeenSlot: firstSeen,
          blockRef: ctx.blockRef === undefined ? undefined : { ...ctx.blockRef },
          introductions: intros,
          failedDials: 0,
          // The validator verified THIS signature against these exact fields;
          // storing it lets the peer-book server re-serve the record byte-true.
          signature: r.signature instanceof Uint8Array ? r.signature.slice() : new Uint8Array(0),
          history: freshHistory(),
        }
        stampSlot(entry.history, currentSlot) // 9.4: this slot counts as seen
        entriesById.set(id, entry)
        attachProvenance(id, entry.blockRef)
        mergePending(entry)
      }
    },

    ingestIntroduction(
      record: unknown,
      ctx: { currentSlot: number | bigint; expectedChainId: string },
    ): BookIntroResult {
      const currentSlot = coerce(ctx.currentSlot)
      // Self-exclusion, same rule as announcements: an introduction whose
      // SUBJECT is this node never enters the book (nor the pending map).
      if (describesSelf(record, 'subjectIdentityId')) return { ok: true }
      const verdict = validateIntroduction(record, {
        currentSlot,
        expectedChainId: ctx.expectedChainId,
      })
      if (!verdict.ok) return verdict
      const r = record as SignedIntroduction
      const slotObserved = coerce(r.slotObserved)

      const entry = entriesById.get(r.subjectIdentityId)
      if (entry !== undefined) {
        const heldNow = entry.introductions.get(r.signerIdentityId)
        if (heldNow === undefined || slotObserved > heldNow) {
          entry.introductions.set(r.signerIdentityId, slotObserved)
          capVouches(entry.introductions)
        }
        return { ok: true }
      }
      // Parked for a subject not yet known — validated NOW, merged when the
      // record arrives. Bounded: at most `maxEntries` subjects parked (the
      // one whose NEWEST vouch is oldest goes first — deterministic, and it
      // keeps the freshest waiting state), and each parked subject's vouch
      // map is capped like a live entry's.
      if (!pending.has(r.subjectIdentityId) && pending.size >= maxEntries) {
        let worstSubject: string | undefined
        let worstNewest: bigint | undefined
        for (const [subject, bySigner] of pending) {
          let newest = 0n
          for (const slot of bySigner.values()) if (slot > newest) newest = slot
          if (
            worstNewest === undefined ||
            newest < worstNewest ||
            (newest === worstNewest && subject > (worstSubject ?? ''))
          ) {
            worstSubject = subject
            worstNewest = newest
          }
        }
        if (worstSubject !== undefined) pending.delete(worstSubject)
      }
      let bySigner = pending.get(r.subjectIdentityId)
      if (bySigner === undefined) {
        bySigner = new Map()
        pending.set(r.subjectIdentityId, bySigner)
      }
      const held = bySigner.get(r.signerIdentityId)
      if (held === undefined || slotObserved > held) {
        bySigner.set(r.signerIdentityId, slotObserved)
        capVouches(bySigner)
      }
      return { ok: true }
    },

    recordSourcedData(identityId: string, valid: number, total: number): void {
      const e = entriesById.get(identityId)
      if (e === undefined) return
      if (!(total > 0)) return
      e.history.sourcedValid += Math.max(0, Math.trunc(valid))
      e.history.sourcedTotal += Math.max(0, Math.trunc(total))
    },

    score(identityId: string): number {
      const e = entriesById.get(identityId)
      return scorePeer(e === undefined ? emptyPeerHistory() : historyView(e))
    },

    recordDialFailure(identityId: string, currentSlot: number | bigint): void {
      const e = entriesById.get(identityId)
      if (e === undefined) return
      expireQuarantine(e, coerce(currentSlot)) // an expired window starts fresh
      e.failedDials += 1
      // 9.4: the reliability dial EWMA samples 0 — an ORDERING signal, and
      // deliberately NOT what quarantines anything (that stays the counter).
      e.history.dialEwma = ewmaUpdate(e.history.dialEwma, 0)
      if (e.failedDials >= DIAL_FAILURES_TO_QUARANTINE) {
        e.quarantineUntilSlot = coerce(currentSlot) + quarantineSlots
      }
    },

    recordDialSuccess(identityId: string, latencyMs?: number): void {
      const e = entriesById.get(identityId)
      if (e === undefined) return
      e.failedDials = 0
      delete e.quarantineUntilSlot
      // 9.4: success samples the dial EWMA with 1; a measured dial duration
      // samples the latency EWMA (raw ms — scorePeer applies the cap).
      e.history.dialEwma = ewmaUpdate(e.history.dialEwma, 1)
      if (latencyMs !== undefined && Number.isFinite(latencyMs) && latencyMs >= 0) {
        e.history.latencyEwmaMs = ewmaUpdate(e.history.latencyEwmaMs, latencyMs)
      }
    },

    retractBlock(blockHashHex: string): number {
      const ids = byBlock.get(blockHashHex)
      if (ids === undefined) return 0
      let removed = 0
      for (const id of ids) {
        const e = entriesById.get(id)
        // Only entries whose CURRENT provenance is this block — a record
        // superseded by a fresher one from another block already detached.
        if (e !== undefined && e.blockRef?.blockHashHex === blockHashHex) {
          dropEntry(id)
          removed += 1
        }
      }
      byBlock.delete(blockHashHex)
      return removed
    },

    dialEligible(currentSlot: number | bigint): DialTarget[] {
      const slot = coerce(currentSlot)
      const out: DialTarget[] = []
      for (const e of entriesById.values()) {
        expireQuarantine(e, slot)
        if (isEligible(e, slot)) {
          out.push({
            identityId: e.identityId,
            multiaddrs: [...e.multiaddrs],
            observedExternalAddr: e.observedExternalAddr,
            sourceClass: e.sourceClass,
          })
        }
      }
      return out.sort((a, b) => (a.identityId < b.identityId ? -1 : a.identityId > b.identityId ? 1 : 0))
    },

    entries(): AddressBookEntry[] {
      return [...entriesById.values()]
        .map(snapshot)
        .sort((a, b) => (a.identityId < b.identityId ? -1 : a.identityId > b.identityId ? 1 : 0))
    },

    pruneExpired(currentSlot: number | bigint): number {
      return pruneExpiredInner(coerce(currentSlot))
    },

    size(): number {
      return entriesById.size
    },
  }

  function pruneExpiredInner(currentSlot: bigint): number {
    let removed = 0
    for (const e of [...entriesById.values()]) {
      if (e.slotEnd < currentSlot) {
        dropEntry(e.identityId)
        removed += 1
      }
    }
    return removed
  }
}
