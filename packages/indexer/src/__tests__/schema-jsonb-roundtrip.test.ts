import { describe, test, expect, beforeAll, beforeEach, afterAll } from "bun:test";
import { sql, withTransaction } from "@/db/client.ts";
import type { ParsedOperation } from "@/scanner/operation-parser.ts";
import { handleCreateCollection } from "@/processor/handlers/core/create-collection.ts";
import { handleExtendSchema } from "@/processor/handlers/core/extend-schema.ts";
import { handleMint } from "@/processor/handlers/core/mint.ts";
import { getCollectionRules } from "@/db/queries/collections.ts";
import { config } from "@/config.ts";
import {
	ACTION_CREATE_COLLECTION,
	ACTION_EXTEND_SCHEMA,
	ACTION_MINT,
	PROTOCOL_VERSION,
	PROTOCOL_COLLECTION_FEE_HBD,
	generateDeterministicCollectionId,
	generateDeterministicSeedId,
} from "@/protocol/index.ts";

// JSONB round-trip regressions. postgres.js auto-serializes objects into
// JSONB — wrapping them in JSON.stringify first produces a doubly-encoded
// value that comes back as a plain string on read. Any caller that passes
// the read value to `optionalCollectionSchema` or similar parsers fails
// with "expected object". These tests pin the contract: objects in →
// objects out.

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
	const op = makeOp(
		ACTION_CREATE_COLLECTION,
		{
			id: COL_ID,
			name: "RoundTrip",
			symbol: "ROUND",
			totalPotential: 100,
			maxInstances: 0,
			metadata: { description: "round-trip test", image: "https://example.com/img.png" },
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

describe("JSONB round-trip for schema and immutableData", () => {
	beforeAll(async () => {
		COL_ID = await generateDeterministicCollectionId("alice", "RoundTrip", "ROUND");
		await sql.unsafe(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
		const schemaFile = Bun.file(import.meta.dir + "/../db/schema.sql");
		await sql.unsafe(await schemaFile.text());
	});

	afterAll(async () => {
		await cleanDb();
		await sql.end();
	});

	beforeEach(cleanDb);

	test("collections.schema stored via handleCreateCollection reads back as object", async () => {
		await createCollectionWithSchema();
		const row = await getCollectionRules(COL_ID);
		expect(row).not.toBeNull();
		expect(typeof row!.schema).toBe("object");
		expect(row!.schema).toEqual({
			immutable: [{ name: "rarity", type: "uint32" }],
			mutable: [{ name: "xp", type: "uint32" }],
		});
	});

	test("schema_versions.schema written by handleExtendSchema reads back as object", async () => {
		await createCollectionWithSchema();
		const op = makeOp(ACTION_EXTEND_SCHEMA, {
			collectionId: COL_ID,
			newMutableFields: [{ name: "level", type: "uint32" }],
		});
		await withTransaction((txn) => handleExtendSchema(op, txn));
		const [row] = await sql`SELECT schema FROM schema_versions WHERE collection_id = ${COL_ID} ORDER BY version DESC LIMIT 1`;
		expect(row).toBeDefined();
		expect(typeof row?.schema).toBe("object");
		expect(row?.schema).toEqual({
			immutable: [{ name: "rarity", type: "uint32" }],
			mutable: [
				{ name: "xp", type: "uint32" },
				{ name: "level", type: "uint32" },
			],
		});
	});

	test("nfts.immutable_data stored via handleMint reads back as object", async () => {
		await createCollectionWithSchema();
		const seedId = await generateDeterministicSeedId(COL_ID, "seed1");
		const op = makeOp(ACTION_MINT, {
			id: seedId,
			collectionId: COL_ID,
			artId: "seed1",
			edition: 1,
			owner: "alice",
			maxSupply: 10,
			metadata: { name: "Seed", imageUrl: "https://example.com/nft.png", imageHash: "img_seed" },
			immutableData: { rarity: 7 },
		});
		await withTransaction((txn) => handleMint(op, txn));
		const [row] = await sql`SELECT immutable_data FROM nfts WHERE id = ${seedId}`;
		expect(typeof row?.immutable_data).toBe("object");
		expect(row?.immutable_data).toEqual({ rarity: 7 });
	});
});
