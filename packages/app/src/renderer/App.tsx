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

import {
  describeCircuitInvite,
  describeIpv6,
  describeLoopbackInvite,
  type InviteDiagnostics,
} from './ipv6-hint.js'
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

  // Invite-share UX: the Copy feedback line (set on click only — NO timer
  // clears it, RENDERER_NO_POLL; Electron tests pin the clipboard CALL, not
  // OS state, so the status reflects the attempt).
  const [copied, setCopied] = useState<string | null>(null)
  // Invite-share UX: LAN-mode dial addresses (display-only, CAP-9) — [] in
  // every normal mode, so this block is invisible outside LAN testnets.
  const [lanAddrs, setLanAddrs] = useState<string[]>([])

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

  // Invite-share UX: PUSH, don't poll — the core emits `SelfInviteUpdated`
  // the moment the invite mints (first announce window) and on every
  // refresh, and clears it (`invite: null`) when the node stops. The panel
  // therefore shows the copyable invite WITHOUT asking the user to Refresh.
  // Same public signed text `getInvite()` returns (AD-11-safe by identity).
  useEffect(
    () =>
      window.succinctcoin.on('SelfInviteUpdated', (payload) => {
        setInvite(payload.invite)
      }),
    [],
  )

  // Invite-share UX: LAN-address read (the main process owns the mode
  // check — [] whenever not in LAN mode, so no timer is needed). TWO
  // triggers, both event-driven: once at mount (covers a node that started
  // before this panel did) and on `CoreStarted` (boot loads the renderer
  // BEFORE host.start, so the adapter can still be un-listening at mount —
  // the started event is exactly when listenAddresses becomes real).
  const readLan = (): void => {
    void window.succinctcoin
      .getLanDial()
      .then((addrs) => setLanAddrs(addrs))
      .catch(() => setLanAddrs([]))
  }
  useEffect(readLan, [])
  useEffect(() => window.succinctcoin.on('CoreStarted', readLan), [])

  /** Copy `text`; `done` is the success line (failure stays a manual-copy hint). */
  const copy = (text: string, done: string): void => {
    // The frozen matrix says "never throws": a missing clipboard API fails
    // SYNCHRONOUSLY on property access, before any promise exists — so the
    // access itself is guarded too, and every path lands in the status line.
    const fail = 'copy failed — select the text and copy manually.'
    try {
      void navigator.clipboard
        .writeText(text)
        .then(() => setCopied(done))
        .catch(() => setCopied(fail))
    } catch {
      setCopied(fail)
    }
  }

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
  // Ticket 7: an invite whose address carries /p2p-circuit rides a relay —
  // say so, distinctly from the loopback warning (a circuit is healthy, not
  // broken; it just costs a hop). Own invite and pasted invite alike.
  const ownCircuitHint = invite !== null ? describeCircuitInvite(invite) : null
  const pastedCircuitHint =
    pasted.trim() === '' ? null : describeCircuitInvite(pasted)

  return (
    <section>
      <h2>Invitations</h2>
      {invite === null ? (
        <p>
          No invite yet — this node announces once it has a global IPv6 address or holds a circuit
          through a relay hop. It appears here by itself the moment it is ready.{' '}
          <button onClick={refresh}>Refresh</button>
          {diag !== null && <span> {describeIpv6(diag)}</span>}
        </p>
      ) : (
        <>
          <p>
            Your invite is ready. <strong>1.</strong> Copy it and send it to your friend as one
            whole message. <strong>2.</strong> Your friend pastes it into the box below (in{' '}
            <em>their</em> app) and presses Join — nothing else to type.
          </p>
          <textarea readOnly rows={3} cols={72} value={invite} onFocus={(e) => e.currentTarget.select()} />
          <button
            onClick={() => copy(invite, 'Invite copied — send it as one whole message.')}
          >
            Copy invite
          </button>
          <button onClick={refresh}>Refresh</button>
          {loopbackWarning !== null && <p role="status">{loopbackWarning}</p>}
          {ownCircuitHint !== null && <p role="status">{ownCircuitHint}</p>}
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
      {pastedCircuitHint !== null && <p role="status">{pastedCircuitHint}</p>}
      <button onClick={join} disabled={pasted.trim() === ''}>
        Join
      </button>
      {status !== null ? <p role="status">{status}</p> : null}
      {copied !== null ? <p role="status">{copied}</p> : null}
      {/* Invite-share UX: in LAN mode with NO invite the honest answer is
          "local testnet only" (CAP-9) — the LOCAL dial address is still
          worth copying. Display-only, same filter as the boot line; the
          either/or mirrors the boot log (an INVITE always wins — a dual-
          stack LAN host must not see mixed messages); invisible outside
          LAN mode (the read returns []). */}
      {invite === null && lanAddrs.length > 0 && (
        <div>
          <p>
            <strong>Local testnet addresses — not an invite.</strong> This node
            runs in LAN mode: these work only on this local network, and a
            friend joins by pasting one into their bootstrap.txt.
          </p>
          <ul>
            {lanAddrs.map((addr) => (
              <li key={addr}>
                <code>{addr}</code>{' '}
                <button
                  onClick={() =>
                    copy(addr, 'Address copied — your friend pastes it into their bootstrap.txt.')
                  }
                >
                  Copy
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
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
