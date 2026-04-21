// Core of /api/buy: broadcasts tx1, the sale_lock custom_json signed solely
// with the node's posting key.
//
// Why posting-only here (not active): sale_lock moves NO funds. It is a
// server-side reservation that transitions the NFT from 'listed' to
// 'pending_sale' for the buyer named inside. Using posting keeps the active
// key reserved for operations that actually touch balances, and matches
// ACTION_AUTH_LEVEL[ACTION_SALE_LOCK] = "posting" in @nftlox/protocol.
//
// Signing path (matches api/services/multisig/transaction.ts — copied, not
// imported, since that module is being removed with the multisig cleanup):
//   new Transaction({expiration})
//   -> addOperation('custom_json', body)
//   -> digest()  (yields {digest: Uint8Array, txId})
//   -> signPostingDigest(hex)  (beekeeper WASM; WIF never enters JS heap)
//   -> addSignature(sig)
//   -> broadcast(true)  (waits for irreversible-or-rejected before returning)
//
// CONFIDENCE: HIGH — matches the multisig signing pattern this codebase
// already runs in production, swapped to posting. The critical posting-key
// boundary (beekeeper WASM, no plaintext) is unchanged.

import { Transaction, type CustomJsonOperation } from "hive-tx";
import {
	ACTION_SALE_LOCK,
	BUY_TX_TTL_MS,
	createHiveOperation,
	createPayload,
	type SaleLockData,
} from "@/protocol/index.ts";
import { signPostingDigest, isPostingSignerReady } from "@/api/services/beekeeper-signer.ts";
import { createBuyError } from "./errors.ts";
import { redactError } from "@/utils/redact.ts";
import type { SaleLockBroadcastResult } from "./types.ts";

export async function broadcastSaleLock(
	data: SaleLockData,
	nodeAccount: string,
): Promise<SaleLockBroadcastResult> {
	// REVIEW: guard ordering matters — we fail fast BEFORE creating the
	// Transaction so no partial state leaks on misconfiguration.
	if (!isPostingSignerReady()) {
		throw createBuyError(
			"POSTING_SIGNER_UNAVAILABLE",
			"Node posting key is not loaded — this node cannot broadcast sale_lock",
		);
	}

	const payload = createPayload(ACTION_SALE_LOCK, data);
	const [, bodyReadonly] = createHiveOperation(payload, nodeAccount);
	const body: CustomJsonOperation = {
		required_auths: [...bodyReadonly.required_auths],
		required_posting_auths: [...bodyReadonly.required_posting_auths],
		id: bodyReadonly.id,
		json: bodyReadonly.json,
	};
	assertPostingAuthShape(body, nodeAccount);

	const tx = new Transaction({ expiration: BUY_TX_TTL_MS });
	await tx.addOperation("custom_json", body);

	const { digest, txId } = tx.digest();
	// CONFIDENCE: HIGH — `signPostingDigest` signs inside beekeeper WASM; the
	// posting WIF never materializes in this process's JS heap.
	const signatureHex = signPostingDigest(bufferToHex(digest));
	tx.addSignature(signatureHex);

	return await broadcastAndWrap(tx, txId);
}

function assertPostingAuthShape(body: CustomJsonOperation, nodeAccount: string): void {
	// REVIEW: defensive — createHiveOperation already produces this shape for
	// posting-level actions, but a protocol auth-map drift would silently
	// downgrade authority. Better to crash here than broadcast an active-auth
	// sale_lock.
	const hasActive = Array.isArray(body.required_auths) && body.required_auths.length > 0;
	const posting = body.required_posting_auths ?? [];
	if (hasActive || posting.length !== 1 || posting[0] !== nodeAccount) {
		throw createBuyError(
			"INTERNAL_ERROR",
			"sale_lock custom_json must have required_posting_auths=[nodeAccount] and empty required_auths",
		);
	}
}

async function broadcastAndWrap(tx: Transaction, txId: string): Promise<SaleLockBroadcastResult> {
	try {
		const result = await tx.broadcast(true);
		if (result.status !== "within_irreversible_block") {
			// REVIEW: `checkStatus: true` waits for the tx to either land irreversibly
			// OR expire. Any non-success status means the lock did not land.
			throw createBuyError(
				"TX1_REJECTED",
				`sale_lock broadcast returned status='${result.status}' for tx ${txId}`,
			);
		}
		return { txId: result.tx_id, operationId: `${result.tx_id}:0`, blockNum: null };
	} catch (err) {
		if (err instanceof Error && err.name === "BuyError") throw err;
		throw createBuyError(
			"TX1_BROADCAST_FAILED",
			`sale_lock broadcast failed for tx ${txId}: ${safeMessage(err)}`,
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
