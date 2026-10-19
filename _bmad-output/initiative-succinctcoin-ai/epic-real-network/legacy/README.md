# legacy probes

Kept for reference and the opt-in mDNS flag (`SUCCINCTCOIN_MDNS=1`), but NOT
part of the shipped discovery story since epic 9 went **IPv6-only with
invite-first join** (mDNS default OFF; LAN multicast is no longer how peers
find each other on global-v6 networks).

- `mdns-smoke.mjs` — pre-IPv6 LAN multicast discovery smoke (epic 7 era).
  Still runs if you want to exercise the opt-in mDNS flag on a local
  network; its `/ip4` expectations predate the 9.1 address policy and it is
  not wired into any gate. Use `../dial-manual.mjs` (plain dial or
  `invite-new` / `invite-use` modes) for anything current.
