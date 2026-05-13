import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { sql } from "@/db/client.ts";
import { cleanupExpiredOperations } from "@/db/queries/sync.ts";
import { fixtureNftId } from "./helpers/nft-fixtures.ts";

const COLLECTION_ID = "col_confirmed_retention";
const OLD_BLOCK_TIME = "2000-01-01T00:00:00.000Z";

async function resetRows(): Promise<void> {
	await sql`DELETE FROM nfts WHERE collection_id = ${COLLECTION_ID}`;
	await sql`DELETE FROM collections WHERE id = ${COLLECTION_ID}`;
	await sql`DELETE FROM confirmed_operations WHERE operation_id LIKE 'retention-%'`;
}

async function seedCollection(): Promise<void> {
	await sql`
		INSERT INTO collections (id, name, symbol, creator, origin_dna, block_num, tx_id, created_at)
		VALUES (${COLLECTION_ID}, 'Retention', 'RTN', 'alice', 'odna_retention', 100, ${"a".repeat(40)}, ${OLD_BLOCK_TIME})
	`;
}

async function seedConfirmedNft(params: Readonly<{
	operationId: string;
	action: "mint" | "bulk_distribute";
	nftId: string;
	nftIds: ReadonlyArray<string>;
}>): Promise<void> {
	await sql`
		INSERT INTO confirmed_operations (
			operation_id, tx_id, block_num, signer, action, nft_ids, created_at
		)
		VALUES (
			${params.operationId},
			${"b".repeat(40)},
			100,
			'alice',
			${params.action},
			${sql.array([...params.nftIds], 25)},
			${OLD_BLOCK_TIME}
		)
	`;

	await sql`
		INSERT INTO nfts (
			id, collection_id, nft_type, status, edition, owner, name,
			max_supply, distributed, reserved_supply,
			previous_owner, owner_operation_id, owner_action, owner_block_num,
			created_operation_id, created_block_num, created_tx_id, created_at
		)
		VALUES (
			${params.nftId}, ${COLLECTION_ID}, 'instance', 'active', 1, 'alice', 'retained',
			0, 0, 0,
			NULL, ${params.operationId}, ${params.action}, 100,
			${params.operationId}, 100, ${"c".repeat(40)}, ${OLD_BLOCK_TIME}
		)
	`;
}

async function findOwnershipInvariantViolations(): Promise<ReadonlyArray<Record<string, unknown>>> {
	return sql`
		SELECT n.id, n.owner_action, co.action, n.owner_block_num, co.block_num, co.nft_ids
		FROM nfts n
		LEFT JOIN confirmed_operations co ON co.operation_id = n.owner_operation_id
		WHERE n.collection_id = ${COLLECTION_ID}
		  AND (
			co.operation_id IS NULL
			OR co.action <> n.owner_action::text
			OR co.block_num <> n.owner_block_num
			OR (
				n.owner_action::text IN ('mint', 'transfer', 'nft_transfer_from', 'buy')
				AND NOT (n.id = ANY(co.nft_ids))
			)
		  )
	`;
}

describe("confirmed_operations retention", () => {
	beforeEach(async () => {
		await resetRows();
		await seedCollection();
	});

	afterAll(async () => {
		await resetRows();
	});

	test("cleanup preserves old ownership anchors referenced by live NFTs", async () => {
		const mintedNftId = fixtureNftId("mint-retention");
		const bulkNftId = fixtureNftId("bulk-retention");

		await seedConfirmedNft({
			operationId: "retention-mint-op",
			action: "mint",
			nftId: mintedNftId,
			nftIds: [mintedNftId],
		});
		await seedConfirmedNft({
			operationId: "retention-bulk-op",
			action: "bulk_distribute",
			nftId: bulkNftId,
			nftIds: [],
		});

		await cleanupExpiredOperations();

		const confirmed = await sql<{ count: number }[]>`
			SELECT COUNT(*)::int AS count
			FROM confirmed_operations
			WHERE operation_id IN ('retention-mint-op', 'retention-bulk-op')
		`;
		expect(confirmed[0]?.count).toBe(2);
		expect(await findOwnershipInvariantViolations()).toHaveLength(0);

		const distributor = await sql<{ signer: string | null }[]>`
			SELECT co.signer
			FROM nfts n
			LEFT JOIN confirmed_operations co ON co.operation_id = n.created_operation_id
			WHERE n.id = ${bulkNftId}
		`;
		expect(distributor[0]?.signer).toBe("alice");
	});
});
