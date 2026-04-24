import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { sql } from "@/db/client.ts";

// Defense-in-depth for `schema_versions`. The table is the hash chain
// recording every set_schema operation per collection (prev_hash links each
// row to its predecessor). Application code only ever INSERTs — any UPDATE
// would silently rewrite history and invalidate the chain from that row
// forward. DELETE remains legitimate because archiveCollection relies on
// ON DELETE CASCADE from `collections` to tear down versioned rows as part
// of a full collection teardown.

const COL_ID = "coll-sv-trg-test-1";

async function resetFixture(): Promise<void> {
	await sql`TRUNCATE TABLE collections CASCADE`;
	await sql`
		INSERT INTO collections (
			id, name, symbol, creator, origin_dna, total_potential,
			block_num, tx_id, created_at
		) VALUES (
			${COL_ID}, 'SVTrig', 'SVTRG01', 'alice', 'odna_sv', 10,
			500, 'tx-sv-coll', NOW()
		)
	`;
	await sql`
		INSERT INTO schema_versions (
			collection_id, version, schema, schema_hash, prev_hash,
			block_num, tx_id, created_at
		) VALUES (
			${COL_ID}, 1, '{"v":1}'::jsonb, 'hash-v1', NULL,
			500, 'tx-sv-v1', NOW()
		)
	`;
	await sql`
		INSERT INTO schema_versions (
			collection_id, version, schema, schema_hash, prev_hash,
			block_num, tx_id, created_at
		) VALUES (
			${COL_ID}, 2, '{"v":2}'::jsonb, 'hash-v2', 'hash-v1',
			510, 'tx-sv-v2', NOW()
		)
	`;
}

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

describe("schema_versions triggers — append-only", () => {
	beforeEach(resetFixture);

	it("rejects UPDATE of schema (would silently rewrite chain payload)", async () => {
		await expectQueryError(
			() => sql`UPDATE schema_versions SET schema = '{"v":99}'::jsonb WHERE collection_id = ${COL_ID} AND version = 1`,
			/schema_versions is append-only/,
		);
	});

	it("rejects UPDATE of schema_hash (would break chain continuity)", async () => {
		await expectQueryError(
			() => sql`UPDATE schema_versions SET schema_hash = 'hash-tampered' WHERE collection_id = ${COL_ID} AND version = 1`,
			/schema_versions is append-only/,
		);
	});

	it("rejects UPDATE of prev_hash (would rewrite chain linkage)", async () => {
		await expectQueryError(
			() => sql`UPDATE schema_versions SET prev_hash = 'hash-tampered' WHERE collection_id = ${COL_ID} AND version = 2`,
			/schema_versions is append-only/,
		);
	});

	it("rejects UPDATE of version (would collide with chain ordering)", async () => {
		await expectQueryError(
			() => sql`UPDATE schema_versions SET version = 3 WHERE collection_id = ${COL_ID} AND version = 1`,
			/schema_versions is append-only/,
		);
	});

	it("rejects UPDATE of audit fields (block_num / tx_id / created_at)", async () => {
		await expectQueryError(
			() => sql`UPDATE schema_versions SET block_num = 999 WHERE collection_id = ${COL_ID} AND version = 1`,
			/schema_versions is append-only/,
		);
	});

	it("allows INSERT (append new version to the chain)", async () => {
		await sql`
			INSERT INTO schema_versions (
				collection_id, version, schema, schema_hash, prev_hash,
				block_num, tx_id, created_at
			) VALUES (
				${COL_ID}, 3, '{"v":3}'::jsonb, 'hash-v3', 'hash-v2',
				520, 'tx-sv-v3', NOW()
			)
		`;
		const [row] = await sql`
			SELECT schema_hash FROM schema_versions WHERE collection_id = ${COL_ID} AND version = 3
		`;
		expect(row?.schema_hash).toBe("hash-v3");
	});

	it("allows DELETE via CASCADE from collections (archiveCollection path)", async () => {
		// DELETE FROM collections is the legitimate teardown path used by
		// archiveCollection. ON DELETE CASCADE removes schema_versions rows,
		// and the trigger must not block that flow.
		await sql`DELETE FROM collections WHERE id = ${COL_ID}`;
		const rows = await sql`SELECT 1 FROM schema_versions WHERE collection_id = ${COL_ID}`;
		expect(rows.length).toBe(0);
	});
});
