// Validates the buyer-presigned tx2 BEFORE tx1 is broadcast. If the validator
// rejects, we must not reserve the NFT (no tx1), so the buyer can retry
// immediately without starving other bidders for SALE_LOCK_DURATION_BLOCKS.
//
// What "presigned tx2" means (format contract with SDK — see build-buy.ts):
//   A JSON-serialized hive-tx TransactionType:
//     { ref_block_num, ref_block_prefix, expiration, operations, extensions,
//       signatures: [buyerActiveSig] }
//   operations = [ transfer(seller), transfer(royalty)?, transfer(fee),
//                  custom_json(action=ACTION_BUY) ]
//   required_auths: [nodeAccount] — node cosigns with active
//   required_posting_auths on the custom_json: []
//
// Validation layers:
//   1. JSON shape + hive-tx ops layout (transfers first, custom_json last).
//   2. Expiration is far enough in the future to survive the sale_lock wait.
//   3. Every transfer.from === buyer (active auth on tx is thus implicit).
//   4. Exactly one buyer signature (the active sig) is present.
//   5. custom_json.required_auths = [nodeAccount], required_posting_auths = [].
//   6. custom_json payload is ACTION_BUY with the correct nftId/listingId/listTxId.
//   7. Payment split matches the current listing (verifyTransfers).
//   8. NFT is still listed, buyer != owner, collection is transferable.
//
// Anything not listed above is out of scope: the SDK is trusted to produce
// well-formed payloads, the indexer is trusted to enforce on-chain shape.
//
// CONFIDENCE: HIGH on the structural checks — they mirror multisig/buy.ts
// which has production coverage. MEDIUM on the buyer-signature count check
// alone being a sufficient proof that the buyer actively authorized tx2 —
// the real enforcement is verify_authority at the Hive witness layer; this
// function only prevents obvious malformed envelopes.

import { NFT_KIND_INSTANCE } from "@/db/queries/nft-types.ts";
import { getNftWithCollectionRules } from "@/db/queries/nft-reads.ts";
import {
	ACTION_BUY,
	BUY_TX_TTL_MS,
	HIVE_CUSTOM_JSON_MAX_BYTES,
	MIN_PROTOCOL_VERSION,
	PROTOCOL_ID,
	isProtocolAction,
} from "@/protocol/index.ts";
import { verifyTransfers, requireSupportedCurrency, type TransferRecord } from "@/utils/validation.ts";
import { createBuyError } from "./errors.ts";
import type { Queryable } from "@/db/client.ts";
import type { ValidatedBuyRequest } from "./types.ts";

export type PresignedTx2 = Readonly<{
	readonly ref_block_num: number;
	readonly ref_block_prefix: number;
	readonly expiration: string;
	readonly operations: ReadonlyArray<readonly [string, Record<string, unknown>]>;
	readonly extensions: ReadonlyArray<unknown>;
	readonly signatures: ReadonlyArray<string>;
}>;

export type ValidatedPresignedTx2 = Readonly<{
	readonly parsed: PresignedTx2;
	readonly serialized: string;
	readonly transfers: ReadonlyArray<TransferRecord>;
}>;

export async function validatePresignedTx2(
	request: ValidatedBuyRequest,
	nodeAccount: string,
	db: Queryable,
): Promise<ValidatedPresignedTx2> {
	const parsed = parsePresignedTx2(request.presignedTx2);
	assertStructuralShape(parsed);
	assertExpiration(parsed.expiration);
	const transfers = assertOperations(parsed, request, nodeAccount);
	assertBuyerSignature(parsed.signatures);

	await assertNftStateAndPayment(request, transfers, nodeAccount, db);

	return { parsed, serialized: request.presignedTx2, transfers };
}

function parsePresignedTx2(serialized: string): PresignedTx2 {
	let parsed: unknown;
	try {
		parsed = JSON.parse(serialized);
	} catch (cause) {
		throw createBuyError("INVALID_PRESIGNED_TX2", "presignedTx2 is not valid JSON", { cause });
	}

	if (!isRecord(parsed)) {
		throw createBuyError("INVALID_PRESIGNED_TX2", "presignedTx2 must decode to an object");
	}

	return parsed as unknown as PresignedTx2;
}

function assertStructuralShape(tx: PresignedTx2): void {
	if (typeof tx.ref_block_num !== "number" || typeof tx.ref_block_prefix !== "number") {
		throw createBuyError("INVALID_PRESIGNED_TX2", "presignedTx2 is missing ref_block_num/ref_block_prefix");
	}
	if (typeof tx.expiration !== "string") {
		throw createBuyError("INVALID_PRESIGNED_TX2", "presignedTx2.expiration must be a string");
	}
	if (!Array.isArray(tx.operations) || tx.operations.length < 2) {
		throw createBuyError("INVALID_PRESIGNED_TX2", "presignedTx2.operations must have at least 2 entries (transfers + buy)");
	}
	if (!Array.isArray(tx.signatures)) {
		throw createBuyError("INVALID_PRESIGNED_TX2", "presignedTx2.signatures must be an array");
	}
}

function assertExpiration(expiration: string): void {
	const expiresAt = Date.parse(`${expiration}Z`);
	if (Number.isNaN(expiresAt)) {
		throw createBuyError("INVALID_PRESIGNED_TX2", "presignedTx2.expiration is not a valid date");
	}

	const minWindow = Math.floor(BUY_TX_TTL_MS / 2);
	const remaining = expiresAt - Date.now();
	if (remaining < minWindow) {
		throw createBuyError(
			"INVALID_PRESIGNED_TX2",
			`presignedTx2 expires too soon (${remaining}ms left); need at least ${minWindow}ms for cosign + broadcast`,
		);
	}
}

function assertOperations(
	tx: PresignedTx2,
	request: ValidatedBuyRequest,
	nodeAccount: string,
): ReadonlyArray<TransferRecord> {
	const transferOps = tx.operations.slice(0, -1);
	const lastOp = tx.operations[tx.operations.length - 1];
	if (!lastOp) {
		throw createBuyError("INVALID_PRESIGNED_TX2", "presignedTx2 has no operations");
	}

	const transfers = transferOps.map((op, idx) => assertTransferOp(op, idx, request.buyer));
	assertBuyCustomJson(lastOp, request, nodeAccount);
	return transfers;
}

function assertTransferOp(
	op: readonly [string, Record<string, unknown>],
	idx: number,
	buyer: string,
): TransferRecord {
	if (op[0] !== "transfer") {
		throw createBuyError(
			"INVALID_PRESIGNED_TX2",
			`presignedTx2.operations[${idx}] must be 'transfer', got '${String(op[0])}'`,
		);
	}
	const body = op[1];
	const from = body.from;
	const to = body.to;
	const amount = body.amount;
	const memo = body.memo;
	if (typeof from !== "string" || typeof to !== "string" || typeof amount !== "string" || typeof memo !== "string") {
		throw createBuyError(
			"INVALID_PRESIGNED_TX2",
			`presignedTx2.operations[${idx}] transfer missing required fields`,
		);
	}
	if (from !== buyer) {
		throw createBuyError(
			"MISSING_BUYER_SIGNATURE",
			`presignedTx2.operations[${idx}] transfer.from must be the buyer ('${buyer}'), got '${from}'`,
		);
	}
	const { value, currency } = parseAmount(amount);
	return { from, to, amount: value, currency, memo };
}

function assertBuyCustomJson(
	op: readonly [string, Record<string, unknown>],
	request: ValidatedBuyRequest,
	nodeAccount: string,
): void {
	if (op[0] !== "custom_json") {
		throw createBuyError(
			"INVALID_PRESIGNED_TX2",
			`presignedTx2 last operation must be 'custom_json', got '${String(op[0])}'`,
		);
	}

	const body = op[1];
	const requiredAuths = body.required_auths;
	const requiredPostingAuths = body.required_posting_auths;
	const id = body.id;
	const json = body.json;

	if (!Array.isArray(requiredAuths) || requiredAuths.length !== 1 || requiredAuths[0] !== nodeAccount) {
		throw createBuyError(
			"NODE_ACCOUNT_MISMATCH",
			`presignedTx2 custom_json.required_auths must be [${nodeAccount}]`,
		);
	}
	if (!Array.isArray(requiredPostingAuths) || requiredPostingAuths.length !== 0) {
		throw createBuyError(
			"INVALID_PRESIGNED_TX2",
			"presignedTx2 custom_json.required_posting_auths must be empty (buy uses active multisig)",
		);
	}
	if (id !== PROTOCOL_ID) {
		throw createBuyError(
			"INVALID_PRESIGNED_TX2",
			`presignedTx2 custom_json.id must be '${PROTOCOL_ID}', got '${String(id)}'`,
		);
	}
	if (typeof json !== "string") {
		throw createBuyError("INVALID_PRESIGNED_TX2", "presignedTx2 custom_json.json must be a string");
	}
	if (Buffer.byteLength(json, "utf8") > HIVE_CUSTOM_JSON_MAX_BYTES) {
		throw createBuyError(
			"INVALID_PRESIGNED_TX2",
			`presignedTx2 custom_json.json exceeds Hive limit of ${HIVE_CUSTOM_JSON_MAX_BYTES} bytes`,
		);
	}

	assertBuyPayload(json, request);
}

function assertBuyPayload(json: string, request: ValidatedBuyRequest): void {
	let payload: Record<string, unknown>;
	try {
		const parsed: unknown = JSON.parse(json);
		if (!isRecord(parsed)) {
			throw new Error("payload must be an object");
		}
		payload = parsed;
	} catch (cause) {
		throw createBuyError("INVALID_PROTOCOL_PAYLOAD", "presignedTx2 custom_json.json is not valid JSON", { cause });
	}

	if (payload.protocol !== PROTOCOL_ID) {
		throw createBuyError(
			"INVALID_PROTOCOL_PAYLOAD",
			`presignedTx2 buy payload.protocol must be '${PROTOCOL_ID}', got '${String(payload.protocol)}'`,
		);
	}
	if (typeof payload.version !== "string" || payload.version < MIN_PROTOCOL_VERSION) {
		throw createBuyError(
			"INVALID_PROTOCOL_PAYLOAD",
			`presignedTx2 buy payload.version must be >= ${MIN_PROTOCOL_VERSION}`,
		);
	}
	if (!isProtocolAction(payload.action) || payload.action !== ACTION_BUY) {
		throw createBuyError(
			"INVALID_PROTOCOL_PAYLOAD",
			`presignedTx2 buy payload.action must be '${ACTION_BUY}', got '${String(payload.action)}'`,
		);
	}

	const data = payload.data;
	if (!isRecord(data)) {
		throw createBuyError("INVALID_PROTOCOL_PAYLOAD", "presignedTx2 buy payload.data must be an object");
	}
	if (data.nftId !== request.nftId) {
		throw createBuyError(
			"INVALID_PROTOCOL_PAYLOAD",
			`presignedTx2 buy payload.data.nftId mismatch: expected '${request.nftId}', got '${String(data.nftId)}'`,
		);
	}
	if (data.listingId !== request.listingId) {
		throw createBuyError(
			"INVALID_PROTOCOL_PAYLOAD",
			`presignedTx2 buy payload.data.listingId mismatch: expected '${request.listingId}', got '${String(data.listingId)}'`,
		);
	}
	if (data.listTxId !== request.listTxId) {
		throw createBuyError(
			"INVALID_PROTOCOL_PAYLOAD",
			`presignedTx2 buy payload.data.listTxId mismatch: expected '${request.listTxId}', got '${String(data.listTxId)}'`,
		);
	}
}

function assertBuyerSignature(signatures: ReadonlyArray<string>): void {
	// Must have exactly one signature: the buyer's active signature over the
	// full tx digest. The node appends its posting sig later. Two-or-more
	// signatures would mean a pre-cosign attempt — reject.
	if (signatures.length !== 1) {
		throw createBuyError(
			"MISSING_BUYER_SIGNATURE",
			`presignedTx2 must carry exactly 1 buyer signature, got ${signatures.length}`,
		);
	}
	const sig = signatures[0];
	if (typeof sig !== "string" || sig.length !== 130) {
		throw createBuyError(
			"MISSING_BUYER_SIGNATURE",
			`presignedTx2 buyer signature must be a 130-char hex string, got length=${sig?.length ?? 0}`,
		);
	}
}

async function assertNftStateAndPayment(
	request: ValidatedBuyRequest,
	transfers: ReadonlyArray<TransferRecord>,
	nodeAccount: string,
	db: Queryable,
): Promise<void> {
	const nft = await getNftWithCollectionRules(request.nftId, db);
	if (!nft) {
		throw createBuyError("NFT_NOT_FOUND", `NFT '${request.nftId}' not found`);
	}
	if (nft.status !== "listed") {
		throw createBuyError("NFT_NOT_LISTED", `NFT '${request.nftId}' is not currently listed`);
	}
	if (nft.nft_type !== NFT_KIND_INSTANCE) {
		throw createBuyError("NFT_NOT_INSTANCE", "Only instances can be bought through the marketplace");
	}
	if (request.buyer === nft.owner) {
		throw createBuyError("CANNOT_BUY_OWN", "Buyer cannot purchase their own NFT");
	}
	if (!nft.transferable) {
		throw createBuyError("NFT_NOT_TRANSFERABLE", "NFT's collection disallows transfers");
	}
	if (nft.listing_id !== request.listingId) {
		throw createBuyError("LISTING_MISMATCH", "listingId does not match current listing");
	}
	if (nft.listing_tx_id !== request.listTxId) {
		throw createBuyError("LISTING_MISMATCH", "listTxId does not match current listing");
	}

	assertListingAliveForExpiration(nft.listing_expires_at);
	assertPaymentSplit(transfers, nft, request.nftId, nodeAccount);
}

function assertListingAliveForExpiration(listingExpiresAt: string | null): void {
	if (!listingExpiresAt) return;
	const expiresMs = Date.parse(listingExpiresAt);
	if (Number.isNaN(expiresMs)) {
		throw createBuyError("INTERNAL_ERROR", "NFT listing expiration is invalid");
	}
	if (Date.now() >= expiresMs) {
		throw createBuyError("NFT_EXPIRED_LISTING", "Listing has already expired");
	}
}

function assertPaymentSplit(
	transfers: ReadonlyArray<TransferRecord>,
	nft: Awaited<ReturnType<typeof getNftWithCollectionRules>>,
	nftId: string,
	nodeAccount: string,
): void {
	if (!nft) return;
	if (!nft.listing_price || !nft.listing_currency) {
		throw createBuyError("NFT_NOT_LISTED", "NFT has no listing price or currency");
	}
	const totalPrice = Number(nft.listing_price);
	if (!Number.isFinite(totalPrice) || totalPrice <= 0) {
		throw createBuyError("INTERNAL_ERROR", "NFT listing price is invalid");
	}
	const royaltyPct = Number(nft.royalty_pct ?? 0);
	if (!Number.isFinite(royaltyPct) || royaltyPct < 0 || royaltyPct > 50) {
		throw createBuyError("INTERNAL_ERROR", "Collection royalty_pct is invalid");
	}

	try {
		const { split } = verifyTransfers({
			transfers: [...transfers],
			seller: nft.owner,
			totalPrice,
			currency: requireSupportedCurrency(nft.listing_currency, "listing_currency"),
			royaltyPct,
			royaltyRecipient: nft.royalty_recipient ?? null,
			feeAccount: nodeAccount,
			nftId,
		});

		let expected = 0;
		if (split.sellerAmount > 0) expected++;
		if (split.royaltyAmount > 0 && split.royaltyRecipient) expected++;
		if (split.feeAmount > 0) expected++;
		if (transfers.length !== expected) {
			throw new Error(`Expected exactly ${expected} transfers, got ${transfers.length}`);
		}
	} catch (cause) {
		throw createBuyError(
			"INVALID_PAYMENT_SPLIT",
			cause instanceof Error ? cause.message : "Payment split verification failed",
			{ cause },
		);
	}
}

function parseAmount(amount: string): Readonly<{ value: number; currency: string }> {
	const parts = amount.split(" ");
	if (parts.length !== 2) {
		throw createBuyError("INVALID_PRESIGNED_TX2", `Invalid Hive amount format: '${amount}'`);
	}
	const [amountPart, currencyPart] = parts;
	if (!amountPart || !currencyPart || !/^\d+\.\d{3}$/.test(amountPart)) {
		throw createBuyError("INVALID_PRESIGNED_TX2", `Hive amount needs 3 decimal places: '${amount}'`);
	}
	const value = Number(amountPart);
	if (!Number.isFinite(value) || value <= 0) {
		throw createBuyError("INVALID_PRESIGNED_TX2", `Invalid amount value in '${amount}'`);
	}
	return { value, currency: currencyPart };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
