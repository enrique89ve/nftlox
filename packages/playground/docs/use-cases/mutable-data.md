# Mutable Data

How to update the `mutableData` of a live NFT instance: level-ups, XP gain, win counts, in-game state. Works for both the owner (`set_data`) and an approved game server (`set_data_from`).

## The schema contract

Only fields declared under the `mutable` section of the collection schema can be updated. Immutable fields are written once (at mint) and frozen forever. Collections without a schema accept any JSON — the SDK's builders still emit valid payloads but the indexer skips type validation.

```typescript
import { createSchemaBuilder, buildCollection } from "nftlox-sdk";

const schema = createSchemaBuilder()
	.immutable("rarity", "string")
	.immutable("base_power", "uint16")
	.mutable("xp", "uint32")
	.mutable("level", "uint8")
	.mutable("wins", "uint32")
	.build();
```

## Owner updates their own NFT — `buildSetData`

Uses posting auth. `instanceDna` is required — it binds the update to the exact NFT state and prevents cross-NFT replays. Read it from `client.getNft(nftId).instance_dna`.

```typescript
import { buildSetData, createIndexerClient } from "nftlox-sdk";
import hive from "hive-tx";

const client = createIndexerClient(process.env.INDEXER!);
hive.config.set("node", "https://api.hive.blog");

async function levelUp(nftId: string, newXp: number, newLevel: number) {
	const nft = await client.getNft(nftId);

	const result = buildSetData({
		owner: nft.owner,
		nftId,
		instanceDna: nft.instance_dna!,
		mutableData: { xp: newXp, level: newLevel },
	});
	if (!result.success) throw new Error(JSON.stringify(result.errors));

	const tx = new hive.Transaction();
	await tx.create(result.operations as [string, object][]);
	tx.sign(hive.PrivateKey.from(process.env.HIVE_POSTING_KEY!));
	const broadcast = await tx.broadcast();
	if (broadcast?.error) throw new Error(JSON.stringify(broadcast.error));
	return broadcast.result.tx_id as string;
}
```

Only the keys you pass are touched. Pass a partial object; other mutable fields keep their values.

## Game server updates on behalf of players — `buildSetDataFrom`

A game server should never ask players for their posting keys. Instead, the **collection creator** grants an operator account (the game's backend) "mutable data" rights via `buildDataOperatorApprove`. The operator then signs `set_data_from` with its own posting key — no player key is ever exposed.

```typescript
import { buildSetDataFrom } from "nftlox-sdk";

async function recordMatchResult(nftId: string, win: boolean) {
	const nft = await client.getNft(nftId);

	const result = buildSetDataFrom({
		operator: "ragnarok-server",
		nftId,
		instanceDna: nft.instance_dna!,
		mutableData: {
			xp: (nft.mutable_data?.xp as number ?? 0) + (win ? 100 : 25),
			wins: (nft.mutable_data?.wins as number ?? 0) + (win ? 1 : 0),
		},
	});
	if (!result.success) throw new Error(JSON.stringify(result.errors));

	const tx = new hive.Transaction();
	await tx.create(result.operations as [string, object][]);
	tx.sign(hive.PrivateKey.from(process.env.RAGNAROK_SERVER_POSTING!));
	await tx.broadcast();
}
```

For the one-time approval setup (`buildDataOperatorApprove`) and the full security boundary, see [Allowances & Operators](../guides/allowances.md#data-operators--builddataoperatorapprove).

## Race conditions & read-modify-write

Two concurrent updates to the same NFT land in block order. If both read `xp = 100` and both write `xp + 100`, the second commit wins — you lose the first increment. Two options:

1. **Use absolute values from the source of truth.** If the server owns the XP state in its own database, broadcast the new absolute value. On-chain state is the broadcast layer; the server is the authority.
2. **Guard with `instanceDna`.** `set_data` rejects writes whose `instanceDna` no longer matches the current one. This is not an atomic CAS, but it catches stale reads.

`mutableData` is for state that must be publicly verifiable and portable across games. For per-session gameplay state (unit positions, cooldowns), keep the data off-chain and only write to NFTs at meaningful checkpoints.

## Size budget

`mutableData` is capped at 64 keys. The entire custom_json must fit in `SAFE_PAYLOAD_MAX_BYTES` (7372 B). For large structured state, store a content hash in `mutableData` and keep the full blob in IPFS / S3 / your game DB — you pay once to broadcast the hash instead of once per write.

## See also

- [SDK Reference — `buildSetData`, `buildSetDataFrom`, `buildDataOperatorApprove`](../sdk/reference.md)
- [Data Formats — `set_data` / `set_data_from`](../data-formats.md#set_data)
- [Allowances & Operators](../guides/allowances.md) — the full permission model.
