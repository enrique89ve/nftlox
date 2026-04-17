import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { sql } from "@/db/client.ts";

// Defense-in-depth for `collections`. The app never mutates the structural
// identity of a collection (creator, symbol, total_potential, audit trail) —
// only schema fields (schema, schema_version) legitimately update via the
// set_schema flow. The trigger blocks any other route.

const COL_ID = "coll-trg-test-1";

async function resetFixture(): Promise<void> {
	await sql`TRUNCATE TABLE collections CASCADE`;
	await sql`
		INSERT INTO collections (
			id, name, symbol, creator, total_potential,
			description, image_url, external_url,
			transferable, burnable, royalty_pct, royalty_recipient,
			schema, schema_version,
			block_num, tx_id, created_at
		) VALUES (
			${COL_ID}, 'TrigColl', 'TRCOL01', 'alice', 100,
			'A collection', 'https://img/c.png', 'https://x/c',
			TRUE, TRUE, 5.00, 'alice',
			NULL, 0,
			200, 'tx-coll-1', NOW()
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

describe("collections triggers — structural immutability", () => {
	beforeEach(resetFixture);

	it("rejects UPDATE of id", async () => {
		await expectQueryError(
			() => sql`UPDATE collections SET id = 'other-id' WHERE id = ${COL_ID}`,
			/collections\.id is immutable/,
		);
	});

	it("rejects UPDATE of creator", async () => {
		await expectQueryError(
			() => sql`UPDATE collections SET creator = 'mallory' WHERE id = ${COL_ID}`,
			/collections\.creator is immutable/,
		);
	});

	it("rejects UPDATE of symbol", async () => {
		await expectQueryError(
			() => sql`UPDATE collections SET symbol = 'OTHR01' WHERE id = ${COL_ID}`,
			/collections\.symbol is immutable/,
		);
	});

	it("rejects UPDATE of total_potential", async () => {
		await expectQueryError(
			() => sql`UPDATE collections SET total_potential = 9999 WHERE id = ${COL_ID}`,
			/collections\.total_potential is immutable/,
		);
	});

	it("rejects UPDATE of block_num", async () => {
		await expectQueryError(
			() => sql`UPDATE collections SET block_num = 999 WHERE id = ${COL_ID}`,
			/collections\.block_num is immutable/,
		);
	});

	it("rejects UPDATE of tx_id", async () => {
		await expectQueryError(
			() => sql`UPDATE collections SET tx_id = 'tx-tampered' WHERE id = ${COL_ID}`,
			/collections\.tx_id is immutable/,
		);
	});

	it("rejects UPDATE of created_at", async () => {
		await expectQueryError(
			() => sql`UPDATE collections SET created_at = NOW() WHERE id = ${COL_ID}`,
			/collections\.created_at is immutable/,
		);
	});
});

describe("collections triggers — legitimate mutations still allowed", () => {
	beforeEach(resetFixture);

	it("allows UPDATE of schema (set_schema path)", async () => {
		await sql`UPDATE collections SET schema = '{"v":1}'::jsonb WHERE id = ${COL_ID}`;
		const [row] = await sql`SELECT schema FROM collections WHERE id = ${COL_ID}`;
		expect(row?.schema).toEqual({ v: 1 });
	});

	it("allows UPDATE of schema_version (set_schema path)", async () => {
		await sql`UPDATE collections SET schema_version = 1 WHERE id = ${COL_ID}`;
		const [row] = await sql`SELECT schema_version FROM collections WHERE id = ${COL_ID}`;
		expect(Number(row?.schema_version)).toBe(1);
	});

	it("allows UPDATE of schema + schema_version together (canonical update path)", async () => {
		await sql`
			UPDATE collections
			SET schema = '{"fields":[]}'::jsonb, schema_version = 2
			WHERE id = ${COL_ID}
		`;
		const [row] = await sql`SELECT schema, schema_version FROM collections WHERE id = ${COL_ID}`;
		expect(row?.schema).toEqual({ fields: [] });
		expect(Number(row?.schema_version)).toBe(2);
	});

	it("allows UPDATE of policy fields (not locked down — future-feature surface)", async () => {
		// Policy fields (name, description, image_url, transferable, royalty_*)
		// are not structurally locked. The app doesn't write them today, but
		// freezing them at the DB layer would encode a product decision the
		// current code doesn't enforce. Keep the trigger conservative.
		await sql`UPDATE collections SET description = 'updated desc' WHERE id = ${COL_ID}`;
		const [row] = await sql`SELECT description FROM collections WHERE id = ${COL_ID}`;
		expect(row?.description).toBe("updated desc");
	});
});
