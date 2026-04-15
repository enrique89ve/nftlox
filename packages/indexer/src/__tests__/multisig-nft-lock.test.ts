/**
 * Tests for the multisig per-NFT lock.
 *
 * The lock is the ONLY race the multisig node can prevent on its own: two
 * concurrent buy requests for the same NFT both getting co-signed. Without
 * it, the loser's transfers still land on-chain while their buy op is
 * rejected by the indexer — funds lost with no automated refund path.
 *
 * Uses real DB (same pattern as multisig-service.test.ts).
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { sql } from "@/db/client.ts";
import { createMultisigNftLock } from "@/api/services/multisig-nft-lock.ts";

const lock = createMultisigNftLock();

describe("multisig_locks", () => {
	beforeAll(async () => {
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
		const a = await lock.acquire("nft_1", "alice", 60_000);
		expect(a.acquired).toBe(true);

		const b = await lock.acquire("nft_1", "bob", 60_000);
		expect(b.acquired).toBe(false);
		if (!b.acquired) {
			expect(b.heldBy).toBe("alice");
			expect(b.retryAfterMs).toBeGreaterThan(0);
			expect(b.retryAfterMs).toBeLessThanOrEqual(60_000);
		}
	});

	test("same buyer can re-acquire (idempotent refresh)", async () => {
		const first = await lock.acquire("nft_1", "alice", 60_000);
		expect(first.acquired).toBe(true);

		const second = await lock.acquire("nft_1", "alice", 60_000);
		expect(second.acquired).toBe(true);
	});

	test("release is buyer-scoped — wrong buyer cannot nuke the lock", async () => {
		await lock.acquire("nft_1", "alice", 60_000);

		// Bob's release for Alice's lock is a no-op
		await lock.release("nft_1", "bob");

		const b = await lock.acquire("nft_1", "bob", 60_000);
		expect(b.acquired).toBe(false);
		if (!b.acquired) {
			expect(b.heldBy).toBe("alice");
		}
	});

	test("correct-buyer release frees the lock for another buyer", async () => {
		await lock.acquire("nft_1", "alice", 60_000);
		await lock.release("nft_1", "alice");

		const b = await lock.acquire("nft_1", "bob", 60_000);
		expect(b.acquired).toBe(true);
	});

	test("expired lock is atomically replaced on next acquire", async () => {
		// 1ms expiration — the acquire SQL deletes expired rows atomically
		// before trying to insert, so the next acquire sees no prior lock.
		await lock.acquire("nft_1", "alice", 1);
		await new Promise(resolve => setTimeout(resolve, 20));

		const b = await lock.acquire("nft_1", "bob", 60_000);
		expect(b.acquired).toBe(true);

		const [row] = await sql`SELECT buyer FROM multisig_locks WHERE nft_id = 'nft_1'`;
		expect(row?.buyer).toBe("bob");
	});

	test("different NFTs do not contend", async () => {
		const a = await lock.acquire("nft_1", "alice", 60_000);
		const b = await lock.acquire("nft_2", "bob", 60_000);
		expect(a.acquired).toBe(true);
		expect(b.acquired).toBe(true);
	});

	test("concurrent acquires for same NFT — exactly one wins", async () => {
		// Fire N parallel acquires from distinct buyers for the same NFT.
		// Postgres-level serialization must guarantee exactly one acquires.
		const buyers = ["a", "b", "c", "d", "e"];
		const results = await Promise.all(
			buyers.map(buyer => lock.acquire("nft_race", buyer, 60_000)),
		);
		const winners = results.filter(r => r.acquired);
		expect(winners.length).toBe(1);

		const losers = results.filter((r): r is Extract<typeof r, { acquired: false }> => !r.acquired);
		expect(losers.length).toBe(buyers.length - 1);
		// Every loser must see the same holder
		const heldBys = new Set(losers.map(r => r.heldBy));
		expect(heldBys.size).toBe(1);
	});
});
