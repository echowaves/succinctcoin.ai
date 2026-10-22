// LAN-locality probe (prototype field test, 2026-10-22) — the missing
// observability between "mDNS announces /ip4" and "peers appear". Runs TWO
// adapters in ONE process with the EXACT app LAN config
// (defaultNetConfig({ lan: true })): prints each node's wire view (what the
// mDNS TXT / identify will carry) and polls peers() every second, so a
// discovery-without-connection failure is visible as exactly that. The
// adapter exposes no discovery event (the dial listener is fire-and-forget);
// for dial-level detail prefix with DEBUG='*libp2p*' — @libp2p/logger prints
// mdns announcements AND connection failures. PASS = both nodes report >=1
// peer within 60s.
//
//   node _bmad-output/initiative-succinctcoin-ai/epic-real-network/mdns-lan.mjs
//
// One machine proves the whole LAN path over loopback (same-machine mDNS is
// known-good on this network). For the two-Mac test run it on BOTH machines —
// cross-machine results localize the failure:
//   peers() stays 0 everywhere  → multicast or dial failing (network layer)
//   PASS one machine, not two   → wire-level block (firewall/multicast)
import { webcrypto } from 'node:crypto'

const root = new URL('../../../', import.meta.url) // repo root (file is 3 deep)
globalThis.crypto ??= webcrypto
const { defaultNetConfig } = await import(
  new URL('packages/app/src/main/net-config.ts', root).href
)
const core = await import(new URL('packages/core/dist/index.js', root).href)
const { createNetAdapter } = core

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const nodes = []

for (const label of ['L1', 'L2']) {
  const cfg = defaultNetConfig({ bootstrap: [] }, `lan-${label}`, { lan: true })
  console.log(`[${label}] cfg=${JSON.stringify({ listenAddress: cfg.listenAddress, mdns: cfg.mdns, lanMode: cfg.lanMode })}`)
  const a = createNetAdapter(cfg)
  await a.start()
  const addrs = typeof a.listenAddresses === 'function' ? a.listenAddresses() : []
  console.log(`[${label}] peerId=${a.peerId()} wire-addrs=${JSON.stringify(addrs.map(String))}`)
  nodes.push({ label, a, peers: '' })
}

console.log('[lan] watching for 60s — PEERS = discovered, dialed AND identified')
let done = false
for (let i = 0; i < 60 && !done; i++) {
  await sleep(1000)
  let connected = 0
  for (const n of nodes) {
    const list = (await n.a.peers()).map(String).sort().join(',')
    if (list !== n.peers) {
      n.peers = list
      console.log(`[${n.label}] PEERS(${String((list === '' ? 0 : list.split(',').length))}): ${list}`)
    }
    if (list !== '') connected++
  }
  done = connected === nodes.length
}
for (const n of nodes) await n.a.stop()
console.log(done ? '[lan] PASS — both nodes connected' : '[lan] FAIL — see which side went silent above')
process.exit(done ? 0 : 3)
