// LAN diagnostics support harness (7.3/8.6 troubleshooting) — the manual-dial
// probe. Where mdns-smoke.mjs tests DISCOVERY (multicast), this tests the raw
// TCP path between two machines with NO mDNS reliance: side A starts and
// prints its real listen multiaddr; side B dials it explicitly (the same
// mechanism a bootstrap entry uses). PASS = B prints DIALED + both see the
// peer in peers().
//
// Run on machine A (the one whose IP you will dial):
//   node _bmad-output/initiative-succinctcoin-ai/epic-real-network/dial-manual.mjs A
// It prints e.g.:
//   [A] peerId=12D3KooW... addrs=["/ip4/192.168.1.17/tcp/53615/p2p/12D3KooW..."]
// Then on machine B:
//   node .../dial-manual.mjs B /ip4/192.168.1.17/tcp/53615/p2p/12D3KooW...
// (paste A's printed multiaddr verbatim, quoted).
const label = process.argv[2] ?? 'A'
const target = process.argv[3]

const root = new URL('../../../', import.meta.url) // repo root (file is 3 deep)
const { defaultNetConfig } = await import(
  new URL('packages/app/src/main/net-config.ts', root).href
)
const { createNetAdapter } = await import(
  new URL('packages/core/dist/index.js', root).href
)

const cfg = defaultNetConfig({ bootstrap: [] }, `manual-${label}`)
const a = createNetAdapter(cfg)
await a.start()
const addrs = typeof a.listenAddresses === 'function' ? a.listenAddresses() : []
console.log(`[${label}] peerId=${a.peerId()} addrs=${JSON.stringify(addrs)}`)
if (target === undefined) {
  console.log(`[${label}] now on the OTHER machine run: node .../dial-manual.mjs B '${addrs[0] ?? '/ip4/<this-machine-ip>/tcp/<port>/p2p/...'}'`)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let dialed = false
if (target !== undefined) {
  console.log(`[${label}] dialing ${target} (retrying for 90s)...`)
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline && !dialed) {
    try {
      await a.dial(target)
      dialed = true
      console.log(`[${label}] DIALED ok`)
    } catch (err) {
      console.log(`[${label}] dial failed: ${String(err).slice(0, 120)} — retry in 3s`)
      await sleep(3000)
    }
  }
  if (!dialed) {
    console.log(`[${label}] FAIL — could not dial within 90s (TCP path broken)`)
    process.exit(2)
  }
}

// Report the peer set for both sides (the dial alone proves TCP; peers()
// confirms the identify/metadata handshake completed). Side A waits longer —
// a human starts side B by hand with the printed multiaddr.
const deadline = Date.now() + (target === undefined ? 240_000 : 60_000)
let ok = false
while (Date.now() < deadline && !ok) {
  const peers = await a.peers()
  if (peers.length > 0) {
    console.log(`[${label}] PEERS ${peers.join(', ')}`)
    ok = true
  } else {
    await sleep(1500)
  }
}
if (!ok) console.log(`[${label}] FAIL — dialed/started but no peers() within 60s`)
await a.stop()
process.exit(ok ? 0 : 3)
