# NFTLox — LLM Context Reference

This is a compact orientation for AI assistants and code search. It is not a
second protocol specification. For exact actions, types, authorities, limits,
and constants, use [`@nftlox/protocol`](../../protocol/README.md). For the
complete SDK surface, use the [SDK Reference](sdk/reference.md).

## Core model

NFTLox stores protocol operations as Hive L1 `custom_json`. The SDK builds
unsigned operations; the user signs them; Hive provides the authoritative
history; and an indexer replays that history into PostgreSQL for queries.

```text
application → SDK builder → user signature → Hive L1
                                      ↓
                              indexer projection
                                      ↓
                              query API / SPV check
```

The indexer does not hold user keys and its database is not the asset. Use the
SDK's SPV helpers to verify an ownership edge against Hive before an
irreversible decision.

## Why developers use NFTLox

- No smart-contract deployment or gas fees; Hive uses Resource Credits.
- Deterministic collection, seed, instance, listing, DNA, and access-key IDs.
- Seed templates can create many independently transferable instances.
- Game servers can update mutable data through scoped operator approval.
- Lending delegates use without changing ownership.
- Marketplace `buy` is atomic and node-last; payment and ownership change
  succeed together or fail together.

## Integration flow

1. Read indexed state with `createIndexerClient()`.
2. Build an operation with an SDK builder.
3. Check `result.success`.
4. Sign `result.operations` with the key named by `result.keyType`.
5. Broadcast to a Hive RPC, except for the two node-multisig flows below.
6. Poll the indexer and use SPV when the result must be independently checked.

Every builder returns a `KeychainResult<T>`:

```typescript
type KeychainResult<T> =
  | {
      success: true;
      operations: ReadonlyArray<HiveOperation | HiveTransferOperation>;
      keyType: "Active" | "Posting";
      signer: string;
      payload: ProtocolPayload<T>;
      coSigners?: readonly CoSigner[];
      generatedIds?: Readonly<Record<string, string>>;
      warnings?: readonly string[];
    }
  | {
      success: false;
      errors: readonly ValidationError[];
    };
```

Never infer the key type from the action name. Use `result.keyType`; the
authority map is owned by the protocol package.

## Signing boundaries

| Flow | Caller does | Indexer does |
|---|---|---|
| Normal action | Builds, signs, and broadcasts | Indexes the result |
| `create_collection` | Signs the fee transfer and requests co-signing | Adds the node signature |
| `buy` | Builds and signs the full buyer transaction | Broadcasts `buy_commitment`, wins ordering, co-signs, and settles |

`buy_commitment` is node-only. Applications do not construct or broadcast it.

## Domain rules to preserve

- Hive operation authorities identify the signer; payload fields do not.
- A seed is a reusable template. `bulk_distribute` creates instances.
- Packs are an external game mechanic; the packs engine emits normal
  `bulk_distribute` items.
- PostgreSQL fields are a projection of L1 history, not a replacement for it.
- Permissionless node checkpoint mismatches are advisory, not a Sybil-resistant
  quorum proof.
- Protocol version, accepted actions, limits, and authorities come from
  `packages/protocol`, not from copied tables in application docs.

## Documentation map

- [Getting Started](getting-started.md) — first request and first mutation.
- [Using the SDK](sdk/overview.md) — builders, clients, and flows.
- [SDK Reference](sdk/reference.md) — complete exports and types.
- [Signing & Broadcasting](broadcasting.md) — signer and transport examples.
- [Data Formats](data-formats.md) — readable wire examples.
- [Game Development](use-cases/games.md) — end-to-end game architecture.
- [SPV Verification](guides/spv.md) — L1 ownership checks.
- [API Reference](reference/api.md) — indexer HTTP contract.
- [Error Reference](reference/errors.md) — codes and retry guidance.
