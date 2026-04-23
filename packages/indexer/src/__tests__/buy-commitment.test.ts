import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { sql, withTransaction } from "@/db/client.ts";
import type { ParsedOperation, AuthLevel } from "@/scanner/operation-parser.ts";
import { handleBuyCommitment } from "@/processor/handlers/marketplace/buy-commitment.ts";
import { sweepExpiredBuyCommitments } from "@/db/queries/nft-mutations.ts";
import {
	ACTION_BUY_COMMITMENT,
	ACTIVE_AUTH_ACTIONS,
	BUY_COMMITMENT_TTL_BLOCKS,
	MAX_ACTIVE_COMMITMENTS_PER_NODE,
} from "@/protocol/index.ts";

const ACTIVE_SET = new Set<string>(ACTIVE_AUTH_ACTIONS);

const NODE = "node.one";
const OTHER_NODE = "node.two";
const SELLER = "seller.one";
const BUYER = "buyer.one";
const COLLECTION_ID = "col_commitment_tests";

let opCounter = 0;
function makeOp(
	action: string,
	data: Record<string, unknown>,
	signer: string,
	blockNum: number,
): ParsedOperation {
	const id = ++opCounter;
	const authLevel: AuthLevel = ACTIVE_SET.has(action) ? "active" : "posting";
	return {
		blockNum,
		timestamp: new Date().toISOString(),
		txId: `tx_${action}_${id}`.padEnd(40, "0").slice(0, 40),
		operationId: `op_${id}`,
		signer,
		authLevel,
		action: action as ParsedOperation["action"],
		version: "0.8.0",
		data,
	};
}

async function seedCollection(): Promise<void> {
	await sql`
		INSERT INTO collections (
			id, name, symbol, creator, total_potential, max_instances,
			transferable, burnable, royalty_pct, royalty_recipient,
			block_num, tx_id, created_at
		)
		VALUES (
			${COLLECTION_ID}, 'Commit Coll', 'CMT', ${SELLER}, 100, 0,
			true, true, 0, NULL,
			90000000, ${"col_tx".padEnd(40, "0").slice(0, 40)}, NOW()
		)
		ON CONFLICT (id) DO NOTHING
	`;
}

async function insertListedInstance(params: {
	readonly nftId: string;
	readonly listingId: string;
	readonly listTxId: string;
	readonly price?: string;
}): Promise<void> {
	const price = params.price ?? "10.000";
	const createdTx = `${params.nftId}_mint_tx`.padEnd(40, "0").slice(0, 40);
	const opId = `op_${params.nftId}`;
	await sql`
		INSERT INTO nfts (
			id, collection_id, nft_type, status, edition, owner, name,
			image_url, origin_dna, instance_dna, max_supply, distributed, reserved_supply,
			previous_owner, owner_operation_id, owner_action, owner_block_num,
			listing_id, listing_tx_id, listing_price, listing_currency,
			listing_expires_at, listing_marketplace,
			created_operation_id, created_block_num, created_tx_id, created_at
		) VALUES (
			${params.nftId}, ${COLLECTION_ID}, 'instance', 'listed', 1, ${SELLER}, 'test',
			'https://img.example/i.png', ${"0".repeat(32)}, ${"1".repeat(40)}, 0, 0, 0,
			NULL, ${opId}, 'mint', 90000001,
			${params.listingId}, ${params.listTxId}, ${price}, 'HIVE',
			${new Date(Date.now() + 3600_000).toISOString()}, NULL,
			${opId}, 90000001, ${createdTx}, NOW()
		)
	`;
}

function commitmentOp(params: {
	nftId: string;
	listingId: string;
	listTxId: string;
	buyer: string;
	buyTxHash?: string;
	settlementNode?: string;
	blockNum?: number;
}): ParsedOperation {
	return makeOp(
		ACTION_BUY_COMMITMENT,
		{
			nftId: params.nftId,
			listingId: params.listingId,
			listTxId: params.listTxId,
			buyer: params.buyer,
			txHash: params.buyTxHash ?? "a".repeat(40),
		},
		params.settlementNode ?? NODE,
		params.blockNum ?? 100_000,
	);
}

async function cleanDb(): Promise<void> {
	await sql`DELETE FROM nfts`;
	await sql`DELETE FROM collections WHERE id = ${COLLECTION_ID}`;
}

beforeAll(async () => {
	await cleanDb();
	await seedCollection();
});

beforeEach(async () => {
	await sql`DELETE FROM nfts`;
});

afterAll(async () => {
	await cleanDb();
});

describe("handleBuyCommitment", () => {
	test("projects pending_sale on a listed NFT", async () => {
		const nftId = "nft_commit_a";
		await insertListedInstance({ nftId, listingId: "list_a", listTxId: "tx_a" });

		const buyTxHash = "b".repeat(40);
		const op = commitmentOp({ nftId, listingId: "list_a", listTxId: "tx_a", buyer: BUYER, buyTxHash, blockNum: 100_500 });

		await withTransaction((txn) => handleBuyCommitment(op, txn));

		const [row] = await sql<
			{
				status: string;
				sale_buyer: string | null;
				sale_settlement_node: string | null;
				sale_expires_block: string | null;
				sale_commitment_buy_tx_hash: string | null;
			}[]
		>`
			SELECT status, sale_buyer, sale_settlement_node, sale_expires_block, sale_commitment_buy_tx_hash
			FROM nfts WHERE id = ${nftId}
		`;
		expect(row?.status).toBe("pending_sale");
		expect(row?.sale_buyer).toBe(BUYER);
		expect(row?.sale_settlement_node).toBe(NODE);
		expect(Number(row?.sale_expires_block)).toBe(100_500 + BUY_COMMITMENT_TTL_BLOCKS);
		expect(row?.sale_commitment_buy_tx_hash).toBe(buyTxHash);
	});

	test("rejects when NFT is not found", async () => {
		const op = commitmentOp({
			nftId: "nft_ghost",
			listingId: "list_x",
			listTxId: "tx_x",
			buyer: BUYER,
		});
		await expect(withTransaction((txn) => handleBuyCommitment(op, txn))).rejects.toThrow("not found");
	});

	test("rejects listingId mismatch", async () => {
		const nftId = "nft_commit_mismatch";
		await insertListedInstance({ nftId, listingId: "list_real", listTxId: "tx_real" });

		const op = commitmentOp({
			nftId,
			listingId: "list_wrong",
			listTxId: "tx_real",
			buyer: BUYER,
		});
		await expect(withTransaction((txn) => handleBuyCommitment(op, txn))).rejects.toThrow("listingId mismatch");
	});

	test("rejects when buyer is the seller", async () => {
		const nftId = "nft_commit_self";
		await insertListedInstance({ nftId, listingId: "list_self", listTxId: "tx_self" });
		const op = commitmentOp({ nftId, listingId: "list_self", listTxId: "tx_self", buyer: SELLER });
		await expect(withTransaction((txn) => handleBuyCommitment(op, txn))).rejects.toThrow("Cannot reserve own");
	});

	test("rejects a competing commitment while a reservation is active", async () => {
		const nftId = "nft_commit_race";
		await insertListedInstance({ nftId, listingId: "list_race", listTxId: "tx_race" });

		const firstBlock = 100_200;
		await withTransaction((txn) =>
			handleBuyCommitment(
				commitmentOp({ nftId, listingId: "list_race", listTxId: "tx_race", buyer: BUYER, blockNum: firstBlock }),
				txn,
			),
		);

		const competingOp = commitmentOp({
			nftId,
			listingId: "list_race",
			listTxId: "tx_race",
			buyer: "buyer.two",
			buyTxHash: "c".repeat(40),
			settlementNode: OTHER_NODE,
			blockNum: firstBlock + 1,
		});
		await expect(withTransaction((txn) => handleBuyCommitment(competingOp, txn))).rejects.toThrow("already committed");
	});

	test("overwrites an expired reservation", async () => {
		const nftId = "nft_commit_expired";
		await insertListedInstance({ nftId, listingId: "list_exp", listTxId: "tx_exp" });

		const firstBlock = 100_000;
		await withTransaction((txn) =>
			handleBuyCommitment(
				commitmentOp({
					nftId,
					listingId: "list_exp",
					listTxId: "tx_exp",
					buyer: BUYER,
					buyTxHash: "d".repeat(40),
					blockNum: firstBlock,
				}),
				txn,
			),
		);

		const secondBuyer = "buyer.two";
		const secondBlock = firstBlock + BUY_COMMITMENT_TTL_BLOCKS + 1;
		const secondHash = "e".repeat(40);
		await withTransaction((txn) =>
			handleBuyCommitment(
				commitmentOp({
					nftId,
					listingId: "list_exp",
					listTxId: "tx_exp",
					buyer: secondBuyer,
					buyTxHash: secondHash,
					settlementNode: OTHER_NODE,
					blockNum: secondBlock,
				}),
				txn,
			),
		);

		const [row] = await sql<
			{ sale_buyer: string; sale_commitment_buy_tx_hash: string; sale_expires_block: string; sale_settlement_node: string }[]
		>`
			SELECT sale_buyer, sale_commitment_buy_tx_hash, sale_expires_block, sale_settlement_node
			FROM nfts WHERE id = ${nftId}
		`;
		expect(row?.sale_buyer).toBe(secondBuyer);
		expect(row?.sale_commitment_buy_tx_hash).toBe(secondHash);
		expect(row?.sale_settlement_node).toBe(OTHER_NODE);
		expect(Number(row?.sale_expires_block)).toBe(secondBlock + BUY_COMMITMENT_TTL_BLOCKS);
	});

	test("sweep clears expired reservations", async () => {
		const nftId = "nft_commit_sweep";
		await insertListedInstance({ nftId, listingId: "list_sweep", listTxId: "tx_sweep" });

		const firstBlock = 100_000;
		await withTransaction((txn) =>
			handleBuyCommitment(
				commitmentOp({ nftId, listingId: "list_sweep", listTxId: "tx_sweep", buyer: BUYER, blockNum: firstBlock }),
				txn,
			),
		);

		const sweepAt = firstBlock + BUY_COMMITMENT_TTL_BLOCKS + 1;
		await withTransaction((txn) => sweepExpiredBuyCommitments(sweepAt, txn));

		const [row] = await sql<
			{ status: string; sale_buyer: string | null; sale_commitment_buy_tx_hash: string | null }[]
		>`
			SELECT status, sale_buyer, sale_commitment_buy_tx_hash
			FROM nfts WHERE id = ${nftId}
		`;
		expect(row?.status).toBe("listed");
		expect(row?.sale_buyer).toBeNull();
		expect(row?.sale_commitment_buy_tx_hash).toBeNull();
	});

	test("rejects once a single node holds MAX_ACTIVE_COMMITMENTS_PER_NODE reservations", async () => {
		const firstBlock = 200_000;

		for (let i = 0; i <= MAX_ACTIVE_COMMITMENTS_PER_NODE; i++) {
			const nftId = `nft_cap_${i}`;
			const listingId = `list_cap_${i}`;
			const listTxId = `tx_cap_${i}`.padEnd(40, "0").slice(0, 40);
			await insertListedInstance({ nftId, listingId, listTxId });

			const op = commitmentOp({
				nftId,
				listingId,
				listTxId,
				buyer: `buyer${i}`,
				buyTxHash: `${i.toString(16).padStart(2, "0")}`.repeat(20),
				blockNum: firstBlock + i,
			});

			const attempt = withTransaction((txn) => handleBuyCommitment(op, txn));
			if (i < MAX_ACTIVE_COMMITMENTS_PER_NODE) {
				await attempt;
			} else {
				await expect(attempt).rejects.toThrow("commitment cap");
			}
		}
	});
});
