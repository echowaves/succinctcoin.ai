/**
 * `core/consensus` — `applyBlock`, the single mutation path (AD-2, R5).
 *
 * The ONE place chain + ledger state mutate in the tracer: it credits the
 * fixed-emission reward as an ordinary ledger `apply` transfer
 * `mintId → winner` (the ledger seam has NO mint path — 2.1: an unfunded
 * debit fails SC-LEDGER-1 — so the reward is a transfer out of the
 * pre-funded treasury), commits the block through the store, and saves the
 * balance snapshot. Nothing else in the core may mutate balances (AD-2).
 *
 * The tracer's reward credit is a FIXED-EMISSION credit (a pre-funded
 * mint/treasury), not a real economic model — 3.6 refines the initial
 * allocation, fees, and burn-vs-credit semantics. `rewardBaseUnits` is
 * integer base units: the one-time display→base-unit conversion
 * (`fromDisplay`, the AD-5 big.js boundary) happens OUTSIDE this module,
 * at the call site that owns the display string.
 *
 * Ordering: ledger first (an unfunded reward — `SC-LEDGER-1` — leaves the
 * chain and the snapshot untouched), then `store.commit(block)`, then
 * `store.saveState(toJson(newBalances))` (AD-5 decimal-string snapshot,
 * atomic under the store's exclusive lock).
 */
import type { Block } from '../proto/index.js'
import type { StorePort } from '../ports.js'
import type { BalanceMap } from '../ledger/index.js'
import { apply, toJson } from '../ledger/index.js'

/**
 * The inputs to `applyBlock` — all threaded in (the tracer is standalone
 * functions; 3.5 wires it into the core lifecycle). `block` is the mined
 * block (already pow-checked + hashed by 3.2's `mineBlock`); `balances` is
 * the current ledger state (the pre-funded treasury included);
 * `rewardBaseUnits` is the fixed-emission reward in integer base units;
 * `mintId` is the reserved treasury id the reward transfers from.
 */
export interface ApplyBlockParams {
  store: StorePort
  block: Block
  balances: BalanceMap
  rewardBaseUnits: bigint
  mintId: string
}

/**
 * `applyBlock` — the single mutation path (AD-2):
 *
 *   1. credit the reward: `apply(balances, [{ from: mintId, to: winner,
 *      amount: rewardBaseUnits }])` — an ordinary transfer, so the winner's
 *      balance rises by the reward, the mint falls by it, and `totalSupply`
 *      is unchanged (closed system). A reward the treasury cannot fund
 *      throws `SC-LEDGER-1` BEFORE anything is committed.
 *   2. `store.commit(block)` — persist the block's canonical wire bytes and
 *      advance the head.
 *   3. `store.saveState(toJson(newBalances))` — persist the balance
 *      snapshot (decimal strings, AD-5).
 *
 * Returns the new `BalanceMap` (the caller threads it forward; the tracer's
 * `mineAndApply` returns it alongside the block).
 */
export async function applyBlock(params: ApplyBlockParams): Promise<BalanceMap> {
  const { store, block, balances, rewardBaseUnits, mintId } = params
  const winner = block.winnerIdentityId

  // 1 — the reward credit, through the ledger's single mutation seam (AD-2).
  const newBalances = apply(balances, [
    { from: mintId, to: winner, amount: rewardBaseUnits },
  ])

  // 2 — commit the block (canonical wire bytes + head advance).
  await store.commit(block)

  // 3 — save the balance snapshot (AD-5: decimal-string base units).
  await store.saveState(toJson(newBalances))

  return newBalances
}
