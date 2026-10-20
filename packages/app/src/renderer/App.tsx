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
 * AD-9 (read-first): the state panels render only what the hook maintains
 * from the event stream + the read-API (E1, no polling). The ONE deliberate
 * exception is the 9.2 invitation panel: joining through a pasted invite is
 * a user COMMAND by design (and it carries no key material, E3).
 */
import { useEffect, useState } from 'react'

import { describeIpv6, describeLoopbackInvite, type InviteDiagnostics } from './ipv6-hint.js'
import { useSuccinctcoin } from './useSuccinctcoin.js'
import type { UiState } from './ui-state.js'

// Mirror of core's InviteRejectReason (thin-client rule AD-1: the renderer
// never imports @succinctcoin/core — bridge shapes are mirrored structurally,
// same as the ladder row mirrors its report).
export type InviteRejectReason =
  | 'malformed-identity'
  | 'malformed-multiaddr'
  | 'too-many-multiaddrs'
  | 'malformed-observed-addr'
  | 'malformed-slot'
  | 'malformed-chain-id'
  | 'malformed-signature'
  | 'unsupported-address'
  | 'chain-mismatch'
  | 'bad-signature'
  | 'not-yet-valid'
  | 'expired'
  | 'malformed-invite'
  | 'no-recent-ticket'

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

/**
 * The invitation panel (ticket 9.2). Two affordances, no more:
 *  - MY INVITE: this node's renderable self-invitation — copy-paste it into
 *    an email/SMS or render it as a QR anywhere; it refreshes as the node
 *    keeps mining (a Refresh button re-reads it).
 *  - JOIN: paste a friend's `scinvite:v1:…` line and connect through it.
 * Key-free by construction (E3/AD-11): the bridge carries only public
 * signed text in and an `{ ok | reason }` result out — signing stays in
 * main/core, verification decides what gets dialed.
 */
function InvitePanel() {
  const [invite, setInvite] = useState<string | null>(null)
  const [pasted, setPasted] = useState('')
  const [status, setStatus] = useState<string | null>(null)
  // Post-9.5: WHY there is no invite (the panel states the precondition —
  // the hint states this machine's actual IPv6 situation).
  const [diag, setDiag] = useState<InviteDiagnostics | null>(null)

  const refresh = (): void => {
    // ONE paired fetch (review F2): invite + diagnostics land together, so a
    // hint never describes a different snapshot than the invite beside it.
    void Promise.all([
      window.succinctcoin.getInvite().catch(() => null),
      window.succinctcoin.getInviteDiagnostics().catch(() => null),
    ])
      .then(([nextInvite, nextDiag]) => {
        setInvite(nextInvite)
        setDiag(nextDiag)
      })
      .catch(() => {
        setInvite(null)
        setDiag(null)
      })
  }
  useEffect(refresh, [])

  const join = (): void => {
    if (pasted.trim() === '') return
    setStatus('joining…')
    void window.succinctcoin
      .applyInvite(pasted)
      .then((r) =>
        r.ok
          ? setStatus(`joined through ${r.identityId.slice(0, 8)}…`)
          : setStatus(`rejected: ${(r as { reason: InviteRejectReason }).reason}`),
      )
      .catch((e: unknown) => setStatus(`failed: ${String(e)}`))
  }

  // Dev-only announce allowance honesty (computed once): an invite while
  // this machine has NO global IPv6 is either a loopback dev invite or a
  // stale one — friends cannot dial in either way. Say so.
  const loopbackWarning = diag !== null ? describeLoopbackInvite(diag) : null

  return (
    <section>
      <h2>Invitations</h2>
      {invite === null ? (
        <p>
          No invite yet — this node announces once it has a global IPv6 address.{' '}
          <button onClick={refresh}>Refresh</button>
          {diag !== null && <span> {describeIpv6(diag)}</span>}
        </p>
      ) : (
        <>
          <p>Your invite (send it to a friend):</p>
          <textarea readOnly rows={3} cols={72} value={invite} onFocus={(e) => e.currentTarget.select()} />
          <button onClick={refresh}>Refresh</button>
          {loopbackWarning !== null && <p role="status">{loopbackWarning}</p>}
        </>
      )}
      <p>Join via a friend's invite:</p>
      <textarea
        rows={3}
        cols={72}
        placeholder="scinvite:v1:…"
        value={pasted}
        onChange={(e) => setPasted(e.target.value)}
      />
      <button onClick={join} disabled={pasted.trim() === ''}>
        Join
      </button>
      {status !== null ? <p role="status">{status}</p> : null}
    </section>
  )
}

/** The view root: the state panels + the 9.2 invitation panel. */
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
      <InvitePanel />
    </main>
  )
}
