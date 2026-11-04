# Witness flow diagrams (scinvite:v2)

Companion to `spec-scinvite-v2.md`. Diagrams only; normative text lives in the kernel.

## mint → redeem with an offline inviter (WB-1/2/3)

```mermaid
sequenceDiagram
    participant B as Backup relay R
    participant W as Witnessing peers
    participant A as Alice (inviter, later offline)
    participant T as Text message
    participant V as Bob (fresh, CGNAT)

    W->>A: probe/dial success → signed ReachabilityWitness(A.addr, expirySlot)
    A->>A: also holds circuit via R → witness(R.circuitAddr) from its peers
    Note over A: Alice mints the bundle while still online
    A->>T: scinvite:v2 = primary record + backups[R] + witnesses (all signed)
    Note over A: Alice closes the laptop — offline at redemption
    V->>T: paste invite
    V->>V: gate 1-3 on PRIMARY (v1 verbatim; empty-chain rule may allow)
    V->>V: per backup: ≥2 distinct signers, expiry vs currentSlot, diversity floor
    V->>R: dial primary first; on failure dial witnessed candidate
    R-->>V: circuit to the network (chain sync begins)
```

## verification decision (WB-3, WB-6)

```mermaid
flowchart TD
    P[paste scinvite:v2] --> PV{primary passes v1 three gates}
    PV -- no --> X[reject - never a dial target]
    PV -- yes --> D[dial primary direct-first]
    D -- answers --> OK[joined]
    D -- fails --> C[per backup candidate]
    C --> K{witnesses >= 2 distinct signers}
    K -- no --> SK[candidate skipped]
    K --> E{unexpired vs currentSlot}
    E -- no --> SK
    E --> DF{diversity floor met}
    DF -- no --> SK
    DF --> RW[dial candidate - witness-grade ingest after success]
    RW --> OK
```

## self-refreshing knowledge (WB-4)

```mermaid
flowchart LR
    subgraph gossip [existing windowed announcement exchange - additive fields]
        A2[A node] -- carries witnesses it made --> C2[C node]
        B2[B node] -- reachable to A --> A2
    end
    C2 --> PB[(peer book: witness-grade, renews every window)]
    PB -. "next invite Bob sends is already fresh" .-> B3[Bob becomes the inviter]
```

Note: no new protocol — witnesses ride announcement gossip; nodes that predate v2 ignore the fields (proto3 unknown-field tolerance, pinned by a WB-4 row).
