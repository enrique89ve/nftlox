# @nftlox/protocol

Canonical wire protocol package for NFTLox. This package owns the action names,
payload envelope, action-specific data types, authority map, deterministic ID
helpers, schema primitives, and protocol-level constants shared by the SDK and
indexer.

## Source Of Truth

The implementation in this package is normative:

| File | Owns |
|---|---|
| `src/constants.ts` | Protocol id/version, Hive platform constants, limits, action names, action groups, currencies, id/DNA prefixes, hash domains, burn recipient |
| `src/auth.ts` | Active vs posting authority per action + `NODE_SIGNED_ACTIONS` (settlement-node signer requirement) |
| `src/action-data.ts` | The `data` shape for each protocol action |
| `src/types.ts` | Shared wire, schema, payment, and multisig types; discriminated `TypedProtocolPayload` |
| `src/payload.ts` | `ProtocolPayload` creation and Hive `custom_json` wrapping |
| `src/dna.ts` | Deterministic collection, seed, instance, DNA, image, access-key, and listing ids |
| `src/payment-requirements.ts` | Native-token payment requirements per action |
| `src/payment.ts` | Payment-split math and Hive-amount precision helpers (HIVE_PRECISION, rounding, basis-points) |
| `src/schema.ts` | Collection schema validation, canonical JSON, data hashing |
| `src/username.ts` | Hive username validation |
| `src/node-endpoint.ts` | Node endpoint URL validation and normalization |

Other repository docs should link here instead of maintaining a second protocol
specification. If prose and code diverge, this package wins.

## Protocol Snapshot

| Property | Value |
|---|---|
| Protocol id | `nftlox_testnet` |
| Protocol version | `0.9.1` |
| Minimum accepted version | `0.9.1` |
| Transport | Hive `custom_json` |
| Max JSON payload | `8000` bytes |
| Hive hard cap | `8192` bytes |
| Safe SDK payload budget | `7372` bytes |
| Max Hive ops per transaction | `5` |
| Hive block time | `3000` ms |
| Hive native-asset decimals | `3` |
| Accepted actions | `20` |

NFTLox has no smart contract. State is reconstructed by deterministic indexers
that replay accepted Hive operations from the configured genesis block.

## Wire Envelope

Every NFTLox action is encoded as a `ProtocolPayload<T>` and placed in the
`json` field of a Hive `custom_json` operation. The Hive `custom_json.id` must
match the payload `protocol`.

```typescript
type ProtocolPayload<T> = {
	readonly protocol: string;
	readonly version: string;
	readonly action: ProtocolAction;
	readonly data: T;
};
```

`createHiveOperation()` chooses `required_auths` or
`required_posting_auths` from `ACTION_AUTH_LEVEL`. Callers should not hard-code
that map outside this package.

## Authority Model

Three actions require active authority:

| Action | Why |
|---|---|
| `create_collection` | Collection creation includes a native-token fee transfer and node multisig custom_json |
| `buy_commitment` | Broadcast by the settlement node's own active key to reserve the listing on chain before co-signing the buy |
| `buy` | Marketplace settlement moves native HIVE/HBD and requires node multisig protection |

Every other action uses posting authority. The signer is derived from the Hive
operation authority, not from a payload field.

A subset of active-auth actions additionally require that the signer **be a
registered active settlement node at processing time** — this rule is encoded
in `NODE_SIGNED_ACTIONS` and enforced via `requiresActiveNodeSigner(action)`.
It is orthogonal to the auth level and currently covers `buy_commitment` and
`buy`.

## Base Operations

These are the actions currently accepted by `ALL_ACTIONS`.

| Area | Action | Auth | Effect |
|---|---|---|---|
| Collections | `create_collection` | Active | Creates a collection after the fee transfer and node co-signature are valid |
| Collections | `extend_schema` | Posting | Appends immutable or mutable fields to an existing collection schema |
| Collections | `archive_collection` | Posting | Freezes new mints and distributions for a collection |
| Supply | `mint` | Posting | Creates a seed NFT, the reusable template for future instances |
| Supply | `bulk_distribute` | Posting | Creates instance NFTs from one or more seeds |
| Ownership | `transfer` | Posting | Moves one or more NFTs, or burns them by setting `to` to `BURN_RECIPIENT` |
| Data | `set_data` | Posting | Lets the NFT owner update mutable data |
| Data | `data_operator_approve` | Posting | Lets a collection creator approve or revoke a data operator |
| Data | `set_data_from` | Posting | Lets an approved data operator update mutable data |
| Marketplace | `list` | Posting | Lists an NFT for sale |
| Marketplace | `unlist` | Posting | Starts the deterministic unlist delay before a listing becomes inactive |
| Marketplace | `buy_commitment` | Active (node) | Server-side commitment broadcast by a settlement node before co-signing the buyer's `buy` transaction; Hive block ordering makes the first-landed commitment the cross-node winner |
| Marketplace | `buy` | Active | Settles a listed NFT after payment transfers and node co-signature are valid |
| Approvals | `nft_approve` | Posting | Grants or revokes transfer authority for one instance |
| Approvals | `nft_approve_all` | Posting | Grants or revokes collection-wide transfer authority for one owner |
| Approvals | `nft_transfer_from` | Posting | Transfers an instance using prior approval |
| Lending | `nft_lend` | Posting | Lends an instance without changing ownership |
| Lending | `nft_return` | Posting | Returns a lent instance to active custody |
| Nodes | `node_register` | Posting | Registers a public indexer node in the discovery directory |
| Nodes | `node_heartbeat` | Posting | Publishes indexed head and ownership state-root liveness data |

`buy_commitment` is **node-only**: it is never emitted by the SDK or by end
users. The settlement node broadcasts it with its own active key as part of
the node-last buy flow.

There are no native pack actions in the protocol. Pack planning lives outside
the base protocol and ultimately emits normal `bulk_distribute` operations.

## Instance Inheritance

Only `mint` carries image metadata on the wire. Instances are never self-describing:

- A **seed** stores its own `imageUrl` / `imageHash` in the `nfts` row written
  at mint time (via `NFTMetadata` in `NFTData`).
- An **instance** (created by `bulk_distribute`) has `image_url = NULL` and
  inherits name, image, and origin-DNA via the `instance → seed → collection`
  foreign-key chain resolved at read time.
- `transfer`, `list`, and `unlist` payloads **do not carry** `imageUrl` or
  `imageHash`. Explorers and clients resolve the image by following the same
  FK chain. Seeds are immutable, so there is no "snapshot at listing time" to
  preserve.

This keeps the on-chain payload autodescriptive without reintroducing
duplication that the database would have to reconcile on every read.

## SeedProvenance Attestation

Eight actions accept an optional `SeedProvenance` block in their payload:
`transfer`, `list`, `unlist`, `set_data`, `set_data_from`,
`nft_transfer_from`, `nft_lend`, `nft_return`.

```typescript
type SeedProvenance = {
	readonly seedId?: string;    // parent seed id
	readonly seedTxId?: string;  // Hive txId where the seed was minted
};
```

Semantics — **opt-in, verified-if-present**:

- **Both absent** → op processes normally. Backwards-compatible default.
- **Either declared** → the indexer validates the declared field(s) against
  the authoritative NFT row (and the seed's `created_tx_id`). Any mismatch
  rejects the whole op and no state mutation occurs.
- **Declared on a seed NFT** → rejected. Seeds have no parent seed.
- **Declared with a non-string type** (e.g. `seedId: 123`) → rejected. A
  malformed attestation is semantically different from an absent one.

Because the indexer filters out false attestations at write time, apps that
read Hive L1 directly can trust `seedId` / `seedTxId` on any accepted op
without an extra indexer round-trip. Apps that prefer simpler payloads may
omit both fields and resolve `seed_id` through the indexer at bootstrap.

The `items[].seedTxId` carried inside `bulk_distribute` is **not** this
attestation — it is a required nested field already validated since the
first release.

## Payload Data

Payload interfaces live in `src/action-data.ts` and are exported from the
package root:

```typescript
import type {
	CollectionData,
	NFTData,
	BulkDistributeData,
	TransferData,
	ListingData,
	BuyData,
} from "@nftlox/protocol";
```

Use the exported TypeScript types and SDK builders for exact field-level
contracts. This README intentionally stays small so it remains a stable map of
base operations instead of a second copy of the type system.

## Invariants

- Indexers must accept only actions in `ALL_ACTIONS`.
- `ACTION_AUTH_LEVEL`, `PayloadDataByAction`, and `ACTION_PAYMENT` must each
  cover every action exactly once. Each map is `satisfies
  Record<ProtocolAction, …>` so a missing entry is a compile error.
- Actions in `NODE_SIGNED_ACTIONS` additionally require the signer to be an
  active settlement node registered and alive at processing time. This rule
  is orthogonal to the auth level and is enforced per action via
  `requiresActiveNodeSigner(action)`.
- Action payloads must keep the `ProtocolPayload` envelope.
- Hive authority determines signer authority.
- Seeds are templates; instances are the transferable user assets.
- `buy` and `create_collection` are multisig flows with native-token side
  effects; `buy_commitment` is the node-side reservation op that precedes `buy`.
- Hash domain separators are permanent historical commitments.
- Id/DNA prefixes (`COLLECTION_ID_PREFIX`, `SEED_ID_PREFIX`, `INSTANCE_ID_PREFIX`,
  `IMAGE_ID_PREFIX`, `ORIGIN_DNA_PREFIX`, `NFT_DNA_PREFIX`) are single sources
  of truth: raw literals outside `constants.ts` are rejected by
  `tests/no-magic-prefixes.test.ts`.
- Any action that changes ownership must preserve deterministic replay.

Run the package checks after changing protocol contracts:

```bash
bun test packages/protocol
```
