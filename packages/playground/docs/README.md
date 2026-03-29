# NFTLox Protocol

**Polymorphic ownership infrastructure on Hive L1.** Build games with on-chain NFTs that have functional DNA -- no smart contracts, no gas fees, no oracles.

---

## Why NFTLox

Traditional NFT protocols force you into rigid smart contract environments. NFTLox takes a different approach: encode operations as deterministic `custom_json` on Hive L1, then reconstruct state through indexing. The result is a protocol that is fast, free to transact, and fully verifiable.

**If you are building a game** with collectible cards, items, or characters, NFTLox gives you typed schemas, deterministic RNG for trustless pack openings, and mutable data fields your game server can update in real time -- all anchored to an L1 blockchain with 3-second finality.

## Features at a Glance

- **No smart contracts** -- Operations are `custom_json` payloads on Hive L1; the protocol is enforced by deterministic indexing
- **Typed schemas** -- Define immutable, mutable, and owner-editable fields per collection with strict validation
- **Deterministic DNA** -- Every NFT has a reproducible cryptographic identity derived from blockchain data
- **Verifiable RNG** -- Pack openings use dual-pass FNV-1a seeded from block data; anyone can independently verify the results
- **Seed/Instance model** -- Mint a seed template, distribute instances from it; each instance gets unique DNA
- **Zero transaction fees** -- Hive L1 uses resource credits, not gas; end users pay nothing
- **3-second finality** -- Operations are confirmed in the next Hive block
- **Composable operators** -- Lending, allowances, and data operators let game servers act on behalf of users
- **Built-in marketplace** -- List, buy, and unlist with multisig buyer protection

## Architecture

```
Your App                              Hive L1
--------                              -------

  SDK / fetch()                       custom_json operation
       |                                    |
       v                                    v
  Build API  ────── builds payload ──>  Broadcast to
  (unsigned)                            Hive RPC node
                                            |
                                            v
                                       NFTLox Indexer
                                       (reads L1, validates,
                                        builds state)
                                            |
                                            v
  Query API  <────── reads state ────  PostgreSQL
  (public, no auth)
```

**Write path:** Build an unsigned payload via the SDK or Build API. Sign it client-side with a Hive key. Broadcast to any Hive RPC node. The indexer detects the operation and updates state.

**Read path:** Query the indexer API for collections, NFTs, users, marketplace listings, packs, and operators. No authentication required.

## Quick Start

Check that the indexer is running:

```bash
curl https://api-nftlox.hivecreators.co/api/status
```

Then follow the [Getting Started guide](getting-started.md) to make your first API call and mint an NFT in under 5 minutes.

## Documentation

| Section | What you will find |
|---|---|
| [Getting Started](getting-started.md) | First API call, reading data, building transactions |
| [Signing and Broadcasting](broadcasting.md) | How to sign payloads and broadcast to Hive |
| [Data Formats](data-formats.md) | Field constraints, validation rules, accepted values |
| [Query API Reference](api-reference.md) | All read endpoints -- collections, NFTs, users, marketplace |
| [Build API Reference](build-reference.md) | All write endpoints -- payload construction |
| [SDK Direct Usage](using-sdk.md) | Use the TypeScript SDK without the HTTP layer |
| [Game Integration](game-integration.md) | Server-side resolution pattern for games |
| [RNG Algorithm](rng-reference.md) | Deterministic RNG specification with test vectors |

## Examples

Working code for common workflows:

- [Seed Ceremony](examples/seed-ceremony.md) -- Create a collection and mint seeds with typed schemas
- [Pack Opening](examples/pack-opening.md) -- Verifiable RNG pack resolution and instance distribution
- [Mutable Data](examples/mutable-data.md) -- Update game-state fields on NFTs

## Protocol Info

| Property | Value |
|----------|-------|
| Protocol ID | `nftlox_testnet` |
| Version | `0.3.0` |
| Min Version | `0.2.0` |
| Blockchain | Hive L1 |
| Finality | ~3 seconds |
| Auth | Posting key (all ops) / Active key (buy only) |

| Environment | URL |
|---|---|
| Testnet API | `https://api-nftlox.hivecreators.co/api/` |
| Playground | `https://nftloxtest.hivecreators.co/api/` |

---

<div class="nftlox-footer">
	<span class="version-badge">v0.3.0</span>
	<br>
	NFTLox Protocol -- Built on Hive L1
</div>
