// Regression tests for the buy-flow lock module. The `finally` block in
// `multisig/buy.ts` relies on these invariants:
//
//   1. Once acquired, the lock survives a same-holder re-acquire (no refresh).
//      This is what makes the `commitmentBroadcast && !buyBroadcast` retention
//      branch safe — releasing on a same-holder retry would let the same
//      client emit a second commitment before the first is observable.
//   2. A different holder is rejected outright (ON CONFLICT DO NOTHING).
//   3. Release removes the row, freeing the slot for the next attempt.
//   4. cleanupExpired purges only past-TTL rows.
//
// These four are the load-bearing semantics for the buy flow's
// cross-node race protection. If any of them regress, the buy flow's
// lock retention behavior changes silently.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { sql, withTransaction } from "@/db/client.ts";
import { createMultisigBuyLock } from "@/api/services/multisig-buy-lock.ts";

const LOCK_TTL_MS = 1_000;

const TEST_NFT_ID = "nft_test_lock_001";
const TEST_LISTING_ID = "list_test_001";
const TEST_LIST_TX_ID = "listtx_001";
const HOLDER_A = "holderA";
const HOLDER_B = "holderB";

async function clearLockTable(): Promise<void> {
	await sql`DELETE FROM multisig_buy_locks WHERE nft_id = ${TEST_NFT_ID}`;
}

describe("multisig-buy-lock", () => {
	beforeEach(clearLockTable);
	afterEach(clearLockTable);

	describe("acquire", () => {
		it("returns acquired=true when the slot is free", async () => {
			const lock = createMultisigBuyLock();
			const result = await lock.acquire(
				TEST_NFT_ID,
				TEST_LISTING_ID,
				TEST_LIST_TX_ID,
				HOLDER_A,
				LOCK_TTL_MS,
			);
			expect(result.acquired).toBe(true);
		});

		// P1 invariant: same-buyer refresh was removed. A retry with the same
		// buyTxId inside the lock window must hit NFT_LOCKED, not silently
		// refresh expires_at. The buy flow's `finally` block depends on this
		// to prevent duplicate commitment broadcasts.
		it("returns acquired=false when the same holder tries to re-acquire (no refresh)", async () => {
			const lock = createMultisigBuyLock();
			const first = await lock.acquire(
				TEST_NFT_ID,
				TEST_LISTING_ID,
				TEST_LIST_TX_ID,
				HOLDER_A,
				LOCK_TTL_MS,
			);
			expect(first.acquired).toBe(true);

			// Capture the original expires_at to verify it is NOT refreshed.
			const [original] = await sql<{ expires_at: Date }[]>`
				SELECT expires_at FROM multisig_buy_locks WHERE nft_id = ${TEST_NFT_ID}
			`;
			expect(original).toBeDefined();

			// Sleep a few ms so a refresh would visibly change the timestamp.
			await new Promise((r) => setTimeout(r, 10));

			const second = await lock.acquire(
				TEST_NFT_ID,
				TEST_LISTING_ID,
				TEST_LIST_TX_ID,
				HOLDER_A,
				LOCK_TTL_MS,
			);
			expect(second.acquired).toBe(false);
			if (second.acquired === false) {
				expect(second.heldBy).toBe(HOLDER_A);
			}

			const [after] = await sql<{ expires_at: Date; holder: string }[]>`
				SELECT expires_at, holder FROM multisig_buy_locks WHERE nft_id = ${TEST_NFT_ID}
			`;
			expect(after?.holder).toBe(HOLDER_A);
			// The TTL must not have been extended by the failed re-acquire.
			expect(new Date(String(after?.expires_at)).getTime())
				.toBe(new Date(String(original?.expires_at)).getTime());
		});

		it("returns acquired=false when a different holder tries to acquire", async () => {
			const lock = createMultisigBuyLock();
			await lock.acquire(
				TEST_NFT_ID,
				TEST_LISTING_ID,
				TEST_LIST_TX_ID,
				HOLDER_A,
				LOCK_TTL_MS,
			);

			const second = await lock.acquire(
				TEST_NFT_ID,
				TEST_LISTING_ID,
				TEST_LIST_TX_ID,
				HOLDER_B,
				LOCK_TTL_MS,
			);
			expect(second.acquired).toBe(false);
			if (second.acquired === false) {
				expect(second.heldBy).toBe(HOLDER_A);
			}
		});
	});

	describe("release", () => {
		it("removes the row only when holder matches", async () => {
			const lock = createMultisigBuyLock();
			await lock.acquire(
				TEST_NFT_ID,
				TEST_LISTING_ID,
				TEST_LIST_TX_ID,
				HOLDER_A,
				LOCK_TTL_MS,
			);

			// Wrong holder — no-op, row remains.
			await lock.release(TEST_NFT_ID, HOLDER_B);
			const [afterWrong] = await sql<{ holder: string }[]>`
				SELECT holder FROM multisig_buy_locks WHERE nft_id = ${TEST_NFT_ID}
			`;
			expect(afterWrong?.holder).toBe(HOLDER_A);

			// Correct holder — row removed.
			await lock.release(TEST_NFT_ID, HOLDER_A);
			const [afterRight] = await sql<{ holder: string }[]>`
				SELECT holder FROM multisig_buy_locks WHERE nft_id = ${TEST_NFT_ID}
			`;
			expect(afterRight).toBeUndefined();
		});

		it("frees the slot for a new acquire by a different holder", async () => {
			const lock = createMultisigBuyLock();
			await lock.acquire(
				TEST_NFT_ID,
				TEST_LISTING_ID,
				TEST_LIST_TX_ID,
				HOLDER_A,
				LOCK_TTL_MS,
			);
			await lock.release(TEST_NFT_ID, HOLDER_A);

			const second = await lock.acquire(
				TEST_NFT_ID,
				TEST_LISTING_ID,
				TEST_LIST_TX_ID,
				HOLDER_B,
				LOCK_TTL_MS,
			);
			expect(second.acquired).toBe(true);
		});
	});

	describe("cleanupExpired", () => {
		it("removes only rows past their expires_at", async () => {
			const expiredNft = "nft_test_lock_expired";
			const liveNft = "nft_test_lock_live";

			await withTransaction(async (txn) => {
				await txn`
					INSERT INTO multisig_buy_locks (nft_id, listing_id, listing_tx_id, holder, expires_at)
					VALUES (${expiredNft}, 'list_x', 'tx_x', 'h', NOW() - INTERVAL '1 second')
				`;
				await txn`
					INSERT INTO multisig_buy_locks (nft_id, listing_id, listing_tx_id, holder, expires_at)
					VALUES (${liveNft}, 'list_y', 'tx_y', 'h', NOW() + INTERVAL '1 hour')
				`;
			});

			const lock = createMultisigBuyLock();
			await lock.cleanupExpired();

			const [expiredRow] = await sql<{ nft_id: string }[]>`
				SELECT nft_id FROM multisig_buy_locks WHERE nft_id = ${expiredNft}
			`;
			const [liveRow] = await sql<{ nft_id: string }[]>`
				SELECT nft_id FROM multisig_buy_locks WHERE nft_id = ${liveNft}
			`;
			expect(expiredRow).toBeUndefined();
			expect(liveRow?.nft_id).toBe(liveNft);

			// Cleanup of the live row we inserted directly.
			await sql`DELETE FROM multisig_buy_locks WHERE nft_id = ${liveNft}`;
		});
	});
});
