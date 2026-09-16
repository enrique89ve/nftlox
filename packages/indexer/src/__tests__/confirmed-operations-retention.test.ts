import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { sql } from "@/db/client.ts";
import { cleanupExpiredOperations } from "@/db/queries/sync.ts";
import { fixtureAssetId } from "./helpers/asset-fixtures.ts";

const COLLECTION_ID = "col_confirmed_retention";
const OLD_BLOCK_TIME = "2000-01-01T00:00:00.000Z";

async function resetRows(): Promise<void> {
	await sql`DELETE FROM assets WHERE collection_id = ${COLLECTION_ID}`;
	await sql`DELETE FROM collections WHERE id = ${COLLECTION_ID}`;
	await sql`DELETE FROM confirmed_operations WHERE operation_id LIKE 'retention-%'`;
}

async function seedCollection(): Promise<void> {
	await sql`
		INSERT INTO collections (id, name, symbol, creator, origin_dna, block_num, tx_id, created_at)
		VALUES (${COLLECTION_ID}, 'Retention', 'RTN', 'alice', 'odna_retention', 100, ${"a".repeat(40)}, ${OLD_BLOCK_TIME})
	`;
}

async function seedConfirmedAsset(params: Readonly<{
	operationId: string;
	action: "mint" | "bulk_distribute";
	assetId: string;
	assetIds: ReadonlyArray<string>;
}>): Promise<void> {
	await sql`
		INSERT INTO confirmed_operations (
			operation_id, tx_id, block_num, signer, action, asset_ids, created_at
		)
		VALUES (
			${params.operationId},
			${"b".repeat(40)},
			100,
			'alice',
			${params.action},
			${sql.array([...params.assetIds], 25)},
			${OLD_BLOCK_TIME}
		)
	`;

	await sql`
		INSERT INTO assets (
			id, collection_id, asset_type, status, edition, owner, name,
			max_supply, distributed, reserved_supply,
			previous_owner, owner_operation_id, owner_action, owner_block_num,
			created_operation_id, created_block_num, created_tx_id, created_at
		)
		VALUES (
			${params.assetId}, ${COLLECTION_ID}, 'instance', 'active', 1, 'alice', 'retained',
			0, 0, 0,
			NULL, ${params.operationId}, ${params.action}, 100,
			${params.operationId}, 100, ${"c".repeat(40)}, ${OLD_BLOCK_TIME}
		)
	`;
}

async function findOwnershipInvariantViolations(): Promise<ReadonlyArray<Record<string, unknown>>> {
	return sql`
		SELECT n.id, n.owner_action, co.action, n.owner_block_num, co.block_num, co.asset_ids
		FROM assets n
		LEFT JOIN confirmed_operations co ON co.operation_id = n.owner_operation_id
		WHERE n.collection_id = ${COLLECTION_ID}
		  AND (
			co.operation_id IS NULL
			OR co.action <> n.owner_action::text
			OR co.block_num <> n.owner_block_num
			OR (
				n.owner_action::text IN ('mint', 'transfer', 'asset_transfer_from', 'buy')
				AND NOT (n.id = ANY(co.asset_ids))
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

	test("cleanup preserves old ownership anchors referenced by live Assets", async () => {
		const mintedAssetId = fixtureAssetId("mint-retention");
		const bulkAssetId = fixtureAssetId("bulk-retention");

		await seedConfirmedAsset({
			operationId: "retention-mint-op",
			action: "mint",
			assetId: mintedAssetId,
			assetIds: [mintedAssetId],
		});
		await seedConfirmedAsset({
			operationId: "retention-bulk-op",
			action: "bulk_distribute",
			assetId: bulkAssetId,
			assetIds: [],
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
			FROM assets n
			LEFT JOIN confirmed_operations co ON co.operation_id = n.created_operation_id
			WHERE n.id = ${bulkAssetId}
		`;
		expect(distributor[0]?.signer).toBe("alice");
	});
});
