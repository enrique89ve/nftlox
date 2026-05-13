import { describe, it, expect, beforeAll, beforeEach } from "bun:test";
import { sql, withTransaction } from "@/db/client.ts";
import { routeOperationDetailed } from "@/processor/action-router.ts";
import type { ParsedOperation, TransferDetail } from "@/scanner/operation-parser.ts";
import {
	ACTION_BUY,
	ACTION_BUY_COMMITMENT,
	ACTION_BULK_DISTRIBUTE,
	ACTION_CREATE_COLLECTION,
	ACTION_LIST,
	ACTION_MINT,
	ACTION_TRANSFER,
	HIVE_BLOCK_TIME_MS,
	MEMO_PREFIX_BUY,
	MEMO_PREFIX_FEE,
	MEMO_PREFIX_FEE_COL,
	MIN_LISTING_TTL_MS,
	PROTOCOL_COLLECTION_FEE_HBD,
	calculatePaymentSplit,
	generateDeterministicCollectionId,
	generateDeterministicSeedId,
	generateListingId,
	generateOriginDna,
} from "@/protocol/index.ts";
import { getStateMeta } from "@/db/queries/state-root.ts";
import { formatStateRoot } from "@/utils/state-root-hash.ts";
import { config } from "@/config.ts";
import { makeOp } from "./helpers/make-op.ts";
import { seedActiveSettlementNode } from "./helpers/settlement-node.ts";

// F2.B — Genesis replay determinism.
//
// Locks down the projection's two determinism invariants required for cross-
// node state-root agreement (F3):
//   1. Idempotence: replaying the same fixture in two independent clean-DB
//      runs MUST produce byte-equal `state_meta.state_root`. Catches every
//      flavor of accidental non-determinism (Math.random, Date.now, parallel
//      hashing, iteration over unordered sets).
//   2. Snapshot: the fixture replay MUST match a pinned reference hash. Any
//      drift in projection logic (handler, hashing, schema) flips this and
//      forces a deliberate update with a justification.
//
// Every input — blockNum, timestamp, account, txId, IDs, prices, nonces — is
// hardcoded. ZERO `Date.now()`, `Math.random()`, or process-derived state is
// allowed inside the fixture builder; otherwise the snapshot becomes a flake.

// Pinned by F2.B determinism test on initial run. Update only when a deliberate
// state-root-affecting change ships, with a comment explaining why.
const EXPECTED_STATE_ROOT = "sha256:de962bd637a5e7bfce28f9f3b8bbdc032c62d0a3dc089e00a4771fc6e16bfd58";

// Anchored in the past so derived listing/expiry math (which compares
// timestamps in ms) lands on stable values across machines and time zones.
const GENESIS_TIME_MS = Date.UTC(2024, 0, 1, 0, 0, 0);
const GENESIS_BLOCK = 90_000_100;

const ALICE = "alice";
const BOB = "bob";
const CAROL = "carol";
const NODE = "node.one";

const COL_NAME = "DetCollection";
const COL_SYMBOL = "DETCOL";
const ART_ID_A = "art-det-a";
const ART_ID_B = "art-det-b";
const PRICE = "1.000";
const PRICE_NUMBER = 1;
const LISTING_NONCE = "abc123def456";

// Listing TTL is checked against op.timestamp on the LIST op (not real wall
// clock) so this bound is replay-stable. We lock the absolute expiry well
// above MIN_LISTING_TTL_MS to stay clear of the floor regardless of where the
// LIST op lands in the block sequence.
const LISTING_EXPIRES_AT = GENESIS_TIME_MS + MIN_LISTING_TTL_MS + 60 * 60 * 1000;

function blockTimestamp(blockNum: number): string {
	const blocksSinceGenesis = blockNum - GENESIS_BLOCK;
	return new Date(GENESIS_TIME_MS + blocksSinceGenesis * HIVE_BLOCK_TIME_MS).toISOString();
}

// Builds a deterministic 40-char lowercase-hex tx id from a stable per-op tag.
// The wider protocol enforces TX_ID_REGEX = ^[0-9a-f]{40}$ (see
// `handleBuyCommitment.txHash` and the parser); using ad-hoc strings padded
// with `0` yields invalid tx ids whenever the seed contains non-hex bytes.
function detTxId(tag: string): string {
	const padded = tag.padStart(40, "0");
	return padded
		.toLowerCase()
		.replace(/[^0-9a-f]/g, (ch) => ((ch.charCodeAt(0) % 16).toString(16)))
		.slice(0, 40);
}

// Builds a stable operation id from a tag. Hashed into the state-root via
// `nfts.owner_operation_id` (see NftStateRow), so it MUST NOT depend on the
// `makeOp` global counter — the counter advances across tests and breaks
// idempotence between fixture replays.
function detOpId(tag: string): string {
	return `op_det_${tag}`;
}

async function cleanDb(): Promise<void> {
	await sql`DELETE FROM sales`;
	await sql`DELETE FROM nft_allowances`;
	await sql`DELETE FROM collection_allowances`;
	await sql`TRUNCATE nfts, owner_nft_counts, collection_stats, collections RESTART IDENTITY CASCADE`;
	await sql`DELETE FROM invalid_operations`;
	await sql`DELETE FROM confirmed_operations`;
	await sql`DELETE FROM orphaned_buys`;
	await sql`DELETE FROM l2_node_checkpoints`;
	await sql`DELETE FROM l2_node_heartbeats`;
	await sql`DELETE FROM state_root_checkpoints`;
	await sql`DELETE FROM l2_nodes`;
	// Genesis reset for state_meta — not covered by the TRUNCATE above because
	// the row is bootstrapped once and must be reverted (not re-inserted) so
	// the singleton check (CHECK id = 1) keeps holding.
	await sql`
		UPDATE state_meta
		SET state_root = decode(repeat('00', 32), 'hex'),
			nft_count = 0,
			last_block_num = 0
		WHERE id = 1
	`;
}

// Resolves the instance id derived from a seed. bulk_distribute mints the
// instance under a deterministic id; we read it back so the rest of the
// fixture (transfer, list, buy) can address it without a forward-coupled
// generator.
async function resolveInstanceId(seedId: string): Promise<string> {
	const [row] = await sql<{ id: string }[]>`
		SELECT id FROM nfts WHERE seed_id = ${seedId} LIMIT 1
	`;
	if (!row) throw new Error(`No instance found for seed ${seedId}`);
	return row.id;
}

// Drives the full fixture against a clean database. Returns the formatted
// state_root after every op has been applied.
async function replayFixture(): Promise<string> {
	const collectionId = await generateDeterministicCollectionId(ALICE, COL_NAME, COL_SYMBOL);
	const seedIdA = await generateDeterministicSeedId(collectionId, ART_ID_A);
	const seedIdB = await generateDeterministicSeedId(collectionId, ART_ID_B);
	const originDna = await generateOriginDna(collectionId);
	const feeAmount = parseFloat(PROTOCOL_COLLECTION_FEE_HBD);

	const blocks = {
		createCollection: GENESIS_BLOCK + 0,
		mintA: GENESIS_BLOCK + 1,
		mintB: GENESIS_BLOCK + 2,
		distributeA: GENESIS_BLOCK + 3,
		distributeB: GENESIS_BLOCK + 4,
		transferAtoBob: GENESIS_BLOCK + 5,
		listB: GENESIS_BLOCK + 6,
		buyCommitment: GENESIS_BLOCK + 7,
		buy: GENESIS_BLOCK + 8,
		transferAback: GENESIS_BLOCK + 9,
	} as const;

	// Settlement nodes must exist before any op whose fee recipient is derived
	// from `op.signer` (create_collection) or whose action is node-signed
	// (buy_commitment, buy). Both signers — the protocol-fee account and the
	// dedicated node — are seeded with a pinned registration block so the
	// snapshot stays stable across runs.
	await seedActiveSettlementNode(config.hiveAccount, { registeredBlock: GENESIS_BLOCK });
	await seedActiveSettlementNode(NODE, { registeredBlock: GENESIS_BLOCK });

	const applyOp = async (op: ParsedOperation): Promise<void> => {
		await withTransaction(async (txn) => {
			const result = await routeOperationDetailed(op, txn);
			if (result.kind !== "applied") {
				throw new Error(
					`Fixture op did not apply (kind=${result.kind}, action=${op.action}, txId=${op.txId}): ${result.reason}`,
				);
			}
		});
	};

	// 1. create_collection — fee transfer in pairedTransfers.
	await applyOp(makeOp({
		action: ACTION_CREATE_COLLECTION,
		signer: config.hiveAccount,
		blockNum: blocks.createCollection,
		txId: detTxId("create_collection"),
		operationId: detOpId("create_collection"),
		timestamp: blockTimestamp(blocks.createCollection),
		data: {
			id: collectionId,
			name: COL_NAME,
			symbol: COL_SYMBOL,
			originDna,
			totalPotential: 10,
			maxInstances: 0,
			metadata: { description: "deterministic", image: "https://example.com/det.png" },
			rules: { transferable: true, burnable: false, royaltyPct: 0 },
		},
		pairedTransfers: [
			{
				from: ALICE,
				to: config.hiveAccount,
				amount: feeAmount,
				currency: "HBD",
				memo: `${MEMO_PREFIX_FEE_COL}${collectionId}`,
			},
		],
	}));

	// 2 + 3. Mint two seeds owned by alice. Mint tx ids are emitted in the
	// canonical 40-char hex form because bulk_distribute later attests
	// `seedTxId === seed.created_tx_id` and the parser/handler reject
	// non-hex tx ids elsewhere in the chain.
	const mintTxA = detTxId("mint_a");
	const mintTxB = detTxId("mint_b");
	await applyOp(makeOp({
		action: ACTION_MINT,
		signer: ALICE,
		blockNum: blocks.mintA,
		txId: mintTxA,
		operationId: detOpId("mint_a"),
		timestamp: blockTimestamp(blocks.mintA),
		data: {
			id: seedIdA,
			artId: ART_ID_A,
			collectionId,
			edition: 1,
			owner: ALICE,
			nftType: "seed",
			maxSupply: 1,
		},
	}));
	await applyOp(makeOp({
		action: ACTION_MINT,
		signer: ALICE,
		blockNum: blocks.mintB,
		txId: mintTxB,
		operationId: detOpId("mint_b"),
		timestamp: blockTimestamp(blocks.mintB),
		data: {
			id: seedIdB,
			artId: ART_ID_B,
			collectionId,
			edition: 1,
			owner: ALICE,
			nftType: "seed",
			maxSupply: 1,
		},
	}));

	// 4 + 5. Distribute each seed into a single instance owned by alice.
	await applyOp(makeOp({
		action: ACTION_BULK_DISTRIBUTE,
		signer: ALICE,
		blockNum: blocks.distributeA,
		txId: detTxId("dist_a"),
		operationId: detOpId("dist_a"),
		timestamp: blockTimestamp(blocks.distributeA),
		data: {
			items: [{ seedId: seedIdA, quantity: 1, seedTxId: mintTxA }],
		},
	}));
	await applyOp(makeOp({
		action: ACTION_BULK_DISTRIBUTE,
		signer: ALICE,
		blockNum: blocks.distributeB,
		txId: detTxId("dist_b"),
		operationId: detOpId("dist_b"),
		timestamp: blockTimestamp(blocks.distributeB),
		data: {
			items: [{ seedId: seedIdB, quantity: 1, seedTxId: mintTxB }],
		},
	}));

	const instanceA = await resolveInstanceId(seedIdA);
	const instanceB = await resolveInstanceId(seedIdB);

	// 6. transfer NFT_A from alice → bob.
	await applyOp(makeOp({
		action: ACTION_TRANSFER,
		signer: ALICE,
		blockNum: blocks.transferAtoBob,
		txId: detTxId("transfer_a_to_bob"),
		operationId: detOpId("transfer_a_to_bob"),
		timestamp: blockTimestamp(blocks.transferAtoBob),
		data: { nftId: instanceA, to: BOB },
	}));

	// 7. list NFT_B — replay-deterministic listingId requires the same nonce
	//    each run. No royalty is configured so the buy split is seller+fee.
	const listingId = await generateListingId({
		nftId: instanceB,
		owner: ALICE,
		marketplace: "",
		priceAmount: PRICE,
		priceCurrency: "HIVE",
		expiresAt: LISTING_EXPIRES_AT,
		nonce: LISTING_NONCE,
	});
	const listingTxId = detTxId("list_b");
	await applyOp(makeOp({
		action: ACTION_LIST,
		signer: ALICE,
		blockNum: blocks.listB,
		txId: listingTxId,
		operationId: detOpId("list_b"),
		timestamp: blockTimestamp(blocks.listB),
		data: {
			nftId: instanceB,
			listingId,
			listingNonce: LISTING_NONCE,
			price: { amount: PRICE, currency: "HIVE" },
			expiresAt: LISTING_EXPIRES_AT,
		},
	}));

	// 8. buy_commitment — node reserves NFT_B for carol against the future buy.
	//    txHash MUST be the buy op's txId (lower-cased) so handleBuy passes the
	//    commitment digest check.
	const buyTxId = detTxId("buy_b");
	await applyOp(makeOp({
		action: ACTION_BUY_COMMITMENT,
		signer: NODE,
		blockNum: blocks.buyCommitment,
		txId: detTxId("buy_commitment"),
		operationId: detOpId("buy_commitment"),
		timestamp: blockTimestamp(blocks.buyCommitment),
		data: {
			nftId: instanceB,
			listingId,
			listTxId: listingTxId,
			buyer: CAROL,
			txHash: buyTxId,
		},
	}));

	// 9. buy — multisig signed by node; carol funds seller + protocol fee.
	const split = calculatePaymentSplit(PRICE_NUMBER, "HIVE", 0, null, ALICE, NODE);
	const sellerTransfer: TransferDetail = {
		from: CAROL,
		to: ALICE,
		amount: split.sellerAmount,
		currency: "HIVE",
		memo: `${MEMO_PREFIX_BUY}${instanceB}`,
	};
	const feeTransfer: TransferDetail = {
		from: CAROL,
		to: NODE,
		amount: split.feeAmount,
		currency: "HIVE",
		memo: `${MEMO_PREFIX_FEE}${instanceB}`,
	};
	const buyTransfers: TransferDetail[] = [sellerTransfer, feeTransfer];

	await applyOp(makeOp({
		action: ACTION_BUY,
		signer: NODE,
		blockNum: blocks.buy,
		txId: buyTxId,
		operationId: detOpId("buy_b"),
		timestamp: blockTimestamp(blocks.buy),
		data: {
			nftId: instanceB,
			listingId,
			listTxId: listingTxId,
			txId: listingTxId,
		},
		pairedTransfers: buyTransfers,
	}));

	// 10. transfer NFT_A from bob → alice (round-trip; ends with
	//     owner=alice, previous_owner=bob, owner_action='transfer').
	await applyOp(makeOp({
		action: ACTION_TRANSFER,
		signer: BOB,
		blockNum: blocks.transferAback,
		txId: detTxId("transfer_a_back"),
		operationId: detOpId("transfer_a_back"),
		timestamp: blockTimestamp(blocks.transferAback),
		data: { nftId: instanceA, to: ALICE },
	}));

	const meta = await getStateMeta();
	return formatStateRoot(meta.state_root);
}

describe("F2.B genesis replay determinism", () => {
	beforeAll(cleanDb);
	beforeEach(cleanDb);

	it("two independent replays produce byte-equal state_root (idempotence)", async () => {
		const firstRoot = await replayFixture();
		await cleanDb();
		const secondRoot = await replayFixture();
		expect(firstRoot).toBe(secondRoot);
	});

	it("replay matches the pinned EXPECTED_STATE_ROOT (snapshot)", async () => {
		const root = await replayFixture();
		expect(root).toBe(EXPECTED_STATE_ROOT);
	});
});
