/**
 * `core/consensus` — the tracer's mining loop (3.2, R3 hot path).
 *
 * `mineBlock(template)` is the per-attempt PoW loop pinned by AD-6:
 *   - increment a PLAIN INTEGER COUNTER,
 *   - set the block's `nonce` field to the counter's u64be form (3.1: the
 *     counter is a FIELD of the canonical digest bytes),
 *   - call `powCheck` (→ `blockDigest` → `canonicalBlockBytes` →
 *     `node:crypto` sha256) once per attempt,
 *   - stop at the first passing counter and set `hash = blockDigest(block)`.
 *
 * This file imports NO `big.js`, NO keccak, NO pure-JS hash, and NO protons
 * `encode` (AD-6): the only per-attempt byte work is the 3.1 PoW seam in
 * `./pow.js` (node:crypto sha256). The standing import scan in
 * `test/consensus-tracer.test.ts` (MINING_PATH_GUARD) fails the suite if a
 * big.js/keccak import ever appears here.
 *
 * The trivial fixed winner + the reserved mint id (replaced by the draw at
 * 3.3, refined by the economic model at 3.6) are the tracer's only protocol
 * choices; slot and parent come from the chain (R4, AD-3).
 */
import type { Block } from '../proto/index.js'
import { blockDigest, powCheck } from './pow.js'

/**
 * The reserved mint identity (3.2 design notes): a pre-funded treasury id
 * that pays each block's fixed-emission reward as an ordinary `apply`
 * transfer `MINT_ID → winner`. The ledger `apply` seam has NO mint path
 * (2.1: an unfunded debit fails SC-LEDGER-1), so the tracer pre-funds
 * `MINT_ID` with `maxSupply` — a closed system whose `totalSupply` stays
 * `maxSupply`. 3.6 refines the economic model (initial allocation, fees).
 * A 32-byte-hex id (spine convention), distinct from any real identity.
 */
export const MINT_ID = '0000000000000000000000000000000000000000000000000000000000000001'

/**
 * The tracer's trivial fixed single-node winner (replaced by the draw at
 * 3.3): a constant 32-byte-hex id the slot loop always mines for, with an
 * EMPTY placeholder ticket. No draw / ticket verification exists in this
 * tracer (AD-7 lands at 3.3/3.4).
 */
export const TRACER_WINNER_ID = '0000000000000000000000000000000000000000000000000000000000000002'

/**
 * A block template: everything a mined block carries EXCEPT the two fields
 * the mining loop owns — the counter (`nonce`) and the `hash` it produces.
 * `slot` / `parentHash` come from the chain (R4); `winnerIdentityId` is the
 * tracer's fixed winner; `winnerTicket` is the empty placeholder ticket
 * (3.3 replaces it with the winning ticket); `txCount` is 0 in the tracer.
 */
export interface BlockTemplate {
  slot: bigint
  parentHash: Uint8Array<ArrayBuffer>
  winnerIdentityId: string
  winnerTicket: Uint8Array<ArrayBuffer>
  txCount: bigint
}

/** One plain-integer counter in the `nonce` field's u64be (AD-12 digest) form. */
function counterToNonce(counter: bigint): Uint8Array<ArrayBuffer> {
  const buf = new Uint8Array(8)
  new DataView(buf.buffer).setBigUint64(0, counter, false) // big-endian
  return buf
}

/**
 * Hard cap on counter values tried (a liveness guard, not an expected path):
 * at the fixed N=16 target the expected counter is ≈ 2^16, and the
 * probability of needing ≥ 2^32 attempts is e^-32768 ≈ 0. The cap turns a
 * hypothetical runaway loop into a loud throw instead of spinning the event
 * loop forever. (The u64be nonce field holds counters up to 2^64; the cap is
 * far below that — it bounds the search, not the field.)
 */
const MAX_COUNTER = 2n ** 32n

/**
 * Mine one block (the R3 per-attempt hot path): iterate the integer
 * counter, set the u64be `nonce` field, stop when `powCheck` is true, set
 * `hash = blockDigest(block)`. The template's other fields pass through
 * unchanged; the result is a fully-formed `Block` ready for `applyBlock`.
 *
 * Per attempt this path references ONLY `node:crypto` sha256 (inside
 * `powCheck`/`blockDigest`) and the integer counter — no `big.js`, no keccak
 * (AD-6; enforced by the MINING_PATH_GUARD scan in the tracer test).
 *
 * @throws {Error} if no counter below `MAX_COUNTER` passes `powCheck` —
 *   astronomically unlikely at N=16 (a bug, not data).
 */
export function mineBlock(template: BlockTemplate): Block {
  for (let counter = 0n; counter < MAX_COUNTER; counter += 1n) {
    const block: Block = {
      slot: template.slot,
      parentHash: template.parentHash,
      winnerIdentityId: template.winnerIdentityId,
      winnerTicket: template.winnerTicket,
      nonce: counterToNonce(counter),
      // Placeholder: `canonicalBlockBytes`/`powCheck` never read the hash
      // field (AD-6 — a hash cannot include itself); it is set below.
      hash: new Uint8Array(32),
      txCount: template.txCount,
    }
    if (powCheck(block)) {
      // `blockDigest` declares a bare `Uint8Array` (i.e.
      // `Uint8Array<ArrayBufferLike>` under TS 5.9's generic typed arrays);
      // `Block.hash` is `Uint8Array<ArrayBuffer>`. `Uint8Array.from` yields
      // the exact same bytes with the ArrayBuffer-backed type — once per
      // SUCCESSFUL block, never in the per-attempt loop (AD-6).
      block.hash = Uint8Array.from(blockDigest(block))
      return block
    }
  }
  const err = new Error(
    `mineBlock: no counter below ${MAX_COUNTER.toString(10)} passed powCheck ` +
      `(the fixed N=16 target should be reached in ≈2^16 attempts — this is a bug, not data)`,
  )
  ;(err as { code?: string }).code = 'SC-CONSENSUS-1'
  throw err
}
