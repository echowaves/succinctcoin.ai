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
//
// ── MODE 3: the RELAY trio (10.3 — circuit path end to end) ─────────────
// Three terminals (ONE machine is enough with SUCCINCTCOIN_ALLOW_LOOPBACK=1
// on all three commands; every skipped check prints loudly, same rules as
// the invite modes):
//   1. node .../dial-manual.mjs relay-new
//      → starts a VOLUNTEER RELAY (the 5.7 server role) and prints its
//        SEED line (/ip6/…/tcp/…/p2p/<relayId>) — what an operator would
//        share out-of-band, the two-machine version passes an explicit
//        global address as arg.
//   2. node .../dial-manual.mjs node-behind '<SEED>'
//      → starts a hidden peer with SUCCINCTCOIN_RELAY_SEEDS=[seed], waits
//        for the held /p2p-circuit address, signs an invite CARRYING ONLY
//        that circuit address, prints it, then serves peers through the
//        circuit for 600s.
//   3. node .../dial-manual.mjs invite-use-through-relay '<that invite>'
//      → verifies (full shipped path when the relay hop is global; under
//        the loopback flag, probe-side sig+chainId only — disclosed), then
//        DIALS the circuit address through the relay.
// PASS = terminal 3 prints `DIALED THROUGH RELAY` + PEERS, and terminals
// 1–2 each see a peer. This is the manual proof of the ticket-10.3 tier;
// the headless hold/announce/dial mechanics live in core relay-seeds.test.ts.
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

// A multiaddr text carries a /p2p-circuit COMPONENT (not a host name).
const isCircuitAddr = (a) => String(a).split('/').includes('p2p-circuit')

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

// ── MODE 3: the RELAY trio (10.3) ─────────────────────────────────────────
if (mode === 'relay-new') {
  // The volunteer relay: the 5.7 server role via config (relayRole), zero
  // special code. Its SEED line is what operators share out-of-band.
  const cfg = defaultNetConfig({ bootstrap: [] }, 'relay-server', { relayServer: true })
  const r = createNetAdapter(cfg)
  await r.start()
  const listening = r.listenAddresses().map(String)
  console.log(`[relay-new] listening: ${JSON.stringify(listening)}`)
  // Same address pick as invite-new: explicit arg, else a policy-global /ip6,
  // else (loopback flag ONLY) ::1 with the real port — every skip printed.
  const globals = filterPolicyAddresses(listening.filter((a) => !isCircuitAddr(a)))
  const portMatch = listening.map((x) => /\/tcp\/(\d+)/.exec(x)).find((m) => m != null)
  const loopbackFlag = process.env.SUCCINCTCOIN_ALLOW_LOOPBACK === '1'
  const direct =
    arg ??
    (globals[0] !== undefined
      ? globals[0]
      : loopbackFlag && portMatch != null
        ? `/ip6/::1/tcp/${portMatch[1]}` // one-machine proof: same listener, loopback route
        : undefined)
  if (direct === undefined) {
    console.error('[relay-new] no global /ip6 listen address — pass one explicitly or set SUCCINCTCOIN_ALLOW_LOOPBACK=1')
    await r.stop()
    process.exit(2)
  }
  const seed = direct.includes('/p2p/') ? direct : `${direct}/p2p/${r.peerId()}`
  console.log(`[relay-new] circuit address advertised: ${listening.some(isCircuitAddr)}`)
  console.log('---8<--- this SEED is what hidden peers put in SUCCINCTCOIN_RELAY_SEEDS ---8<---')
  console.log(`SEED ${seed}`)
  console.log(`[relay-new] then: node .../dial-manual.mjs node-behind '${seed}'`)
  // PASS = BOTH sides arrive: the hidden peer's hold connection AND the
  // outsider dialed through the circuit (2 distinct peers — exiting on the
  // first would kill the relay before the third command even starts).
  console.log('[relay-new] serving up to 600s; PASS = served two distinct peers (hold + circuit dial)…')
  // CUMULATIVE: the hidden peer may leave the moment its arrival is confirmed
  // — a relay that SAW both identities served the circuit either way.
  const served = new Set()
  let ok = false
  const relayDeadline = Date.now() + 600_000
  while (Date.now() < relayDeadline && !ok) {
    for (const p of await r.peers()) served.add(p)
    if (served.size >= 2) {
      console.log(`[relay-new] SERVED ${[...served].join(', ')}`)
      ok = true
    } else await sleep(1500)
  }
  if (!ok) console.log('[relay-new] FAIL — did not serve both peers in time')
  await r.stop()
  process.exit(ok ? 0 : 3)
}

if (mode === 'node-behind') {
  // The hidden peer: relay seed in, circuit-carried invite out. Stays alive
  // so the third command can actually dial THROUGH it.
  if (arg === undefined) {
    console.error('usage: dial-manual.mjs node-behind <seed /ip6/…/tcp/…/p2p/<relayId>>')
    process.exit(2)
  }
  const cfg = {
    ...defaultNetConfig({ bootstrap: [] }, 'node-behind', { relaySeeds: [arg] }),
    // Print every hold attempt outcome — the same lines the app logs at boot.
    onRelaySeed: (e) =>
      console.log(`[node-behind] seed ${e.ok ? 'HELD' : 'FAIL'} ${e.seed}${e.error != null ? `: ${e.error}` : ''}`),
  }
  const n = createNetAdapter(cfg)
  await n.start()
  // The 10.2 hold loop announces `<seed>/p2p-circuit/p2p/<self>` once the
  // reservation lands; poll listenAddresses() for it (bounded).
  let circuitAddr
  const holdDeadline = Date.now() + 60_000
  while (circuitAddr === undefined && Date.now() < holdDeadline) {
    circuitAddr = n.listenAddresses().find(isCircuitAddr)
    if (circuitAddr === undefined) await sleep(1000)
  }
  if (circuitAddr === undefined) {
    console.log('[node-behind] FAIL — no /p2p-circuit address within 60s (relay never held)')
    await n.stop()
    process.exit(2)
  }
  console.log(`[node-behind] HELD circuit: ${circuitAddr}`)
  // Sign an invite whose ONLY address is the circuit one — a peer with no
  // reachable direct address at all.
  const seedBytes = webcrypto.getRandomValues(new Uint8Array(32))
  const key = deriveIdentityKeypair(seedBytes)
  const fields = { identityId: key.identityId, multiaddrs: [String(circuitAddr)], slotStart: 0, slotEnd: 1_000_000, chainId }
  const invite = encodeInvite({ ...fields, signature: signPeerAnnouncement(key, fields) })
  console.log('---8<--- copy the ONE line below to the THIRD terminal ---8<---')
  console.log(invite)
  // The relay itself is already a peer (the hold connection) — PASS is an
  // ARRIVAL: some other peer dialed us through the circuit. A seed without
  // /p2p/<id> would make every peer an "arrival" (false PASS) — refuse it.
  const relayPeer = /\/p2p\/([^/]+)$/.exec(arg)?.[1]
  if (relayPeer === undefined) {
    console.error('[node-behind] seed must end with /p2p/<relayId> (the adapter would skip it too)')
    await n.stop()
    process.exit(2)
  }
  console.log('[node-behind] staying alive; waiting up to 600s for a peer dialed through the relay…')
  let ok = false
  const behindDeadline = Date.now() + 600_000
  while (Date.now() < behindDeadline && !ok) {
    const arrivals = (await n.peers()).filter((p) => p !== relayPeer)
    if (arrivals.length > 0) {
      console.log(`[node-behind] PEERS ${arrivals.join(', ')}`)
      ok = true
    } else await sleep(1500)
  }
  if (!ok) console.log('[node-behind] FAIL — nobody arrived through the circuit')
  // Settle: stay a beat so the relay's poll observes the circuit connection
  // before our stop tears it down.
  if (ok) await sleep(5000)
  await n.stop()
  process.exit(ok ? 0 : 3)
}

if (mode === 'invite-use-through-relay') {
  // The outsider: verifies an invite whose address is a CIRCUIT address and
  // dials it through the relay. PASS line: DIALED THROUGH RELAY.
  if (arg === undefined) {
    console.error('usage: dial-manual.mjs invite-use-through-relay <scinvite:v1:…>')
    process.exit(2)
  }
  const text = arg
  const parsed = parseInvite(text)
  if (!parsed.ok) {
    console.log(`[invite-use-through-relay] PARSE FAILED: ${parsed.reason}`)
    process.exit(2)
  }
  if (!parsed.record.multiaddrs.some(isCircuitAddr)) {
    console.log('[invite-use-through-relay] NOTE: invite carries no /p2p-circuit address — this degrades to the plain invite-use proof')
  }
  const v = verifyInvite(text, { currentSlot: 0, expectedChainId: chainId, hadRecentTicket: () => true })
  let record
  if (v.ok) {
    record = v.record
    console.log('[invite-use-through-relay] VERIFIED full shipped path (signature + chainId + address policy; ticket liveness probe-skipped — always true here)')
  } else if (process.env.SUCCINCTCOIN_ALLOW_LOOPBACK === '1' && v.reason === 'unsupported-address' && parsed.ok) {
    // Loopback proof (same disclosed shortcut as invite-use): the shipped
    // validator keeps rejecting ::1 hops (the flag is dial-only). Verify
    // signature + chainId probe-side and say so LOUDLY.
    const { signature: sig, ...fields } = parsed.record
    if (!verifyPeerAnnouncementSignature(fields, sig) || fields.chainId !== chainId) {
      console.log('[invite-use-through-relay] VERIFY FAILED (probe-side loopback path): bad signature or chainId')
      process.exit(2)
    }
    record = parsed.record
    console.log('[invite-use-through-relay] VERIFIED probe-side (signature + chainId ONLY — address policy, slot freshness, and ticket liveness all SKIPPED for the loopback proof; do not use this path across machines)')
  } else {
    console.log(`[invite-use-through-relay] VERIFY FAILED: ${v.reason}`)
    process.exit(2)
  }
  const d = createNetAdapter(defaultNetConfig({ bootstrap: [] }, 'relay-outsider'))
  await d.start()
  let dialed = false
  for (const addr of record.multiaddrs ?? []) {
    if (await dialWithRetry(d, String(addr))) {
      dialed = true
      break
    }
  }
  if (!dialed) {
    console.log('[invite-use-through-relay] FAIL — could not dial any circuit address within 90s')
    await d.stop()
    process.exit(2)
  }
  console.log('[invite-use-through-relay] DIALED THROUGH RELAY')
  const ok = await reportPeers(d, 60)
  // Settle window: the relay and the hidden peer poll peers() every 1.5s —
  // exiting the instant we print would close the circuit before they ever
  // observe it (their PASS is seeing THIS connection).
  if (ok) await sleep(15_000)
  await d.stop()
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
