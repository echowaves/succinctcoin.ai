/**
 * `core/consensus` — the economic-model constants (3.6).
 *
 * The single home for the economic protocol constants, mirroring `pow.ts`
 * (which holds the fixed-at-launch `POW_TARGET_LEADING_ZERO_BITS`). Both
 * are PROTOCOL constants, not config: changing either value is a protocol
 * version bump (AD-7/AD-12), not a genesis or config edit.
 */

/**
 * Fixed-at-launch transaction fee rate, as a plain-decimal string in [0,1)
 * — the 2.2 fee-boundary form (`computeFee(amount, rate)`).
 *
 * ONE named origin (3.6 Decision): this constant is the single provenance
 * of the fee rate — NOT a genesis field and NOT an inline test constant. A
 * genesis fee field would be a protocol change (a genesis version bump),
 * which the inception deferred so it cannot collide with epic 4's
 * genesis/proto edits; a future genesis fee field would REPLACE this
 * constant in a later epic with a version bump.
 *
 * The value `"0.001"` (0.1%) continues the 2.2 fixed-rate decision and the
 * 2.4 conservation property test's `RATE` (the established interim rate):
 * a plain decimal in [0,1), makes the fee boundary's truncation
 * observable, and is economically sane.
 *
 * `computeFee` (the 2.2 boundary) validates the form (plain decimal,
 * [0,1)) — this constant is that contract's canonical input.
 */
export const FEE_RATE = '0.001'

/**
 * The reserved burn identity (3.6 Decision: BURN, not credit-to-winner): a
 * receive-only account that receives every transaction fee and never sends.
 *
 * "Burn" is a transfer to this identity, NOT a supply destruction: the
 * ledger `apply` seam (2.1) has NO destroy path — it only moves base units
 * between identities. Because the fee (`sender → BURN_ID`) and the reward
 * (`MINT_ID → winner`) are both within-supply transfers, `totalSupply`
 * (sum over ALL identities, INCLUDING `BURN_ID`) is CONSERVED under a
 * running miner — the 2.4 `CONSERVATION_SUPPLY` invariant, made concrete.
 * Circulating supply (excl. mint + burn) drops by exactly Σ fees.
 *
 * Why burn, not credit-to-winner: crediting the fee to the winning
 * identity would couple the mining reward to network traffic (a busy
 * network → the winner earns more), which distorts uptime-only mining (R1:
 * a node's win rate depends ONLY on its uptime, not on fee volume).
 * Burning to a neutral account keeps the winner's income = the fixed block
 * reward, independent of traffic.
 *
 * A 32-byte-hex id (spine convention), 63 zeros + "3" — distinct from
 * `MINT_ID` (…001, the pre-funded treasury) and `TRACER_WINNER_ID`
 * (…002, the tracer's single-node winner).
 */
export const BURN_ID = '0000000000000000000000000000000000000000000000000000000000000003'
