// Ticket 7.3 support harness — machine-level PROOF of the epic's outcome:
// two SEPARATE processes discover each other over the real transport and
// gossip a block both ways, with NO bootstrap entries. It imports the REAL
// seam (packages/app/src/main/net-config.ts — pure, type-only core import;
// Node >= 23.6 strips the types), so the config under test is exactly what
// the app boots with: tcp + mDNS + bootstrap-from-genesis (empty = LAN-only).
//
// Run (repo must be built: corepack pnpm install && corepack pnpm build):
//   node <this file> A > /tmp/smoke-A.log 2>&1 &
//   node <this file> B > /tmp/smoke-B.log 2>&1 &
//   wait; cat /tmp/smoke-A.log /tmp/smoke-B.log
// PASS = both logs show DISCOVERED + RECEIVED ... from the OTHER label.
const label = process.argv[2] ?? 'A'

const root = new URL('../../../', import.meta.url) // repo root (file is 3 deep)
const { defaultNetConfig, LAN_LISTEN_ADDRESS } = await import(
  new URL('packages/app/src/main/net-config.ts', root).href
)
const { createNetAdapter } = await import(
  new URL('packages/core/dist/index.js', root).href
)

const cfg = defaultNetConfig({ bootstrap: [] }, `smoke-identity-${label}`)
console.log(`[${label}] config from defaultNetConfig:`, JSON.stringify(cfg))
const a = createNetAdapter(cfg)

await a.start()
console.log(
  `[${label}] peerId=${a.peerId()} listening on ${LAN_LISTEN_ADDRESS} (mdns:true, bootstrap:[])`,
)

const deadline = Date.now() + 90_000
let found = false
while (Date.now() < deadline && !found) {
  const peers = await a.peers()
  if (peers.length > 0) {
    console.log(`[${label}] DISCOVERED ${peers.length} peer(s): ${peers.join(', ')}`)
    found = true
  } else {
    await new Promise((r) => setTimeout(r, 1000))
  }
}
if (!found) {
  console.log(`[${label}] FAIL — no peers discovered within 90s`)
  process.exit(2)
}

// Let the gossip mesh graft, then publish a block; we also receive the other side's.
await new Promise((r) => setTimeout(r, 3000))
const FIX_BLOCK = {
  slot: 777n,
  parentHash: new Uint8Array(32).fill(label === 'A' ? 0x0a : 0xbb),
  winnerIdentityId: `smoke-identity-${label}`,
  winnerTicket: new Uint8Array(64).fill(0x11),
  nonce: new Uint8Array(32).fill(0x02),
  hash: new Uint8Array(32).fill(label === 'A' ? 0xa1 : 0xb1),
  txCount: 0n,
}
// The mesh grafts on gossipsub heartbeats (~1 s each, cross-machine can take
// several); the adapter's send is single-shot (5.1 D6), so retry until the
// mesh accepts — publishUntilAccepted, the pattern every 5.x driver uses.
{
  const pubDeadline = Date.now() + 30_000
  let published = false
  let lastErr = ''
  while (Date.now() < pubDeadline && !published) {
    try {
      await a.sendBlock(FIX_BLOCK)
      published = true
    } catch (err) {
      lastErr = String(err).slice(0, 80)
      await new Promise((r) => setTimeout(r, 1000))
    }
  }
  if (!published) console.log(`[${label}] WARN — publish never accepted in 30s: ${lastErr}`)
}
console.log(`[${label}] published a block (slot 777)`)

const rxDeadline = Date.now() + 20_000
let mine = []
while (Date.now() < rxDeadline) {
  mine = a.received.get('blocks') ?? []
  if (mine.length > 0) break
  await new Promise((r) => setTimeout(r, 500))
}
if (mine.length === 0) {
  console.log(`[${label}] discovered OK but received NO blocks within 20s`)
  await a.stop()
  process.exit(3)
}
console.log(
  `[${label}] RECEIVED ${mine.length} block(s) via gossip from sourcePeerId=${mine.map((e) => e.sourcePeerId).join(',')}`,
)
await a.stop()
console.log(`[${label}] OK — stopped cleanly`)
process.exit(0)
