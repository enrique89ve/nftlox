import { describe, test, expect, beforeAll, beforeEach, afterAll } from "bun:test";
import { sql, withTransaction } from "@/db/client.ts";
import type { ParsedOperation } from "@/scanner/operation-parser.ts";
import { handleCreateCollection } from "@/processor/handlers/core/create-collection.ts";
import { handleMint } from "@/processor/handlers/core/mint.ts";
import { handleTransfer } from "@/processor/handlers/core/transfer.ts";
import { handleExtendSchema } from "@/processor/handlers/core/extend-schema.ts";
import { config } from "@/config.ts";
import {
	ACTION_CREATE_COLLECTION,
	ACTION_MINT,
	ACTION_TRANSFER,
	ACTION_EXTEND_SCHEMA,
	PROTOCOL_VERSION,
	PROTOCOL_COLLECTION_FEE_HBD,
	generateDeterministicCollectionId,
	generateDeterministicSeedId,
	generateOriginDna,
} from "@/protocol/index.ts";

// The immutable namespace freezes at the first seed mint. Before any mint the
// creator may still iterate on the schema (design phase); after the first mint
// there are on-chain commitments that downstream consumers (marketplace,
// lending, rarity) rely on, so the immutable shape must stay fixed. Mutable
// extensions remain allowed forever — they govern evolving state (XP, level,
// status), not economic identity.

let COL_ID = "";

async function cleanDb(): Promise<void> {
	await sql`DELETE FROM nfts`;
	await sql`DELETE FROM schema_versions`;
	await sql`DELETE FROM owner_nft_counts`;
	await sql`DELETE FROM collection_stats`;
	await sql`DELETE FROM collections`;
}

let opCounter = 0;
function makeOp(
	action: string,
	data: Record<string, unknown>,
	signer = "alice",
	pairedTransfers?: ParsedOperation["pairedTransfers"],
): ParsedOperation {
	const id = ++opCounter;
	return {
		blockNum: 90000100,
		timestamp: "2024-01-01T00:00:00",
		txId: `tx_${action}_${id}`,
		operationId: `op_${id}`,
		signer,
		authLevel: "posting",
		action: action as ParsedOperation["action"],
		version: PROTOCOL_VERSION,
		data,
		pairedTransfers,
	};
}

async function createCollectionWithSchema(): Promise<void> {
	const feeAmount = parseFloat(PROTOCOL_COLLECTION_FEE_HBD);
	const memo = `NFTLox FEE-COL:${COL_ID}`;
	const pairedTransfers = [
		{ from: "alice", to: config.hiveAccount, amount: feeAmount, currency: "HBD", memo },
	];
	const originDna = await generateOriginDna(COL_ID);
	const op = makeOp(
		ACTION_CREATE_COLLECTION,
		{
			id: COL_ID,
			name: "FrozenTest",
			symbol: "FROZEN",
			originDna,
			totalPotential: 100,
			maxInstances: 0,
			metadata: { description: "freeze test", image: "https://example.com/img.png" },
			rules: { transferable: true, burnable: true, royaltyPct: 0 },
			schema: {
				immutable: [{ name: "rarity", type: "uint32" }],
				mutable: [{ name: "xp", type: "uint32" }],
			},
		},
		config.hiveAccount,
		pairedTransfers,
	);
	op.payment = {
		kind: "fixed",
		payer: "alice",
		amount: feeAmount,
		currency: "HBD",
		consumedIndices: [0],
	};
	await withTransaction((txn) => handleCreateCollection(op, txn));
}

async function mintSeed(): Promise<string> {
	const id = await generateDeterministicSeedId(COL_ID, "seed1");
	const op = makeOp(ACTION_MINT, {
		id,
		collectionId: COL_ID,
		artId: "seed1",
		edition: 1,
		owner: "alice",
		nftType: "seed",
		maxSupply: 10,
		metadata: { name: "Seed 1", imageUrl: "https://example.com/nft.png", imageHash: "img_seed1" },
		immutableData: { rarity: 5 },
	});
	await withTransaction((txn) => handleMint(op, txn));
	return id;
}

async function burnSeed(seedId: string): Promise<void> {
	const op = makeOp(ACTION_TRANSFER, {
		nftId: seedId,
		to: "null",
	});
	await withTransaction((txn) => handleTransfer(op, txn));
}

describe("extend_schema — immutable namespace frozen after first seed mint", () => {
	beforeAll(async () => {
		COL_ID = await generateDeterministicCollectionId("alice", "FrozenTest", "FROZEN");
		await sql.unsafe(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
		const schemaFile = Bun.file(import.meta.dir + "/../db/schema.sql");
		await sql.unsafe(await schemaFile.text());
	});

	afterAll(async () => {
		await cleanDb();
		await sql.end();
	});

	beforeEach(cleanDb);

	test("pre-mint: extend with newImmutableFields succeeds (design phase)", async () => {
		await createCollectionWithSchema();
		const op = makeOp(ACTION_EXTEND_SCHEMA, {
			collectionId: COL_ID,
			newImmutableFields: [{ name: "faction", type: "string" }],
		});
		await withTransaction((txn) => handleExtendSchema(op, txn));
		const [row] = await sql`SELECT schema_version FROM collections WHERE id = ${COL_ID}`;
		expect(row?.schema_version).toBe(2);
	});

	test("post-mint: extend with newImmutableFields is rejected", async () => {
		await createCollectionWithSchema();
		await mintSeed();
		const op = makeOp(ACTION_EXTEND_SCHEMA, {
			collectionId: COL_ID,
			newImmutableFields: [{ name: "faction", type: "string" }],
		});
		await expect(
			withTransaction((txn) => handleExtendSchema(op, txn)),
		).rejects.toThrow(/immutable.*frozen|cannot extend immutable/i);
	});

	test("post-mint: extend with only newMutableFields succeeds", async () => {
		await createCollectionWithSchema();
		await mintSeed();
		const op = makeOp(ACTION_EXTEND_SCHEMA, {
			collectionId: COL_ID,
			newMutableFields: [{ name: "level", type: "uint32" }],
		});
		await withTransaction((txn) => handleExtendSchema(op, txn));
		const [row] = await sql`SELECT schema_version FROM collections WHERE id = ${COL_ID}`;
		expect(row?.schema_version).toBe(2);
	});

	// Burn-and-remint bypass: `collection_stats.seeds` is decremented on burn,
	// so a naive check on seed_count > 0 would let a creator mint a seed, burn
	// it, extend immutable, then mint fresh seeds under an altered schema. The
	// freeze must consult the historical burn ledger so "forever" really means
	// forever — the immutable shape must not silently change across rebirths.
	test("post-mint-and-burn: extend with newImmutableFields is still rejected", async () => {
		await createCollectionWithSchema();
		const seedId = await mintSeed();
		await burnSeed(seedId);
		const [stats] = await sql`SELECT seeds FROM collection_stats WHERE collection_id = ${COL_ID}`;
		expect(Number(stats?.seeds ?? 0)).toBe(0);
		const op = makeOp(ACTION_EXTEND_SCHEMA, {
			collectionId: COL_ID,
			newImmutableFields: [{ name: "faction", type: "string" }],
		});
		await expect(
			withTransaction((txn) => handleExtendSchema(op, txn)),
		).rejects.toThrow(/immutable.*frozen|cannot extend immutable/i);
	});
});
