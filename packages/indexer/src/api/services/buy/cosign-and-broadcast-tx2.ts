// Final step of /api/buy: rehydrate the buyer-presigned tx2, append the
// node's active signature over the same digest, and broadcast to Hive.
//
// Why the digest is safe to recompute: Hive's transaction digest is a hash
// over (chain_id + ref_block_num + ref_block_prefix + expiration + operations
// + extensions). Signatures are NOT part of the digest input. Therefore the
// buyer and the indexer, starting from the same TransactionType, derive the
// same digest bytes — and the indexer can add its active signature alongside
// the buyer's existing active signature without touching or re-deriving any
// operation data. The L1 witness layer then runs verify_authority with both
// sigs against the posted tx.
//
// Why active for the node's signature here: tx2 contains three transfers
// (seller/royalty/fee) and one custom_json(ACTION_BUY). The transfers are
// authorized exclusively by the buyer's ACTIVE auth — the node does NOT sign
// the transfers. The node only cosigns the buy custom_json, which has
// `required_auths = [nodeAccount]`.
//
// Error contract: if the JSON-rpc broadcast returns anything other than
// `within_irreversible_block`, we surface TX2_BROADCAST_FAILED and rely on the
// lazy expiry sweep in sync-engine to release the pending_sale slot when its
// SALE_LOCK_DURATION_BLOCKS window elapses. We deliberately do NOT emit a
// compensating unlock op — the deterministic sweep is the single reconciliation
// path, and adding a retry op would race the sweep and double-spend the lock.
//
// CONFIDENCE: HIGH on the signing boundary — `signWithBeekeeper` keeps the
// WIF inside beekeeper WASM, identical to the path broadcastSaleLock uses.
// HIGH on digest equivalence — hive-tx Transaction.digest() is deterministic
// given the TransactionType input (no clock/nonce dependency).

import { Transaction } from "hive-tx";
import { isBeekeeperReady, signWithBeekeeper } from "@/api/services/beekeeper-signer.ts";
import { createBuyError } from "./errors.ts";
import { redactError } from "@/utils/redact.ts";
import type { PresignedTx2 } from "./validate-presigned-tx2.ts";

export type CosignBroadcastResult = Readonly<{
	readonly tx2Id: string;
	readonly blockNum: number | null;
}>;

export async function cosignAndBroadcastTx2(presigned: PresignedTx2): Promise<CosignBroadcastResult> {
	// REVIEW: same guard as broadcastSaleLock — we fail fast BEFORE rehydrating
	// the tx so a misconfigured node never leaks a partial broadcast attempt.
	if (!isBeekeeperReady()) {
		throw createBuyError(
			"ACTIVE_SIGNER_UNAVAILABLE",
			"Node active key is not loaded — this node cannot cosign tx2",
		);
	}

	const tx = rehydrateTransaction(presigned);
	const { digest, txId } = tx.digest();
	// CONFIDENCE: HIGH — signWithBeekeeper routes through beekeeper WASM; the
	// active WIF never materializes as a JS string in this process.
	const signatureHex = signWithBeekeeper(bufferToHex(digest));
	tx.addSignature(signatureHex);

	return await broadcastAndWrap(tx, txId);
}

function rehydrateTransaction(presigned: PresignedTx2): Transaction {
	// hive-tx accepts a preconstructed TransactionType via the options bag.
	// We strip readonly so the Transaction class's mutating signature operations
	// (addSignature) can append without cloning the buyer's array in place.
	const transaction = {
		ref_block_num: presigned.ref_block_num,
		ref_block_prefix: presigned.ref_block_prefix,
		expiration: presigned.expiration,
		operations: presigned.operations.map((op) => [op[0], { ...op[1] }]) as never,
		extensions: [...presigned.extensions] as never,
		signatures: [...presigned.signatures],
	};
	return new Transaction({ transaction });
}

async function broadcastAndWrap(tx: Transaction, txId: string): Promise<CosignBroadcastResult> {
	try {
		const result = await tx.broadcast(true);
		if (result.status !== "within_irreversible_block") {
			throw createBuyError(
				"TX2_BROADCAST_FAILED",
				`tx2 broadcast returned status='${result.status}' for tx ${txId}`,
			);
		}
		return { tx2Id: result.tx_id, blockNum: null };
	} catch (err) {
		if (err instanceof Error && err.name === "BuyError") throw err;
		throw createBuyError(
			"TX2_BROADCAST_FAILED",
			`tx2 broadcast failed for tx ${txId}: ${safeMessage(err)}`,
			{ cause: err },
		);
	}
}

function bufferToHex(bytes: Uint8Array): string {
	let hex = "";
	for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
	return hex;
}

function safeMessage(err: unknown): string {
	return redactError(err).message;
}
