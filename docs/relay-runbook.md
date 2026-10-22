# Relay Runbook — volunteering a circuit relay (and running the bootstrap relay)

Audience: an operator willing to keep one always-on node reachable so nodes
behind NAT — **including IPv4-only ones** — can hold circuits through it and
be dialed by the rest of the network. No account, no reward (yet): relay
incentives are an open spec question; what you give is bandwidth, what you
get is a network that works for everyone, including you when your inbound
firewall changes.

A relay is a **normal node with serving forced on**. It syncs, gossips and
mines like any other; the extra hop duty costs modest bandwidth. Nothing in
this runbook requires IPv6-only or IPv4-only — the best relay has BOTH.

## What the network needs from you

- An always-on host with a **global IPv6 address** (a v6 VPS is ideal; a home
  box with real v6 works if it stays up) and, if you can, a **publicly
  reachable IPv4** (a public v4 or a port-map). Dual-stack is what makes
  IPv4-only homes joinable — the hop may be global `/ip4` or `/ip6` (the
  2026-10-21 dual-stack-hop rule).
- Inbound **TCP open** on one fixed port (below we use `4001`).
- Node ≥ 24 and a checkout of this repo (or the packaged runner bundle).

## Bring up the relay

From the repo root:

```bash
corepack pnpm install && corepack pnpm build
node packages/app/dist/node/run-node.js \
  --data-dir /var/lib/succinctcoin-relay \
  --listen-port 4001 \
  --relay
```

- `--relay` force-serves hops even if the node's own probes say it is
  unreachable (a reachable machine already serves automatically; this flag
  pins the promise).
- `--listen-port 4001` keeps the port stable across reboots — an ephemeral
  port changes your seed line every boot.
- The runner writes `<data-dir>/identity.seed` on first boot (mode `0600`).
  **Back it up**: deleting it makes a different node, and the seed string you
  published below still names the OLD peer id.

### Keep it running (systemd)

Same unit as the README's headless-node section (`Restart=on-failure`,
`Environment=` lines for extras), with the relay flags in `ExecStart`. After
a host reboot with a NEW IP, restart the service and re-publish your seed
line — the identity survives, the address does not.

## Publish your seed

The boot log prints its dialable listen addresses, peer id included:

```text
[boot] dial me: /ip6/2001:db8::5/tcp/4001/p2p/12D3Koo…
```

**Each address on that line is a seed.** Share them out-of-band — group chat,
forum, your site — and hidden nodes pin them:

```bash
SUCCINCTCOIN_RELAY_SEEDS=/ip6/2001:db8::5/tcp/4001/p2p/12D3Koo… node …
```

`dial me:` lists only policy-dialable addresses — global IPv6 — so a
dual-stack volunteer never sees its own v4 line printed. Publish the v4 seed
yourself: take your host's public IPv4 (cloud console, or `curl -4 ifconfig.co`)
and swap the family in your printed address — same port, same `/p2p/<peerId>`
tail: `/ip4/203.0.113.7/tcp/4001/p2p/12D3Koo…`. Hidden v4-only homes can then
hold through it; the hop law admits a global `/ip4` hop even though direct
`/ip4` addresses are never dialed.

Two rules about seed strings (enforced by the address policy, not opinion):

- A seed's first IP must be **global scope** — `/ip4` or `/ip6`; RFC1918 /
  CGNAT / loopback / link-local / ULA never hold. Publish every family you
  have: v4-only homes need the `/ip4` seed, v6-only peers prefer `/ip6`.
- Seeds carry an **address, not a name**: `/dns/…` seeds are rejected — the
  policy routes no `dns`/`uni` components, and a held circuit through a named
  hop could never validate as chain data. A domain is still worth pointing at
  your relay (A + AAAA records) so your written instructions survive IP
  churn — but what goes into `SUCCINCTCOIN_RELAY_SEEDS` is the resolved
  multiaddr, never the name.

## Verify it actually works

Self-check on the relay machine (loopback trio, dev flag disclosed):

```bash
SUCCINCTCOIN_ALLOW_LOOPBACK=1 node _bmad-output/initiative-succinctcoin-ai/epic-real-network/dial-manual.mjs relay-new-v4
# then, per its printed instructions: node-behind '<seed>' and
# invite-use-through-relay '<invite>' — PASS = DIALED THROUGH RELAY.
```

The real proof uses two networks (this is the CAP-8 promise from outside):

1. **v4-only side** (a phone on cellular data with IPv6 off, USB-tethered):
   run the runner with `SUCCINCTCOIN_RELAY_SEEDS=/ip4/<you>/tcp/4001/p2p/<id>`
   — no dev flag; a global v4 hop is legal chain data now. Expect
   `[boot] relay HOLD (v4) …` and a `/ip4/…/p2p-circuit/p2p/…` invite once it
   announces.
2. **Any other node** dials that invite: `dial-manual.mjs invite-use <invite>`
   or the app's Join panel. PASS = peers connect and data flows; your relay's
   log shows both circuits.
3. Repeat step 1 with an `/ip6` seed from a v6-only network if you published
   one.

If HOLD never prints: inbound TCP (firewall/cloud security group), the port,
or the host genuinely has no global address on that family — each failure is
loud in the boot log (`[boot] relay FAIL (v4) …: <reason>`).

## The bootstrap relay (project-operated instance)

The same runbook, plus three differences, because this instance is where
`DEFAULT_RELAY_SEEDS` points until the pool grows:

1. **Domain first.** Acquire a domain; point A **and** AAAA records at the
   host (dual-stack). The name is for humans and docs — seeds stay IP-form
   (see rules above), but `dig A`/`dig AAAA` are your health check that both
   families really answer.
2. **Static addresses.** Pick a host whose v4 and v6 are pinned; document the
   expected pair beside the unit file so an accidental rebuild with a new IP
   is noticed, not silently shipped in everyone's config.
3. **Seed delivery.** Once verified from both families (steps 1–3 above),
   hand the IP-form multiaddrs to the release: they become the
   `DEFAULT_RELAY_SEEDS` flip in `packages/app/src/main/net-config.ts` (the
   constant is pinned empty today by a test precisely so the flip is a visible
   diff). Format, one entry per family:

   ```text
   /ip4/<relay-v4>/tcp/4001/p2p/<relayId>
   /ip6/<relay-v6>/tcp/4001/p2p/<relayId>
   ```

Operational honesty: until that flip ships, every user configures the env var
themselves (`SUCCINCTCOIN_RELAY_SEEDS`); the shipped default stays empty and
boot behaves exactly like a seedless install.
