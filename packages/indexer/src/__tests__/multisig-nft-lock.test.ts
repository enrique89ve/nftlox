/**
 * Tests for the multisig per-NFT lock.
 *
 * The lock is the ONLY race the multisig node can prevent on its own: two
 * concurrent buy requests for the same NFT both getting co-signed. Without
 * it, the loser's transfers still land on-chain while their buy op is
 * rejected by the indexer — funds lost with no automated refund path.
 *
 * The lock is now keyed by (nft_id) with an idempotency clause on
 * (buyer, listing_id): the same buyer retrying the same listing may re-acquire
 * and refresh the expiration, but a different buyer or a different listing_id
 * for the same NFT is rejected.
 *
 * Uses real DB (same pattern as multisig-service.test.ts).
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { sql } from "@/db/client.ts";
import {
	createMultisigNftLock,
	type NftLockAcquireInput,
} from "@/api/services/multisig-nft-lock.ts";

const lock = createMultisigNftLock();

type Overrides = Partial<NftLockAcquireInput>;

function acquireInput(overrides: Overrides = {}): NftLockAcquireInput {
	return {
		nftId: overrides.nftId ?? "nft_1",
		buyer: overrides.buyer ?? "alice",
		listingId: overrides.listingId ?? "listing_1",
		listTxId: overrides.listTxId ?? "list_tx_1",
		snapshotBlock: overrides.snapshotBlock ?? 1000,
		expirationMs: overrides.expirationMs ?? 60_000,
	};
}

describe("multisig_locks", () => {
	beforeAll(async () => {
		// Drift-immune wipe matches handlers.test.ts — stale leftover tables from
		// a prior run can reject CREATE INDEX statements against new columns.
		await sql.unsafe(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
		const schemaFile = Bun.file(import.meta.dir + "/../db/schema.sql");
		await sql.unsafe(await schemaFile.text());
	});

	beforeEach(async () => {
		await sql`DELETE FROM multisig_locks`;
	});

	afterAll(async () => {
		await sql`DELETE FROM multisig_locks`;
		lock.destroy();
		await sql.end();
	});

	test("second buyer is rejected while first holds the lock", async () => {
		const a = await lock.acquire(acquireInput({ buyer: "alice" }));
		expect(a.acquired).toBe(true);

		const b = await lock.acquire(acquireInput({ buyer: "bob" }));
		expect(b.acquired).toBe(false);
		if (!b.acquired) {
			expect(b.heldBy).toBe("alice");
			expect(b.retryAfterMs).toBeGreaterThan(0);
			expect(b.retryAfterMs).toBeLessThanOrEqual(60_000);
		}
	});

	test("same buyer + same listing is idempotent (refresh)", async () => {
		const first = await lock.acquire(acquireInput({ buyer: "alice", listingId: "listing_1" }));
		expect(first.acquired).toBe(true);

		const second = await lock.acquire(acquireInput({ buyer: "alice", listingId: "listing_1" }));
		expect(second.acquired).toBe(true);
	});

	test("same buyer with a different listing_id is rejected", async () => {
		// Seller relisted and the buyer retried against the old listing — or
		// is racing against themself across listings. Only one listing_id at a
		// time can be locked per (nft, buyer).
		const first = await lock.acquire(acquireInput({ buyer: "alice", listingId: "listing_1" }));
		expect(first.acquired).toBe(true);

		const second = await lock.acquire(acquireInput({ buyer: "alice", listingId: "listing_2" }));
		expect(second.acquired).toBe(false);
		if (!second.acquired) {
			expect(second.heldBy).toBe("alice");
		}
	});

	test("release is buyer-scoped — wrong buyer cannot nuke the lock", async () => {
		await lock.acquire(acquireInput({ buyer: "alice" }));

		await lock.release("nft_1", "bob");

		const b = await lock.acquire(acquireInput({ buyer: "bob" }));
		expect(b.acquired).toBe(false);
		if (!b.acquired) {
			expect(b.heldBy).toBe("alice");
		}
	});

	test("correct-buyer release frees the lock for another buyer", async () => {
		await lock.acquire(acquireInput({ buyer: "alice" }));
		await lock.release("nft_1", "alice");

		const b = await lock.acquire(acquireInput({ buyer: "bob" }));
		expect(b.acquired).toBe(true);
	});

	test("expired lock is atomically replaced on next acquire", async () => {
		await lock.acquire(acquireInput({ buyer: "alice", expirationMs: 1 }));
		await new Promise(resolve => setTimeout(resolve, 20));

		const b = await lock.acquire(acquireInput({ buyer: "bob" }));
		expect(b.acquired).toBe(true);

		const [row] = await sql`SELECT buyer FROM multisig_locks WHERE nft_id = 'nft_1'`;
		expect(row?.buyer).toBe("bob");
	});

	test("different NFTs do not contend", async () => {
		const a = await lock.acquire(acquireInput({ nftId: "nft_1", buyer: "alice" }));
		const b = await lock.acquire(acquireInput({ nftId: "nft_2", buyer: "bob" }));
		expect(a.acquired).toBe(true);
		expect(b.acquired).toBe(true);
	});

	test("persists the snapshot block and listing fields", async () => {
		await lock.acquire(
			acquireInput({
				nftId: "nft_snap",
				buyer: "alice",
				listingId: "listing_42",
				listTxId: "list_tx_xyz",
				snapshotBlock: 12345,
			}),
		);

		const [row] = await sql`
			SELECT buyer, listing_id, list_tx_id, snapshot_block
			FROM multisig_locks WHERE nft_id = 'nft_snap'
		`;
		expect(row?.buyer).toBe("alice");
		expect(row?.listing_id).toBe("listing_42");
		expect(row?.list_tx_id).toBe("list_tx_xyz");
		expect(Number(row?.snapshot_block)).toBe(12345);
	});

	test("concurrent acquires for same NFT — exactly one wins", async () => {
		// Fire N parallel acquires from distinct buyers for the same NFT.
		// Postgres-level serialization must guarantee exactly one acquires.
		const buyers = ["a", "b", "c", "d", "e"];
		const results = await Promise.all(
			buyers.map(buyer => lock.acquire(acquireInput({ nftId: "nft_race", buyer }))),
		);
		const winners = results.filter(r => r.acquired);
		expect(winners.length).toBe(1);

		const losers = results.filter((r): r is Extract<typeof r, { acquired: false }> => !r.acquired);
		expect(losers.length).toBe(buyers.length - 1);
		const heldBys = new Set(losers.map(r => r.heldBy));
		expect(heldBys.size).toBe(1);
	});
});
