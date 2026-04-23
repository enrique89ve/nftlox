import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { sql, withTransaction } from "@/db/client.ts";
import type { ParsedOperation } from "@/scanner/operation-parser.ts";
import { routeOperation } from "@/processor/action-router.ts";
import {
	ACTION_BUY,
	ACTION_BUY_COMMITMENT,
	BUY_COMMITMENT_TTL_BLOCKS,
	MAX_NODE_HEARTBEAT_STALENESS_BLOCKS,
	MEMO_PREFIX_BUY,
	MEMO_PREFIX_FEE,
	calculatePaymentSplit,
} from "@/protocol/index.ts";
import { seedActiveSettlementNode } from "./helpers/settlement-node.ts";
import { makeOp as _makeOp } from "./helpers/make-op.ts";
import { seedCollection, insertListedInstance, cleanCommonTables } from "./helpers/nft-fixtures.ts";

// Tests que validan la gate del action-router para NODE_SIGNED_ACTIONS
// (buy_commitment, buy): op.signer DEBE estar registrado + activo en l2_nodes
// al bloque de procesamiento. Pre-fix, cualquier cuenta Hive podía firmar estas
// acciones — habilitando (a) DOS vía buy_commitment espurio con hash falso, y
// (b) fee-bypass firmando la propia buy con una cuenta no-nodo como feeAccount.

const REGISTERED_NODE = "gate.node";
const STRANGER = "random.hiver";
const SELLER = "seller.gate";
const BUYER = "buyer.gate";
const COLLECTION_ID = "col_gate_tests";
const REGISTERED_BLOCK = 100_000;
const FRESH_BLOCK = REGISTERED_BLOCK + 500; // dentro de la ventana de staleness
const STALE_BLOCK = REGISTERED_BLOCK + MAX_NODE_HEARTBEAT_STALENESS_BLOCKS + 1;

/**
 * Construye una buy op con los transfers válidos dirigidos al feeAccount
 * especificado (que es siempre == signer en el flujo real, ya que el handler
 * usa op.signer como feeAccount). Usarla con signer stranger simula el
 * fee-bypass antes del fix.
 */
function makeBuyOp(params: {
	readonly nftId: string;
	readonly listingId: string;
	readonly listTxId: string;
	readonly buyer: string;
	readonly seller: string;
	readonly signer: string;
	readonly buyTxHash: string;
	readonly blockNum: number;
	readonly price?: number;
}): ParsedOperation {
	const price = params.price ?? 10;
	const split = calculatePaymentSplit(price, "HIVE", 0, null, params.seller, params.signer);
	const transfers: NonNullable<ParsedOperation["pairedTransfers"]> = [
		{
			from: params.buyer,
			to: params.seller,
			amount: split.sellerAmount,
			currency: "HIVE",
			memo: `${MEMO_PREFIX_BUY}${params.nftId}`,
		},
	];
	if (split.feeAmount > 0) {
		transfers.push({
			from: params.buyer,
			to: params.signer,
			amount: split.feeAmount,
			currency: "HIVE",
			memo: `${MEMO_PREFIX_FEE}${params.nftId}`,
		});
	}
	return _makeOp({
		action: ACTION_BUY,
		signer: params.signer,
		blockNum: params.blockNum,
		txId: params.buyTxHash,
		data: {
			nftId: params.nftId,
			listingId: params.listingId,
			listTxId: params.listTxId,
			txId: params.buyTxHash,
		},
		pairedTransfers: transfers,
	});
}

beforeAll(async () => {
	await cleanCommonTables();
	await sql`DELETE FROM collections WHERE id = ${COLLECTION_ID}`;
	await seedCollection(COLLECTION_ID, SELLER);
});

beforeEach(async () => {
	await sql`DELETE FROM nfts`;
	await sql`DELETE FROM invalid_operations`;
	await sql`DELETE FROM confirmed_operations`;
	await sql`DELETE FROM orphaned_buys`;
	await sql`DELETE FROM l2_nodes`;
});

afterAll(async () => {
	await cleanCommonTables();
	await sql`DELETE FROM collections WHERE id = ${COLLECTION_ID}`;
});

describe("router node-signer gate — buy_commitment", () => {
	test("rejects a non-registered signer (DOS prevention)", async () => {
		const nftId = "nft_gate_a";
		await insertListedInstance({ nftId, collectionId: COLLECTION_ID, seller: SELLER, listingId: "list_a", listTxId: "tx_a" });

		const op = _makeOp({
			action: ACTION_BUY_COMMITMENT,
			signer: STRANGER,
			blockNum: FRESH_BLOCK,
			data: {
				nftId,
				listingId: "list_a",
				listTxId: "tx_a",
				buyer: BUYER,
				txHash: "b".repeat(40),
			},
		});

		const ok = await withTransaction((txn) => routeOperation(op, txn));
		expect(ok).toBe(false);

		const [nft] = await sql<{ status: string; sale_buyer: string | null }[]>`
			SELECT status, sale_buyer FROM nfts WHERE id = ${nftId}
		`;
		expect(nft?.status).toBe("listed");
		expect(nft?.sale_buyer).toBeNull();

		const invalid = await sql<{ reason: string }[]>`
			SELECT reason FROM invalid_operations WHERE operation_id = ${op.operationId}
		`;
		expect(invalid).toHaveLength(1);
		expect(invalid[0]!.reason).toContain("is not registered in l2_nodes");
	});

	test("accepts a registered + fresh node signer (happy path)", async () => {
		await seedActiveSettlementNode(REGISTERED_NODE, { registeredBlock: REGISTERED_BLOCK });
		const nftId = "nft_gate_b";
		await insertListedInstance({ nftId, collectionId: COLLECTION_ID, seller: SELLER, listingId: "list_b", listTxId: "tx_b" });

		const op = _makeOp({
			action: ACTION_BUY_COMMITMENT,
			signer: REGISTERED_NODE,
			blockNum: FRESH_BLOCK,
			data: {
				nftId,
				listingId: "list_b",
				listTxId: "tx_b",
				buyer: BUYER,
				txHash: "c".repeat(40),
			},
		});

		const ok = await withTransaction((txn) => routeOperation(op, txn));
		expect(ok).toBe(true);

		const [nft] = await sql<
			{ status: string; sale_settlement_node: string | null; sale_expires_block: string | null }[]
		>`
			SELECT status, sale_settlement_node, sale_expires_block FROM nfts WHERE id = ${nftId}
		`;
		expect(nft?.status).toBe("pending_sale");
		expect(nft?.sale_settlement_node).toBe(REGISTERED_NODE);
		expect(Number(nft?.sale_expires_block)).toBe(FRESH_BLOCK + BUY_COMMITMENT_TTL_BLOCKS);
	});

	test("rejects a registered node with a stale heartbeat", async () => {
		await seedActiveSettlementNode(REGISTERED_NODE, { registeredBlock: REGISTERED_BLOCK });
		const nftId = "nft_gate_c";
		await insertListedInstance({ nftId, collectionId: COLLECTION_ID, seller: SELLER, listingId: "list_c", listTxId: "tx_c" });

		const op = _makeOp({
			action: ACTION_BUY_COMMITMENT,
			signer: REGISTERED_NODE,
			blockNum: STALE_BLOCK,
			data: {
				nftId,
				listingId: "list_c",
				listTxId: "tx_c",
				buyer: BUYER,
				txHash: "d".repeat(40),
			},
		});

		const ok = await withTransaction((txn) => routeOperation(op, txn));
		expect(ok).toBe(false);

		const [nft] = await sql<{ status: string }[]>`
			SELECT status FROM nfts WHERE id = ${nftId}
		`;
		expect(nft?.status).toBe("listed");

		const invalid = await sql<{ reason: string }[]>`
			SELECT reason FROM invalid_operations WHERE operation_id = ${op.operationId}
		`;
		expect(invalid).toHaveLength(1);
		expect(invalid[0]!.reason).toContain("not active for buy settlement");
		expect(invalid[0]!.reason).toContain("stale");
	});
});

describe("router node-signer gate — buy", () => {
	test("rejects buy whose custom_json signer is not a registered node (fee-bypass prevention)", async () => {
		// Set-up: nodo legítimo proyecta el commitment para que handleBuy
		// tuviera una reserva real que consumir. El fix debe bloquear la buy
		// ANTES de que llegue al handler, sin alterar el estado de la reserva.
		await seedActiveSettlementNode(REGISTERED_NODE, { registeredBlock: REGISTERED_BLOCK });

		const nftId = "nft_gate_buy";
		await insertListedInstance({ nftId, collectionId: COLLECTION_ID, seller: SELLER, listingId: "list_buy", listTxId: "tx_buy" });
		const buyTxHash = "e".repeat(40);

		const commitOp = _makeOp({
			action: ACTION_BUY_COMMITMENT,
			signer: REGISTERED_NODE,
			blockNum: FRESH_BLOCK,
			data: {
				nftId,
				listingId: "list_buy",
				listTxId: "tx_buy",
				buyer: BUYER,
				txHash: buyTxHash,
			},
		});
		const committed = await withTransaction((txn) => routeOperation(commitOp, txn));
		expect(committed).toBe(true);

		// Atacante: misma tx_hash que la reserva, pero firma con cuenta no-nodo
		// y se auto-direcciona la fee (signer === feeAccount).
		const buyOp = makeBuyOp({
			nftId,
			listingId: "list_buy",
			listTxId: "tx_buy",
			buyer: BUYER,
			seller: SELLER,
			signer: STRANGER,
			buyTxHash,
			blockNum: FRESH_BLOCK + 1,
		});

		const ok = await withTransaction((txn) => routeOperation(buyOp, txn));
		expect(ok).toBe(false);

		// La reserva sigue intacta — handleBuy no se ejecutó.
		const [nft] = await sql<
			{ status: string; sale_buyer: string | null; owner: string; sale_commitment_buy_tx_hash: string | null }[]
		>`
			SELECT status, sale_buyer, owner, sale_commitment_buy_tx_hash FROM nfts WHERE id = ${nftId}
		`;
		expect(nft?.status).toBe("pending_sale");
		expect(nft?.sale_buyer).toBe(BUYER);
		expect(nft?.owner).toBe(SELLER);
		expect(nft?.sale_commitment_buy_tx_hash).toBe(buyTxHash);

		// Ninguna venta registrada.
		const sales = await sql`SELECT id FROM sales WHERE nft_id = ${nftId}`;
		expect(sales).toHaveLength(0);

		// Reason en invalid_operations debe ser del gate, no del handler.
		const invalid = await sql<{ reason: string }[]>`
			SELECT reason FROM invalid_operations WHERE operation_id = ${buyOp.operationId}
		`;
		expect(invalid).toHaveLength(1);
		expect(invalid[0]!.reason).toContain("is not registered in l2_nodes");

		// Cuando el atacante broadcastea la buy real en Hive, los transfers L1
		// ya habrían ocurrido antes del procesamiento. El catch del router
		// registra ese hecho en orphaned_buys con la misma razón del gate —
		// la mitigación del fix no es "recuperar los fondos" sino "evitar que
		// el NFT cambie de dueño sin fee al nodo legítimo". Asegurar este
		// registro mantiene la trazabilidad operativa.
		const orphaned = await sql<{ reason: string }[]>`
			SELECT reason FROM orphaned_buys WHERE tx_id = ${buyOp.txId}
		`;
		expect(orphaned).toHaveLength(1);
		expect(orphaned[0]!.reason).toContain("is not registered in l2_nodes");
	});
});
