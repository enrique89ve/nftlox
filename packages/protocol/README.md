# @nftlox/protocol

Canonical wire protocol package for NFTLox. This package owns the action names,
payload envelope, action-specific data types, authority map, deterministic ID
helpers, schema primitives, and protocol-level constants shared by the SDK and
indexer.

## Source Of Truth

The implementation in this package is normative:

| File | Owns |
|---|---|
| `src/constants.ts` | Protocol id/version, limits, action names, action groups, currencies, hash domains |
| `src/auth.ts` | Active vs posting authority for every action |
| `src/action-data.ts` | The `data` shape for each protocol action |
| `src/types.ts` | Shared wire, schema, payment, and multisig types |
| `src/payload.ts` | `ProtocolPayload` creation and Hive `custom_json` wrapping |
| `src/dna.ts` | Deterministic collection, seed, instance, DNA, image, and listing ids |
| `src/payment-requirements.ts` | Native-token payment requirements per action |

Other repository docs should link here instead of maintaining a second protocol
specification. If prose and code diverge, this package wins.

## Protocol Snapshot

| Property | Value |
|---|---|
| Protocol id | `nftlox_testnet` |
| Protocol version | `0.6.3` |
| Minimum accepted version | `0.6.3` |
| Transport | Hive `custom_json` |
| Max JSON payload | `8000` bytes |
| Hive hard cap | `8192` bytes |
| Safe SDK payload budget | `7372` bytes |
| Max Hive ops per transaction | `5` |
| Accepted actions | `19` |

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

Only two actions require active authority:

| Action | Why |
|---|---|
| `create_collection` | Collection creation includes a native-token fee transfer and node multisig custom_json |
| `buy` | Marketplace settlement moves native HIVE/HBD and requires node multisig protection |

Every other action uses posting authority. The signer is derived from the Hive
operation authority, not from a payload field.

## Base Operations

These are the actions currently accepted by `ALL_ACTIONS`.

| Area | Action | Auth | Effect |
|---|---|---|---|
| Collections | `create_collection` | Active | Creates a collection after the fee transfer and node co-signature are valid |
| Collections | `extend_schema` | Posting | Appends immutable or mutable fields to an existing collection schema |
| Collections | `archive_collection` | Posting | Freezes new mints and distributions for a collection |
| Supply | `mint` | Posting | Creates a seed NFT, the reusable template for future instances |
| Supply | `bulk_distribute` | Posting | Creates instance NFTs from one or more seeds |
| Ownership | `transfer` | Posting | Moves one or more NFTs, or burns them with `to = "null"` |
| Data | `set_data` | Posting | Lets the NFT owner update mutable data |
| Data | `data_operator_approve` | Posting | Lets a collection creator approve or revoke a data operator |
| Data | `set_data_from` | Posting | Lets an approved data operator update mutable data |
| Marketplace | `list` | Posting | Lists an NFT for sale |
| Marketplace | `unlist` | Posting | Starts the deterministic unlist delay before a listing becomes inactive |
| Marketplace | `buy` | Active | Settles a listed NFT after payment transfers and node co-signature are valid |
| Approvals | `nft_approve` | Posting | Grants or revokes transfer authority for one instance |
| Approvals | `nft_approve_all` | Posting | Grants or revokes collection-wide transfer authority for one owner |
| Approvals | `nft_transfer_from` | Posting | Transfers an instance using prior approval |
| Lending | `nft_lend` | Posting | Lends an instance without changing ownership |
| Lending | `nft_return` | Posting | Returns a lent instance to active custody |
| Nodes | `node_register` | Posting | Registers a public indexer node in the discovery directory |
| Nodes | `node_heartbeat` | Posting | Publishes indexed head and ownership state-root liveness data |

There are no native pack actions in the protocol. Pack planning lives outside
the base protocol and ultimately emits normal `bulk_distribute` operations.

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
- `ACTION_AUTH_LEVEL` must cover every action exactly once.
- Action payloads must keep the `ProtocolPayload` envelope.
- Hive authority determines signer authority.
- Seeds are templates; instances are the transferable user assets.
- `buy` and `create_collection` are multisig flows with native-token side
  effects.
- Hash domain separators are permanent historical commitments.
- Any action that changes ownership must preserve deterministic replay.

Run the package checks after changing protocol contracts:

```bash
bun test packages/protocol
```
