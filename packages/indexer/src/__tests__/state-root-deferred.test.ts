import { describe, it, expect, beforeEach } from "bun:test";
import { sql, withTransaction, getStateRootBuffer } from "@/db/client.ts";
import { useSingletonLock } from "./helpers/singleton-lock.ts";
import { getStateMeta, queueStateRootDelta } from "@/db/queries/state-root.ts";
import { computeStateRootFullScan, type NftStateRow } from "@/utils/state-root-hash.ts";
import { insertNft } from "@/db/queries/nft-mutations.ts";

// Requires the postgres test harness this repo ships with (see scripts/test.sh).
// This suite uses the shared container and truncates affected rows on setup.

async function truncateNftsTx(): Promise<void> {
	await sql`TRUNCATE TABLE nfts, collections, owner_nft_counts, collection_stats CASCADE`;
	await sql`UPDATE state_meta SET state_root = decode(repeat('00', 32), 'hex'), nft_count = 0, last_block_num = 0 WHERE id = 1`;
}

async function seedCollection(): Promise<string> {
	const collectionId = `test-coll-${Date.now()}`;
	await sql`
		INSERT INTO collections (id, name, symbol, creator, origin_dna, block_num, tx_id, created_at)
		VALUES (${collectionId}, 'Test', 'TST0001', 'alice', 'odna_sr', 100, 'tx-seed-coll', NOW())
	`;
	return collectionId;
}

describe("state-root deferred flush", () => {
	useSingletonLock();

	beforeEach(truncateNftsTx);

	it("bulk inserts in one tx → state_meta updated exactly once", async () => {
		const collectionId = await seedCollection();
		const N = 100;
		const rows: NftStateRow[] = [];

		await withTransaction(async (txn) => {
			for (let i = 0; i < N; i++) {
				const id = `nft-${i}`;
				await insertNft({
					id, collectionId, nftType: "seed", edition: 1, owner: "alice",
					nftDna: null,
					name: `N${i}`, imageUrl: null,
					maxSupply: 1, seedId: null, instanceNumber: null, artId: `art-${i}`,
					immutableData: null, dataOperationId: null, dataHash: null,
					schemaVersion: 0,
					ownerOperationId: `op-${i}`, ownerAction: "mint", ownerBlockNum: 100 + i,
					createdOperationId: `op-${i}`, createdBlockNum: 100 + i,
					createdTxId: `tx-${i}`, createdAt: new Date().toISOString(),
				}, txn);
				rows.push({
					id, owner: "alice", previous_owner: null, owner_action: "mint",
					owner_operation_id: `op-${i}`, owner_block_num: 100 + i,
				});
			}
		});

		const meta = await getStateMeta();
		expect(meta.nft_count).toBe(N);
		expect(meta.last_block_num).toBe(100 + N - 1);

		const reference = await computeStateRootFullScan(rows);
		expect(Buffer.from(meta.state_root).toString("hex"))
			.toBe(Buffer.from(reference).toString("hex"));
	});

	it("insert + delete within a tx leaves state_meta unchanged", async () => {
		const collectionId = await seedCollection();
		const before = await getStateMeta();

		await withTransaction(async (txn) => {
			await insertNft({
				id: "ephemeral", collectionId, nftType: "seed", edition: 1, owner: "alice",
				nftDna: null,
				name: "ephemeral", imageUrl: null,
				maxSupply: 1, seedId: null, instanceNumber: null, artId: "eph",
				immutableData: null, dataOperationId: null, dataHash: null,
				schemaVersion: 0,
				ownerOperationId: "op-e", ownerAction: "mint", ownerBlockNum: 200,
				createdOperationId: "op-e", createdBlockNum: 200,
				createdTxId: "tx-e", createdAt: new Date().toISOString(),
			}, txn);
			await txn`DELETE FROM nfts WHERE id = 'ephemeral'`;
			queueStateRootDelta(getStateRootBuffer(txn), {
				type: "delete",
				oldRow: {
					id: "ephemeral", owner: "alice", previous_owner: null,
					owner_action: "mint", owner_operation_id: "op-e", owner_block_num: 200,
				},
				blockNum: 200,
			});
		});

		const after = await getStateMeta();
		expect(after.nft_count).toBe(before.nft_count);
		expect(Buffer.from(after.state_root).toString("hex"))
			.toBe(Buffer.from(before.state_root).toString("hex"));
	});
});
