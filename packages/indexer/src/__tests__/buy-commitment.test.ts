import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { sql, withTransaction } from "@/db/client.ts";
import type { ParsedOperation } from "@/scanner/operation-parser.ts";
import { handleBuyCommitment } from "@/processor/handlers/marketplace/buy-commitment.ts";
import { sweepExpiredBuyCommitments } from "@/db/queries/nft-mutations.ts";
import {
	ACTION_BUY_COMMITMENT,
	BUY_COMMITMENT_TTL_BLOCKS,
	MAX_ACTIVE_COMMITMENTS_PER_NODE,
} from "@/protocol/index.ts";
import { makeOp as _makeOp } from "./helpers/make-op.ts";
import {
	seedCollection,
	insertListedInstance,
	cleanCommonTables,
	fixtureNftId,
	fixtureListingId,
	fixtureHiveTxId,
} from "./helpers/nft-fixtures.ts";

const NODE = "node.one";
const OTHER_NODE = "node.two";
const SELLER = "seller.one";
const BUYER = "buyer.one";
const COLLECTION_ID = "col_commitment_tests";

function commitmentOp(params: {
	nftId: string;
	listingId: string;
	listTxId: string;
	buyer: string;
	buyTxHash?: string;
	settlementNode?: string;
	blockNum?: number;
}): ParsedOperation {
	return _makeOp({
		action: ACTION_BUY_COMMITMENT,
		signer: params.settlementNode ?? NODE,
		blockNum: params.blockNum ?? 100_000,
		data: {
			nftId: params.nftId,
			listingId: params.listingId,
			listTxId: params.listTxId,
			buyer: params.buyer,
			txHash: params.buyTxHash ?? "a".repeat(40),
		},
	});
}

beforeAll(async () => {
	await cleanCommonTables();
	await sql`DELETE FROM collections WHERE id = ${COLLECTION_ID}`;
	await seedCollection(COLLECTION_ID, SELLER);
});

beforeEach(async () => {
	await sql`DELETE FROM nfts`;
});

afterAll(async () => {
	await cleanCommonTables();
	await sql`DELETE FROM collections WHERE id = ${COLLECTION_ID}`;
});

describe("handleBuyCommitment", () => {
	test("projects pending_sale on a listed NFT", async () => {
		const nftId = fixtureNftId("commit-a");
		const listingId = fixtureListingId("a");
		const listTxId = fixtureHiveTxId("a");
		await insertListedInstance({ nftId, collectionId: COLLECTION_ID, seller: SELLER, listingId, listTxId });

		const buyTxHash = "b".repeat(40);
		const op = commitmentOp({ nftId, listingId, listTxId, buyer: BUYER, buyTxHash, blockNum: 100_500 });

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
			nftId: fixtureNftId("ghost"),
			listingId: fixtureListingId("x"),
			listTxId: fixtureHiveTxId("x"),
			buyer: BUYER,
		});
		await expect(withTransaction((txn) => handleBuyCommitment(op, txn))).rejects.toThrow("not found");
	});

	test("rejects listingId mismatch", async () => {
		const nftId = fixtureNftId("commit-mismatch");
		const realListing = fixtureListingId("real");
		const realTx = fixtureHiveTxId("real");
		await insertListedInstance({ nftId, collectionId: COLLECTION_ID, seller: SELLER, listingId: realListing, listTxId: realTx });

		const op = commitmentOp({
			nftId,
			listingId: fixtureListingId("wrong"),
			listTxId: realTx,
			buyer: BUYER,
		});
		await expect(withTransaction((txn) => handleBuyCommitment(op, txn))).rejects.toThrow("listingId mismatch");
	});

	test("rejects when buyer is the seller", async () => {
		const nftId = fixtureNftId("commit-self");
		const listingId = fixtureListingId("self");
		const listTxId = fixtureHiveTxId("self");
		await insertListedInstance({ nftId, collectionId: COLLECTION_ID, seller: SELLER, listingId, listTxId });
		const op = commitmentOp({ nftId, listingId, listTxId, buyer: SELLER });
		await expect(withTransaction((txn) => handleBuyCommitment(op, txn))).rejects.toThrow("Cannot reserve own");
	});

	// Seller-protection gate: without this, a byzantine registered node could
	// emit a fresh buy_commitment every BUY_COMMITMENT_TTL_BLOCKS against an
	// expired listing, keeping the NFT in `pending_sale` and blocking
	// handleUnlist (which refuses on pending_sale). handleBuy would still
	// reject at settlement, but the owner loses the ability to clear the
	// listing. Expiry is evaluated against `op.timestamp` (block timestamp)
	// so the check is replay-deterministic across indexers.
	test("rejects a commitment when the listing is already expired", async () => {
		const nftId = fixtureNftId("commit-expired-listing");
		const listingId = fixtureListingId("expired");
		const listTxId = fixtureHiveTxId("expired-list");
		await insertListedInstance({
			nftId,
			collectionId: COLLECTION_ID,
			seller: SELLER,
			listingId,
			listTxId,
			expiresAtMs: Date.now() - 60_000,
		});

		const op = commitmentOp({
			nftId,
			listingId,
			listTxId,
			buyer: BUYER,
		});

		await expect(withTransaction((txn) => handleBuyCommitment(op, txn))).rejects.toThrow(
			"Listing expired",
		);

		// And the NFT must remain in its pre-commitment state (listed, no
		// sale_* fields populated) so the owner can still call `unlist` once
		// they notice the listing is stale.
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

	test("rejects a competing commitment while a reservation is active", async () => {
		const nftId = fixtureNftId("commit-race");
		const listingId = fixtureListingId("race");
		const listTxId = fixtureHiveTxId("race");
		await insertListedInstance({ nftId, collectionId: COLLECTION_ID, seller: SELLER, listingId, listTxId });

		const firstBlock = 100_200;
		await withTransaction((txn) =>
			handleBuyCommitment(
				commitmentOp({ nftId, listingId, listTxId, buyer: BUYER, blockNum: firstBlock }),
				txn,
			),
		);

		const competingOp = commitmentOp({
			nftId,
			listingId,
			listTxId,
			buyer: "buyer.two",
			buyTxHash: "c".repeat(40),
			settlementNode: OTHER_NODE,
			blockNum: firstBlock + 1,
		});
		await expect(withTransaction((txn) => handleBuyCommitment(competingOp, txn))).rejects.toThrow("already committed");
	});

	test("overwrites an expired reservation", async () => {
		const nftId = fixtureNftId("commit-expired");
		const listingId = fixtureListingId("exp");
		const listTxId = fixtureHiveTxId("exp");
		await insertListedInstance({ nftId, collectionId: COLLECTION_ID, seller: SELLER, listingId, listTxId });

		const firstBlock = 100_000;
		await withTransaction((txn) =>
			handleBuyCommitment(
				commitmentOp({
					nftId,
					listingId,
					listTxId,
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
					listingId,
					listTxId,
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
		const nftId = fixtureNftId("commit-sweep");
		const listingId = fixtureListingId("sweep");
		const listTxId = fixtureHiveTxId("sweep");
		await insertListedInstance({ nftId, collectionId: COLLECTION_ID, seller: SELLER, listingId, listTxId });

		const firstBlock = 100_000;
		await withTransaction((txn) =>
			handleBuyCommitment(
				commitmentOp({ nftId, listingId, listTxId, buyer: BUYER, blockNum: firstBlock }),
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
			const nftId = fixtureNftId(`cap-${i}`);
			const listingId = fixtureListingId(`cap-${i}`);
			const listTxId = fixtureHiveTxId(`cap-${i}`);
			await insertListedInstance({ nftId, collectionId: COLLECTION_ID, seller: SELLER, listingId, listTxId });

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
