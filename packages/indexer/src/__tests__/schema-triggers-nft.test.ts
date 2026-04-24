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
		INSERT INTO collections (id, name, symbol, creator, origin_dna, block_num, tx_id, created_at)
		VALUES (${COLLECTION_ID}, 'TriggerTest', 'TRG0001', 'alice', 'odna_trg', 100, 'tx-trg-coll', NOW())
	`;
	await sql`
		INSERT INTO nfts (
			id, collection_id, nft_type, status, edition, owner,
			nft_dna, name, image_url,
			max_supply, distributed, seed_id, instance_number, art_id,
			immutable_data, data_operation_id, data_hash,
			schema_version, previous_owner, owner_operation_id, owner_action, owner_block_num,
			created_operation_id, created_block_num, created_tx_id, created_at
		) VALUES (
			${NFT_ID}, ${COLLECTION_ID}, 'seed', 'active', 1, 'alice',
			NULL, 'Name-1', 'https://img.example/1.png',
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

async function insertInstanceRow(id: string, seedId: string, collectionId: string, instanceNumber: number): Promise<void> {
	const opId = `op-${id}`;
	const txId = `tx-${id}`;
	await sql`
		INSERT INTO nfts (
			id, collection_id, nft_type, status, edition, owner,
			nft_dna, name, image_url, max_supply, distributed,
			seed_id, instance_number, art_id,
			immutable_data, data_operation_id, data_hash,
			schema_version, previous_owner, owner_operation_id, owner_action, owner_block_num,
			created_operation_id, created_block_num, created_tx_id, created_at
		) VALUES (
			${id}, ${collectionId}, 'instance', 'active', 1, 'bob',
			${"idna_" + id}, '', NULL, 0, 0,
			${seedId}, ${instanceNumber}, NULL,
			NULL, NULL, NULL,
			0, NULL, ${opId}, 'bulk_distribute', 150,
			${opId}, 150, ${txId}, NOW()
		)
	`;
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

	// origin_dna lives on `collections` now — the seed/instance rows no longer
	// carry it. The equivalent immutability test has moved to
	// schema-triggers-collections.test.ts ("rejects UPDATE of origin_dna").

	it("rejects UPDATE of nft_dna (NULL → value — NULL-safe IS DISTINCT FROM)", async () => {
		// Fixture leaves nft_dna NULL (seed NFT). A silent write of a DNA
		// value would break the cryptographic identity recorded at mint time.
		await expectQueryError(
			() => sql`UPDATE nfts SET nft_dna = 'dna-tampered' WHERE id = ${NFT_ID}`,
			/nft_dna is immutable/,
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

describe("nfts schema — seed and instance uniqueness", () => {
	beforeEach(resetFixture);

	it("rejects duplicate seed art_id within the same collection", async () => {
		await expectQueryError(
			() => sql`
				INSERT INTO nfts (
					id, collection_id, nft_type, status, edition, owner,
					nft_dna, name, image_url,
					max_supply, distributed, seed_id, instance_number, art_id,
					immutable_data, data_operation_id, data_hash,
					schema_version, previous_owner, owner_operation_id, owner_action, owner_block_num,
					created_operation_id, created_block_num, created_tx_id, created_at
				) VALUES (
					'trigger-test-seed-dup-art', ${COLLECTION_ID}, 'seed', 'active', 1, 'alice',
					NULL, 'DupArt', 'https://img.example/dup.png',
					10, 0, NULL, NULL, 'art-trg-1',
					NULL, 'op-dup-art', NULL,
					0, NULL, 'op-dup-art', 'mint', 101,
					'op-dup-art', 101, 'tx-dup-art', NOW()
				)
			`,
			/idx_nfts_collection_art_unique|duplicate key/,
		);
	});

	it("rejects duplicate instance_number within the same seed even with a different id", async () => {
		await insertInstanceRow("trigger-test-inst-ord-1", NFT_ID, COLLECTION_ID, 1);
		await expectQueryError(
			() => insertInstanceRow("trigger-test-inst-ord-1-alt-id", NFT_ID, COLLECTION_ID, 1),
			/idx_nfts_seed_instances|duplicate key/,
		);
	});
});

describe("nfts triggers — instance.collection_id matches parent seed", () => {
	const OTHER_COLLECTION_ID = "trigger-test-coll-other";

	beforeEach(async () => {
		await resetFixture();
		// Create a second collection so we can try to insert an instance whose
		// collection_id disagrees with its parent seed's collection_id.
		await sql`
			INSERT INTO collections (id, name, symbol, creator, origin_dna, block_num, tx_id, created_at)
			VALUES (${OTHER_COLLECTION_ID}, 'OtherTrig', 'TRGOTH1', 'alice', 'odna_trg_other', 101, 'tx-trg-other', NOW())
		`;
	});

	it("rejects INSERT of instance with collection_id that does not match its seed's", async () => {
		// The fixture seed belongs to COLLECTION_ID. An instance claiming a
		// different collection would drift the ownership projection and
		// state_root between replicas if the app-level path ever wrote it.
		await expectQueryError(
			() => sql`
				INSERT INTO nfts (
					id, collection_id, nft_type, status, edition, owner,
					nft_dna, name, image_url, max_supply, distributed,
					seed_id, instance_number, art_id,
					immutable_data, data_operation_id, data_hash,
					schema_version, previous_owner, owner_operation_id,
					owner_action, owner_block_num,
					created_operation_id, created_block_num, created_tx_id, created_at
				) VALUES (
					'trigger-test-instance-1', ${OTHER_COLLECTION_ID}, 'instance', 'active', 1, 'bob',
					'idna-inst-1', '', NULL, 0, 0,
					${NFT_ID}, 1, NULL,
					NULL, NULL, NULL,
					0, NULL, 'op-dist-1',
					'bulk_distribute', 150,
					'op-dist-1', 150, 'tx-dist-1', NOW()
				)
			`,
			/collection_id mismatch/,
		);
	});

	it("accepts INSERT of instance with matching collection_id", async () => {
		await sql`
			INSERT INTO nfts (
				id, collection_id, nft_type, status, edition, owner,
				nft_dna, name, image_url, max_supply, distributed,
				seed_id, instance_number, art_id,
				immutable_data, data_operation_id, data_hash,
				schema_version, previous_owner, owner_operation_id,
				owner_action, owner_block_num,
				created_operation_id, created_block_num, created_tx_id, created_at
			) VALUES (
				'trigger-test-instance-ok', ${COLLECTION_ID}, 'instance', 'active', 1, 'bob',
				'idna-inst-ok', '', NULL, 0, 0,
				${NFT_ID}, 1, NULL,
				NULL, NULL, NULL,
				0, NULL, 'op-dist-ok',
				'bulk_distribute', 150,
				'op-dist-ok', 150, 'tx-dist-ok', NOW()
			)
		`;
		const [row] = await sql`SELECT collection_id FROM nfts WHERE id = 'trigger-test-instance-ok'`;
		expect(row?.collection_id).toBe(COLLECTION_ID);
	});

	it("allows INSERT of seed (seed_id NULL) — trigger skips the check", async () => {
		await sql`
			INSERT INTO nfts (
				id, collection_id, nft_type, status, edition, owner,
				nft_dna, name, image_url, max_supply, distributed,
				seed_id, instance_number, art_id,
				immutable_data, data_operation_id, data_hash,
				schema_version, previous_owner, owner_operation_id,
				owner_action, owner_block_num,
				created_operation_id, created_block_num, created_tx_id, created_at
			) VALUES (
				'trigger-test-seed-2', ${COLLECTION_ID}, 'seed', 'active', 1, 'alice',
				NULL, 'Name-2', 'https://img.example/2.png', 10, 0,
				NULL, NULL, 'art-trg-2',
				NULL, 'op-mint-2', NULL,
				0, NULL, 'op-mint-2',
				'mint', 120,
				'op-mint-2', 120, 'tx-mint-2', NOW()
			)
		`;
		const [row] = await sql`SELECT seed_id FROM nfts WHERE id = 'trigger-test-seed-2'`;
		expect(row?.seed_id).toBeNull();
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

describe("nfts triggers — enforce_max_instances (collection cap backstop)", () => {
	const CAPPED_COL = "cap-test-coll";
	const CAPPED_SEED = "cap-test-seed";

	async function seedCappedFixture(cap: number): Promise<void> {
		await sql`TRUNCATE TABLE nfts, collections, owner_nft_counts, collection_stats CASCADE`;
		await sql`
			INSERT INTO collections (id, name, symbol, creator, origin_dna, max_instances, block_num, tx_id, created_at)
			VALUES (${CAPPED_COL}, 'Capped', 'CAP0001', 'alice', 'odna_cap', ${cap}, 100, 'tx-cap-coll', NOW())
		`;
		await sql`
			INSERT INTO nfts (
				id, collection_id, nft_type, status, edition, owner,
				nft_dna, name, image_url,
				max_supply, distributed, seed_id, instance_number, art_id,
				immutable_data, data_operation_id, data_hash,
				schema_version, previous_owner, owner_operation_id, owner_action, owner_block_num,
				created_operation_id, created_block_num, created_tx_id, created_at
			) VALUES (
				${CAPPED_SEED}, ${CAPPED_COL}, 'seed', 'active', 1, 'alice',
				NULL, 'CapSeed', 'https://img.example/cap.png',
				1000, 0, NULL, NULL, 'art-cap',
				NULL, 'op-cap-mint', NULL,
				0, NULL, 'op-cap-mint', 'mint', 100,
				'op-cap-mint', 100, 'tx-cap-mint', NOW()
			)
		`;
	}

	it("rejects instance INSERT when would exceed collections.max_instances", async () => {
		await seedCappedFixture(2);
		// Simulate two instances already materialized — handler would have
		// incremented collection_stats.instances to 2 after those inserts.
		// Trigger already created the row with seeds=1, instances=0 after
		// inserting the fixture seed. Bump instances to simulate prior mints.
		await sql`UPDATE collection_stats SET instances = 2 WHERE collection_id = ${CAPPED_COL}`;
		await expectQueryError(
			() => insertInstanceRow("cap-test-inst-3", CAPPED_SEED, CAPPED_COL, 3),
			/instance cap exceeded/,
		);
	});

	it("accepts instance INSERT when strictly below max_instances", async () => {
		await seedCappedFixture(5);
		await sql`UPDATE collection_stats SET instances = 2 WHERE collection_id = ${CAPPED_COL}`;
		await insertInstanceRow("cap-test-inst-ok", CAPPED_SEED, CAPPED_COL, 3);
		const [row] = await sql`SELECT id FROM nfts WHERE id = 'cap-test-inst-ok'`;
		expect(row?.id).toBe("cap-test-inst-ok");
	});

	it("allows unlimited instances when max_instances = 0 (creator opt-out)", async () => {
		await seedCappedFixture(0);
		// Pretend the collection already has 10_000 instances; trigger must skip
		// the check because cap = 0 means unlimited.
		await sql`UPDATE collection_stats SET instances = 10000 WHERE collection_id = ${CAPPED_COL}`;
		await insertInstanceRow("cap-test-inst-unl", CAPPED_SEED, CAPPED_COL, 10001);
		const [row] = await sql`SELECT id FROM nfts WHERE id = 'cap-test-inst-unl'`;
		expect(row?.id).toBe("cap-test-inst-unl");
	});

	it("skips the check for seed inserts (seed_id IS NULL)", async () => {
		await seedCappedFixture(1);
		// Cap=1 and instances=1 already; inserting another SEED must not be
		// blocked by this trigger (seeds don't count against instance cap).
		await sql`UPDATE collection_stats SET instances = 1 WHERE collection_id = ${CAPPED_COL}`;
		await sql`
			INSERT INTO nfts (
				id, collection_id, nft_type, status, edition, owner,
				nft_dna, name, image_url,
				max_supply, distributed, seed_id, instance_number, art_id,
				immutable_data, data_operation_id, data_hash,
				schema_version, previous_owner, owner_operation_id, owner_action, owner_block_num,
				created_operation_id, created_block_num, created_tx_id, created_at
			) VALUES (
				'cap-test-seed-2', ${CAPPED_COL}, 'seed', 'active', 1, 'alice',
				NULL, 'CapSeed2', 'https://img.example/cap2.png',
				100, 0, NULL, NULL, 'art-cap-2',
				NULL, 'op-cap-mint-2', NULL,
				0, NULL, 'op-cap-mint-2', 'mint', 120,
				'op-cap-mint-2', 120, 'tx-cap-mint-2', NOW()
			)
		`;
		const [row] = await sql`SELECT id FROM nfts WHERE id = 'cap-test-seed-2'`;
		expect(row?.id).toBe("cap-test-seed-2");
	});
});
