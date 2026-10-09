/**
 * `core/consensus` — the uptime-weight derivation (4.5, R2: "uptime = valid
 * tickets over a lookback of L windows, ramping from zero").
 *
 * An identity's **uptime** is its **track record over the prior `L` chain-time
 * windows** — realized as the **integer COUNT of its distinct valid windows in
 * `[currentWindow − L, currentWindow − 1]`** (the `L` windows STRICTLY before
 * the current one — D2/D3). The count IS the identity's **draw weight** for the
 * current window: a `bigint` in `[0, L]`, the exact form `drawWindow`'s
 * `weights` input takes (AD-7). The weight affects an identity's **draw odds
 * only** — never the reward (the slot reward is 3.6's FIXED emission, no stake
 * component, R2).
 *
 * This is a PURE standalone derivation (D1): it does NOT change `drawWindow`
 * (epic 3 owns the draw — the weight is a DERIVED INPUT to it, AD-7), the
 * acceptance cap (4.4), the acceptance seam (4.3), the sim (4.8 has wired these
 * derived weights into the multi-identity accepted-set construction, replacing
 * the fixed `SimNode.uptime` inputs), `applyBlock` / `economics` (3.6), the
 * genesis seam (1.6), or the proto. `L` is the genesis parameter
 * `uptimeLookbackL` (already validated ≥ 1 — 1.6) — a parameter the function
 * receives, not a protocol-logic choice.
 *
 * **Ramp from zero (D3):** the lookback EXCLUDES the current window, so an
 * identity's weight at window `W` is its track record over the PRIOR `L`
 * windows. A fresh identity (no prior valid windows) → weight `0` — it cannot
 * claim uptime it has not earned (no inflation from a fresh identity claiming
 * a long lookback). The weight then ramps 0 → 1 → 2 → … → `L` as valid
 * tickets accumulate, and stays at `L` once fully up. (A weight of 0 is the
 * draw's worst priority — `c^0 = 1` — so a brand-new identity does not win
 * until it has earned prior uptime: the intended ramp.)
 *
 * **Moving window (D4):** only windows in `[currentWindow − L, currentWindow −
 * 1]` count — a valid ticket older than `L` windows is EXCLUDED. The weight
 * reflects RECENT uptime, not all-time history (chain-time, AD-3).
 *
 * **Distinct count (D5):** the count is over DISTINCT window indices (robust
 * to a caller passing duplicates). Given 4.4's acceptance cap (at most one
 * valid ticket per identity per window), an identity has at most one valid
 * window per index, so the count is naturally ≤ `L` (no explicit cap needed).
 *
 * No `big.js`, no float (AD-5): the weight is an integer count over `bigint`
 * window indices — no `number` math, no float literal (NEVER `validCount / L`
 * — that would be a float). No RNG, no wall clock (AD-3): a pure count over
 * chain-time window indices. The proto is unchanged (no field added).
 *
 * Guards (D7): `lookbackL < 0n` or `currentWindow < 0n` is a **programming
 * error** (a bad weight would silently fork the draw) → throw `DrawError`
 * `SC-CONSENSUS-2` (the consensus-domain error, consistent with `draw.ts`'s
 * `u64be` range guard — the class is imported, not re-implemented).
 */
import { DrawError } from './draw.js'

/**
 * The pure uptime-weight derivation (4.5, R2 / D2–D5):
 *
 *   `weight = |{ w ∈ validWindows : currentWindow − L ≤ w ≤ currentWindow − 1 }|`
 *
 * — the COUNT of the identity's DISTINCT valid windows in the `L` windows
 * STRICTLY before `currentWindow`, as a `bigint` in `[0, L]`.
 *
 *   - **Ramp from zero (D3):** `validWindows` empty (a fresh identity) → `0n`;
 *     the range excludes `currentWindow` itself, so no prior-earned window is
 *     ever double-counted;
 *   - **Moving window (D4):** valid windows `< currentWindow − L` (older than
 *     the lookback) are excluded — the window moves forward with the chain;
 *   - **Distinct (D5):** duplicate input indices are counted ONCE (an
 *     identity earns at most one valid window per index under 4.4's cap);
 *   - **Draw input (D6 / AD-7):** the result is exactly the form
 *     `drawWindow`'s `weights` entry takes — a non-negative integer `bigint`
 *     in `[0, L]` (`L = 50` ≪ the draw's `2^20` cap). The weight changes
 *     draw odds only; the reward is 3.6's fixed emission (untouched).
 *
 * Pure: same `(validWindows, currentWindow, lookbackL)` ⇒ same weight, on
 * every node, with no RNG source and no wall clock (AD-3). The input is a
 * `ReadonlyArray` and is never mutated.
 *
 * @param validWindows — the identity's ticket history: the chain-time window
 *   indices at which the identity had a VALID ticket (any order; duplicates
 *   are counted once).
 * @param currentWindow — the chain-time window about to draw (its weight is
 *   the track record over the prior `L` windows — the current window is
 *   EXCLUDED from the count).
 * @param lookbackL — the lookback `L` in windows (the genesis parameter
 *   `uptimeLookbackL`).
 *
 * @returns the identity's draw weight for `currentWindow`: a `bigint` in
 *   `[0, lookbackL]` (the integer count — never `validCount / L`).
 *
 * @throws {DrawError} `SC-CONSENSUS-2` if `lookbackL < 0n` or
 *   `currentWindow < 0n` (a programming error — a bad weight would silently
 *   fork the draw).
 */
export function computeUptimeWeight(
  validWindows: ReadonlyArray<bigint>,
  currentWindow: bigint,
  lookbackL: bigint,
): bigint {
  // D7 guards — a bad L or window is a programming error, not data: a wrong
  // weight would silently fork the draw on every node. Same error class +
  // code as `draw.ts`'s range guards (imported, not re-implemented).
  if (lookbackL < 0n) {
    throw new DrawError(`SC-CONSENSUS-2: lookbackL ${lookbackL} is negative`)
  }
  if (currentWindow < 0n) {
    throw new DrawError(
      `SC-CONSENSUS-2: currentWindow ${currentWindow} is negative`,
    )
  }

  // The lookback range: the `L` windows STRICTLY before the current one —
  // [currentWindow − L, currentWindow − 1]. A fresh identity (currentWindow
  // 0) has an empty range → weight 0 (the ramp from zero, D3).
  const lo = currentWindow - lookbackL
  const hi = currentWindow - 1n

  // Count DISTINCT valid windows in [lo, hi] (D5: robust to duplicate input
  // indices — 4.4's cap makes duplicates impossible on the accepted path,
  // but the count is well-defined either way). Windows < lo (older than the
  // lookback, D4) and >= hi (the current window or later, D3) are excluded.
  let count = 0n
  const seen = new Set<bigint>()
  for (const w of validWindows) {
    if (seen.has(w)) continue // duplicate index: counted once (D5)
    seen.add(w)
    if (w >= lo && w <= hi) count += 1n
  }
  return count
}
