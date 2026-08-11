# NFTLox

NFTLox lets developers build self-custodial digital assets on Hive L1. You
construct typed operations with the SDK, users sign them with their own Hive
keys, and an indexer reconstructs the chain into queryable state.

## What makes NFTLox different

- **L1 ownership:** the chain is the authority; the indexer is a replaceable
  projection.
- **No contract custody:** listings, lending, approvals, and game-server data
  updates are scoped rights, not protocol-held assets.
- **Deterministic assets:** IDs, DNA, schemas, and payment rules are derived by
  shared code and can be checked before broadcast.
- **Game-ready lifecycle:** a seed is a reusable template, while
  `bulk_distribute` creates independently transferable instances.
- **Verifiable settlement:** SPV resolves ownership anchors against Hive, and
  marketplace `buy` settles atomically through a node-last multisig flow.

## Developer path

| Goal | Read |
|---|---|
| Make your first request and mint a seed | [Getting Started](getting-started.md) |
| Understand builders, signers, and clients | [Using the SDK](sdk/overview.md) |
| Sign and broadcast operations | [Signing & Broadcasting](broadcasting.md) |
| Understand collections and schemas | [Collections](concepts/collections.md) |
| Understand ownership and key boundaries | [Ownership](concepts/ownership.md) · [Security](concepts/security.md) |
| Review protocol invariants | [Invariants](concepts/protocol-invariants.md) |
| Build a game integration | [Game Development](use-cases/games.md) |
| Look up exact payloads | [Data Formats](data-formats.md) |
| Look up SDK exports | [SDK Reference](sdk/reference.md) |
| Look up HTTP endpoints and errors | [API](reference/api.md) · [Errors](reference/errors.md) |

## The trust boundary

```text
Your app → SDK builders → signed Hive transaction → Hive L1
                                      ↓
                              NFTLox indexer → REST queries
                                      ↓
                              SDK SPV verification
```

Most operations are built and broadcast by the caller. The indexer is involved
in only two narrow signing flows: `create_collection` co-signing and node-last
`buy` settlement. It never receives the user's private keys.

## Source of truth

The implementation in [`@nftlox/protocol`](../../protocol/README.md) owns wire
actions, payload types, authorities, limits, IDs, schemas, and protocol math.
The [Data Formats](data-formats.md) page is a readable companion, not a second
normative specification.

For the current testnet endpoint:

```bash
curl https://api-nftlox.hivecreators.co/api/status
```

The protocol version, accepted actions, and current limits must be read from
the protocol package and the live status response rather than copied from this
landing page.
