import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { sql } from "@/db/client.ts";

// CHECK-constraint backstops for invariants the application layer already
// enforces. They catch schema drift, ad-hoc SQL, or future refactors that
// bypass the handler pipeline. Scope is strictly defensive — don't rely on
// them for primary validation, but don't leave the DB willing to accept
// structurally impossible rows either.

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

beforeEach(async () => {
	await sql`TRUNCATE TABLE collections CASCADE`;
	await sql`TRUNCATE TABLE sales`;
});

afterAll(async () => {
	await sql.end();
});

describe("collections — total_potential >= 0", () => {
	it("rejects negative total_potential on INSERT", async () => {
		await expectQueryError(
			() => sql`
				INSERT INTO collections (id, name, symbol, creator, total_potential, block_num, tx_id, created_at)
				VALUES ('coll-tp-neg', 'X', 'XNEG01', 'alice', -1, 100, 'tx-tp', NOW())
			`,
			/total_potential/i,
		);
	});

	it("accepts zero and positive total_potential", async () => {
		await sql`
			INSERT INTO collections (id, name, symbol, creator, total_potential, block_num, tx_id, created_at)
			VALUES ('coll-tp-zero', 'X', 'XZER01', 'alice', 0, 100, 'tx-tp', NOW()),
			       ('coll-tp-pos',  'Y', 'XPOS01', 'alice', 42, 100, 'tx-tp', NOW())
		`;
		const rows = await sql`SELECT id FROM collections WHERE id LIKE 'coll-tp-%'`;
		expect(rows.length).toBe(2);
	});
});

describe("collections — royalty_pct in [0, 100]", () => {
	it("rejects royalty_pct below 0", async () => {
		await expectQueryError(
			() => sql`
				INSERT INTO collections (id, name, symbol, creator, royalty_pct, block_num, tx_id, created_at)
				VALUES ('coll-rp-neg', 'X', 'XRNG01', 'alice', -0.01, 100, 'tx-rp', NOW())
			`,
			/royalty_pct/i,
		);
	});

	it("rejects royalty_pct above 100", async () => {
		await expectQueryError(
			() => sql`
				INSERT INTO collections (id, name, symbol, creator, royalty_pct, block_num, tx_id, created_at)
				VALUES ('coll-rp-over', 'X', 'XRNG02', 'alice', 100.01, 100, 'tx-rp', NOW())
			`,
			/royalty_pct/i,
		);
	});

	it("accepts boundary values (0, 100) and typical mid-range", async () => {
		await sql`
			INSERT INTO collections (id, name, symbol, creator, royalty_pct, block_num, tx_id, created_at)
			VALUES ('coll-rp-zero', 'X', 'XRNG03', 'alice', 0,    100, 'tx-rp', NOW()),
			       ('coll-rp-mid',  'Y', 'XRNG04', 'alice', 5.50, 100, 'tx-rp', NOW()),
			       ('coll-rp-max',  'Z', 'XRNG05', 'alice', 100,  100, 'tx-rp', NOW())
		`;
		const rows = await sql`SELECT id FROM collections WHERE id LIKE 'coll-rp-%'`;
		expect(rows.length).toBe(3);
	});
});

describe("sales — seller <> buyer", () => {
	it("rejects self-sale (seller equals buyer)", async () => {
		await expectQueryError(
			() => sql`
				INSERT INTO sales (
					nft_id, collection_id, listing_id, seller, buyer,
					gross_amount, currency, seller_net,
					block_num, tx_id, created_at
				) VALUES (
					'nft-self', 'coll-self', 'lst-1', 'alice', 'alice',
					10, 'HIVE', 10,
					100, 'tx-self', NOW()
				)
			`,
			/seller|buyer|check/i,
		);
	});

	it("accepts distinct seller and buyer", async () => {
		await sql`
			INSERT INTO sales (
				nft_id, collection_id, listing_id, seller, buyer,
				gross_amount, currency, seller_net,
				block_num, tx_id, created_at
			) VALUES (
				'nft-ab', 'coll-ab', 'lst-2', 'alice', 'bob',
				10, 'HIVE', 10,
				100, 'tx-ab', NOW()
			)
		`;
		const [row] = await sql`SELECT buyer FROM sales WHERE nft_id = 'nft-ab'`;
		expect(row?.buyer).toBe("bob");
	});
});
