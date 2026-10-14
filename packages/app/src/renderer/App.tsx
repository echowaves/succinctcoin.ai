/**
 * `app/renderer/App` — the 6.3 React view: a THIN render of the `UiState`.
 *
 * Three panels, all key-free (AD-11): the MINING STATUS (the running flag +
 * the head's slot + the last block's winner identity id + ticket count),
 * the BALANCES (the read-API balances + the head's total supply — decimal
 * strings exactly as the core reports them; no conversion, no big.js), and
 * the NETWORK PEERS list (peer IDs + multiaddrs — the only identity data
 * the AD-11 boundary allows).
 *
 * AD-3 (chain-time only): the view renders chain-time values exactly as the
 * core reports them — no wall clock, no RNG.
 * AD-9 (read-only): the view never calls a command; it renders the state
 * the hook maintains from the event stream + the read-API (E1, no polling).
 */
import { useSuccinctcoin } from './useSuccinctcoin.js'
import type { UiState } from './ui-state.js'

/** A short display form of a long hex id (the full id stays the list key). */
function shortId(id: string): string {
  return id.length <= 12 ? id : `${id.slice(0, 8)}…${id.slice(-4)}`
}

/** The mining-status panel (the running flag + the last block's slot /
 *  winner identity id / ticket count). */
function MiningPanel({ state }: { state: UiState }) {
  const head = state.head
  return (
    <section>
      <h2>Mining status</h2>
      <p>Core: {state.mining ? 'running' : 'halted'}</p>
      {head === null ? (
        <p>No blocks yet.</p>
      ) : (
        <>
          <p>Slot: {head.slot}</p>
          <p>Last-block winner: {shortId(head.winnerIdentityId)}</p>
          <p>Tickets: {head.ticketCount}</p>
        </>
      )}
    </section>
  )
}

/** The balance panel (the read-API balances + the head's total supply,
 *  decimal strings as the core reports them — AD-5 display boundary). */
function BalancesPanel({ state }: { state: UiState }) {
  const balances = state.balances
  const entries = balances === null ? [] : Object.entries(balances.balances)
  return (
    <section>
      <h2>Balance</h2>
      {state.head !== null ? <p>Total supply: {state.head.totalSupplyDisplay}</p> : null}
      {entries.length === 0 ? (
        <p>No balances yet.</p>
      ) : (
        <ul>
          {entries.map(([identityId, amount]) => (
            <li key={identityId}>
              {shortId(identityId)}: {amount}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

/** The network-peers panel (peer IDs + multiaddrs — AD-11: public data). */
function PeersPanel({ state }: { state: UiState }) {
  return (
    <section>
      <h2>Network peers</h2>
      {state.peers.length === 0 ? (
        <p>No peers connected.</p>
      ) : (
        <ul>
          {state.peers.map((peer) => (
            <li key={peer.peerId}>
              {shortId(peer.peerId)}
              {peer.multiaddrs.length > 0 ? (
                <ul>
                  {peer.multiaddrs.map((addr) => (
                    <li key={addr}>{addr}</li>
                  ))}
                </ul>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

/** The 6.3 view root: the three panels, all driven by the hook's state. */
export function App() {
  const state = useSuccinctcoin()
  // F6: a missing bridge (the preload did not expose the surface) is a
  // VISIBLE startup error, not a silent blank window.
  if (state.error !== null) {
    return (
      <main>
        <h1>SuccinctCoin</h1>
        <p role="alert">{state.error}</p>
      </main>
    )
  }
  return (
    <main>
      <h1>SuccinctCoin</h1>
      <MiningPanel state={state} />
      <BalancesPanel state={state} />
      <PeersPanel state={state} />
    </main>
  )
}
