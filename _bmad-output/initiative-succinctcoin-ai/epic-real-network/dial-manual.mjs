// LAN diagnostics support harness (7.3/8.6 troubleshooting; 9.5 invite mode) —
// the manual-dial probe. Where mdns-smoke.mjs (now legacy/) tested DISCOVERY
// (multicast), this tests the raw TCP path between two machines with NO mDNS
// reliance: side A starts and prints its real listen multiaddr; side B dials
// it explicitly. PASS = B prints DIALED + both see the peer in peers().
//
// SINCE 9.1 THE NETWORK IS IPv6-ONLY: dial targets must be GLOBAL unicast
// /ip6 multiaddrs (SC-NET-1 rejects /ip4, ULA, link-local). One-machine
// loopback proofs are still possible via the INVITE modes below with the
// explicit test flag SUCCINCTCOIN_ALLOW_LOOPBACK=1 — it admits EXACTLY ::1
// for DIALING and changes nothing else (announce policy untouched; default
// off; pinned by net-address-policy tests).
//
// ── MODE 1: plain two-machine dial ─────────────────────────────────────────
//   node .../dial-manual.mjs A
//   → prints e.g. [A] addrs=["/ip6/2001:db8::cafe/tcp/53615/p2p/12D3…"]
//   node .../dial-manual.mjs B '/ip6/2001:db8::cafe/tcp/53615/p2p/12D3…'
//
// ── MODE 2: the two-device INVITE proof (re-scoped 8.6) ────────────────────
// Machine A (the reachable one):
//   node .../dial-manual.mjs invite-new /ip6/<A-global-v6-addr>/tcp/4001
//   → prints a `scinvite:v1:…` line + keeps running with its peers loop.
//   (One machine? Use `/ip6/::1/tcp/4001` and prefix BOTH commands with
//   SUCCINCTCOIN_ALLOW_LOOPBACK=1.)
// Machine B:
//   node .../dial-manual.mjs invite-use 'scinvite:v1:…'
//   → parses, verifies (signature + chainId; liveness is printed as
//   probe-skipped), prints the embedded address, DIALS it (90s retry), then
//   reports peers(). PASS = DIALED + PEERS on both sides.
import { webcrypto } from 'node:crypto'

const mode = process.argv[2] ?? 'A'
const arg = process.argv[3]

const root = new URL('../../../', import.meta.url) // repo root (file is 3 deep)
const { defaultNetConfig } = await import(
  new URL('packages/app/src/main/net-config.ts', root).href
)
const core = await import(new URL('packages/core/dist/index.js', root).href)
const { createNetAdapter, deriveIdentityKeypair, signPeerAnnouncement, encodeInvite, parseInvite, verifyInvite, filterPolicyAddresses, verifyPeerAnnouncementSignature } = core
// The genesis loader owns the chainId default (`succinctcoin-v<N>`) — use IT,
// don't re-derive it here (deep dist import is the established probe seam).
const { loadGenesis } = await import(new URL('packages/core/dist/config/genesis.js', root).href)
const chainId = (await loadGenesis(new URL('config/genesis.json', root).pathname)).chainId

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function dialWithRetry(adapter, target, seconds = 90) {
  console.log(`[${mode}] dialing ${target} (retrying for ${seconds}s)...`)
  const deadline = Date.now() + seconds * 1000
  while (Date.now() < deadline) {
    try {
      await adapter.dial(target)
      console.log(`[${mode}] DIALED ok`)
      return true
    } catch (err) {
      console.log(`[${mode}] dial failed: ${String(err).slice(0, 120)} — retry in 3s`)
      await sleep(3000)
    }
  }
  return false
}

async function reportPeers(adapter, seconds) {
  const deadline = Date.now() + seconds * 1000
  while (Date.now() < deadline) {
    const peers = await adapter.peers()
    if (peers.length > 0) {
      console.log(`[${mode}] PEERS ${peers.join(', ')}`)
      return true
    }
    await sleep(1500)
  }
  return false
}

if (mode === 'invite-new') {
  // Side A: start FIRST, then sign the address we can actually be reached
  // on into a one-line invitation.
  const cfg = defaultNetConfig({ bootstrap: [] }, 'invite-A')
  const a = createNetAdapter(cfg)
  await a.start()
  const listening = typeof a.listenAddresses === 'function' ? a.listenAddresses() : []
  console.log(`[${mode}] listening: ${JSON.stringify(listening)}`)
  const portMatch = listening.map((x) => /\/tcp\/(\d+)/.exec(String(x))).find((m) => m != null)
  const globals = filterPolicyAddresses(listening.map(String))
  const loopbackFlag = process.env.SUCCINCTCOIN_ALLOW_LOOPBACK === '1'
  const announceAddr =
    arg ??
    (globals[0] !== undefined
      ? globals[0]
      : loopbackFlag && portMatch != null
        ? `/ip6/::1/tcp/${portMatch[1]}` // one-machine proof: same listener, loopback route
        : undefined)
  if (announceAddr === undefined) {
    console.error(`[${mode}] no global /ip6 listen address — pass one explicitly or set SUCCINCTCOIN_ALLOW_LOOPBACK=1`)
    await a.stop()
    process.exit(2)
  }
  // Noise needs the peer id up front (same rule as bootstrap entries):
  const dialAddr = announceAddr.includes('/p2p/') ? announceAddr : `${announceAddr}/p2p/${a.peerId()}`
  const seed = webcrypto.getRandomValues(new Uint8Array(32))
  const key = deriveIdentityKeypair(seed)
  const fields = { identityId: key.identityId, multiaddrs: [dialAddr], slotStart: 0, slotEnd: 1_000_000, chainId }
  const invite = encodeInvite({ ...fields, signature: signPeerAnnouncement(key, fields) })
  console.log(`[${mode}] announcing ${announceAddr} identity=${key.identityId} chain=${chainId}`)
  console.log('---8<--- copy the ONE line below to machine B ---8<---')
  console.log(invite)
  console.log('---8<--- then on machine B: node .../dial-manual.mjs invite-use \'<that line>\' ---8<---')
  console.log(`[${mode}] waiting up to 240s for machine B to dial in…`)
  const ok = await reportPeers(a, 240)
  await a.stop()
  process.exit(ok ? 0 : 3)
}

if (mode === 'invite-use') {
  // Side B: parse → verify → print → dial.
  if (arg === undefined) {
    console.error('usage: dial-manual.mjs invite-use <scinvite:v1:…>')
    process.exit(2)
  }
  const text = arg
  const parsed = parseInvite(text)
  if (!parsed.ok) {
    console.log(`[${mode}] PARSE FAILED: ${parsed.reason}`)
    process.exit(2)
  }
  console.log(`[${mode}] PARSED ok — record:`, JSON.stringify({ ...parsed.record, signature: '<sig>' }, (_k, v) => (typeof v === 'bigint' ? String(v) : v)))
  const v = verifyInvite(text, {
    currentSlot: 0,
    expectedChainId: chainId,
    hadRecentTicket: () => true, // PROBE-SKIPPED: ticket liveness needs a synced chain — printed honestly below
  })
  let record
  if (v.ok) {
    record = v.record
    console.log(`[${mode}] VERIFIED (signature + chainId; ticket liveness probe-skipped — always true here)`)
  } else if (process.env.SUCCINCTCOIN_ALLOW_LOOPBACK === '1' && v.reason === 'unsupported-address' && parsed.ok) {
    // Loopback proof: the SHIPPED validator keeps rejecting ::1 records
    // (the env flag is DIAL-only by design). Verify what verifyInvite would
    // check for such a record — signature + chainId — HERE, in the probe,
    // and say so loudly. Nothing shipped changes behavior.
    const { signature: sig, ...fields } = parsed.record
    if (!verifyPeerAnnouncementSignature(fields, sig) || fields.chainId !== chainId) {
      console.log(`[${mode}] VERIFY FAILED (probe-side loopback path): ${fields.chainId === chainId ? 'bad signature' : 'chainId mismatch'}`)
      process.exit(2)
    }
    record = parsed.record
    console.log(`[${mode}] VERIFIED probe-side (signature + chainId ONLY — address policy, slot freshness, and ticket liveness all SKIPPED for the loopback proof; do not use this path across machines)`)
  } else {
    console.log(`[${mode}] VERIFY FAILED: ${v.reason}`)
    process.exit(2)
  }
  const addrs = record.multiaddrs ?? []
  const cfg = defaultNetConfig({ bootstrap: [] }, 'invite-B')
  const b = createNetAdapter(cfg)
  await b.start()
  let dialed = false
  for (const addr of addrs) {
    if (await dialWithRetry(b, String(addr))) {
      dialed = true
      break
    }
  }
  if (!dialed) {
    console.log(`[${mode}] FAIL — could not dial any invite address within 90s`)
    await b.stop()
    process.exit(2)
  }
  const ok = await reportPeers(b, 60)
  await b.stop()
  process.exit(ok ? 0 : 3)
}

// ── MODE 1: plain A/B dial (unchanged semantics) ──────────────────────────
const label = mode
const target = arg
const cfg = defaultNetConfig({ bootstrap: [] }, `manual-${label}`)
const a = createNetAdapter(cfg)
await a.start()
const addrs = typeof a.listenAddresses === 'function' ? a.listenAddresses() : []
console.log(`[${label}] peerId=${a.peerId()} addrs=${JSON.stringify(addrs)}`)
if (target === undefined) {
  console.log(`[${label}] now on the OTHER machine run: node .../dial-manual.mjs B '${addrs[0] ?? '/ip6/<this-machine-global-v6>/tcp/<port>/p2p/...'}'`)
}

let dialed = false
if (target !== undefined) {
  if (!(await dialWithRetry(a, target))) {
    console.log(`[${label}] FAIL — could not dial within 90s (TCP path broken)`)
    process.exit(2)
  }
  dialed = true
}

// Report the peer set for both sides (the dial alone proves TCP; peers()
// confirms the identify/metadata handshake completed). Side A waits longer —
// a human starts side B by hand with the printed multiaddr.
const ok = await reportPeers(a, target === undefined ? 240 : 60)
if (!ok) console.log(`[${label}] FAIL — dialed/started but no peers() in time (dialed=${dialed})`)
await a.stop()
process.exit(ok ? 0 : 3)
