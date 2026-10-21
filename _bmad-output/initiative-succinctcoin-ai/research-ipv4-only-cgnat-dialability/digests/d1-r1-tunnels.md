# D1 round 1 — candidate screen: IPv6-obtaining tunnels (6in4/HE, TAYIC/AYIYA, Teredo, LWAAP)

Accessed 2026-10-21. Lead-run inline (no web-capable subagents). Firewall note: project
context used only to shape queries.

## Claims

C1. {claim: "HE tunnelbroker 6in4 CAN traverse ordinary NAT and even double NAT when the
    NAT translates IP protocol 41 (author ran it through two stacked NATs for years, incl.
    inbound SSH from the v6 Internet), but the author explicitly excludes CGNAT: 'if your
    NAT was really just doing only UDP/TCP PATs, or had something obnoxious that
    specifically blocked IP protocol 41 (…AT&T used to do this…), or didn't have full
    mapping from the public address like with CGNAT, this wouldn't work.'",
    source: https://binaryfury.wann.net/2023/12/he-tunnelbroker-6in4-through-double-nat/,
    publisher: "Bryan Wann (binary fury), first-hand ops writeup", pub_date: 2023-12,
    accessed: 2026-10-21, confidence: high, class: experience}

C2. {claim: "HE's own Tunnel Broker forums: asked directly 'Is there any way to get a
    tunnel to work on carrier grade NAT?' the answer from a regular is 'Nope.'; the
    community's fallback advice is (a) beg the ISP for a public v4, or (b) 'get a cheap VPS
    and route its IPv6 prefix to your connection over a Wireguard or OpenVPN tunnel' — i.e.
    the community itself converges on candidate 3 (VPS-hosted address), not on brokers.",
    source: https://forums.he.net/index.php?topic=4141.0, publisher: "HE Tunnel Broker
    forums", pub_date: 2021-11..2022-01, accessed: 2026-10-21, confidence: high,
    class: experience}

C3. {claim: "TAYIC delivers IPv6 via AYIYA (UDP-encapsulated 'anything in anything', the
    SixXS protocol designed precisely to punch out of NAT), client = AICCU — ancient C
    daemon from the SixXS era requiring a TUN device and root; SixXS itself shut down
    2021-06-10 [shutdown date TO VERIFY]. The whole toolchain is pre-systemd, no Windows
    support of note, unmaintained.", source: https://en.wikipedia.org/wiki/AICCU +
    https://en.wikipedia.org/wiki/Anything_In_Anything (AYIYA), publisher: Wikipedia,
    pub_date: n/a (living), accessed: 2026-10-21, confidence: medium (verify TAYIC alive +
    SixXS shutdown), class: technical}

C4. {claim: "Teredo is a Microsoft-managed NAT-traversal tunnel whose client Windows has
    been progressively disabling (enterprise GPO disablement documented; 2025 user reports
    of Teredo 'disabled by latest Windows update' breaking games); no maintained
    cross-platform open-source client for macOS/Linux exists (miredo dead). Not viable as
    a Node.js-embedded zero-config mechanism.", source: learn.microsoft.com Q&A threads +
    oneuptime how-tos (aggregator, cite with caution), pub_date: 2024-2025, accessed:
    2026-10-21, confidence: medium, class: technical}

C5. {claim: "LWAAP/DS-Lite/Lightweight-4over6 are ISP-side transition architectures (RFC
    7596 family) — the customer cannot self-serve them; they only exist where the carrier
    deploys them. Irrelevant to a node solving its own reachability.", source:
    https://www.rfc-editor.org/info/rfc7596/, publisher: IETF RFC Editor, pub_date: 2015-07,
    accessed: 2026-10-21, confidence: high, class: technical}

## Structural finding (cross-cutting, drives the screen)

Every candidate in this cluster hands the ADDRESS TO THE HOST: it needs an OS-level tunnel
interface (TUN device / netsh / ip link) — root/admin privileges, per-OS code, and a system
daemon. A bundled Electron/Node app (and a plain-Node VPS runner) cannot create one without
an installer-level privilege grant. That fails the hard gate "zero configuration for the
operator" INDEPENDENT of whether CGNAT passes the tunnel — even in the lucky-provision case
it is an ops project, not a product feature. Combined with C1/C2 (CGNAT specifically breaks
6in4) and C3/C4 (dead/dying clients), the tunnel cluster fails BOTH ways: universality ✗,
zero-config ✗.

## Leads for round 2
- TAYIC current status (site unfetchable — itself a signal; verify via archive/forums).
- SixXS shutdown date confirmation.
- DERP / Tailscale why-relays docs; IPFS autorelay field experience; js-libp2p auto-relay
  removal rationale (D1 wildcard + D2).
- HE forum answer "route VPS's IPv6 prefix to you over Wireguard" = candidate 3 with a v6
  prefix — note for the verdict's reversibility hedge.
