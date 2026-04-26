# NFTLox Protocol

**Polymorphic ownership infrastructure on Hive L1.** Build games, marketplaces, and digital-asset products with on-chain NFTs that have functional DNA — no smart contracts, no gas fees, no oracles.

## Why NFTLox

Traditional NFT protocols force you into rigid smart-contract environments. NFTLox takes a different approach: every action is a deterministic `custom_json` operation on Hive L1, and the protocol's state is reconstructed by a public indexer. No execution fees, no gas, 3-second finality, and the full audit trail lives on Hive itself.

If you are building a **game** with collectible cards, items, or characters, NFTLox gives you typed schemas, seed/instance distribution, mutable data fields a game server can update in real time, non-custodial lending, and a protected marketplace — all anchored to L1.

## Features

- **No smart contracts.** Operations are `custom_json` payloads on Hive L1. Protocol rules are enforced by the deterministic indexer.
- **Typed schemas.** Declare immutable and mutable fields per collection with strict validation (24 scalar + array types).
- **Seed / instance model.** One seed is a reusable template; `bulk_distribute` hands out instances with unique deterministic DNA.
- **Deterministic IDs.** `collectionId`, `seedId`, `instanceId`, `listingId`, `accessKey` — all SHA-256 with domain separators, precomputable client-side.
- **Zero transaction fees.** Hive uses Resource Credits; end users pay nothing.
- **3-second finality.** One block to confirm.
- **Non-custodial lending.** The lender never loses ownership; the borrower gets a scoped right of use.
- **Approval system.** Instance approvals, collection-wide approvals, and data operators — all posting-key, never active.
- **Protected marketplace.** `buy` is a node-multisig transaction so the buyer's HIVE can never leave their account without the NFT ownership changing atomically.
- **Client-side SPV.** A wallet or UI can verify ownership, listing price, and any NFTLox operation directly against Hive L1.

## Architecture

```
Your App ────▶ nftlox-sdk builders ────▶ Hive L1 (custom_json)
                      │                         │
                      │                         ▼
                      │                   NFTLox Indexer
                      ▼                  (reads L1, validates,
              Hive Keychain / hive-tx     builds state)
              signs posting or active            │
              Keychain-only signing              ▼
                                           PostgreSQL
                                                │
              Query / SPV ◀──────────────────────┘
```

- **Write:** build an unsigned transaction locally with `nftlox-sdk`, sign it (hive-tx / @hiveio/dhive / @hiveio/wax / Hive Keychain), broadcast to any Hive RPC. Two actions hit the indexer instead: `create_collection` gets a node co-signature via `POST /api/multisig/collection` before you broadcast; `buy` is node-last — you sign the transaction locally and POST it to `/api/multisig/buy`, and the settlement node broadcasts it for you.
- **Read:** query the indexer's HTTP API or call `createIndexerClient(baseUrl)` from the SDK. No authentication required.
- **Verify:** run the SPV verifiers (`verifyNftOwnership`, `verifyListingPrice`, …) to double-check the indexer against Hive L1 before irreversible actions.

## Quick check

```bash
curl https://api-nftlox.hivecreators.co/api/status
```

Then follow [Getting Started](getting-started.md) to make your first transaction.

## Documentation map

| Section | What you will find |
|---|---|
| **Getting Started** | |
| [Quick Start](getting-started.md) | First install, indexer client, first NFT |
| [Signing & Broadcasting](broadcasting.md) | Posting, active, and active+multisig flows across hive-tx, @hiveio/dhive, @hiveio/wax, and Hive Keychain |
| [Data Formats](data-formats.md) | Every action's payload shape, schema types, deterministic ID derivation |
| [Protocol Package](../../protocol/README.md) | Canonical wire protocol actions, constants, authority map, and base operations |
| **Core Concepts** | |
| [Collections](concepts/collections.md) | Create, extend schema, archive |
| [Ownership Model](concepts/ownership.md) | Creator vs seed owner vs instance owner; provenance fields |
| [Ecosystem Economy](concepts/economy.md) | Fees, royalties, payment split, deterministic fee schedule |
| [Protocol Invariants](concepts/protocol-invariants.md) | Public reasoning model for authority, ownership, approvals, listings, and seeds |
| [Key Security](concepts/security.md) | Active vs posting; account architectures for games |
| **Guides** | |
| [Marketplace Trading](guides/marketplace.md) | Listings, payment splits, the multisig buy flow |
| [Allowances & Operators](guides/allowances.md) | `nft_approve`, `nft_approve_all`, `data_operator_approve` |
| [NFT Lending](guides/lending.md) | Non-custodial rentals for instances |
| [SPV Verification](guides/spv.md) | Trustless client-side checks against Hive L1 |
| [Game Bot Testing](guides/game-bot-testing.md) | End-to-end bot flow with the packs engine |
| **SDK** | |
| [Using the SDK](sdk/overview.md) | Mental model, three signer flavors, indexer client |
| [SDK Reference](sdk/reference.md) | Every builder, helper, and type |
| **Reference** | |
| [API Endpoints](reference/api.md) | Indexer HTTP surface (query + multisig only — no build API) |
| [Error Codes](reference/errors.md) | Multisig codes, handler validation, retry guidance |
| **Use Cases & Examples** | |
| [Game Development](use-cases/games.md) | Full TCG loop: launch, packs, trading, lending |
| [Seed Ceremony](use-cases/seed-ceremony.md) | Launch a collection end-to-end |
| [Mutable Data](use-cases/mutable-data.md) | `set_data` for owners, `set_data_from` for game servers |

## Protocol snapshot

| Property | Value |
|---|---|
| Protocol ID | `nftlox_testnet` |
| Protocol version | `0.10.0` |
| Blockchain | Hive L1 |
| Finality | ~3 seconds |
| Active-key actions | `create_collection`, `buy` |
| Posting-key actions | All other protocol actions |
| Multisig endpoints | `POST /api/multisig/buy` (node-last buy settlement), `POST /api/multisig/collection` (create co-sign) |

| Environment | URL |
|---|---|
| Testnet API | `https://api-nftlox.hivecreators.co/api/` |

---

<div class="nftlox-footer">
	<span class="version-badge">v0.10.0</span>
	<br>
	NFTLox Protocol — Built on Hive L1
</div>
