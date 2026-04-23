import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { sql } from "@/db/client.ts";

// Verifies the schema-level triggers on `nfts` that enforce post-INSERT
// invariants (defense-in-depth for SPV hash correctness and structural
// immutability). The application code never attempts these UPDATEs — the
// triggers exist to catch a future handler bug, schema drift, or manual
// ad-hoc SQL that would silently corrupt projected state.

const NFT_ID = "trigger-test-nft-1";
const COLLECTION_ID = "trigger-test-coll";

async function resetFixture(): Promise<void> {
	await sql`TRUNCATE TABLE nfts, collections, owner_nft_counts, collection_stats CASCADE`;
	await sql`
		INSERT INTO collections (id, name, symbol, creator, block_num, tx_id, created_at)
		VALUES (${COLLECTION_ID}, 'TriggerTest', 'TRG0001', 'alice', 100, 'tx-trg-coll', NOW())
	`;
	await sql`
		INSERT INTO nfts (
			id, collection_id, nft_type, status, edition, owner,
			origin_dna, instance_dna, name, image_url,
			max_supply, distributed, seed_id, instance_number, art_id,
			immutable_data, data_operation_id, data_hash,
			schema_version, previous_owner, owner_operation_id, owner_action, owner_block_num,
			created_operation_id, created_block_num, created_tx_id, created_at
		) VALUES (
			${NFT_ID}, ${COLLECTION_ID}, 'seed', 'active', 1, 'alice',
			'dna-orig', NULL, 'Name-1', 'https://img.example/1.png',
			10, 0, NULL, NULL, 'art-trg-1',
			'{"tier":"gold"}'::jsonb, 'op-mint-1', 'hash-1',
			0, NULL, 'op-mint-1', 'mint', 100,
			'op-mint-1', 100, 'tx-mint-1', NOW()
		)
	`;
}

// postgres.js returns a PendingQuery (not a real Promise) from a tagged template,
// which trips up bun's `expect(...).rejects.toThrow()` matcher and hangs until
// the per-test 5s timeout. Awaiting inside try/catch converts it into a proper
// rejection we can match against.
async function expectQueryError(
	run: () => Promise<unknown>,
	pattern: RegExp,
): Promise<void> {
	let caught: unknown = null;
	try {
		await run();
	} catch (err) {
		caught = err;
	}
	if (caught === null) {
		throw new Error(`expected query to reject matching ${pattern}, but it resolved`);
	}
	expect(String(caught)).toMatch(pattern);
}

afterAll(async () => {
	await sql.end();
});

describe("nfts triggers — immutable columns", () => {
	beforeEach(resetFixture);

	it("rejects UPDATE of id (primary key re-anchor would desync state_root)", async () => {
		await expectQueryError(
			() => sql`UPDATE nfts SET id = 'nft-tampered' WHERE id = ${NFT_ID}`,
			/nfts\.id is immutable/,
		);
	});

	it("rejects UPDATE of collection_id", async () => {
		await expectQueryError(
			() => sql`UPDATE nfts SET collection_id = 'other-coll' WHERE id = ${NFT_ID}`,
			/collection_id is immutable/,
		);
	});

	it("rejects UPDATE of nft_type", async () => {
		await expectQueryError(
			() => sql`UPDATE nfts SET nft_type = 'instance' WHERE id = ${NFT_ID}`,
			/nft_type is immutable/,
		);
	});

	it("rejects UPDATE of edition", async () => {
		await expectQueryError(
			() => sql`UPDATE nfts SET edition = 2 WHERE id = ${NFT_ID}`,
			/edition is immutable/,
		);
	});

	it("rejects UPDATE of origin_dna", async () => {
		await expectQueryError(
			() => sql`UPDATE nfts SET origin_dna = 'dna-tampered' WHERE id = ${NFT_ID}`,
			/origin_dna is immutable/,
		);
	});

	it("rejects UPDATE of instance_dna (NULL → value — NULL-safe IS DISTINCT FROM)", async () => {
		// Fixture leaves instance_dna NULL (seed NFT). A silent write of an
		// instance DNA would break the seed/instance identity partition that
		// bulk_distribute relies on.
		await expectQueryError(
			() => sql`UPDATE nfts SET instance_dna = 'dna-tampered-instance' WHERE id = ${NFT_ID}`,
			/instance_dna is immutable/,
		);
	});

	it("rejects UPDATE of name", async () => {
		await expectQueryError(
			() => sql`UPDATE nfts SET name = 'Renamed' WHERE id = ${NFT_ID}`,
			/name is immutable/,
		);
	});

	it("rejects UPDATE of image_url", async () => {
		await expectQueryError(
			() => sql`UPDATE nfts SET image_url = 'https://img.example/2.png' WHERE id = ${NFT_ID}`,
			/image_url is immutable/,
		);
	});

	it("rejects UPDATE of max_supply", async () => {
		await expectQueryError(
			() => sql`UPDATE nfts SET max_supply = 100 WHERE id = ${NFT_ID}`,
			/max_supply is immutable/,
		);
	});

	it("rejects UPDATE of seed_id (would repoint instance → different seed)", async () => {
		// BEFORE UPDATE fires before FK validation, so the trigger catches the
		// immutability violation even when the target seed id does not exist.
		await expectQueryError(
			() => sql`UPDATE nfts SET seed_id = 'seed-tampered' WHERE id = ${NFT_ID}`,
			/seed_id is immutable/,
		);
	});

	it("rejects UPDATE of instance_number (ordinal identity of an instance)", async () => {
		await expectQueryError(
			() => sql`UPDATE nfts SET instance_number = 7 WHERE id = ${NFT_ID}`,
			/instance_number is immutable/,
		);
	});

	it("rejects UPDATE of art_id", async () => {
		await expectQueryError(
			() => sql`UPDATE nfts SET art_id = 'art-other' WHERE id = ${NFT_ID}`,
			/art_id is immutable/,
		);
	});

	it("rejects UPDATE of immutable_data", async () => {
		await expectQueryError(
			() => sql`UPDATE nfts SET immutable_data = '{"tier":"silver"}'::jsonb WHERE id = ${NFT_ID}`,
			/immutable_data is immutable/,
		);
	});

	it("rejects UPDATE of schema_version", async () => {
		await expectQueryError(
			() => sql`UPDATE nfts SET schema_version = 99 WHERE id = ${NFT_ID}`,
			/schema_version is immutable/,
		);
	});

	it("rejects UPDATE of created_operation_id", async () => {
		await expectQueryError(
			() => sql`UPDATE nfts SET created_operation_id = 'op-tampered' WHERE id = ${NFT_ID}`,
			/created_.* immutable/,
		);
	});

	it("rejects UPDATE of created_block_num", async () => {
		await expectQueryError(
			() => sql`UPDATE nfts SET created_block_num = 999 WHERE id = ${NFT_ID}`,
			/created_.* immutable/,
		);
	});

	it("allows UPDATE of mutable columns (reserved_supply)", async () => {
		await sql`UPDATE nfts SET reserved_supply = 3 WHERE id = ${NFT_ID}`;
		const [row] = await sql`SELECT reserved_supply FROM nfts WHERE id = ${NFT_ID}`;
		expect(Number(row?.reserved_supply)).toBe(3);
	});

	it("allows UPDATE of distributed (seed mint counter)", async () => {
		await sql`UPDATE nfts SET distributed = distributed + 3 WHERE id = ${NFT_ID}`;
		const [row] = await sql`SELECT distributed FROM nfts WHERE id = ${NFT_ID}`;
		expect(Number(row?.distributed)).toBe(3);
	});

	it("allows UPDATE of ownership fields together (transfer path)", async () => {
		await sql`
			UPDATE nfts SET
				owner = 'bob',
				previous_owner = 'alice',
				owner_operation_id = 'op-xfer-1',
				owner_action = 'transfer',
				owner_block_num = 105
			WHERE id = ${NFT_ID}
		`;
		const [row] = await sql`SELECT owner, previous_owner, owner_block_num FROM nfts WHERE id = ${NFT_ID}`;
		expect(row?.owner).toBe("bob");
		expect(row?.previous_owner).toBe("alice");
		expect(Number(row?.owner_block_num)).toBe(105);
	});

	it("allows UPDATE of data ref columns (set_data path)", async () => {
		await sql`UPDATE nfts SET data_hash = 'hash-new', data_operation_id = 'op-setdata-1' WHERE id = ${NFT_ID}`;
		const [row] = await sql`SELECT data_hash FROM nfts WHERE id = ${NFT_ID}`;
		expect(row?.data_hash).toBe("hash-new");
	});
});

describe("nfts triggers — owner_block_num regression", () => {
	beforeEach(resetFixture);

	it("rejects UPDATE setting owner_block_num below current", async () => {
		await expectQueryError(
			() => sql`UPDATE nfts SET owner_block_num = 50 WHERE id = ${NFT_ID}`,
			/owner_block_num regression/,
		);
	});

	it("allows UPDATE with equal owner_block_num (intra-block mutation)", async () => {
		await sql`UPDATE nfts SET owner_block_num = 100 WHERE id = ${NFT_ID}`;
		const [row] = await sql`SELECT owner_block_num FROM nfts WHERE id = ${NFT_ID}`;
		expect(Number(row?.owner_block_num)).toBe(100);
	});

	it("allows UPDATE with higher owner_block_num (forward progress)", async () => {
		await sql`UPDATE nfts SET owner_block_num = 250 WHERE id = ${NFT_ID}`;
		const [row] = await sql`SELECT owner_block_num FROM nfts WHERE id = ${NFT_ID}`;
		expect(Number(row?.owner_block_num)).toBe(250);
	});

	it("raises the SPV-invariant-violation message (clear diagnostic)", async () => {
		await expectQueryError(
			() => sql`UPDATE nfts SET owner_block_num = 99 WHERE id = ${NFT_ID}`,
			/SPV invariant violation/,
		);
	});
});
