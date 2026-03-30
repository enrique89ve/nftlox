/**
 * Multisig service — validates and co-signs multisig buy transactions.
 *
 * Pure functions with explicit dependencies. No module-level state.
 * The PrivateKey is created per-request and never stored.
 */

import { Transaction, PrivateKey, type TransactionType, type OperationName, type OperationBody } from "hive-tx";
import type { Queryable } from "@/db/client.ts";
import { getNftWithCollectionRules, type NftProcessingRow } from "@/db/queries/nfts.ts";
import type { CollectionRulesRow } from "@/db/queries/collections.ts";
import { verifyTransfers, type TransferRecord } from "@/utils/validation.ts";
import {
	validateHiveUsername,
	ACTION_BUY,
	MAX_MULTISIG_OPERATIONS,
	type MultisigResponse,
	type MultisigErrorCode,
	type HiveTransactionObject,
} from "nftlox-sdk";

// ============ CONSTANTS ============

const MIN_EXPIRATION_MS = 30_000;
const MAX_EXPIRATION_MS = 120_000;
const MIN_OPERATIONS = 2; // minimum: 1 transfer (seller) + 1 custom_json

// ============ TYPES (internal) ============

interface ValidatedRequest {
	readonly buyer: string;
	readonly nftId: string;
	readonly listingId: string;
	readonly listTxId: string;
	readonly transaction: HiveTransactionObject;
}

interface ParsedAmount {
	readonly amount: number;
	readonly currency: string;
}

type MultisigRules = Pick<CollectionRulesRow, "id" | "creator" | "transferable" | "burnable" | "replicable" | "royalty_pct" | "royalty_recipient">;

interface NftStateResult {
	readonly nft: NftProcessingRow;
	readonly rules: MultisigRules;
}

// ============ PUBLIC API ============

export async function processMultisigRequest(
	rawBody: unknown,
	db: Queryable,
	nodeAccount: string,
	protocolId: string,
	activeKey: string,
): Promise<MultisigResponse> {
	try {
		const request = validateRequestShape(rawBody);
		validateTransactionStructure(request.transaction, request.buyer, nodeAccount, protocolId);

		const { nft, rules } = await validateNftState(request.nftId, request.buyer, db);

		// Validate listingId and listTxId match the active listing
		if (nft.listing_id !== request.listingId) {
			throw createMultisigError(
				"INVALID_PROTOCOL_PAYLOAD",
				`listingId mismatch: expected '${nft.listing_id}', got '${request.listingId}'`,
			);
		}
		if (nft.listing_tx_id !== request.listTxId) {
			throw createMultisigError(
				"INVALID_PROTOCOL_PAYLOAD",
				`listTxId mismatch: expected '${nft.listing_tx_id}', got '${request.listTxId}'`,
			);
		}

		// Validate the custom_json payload contains matching listingId and listTxId
		validateBuyPayloadData(request.transaction.operations, request.listingId, request.listTxId);

		const transfers = extractTransfers(request.transaction.operations, request.buyer);
		validatePaymentSplit(transfers, nft, rules, nodeAccount);

		const signResult = signTransaction(request.transaction, activeKey);
		return {
			ok: true,
			signature: signResult.signature,
			digest: signResult.digest,
			expiration: request.transaction.expiration,
		};
	} catch (err) {
		return mapErrorToMultisigResponse(err);
	}
}

// ============ REQUEST VALIDATION ============

function validateRequestShape(raw: unknown): ValidatedRequest {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		throw createMultisigError("INVALID_TX_STRUCTURE", "Request body must be a JSON object");
	}

	const body = raw as Record<string, unknown>;

	if (typeof body.buyer !== "string" || body.buyer === "") {
		throw createMultisigError("INVALID_TX_STRUCTURE", "Field 'buyer' must be a non-empty string");
	}

	const usernameError = validateHiveUsername(body.buyer);
	if (usernameError) {
		throw createMultisigError("INVALID_TX_STRUCTURE", `Invalid buyer username: ${usernameError}`);
	}

	if (typeof body.nftId !== "string" || body.nftId === "") {
		throw createMultisigError("INVALID_TX_STRUCTURE", "Field 'nftId' must be a non-empty string");
	}

	if (typeof body.listingId !== "string" || body.listingId === "") {
		throw createMultisigError("INVALID_TX_STRUCTURE", "Field 'listingId' must be a non-empty string");
	}

	if (typeof body.listTxId !== "string" || body.listTxId === "") {
		throw createMultisigError("INVALID_TX_STRUCTURE", "Field 'listTxId' must be a non-empty string");
	}

	if (!body.transaction || typeof body.transaction !== "object" || Array.isArray(body.transaction)) {
		throw createMultisigError("INVALID_TX_STRUCTURE", "Field 'transaction' must be an object");
	}

	return {
		buyer: body.buyer,
		nftId: body.nftId,
		listingId: body.listingId,
		listTxId: body.listTxId,
		transaction: body.transaction as HiveTransactionObject,
	};
}

// ============ TRANSACTION STRUCTURE VALIDATION ============

function validateTransactionStructure(
	tx: HiveTransactionObject,
	buyer: string,
	nodeAccount: string,
	protocolId: string,
): void {
	validateOperationsArray(tx);
	validateExpiration(tx.expiration);
	validateSignaturesEmpty(tx);
	validateOperationCount(tx.operations);
	validateTransferOperations(tx.operations, buyer);
	validateCustomJsonOperation(tx.operations, nodeAccount, protocolId);
}

function validateOperationsArray(tx: HiveTransactionObject): void {
	if (!Array.isArray(tx.operations)) {
		throw createMultisigError("INVALID_TX_STRUCTURE", "Transaction 'operations' must be an array");
	}
}

function validateExpiration(expiration: unknown): void {
	if (typeof expiration !== "string") {
		throw createMultisigError("INVALID_TX_STRUCTURE", "Transaction 'expiration' must be a string");
	}

	const expiresAt = new Date(expiration + "Z").getTime();
	if (Number.isNaN(expiresAt)) {
		throw createMultisigError("INVALID_TX_STRUCTURE", "Transaction 'expiration' is not a valid date");
	}

	const now = Date.now();
	const diffMs = expiresAt - now;

	if (diffMs < MIN_EXPIRATION_MS) {
		throw createMultisigError(
			"INVALID_TX_STRUCTURE",
			`Transaction expires too soon (${Math.round(diffMs / 1000)}s). Minimum: ${MIN_EXPIRATION_MS / 1000}s`,
		);
	}

	if (diffMs > MAX_EXPIRATION_MS) {
		throw createMultisigError(
			"INVALID_TX_STRUCTURE",
			`Transaction expiration too far in the future (${Math.round(diffMs / 1000)}s). Maximum: ${MAX_EXPIRATION_MS / 1000}s`,
		);
	}
}

function validateSignaturesEmpty(tx: HiveTransactionObject): void {
	if (!Array.isArray(tx.signatures) || tx.signatures.length !== 0) {
		throw createMultisigError("INVALID_TX_STRUCTURE", "Transaction must have an empty signatures array");
	}
}

function validateOperationCount(ops: ReadonlyArray<unknown>): void {
	if (ops.length < MIN_OPERATIONS || ops.length > MAX_MULTISIG_OPERATIONS) {
		throw createMultisigError(
			"INVALID_TX_STRUCTURE",
			`Expected ${MIN_OPERATIONS}-${MAX_MULTISIG_OPERATIONS} operations, got ${ops.length}`,
		);
	}
}

function validateTransferOperations(
	ops: ReadonlyArray<readonly [string, Record<string, unknown>]>,
	buyer: string,
): void {
	const transferOps = ops.slice(0, -1);
	for (const op of transferOps) {
		if (!Array.isArray(op) || op.length !== 2) {
			throw createMultisigError("INVALID_TX_STRUCTURE", "Each operation must be a [name, body] tuple");
		}

		if (op[0] !== "transfer") {
			throw createMultisigError(
				"INVALID_TX_STRUCTURE",
				`Expected 'transfer' operation, got '${String(op[0])}'`,
			);
		}

		const body = op[1];
		if (!body || typeof body !== "object") {
			throw createMultisigError("INVALID_TX_STRUCTURE", "Transfer operation body must be an object");
		}

		const transferBody = body as Record<string, unknown>;
		if (typeof transferBody.from !== "string" || typeof transferBody.to !== "string" ||
			typeof transferBody.amount !== "string" || typeof transferBody.memo !== "string") {
			throw createMultisigError("INVALID_TX_STRUCTURE", "Transfer operation missing required fields (from, to, amount, memo)");
		}

		if (transferBody.from !== buyer) {
			throw createMultisigError(
				"MISSING_BUYER_AUTH",
				`Transfer 'from' must be the buyer ('${buyer}'), got '${String(transferBody.from)}'`,
			);
		}
	}
}

function validateCustomJsonOperation(
	ops: ReadonlyArray<readonly [string, Record<string, unknown>]>,
	nodeAccount: string,
	protocolId: string,
): void {
	const lastOp = ops[ops.length - 1];
	if (!lastOp || !Array.isArray(lastOp) || lastOp.length !== 2) {
		throw createMultisigError("INVALID_TX_STRUCTURE", "Last operation must be a [name, body] tuple");
	}

	if (lastOp[0] !== "custom_json") {
		throw createMultisigError(
			"INVALID_TX_STRUCTURE",
			`Last operation must be 'custom_json', got '${String(lastOp[0])}'`,
		);
	}

	const cj = lastOp[1] as Record<string, unknown>;
	validateCustomJsonAuth(cj, nodeAccount);
	validateCustomJsonProtocol(cj, protocolId);
}

function validateCustomJsonAuth(cj: Record<string, unknown>, nodeAccount: string): void {
	if (!Array.isArray(cj.required_auths) ||
		cj.required_auths.length !== 1 ||
		cj.required_auths[0] !== nodeAccount) {
		throw createMultisigError(
			"NODE_ACCOUNT_MISMATCH",
			"custom_json.required_auths must be [nodeAccount]",
		);
	}

	if (!Array.isArray(cj.required_posting_auths) || cj.required_posting_auths.length !== 0) {
		throw createMultisigError(
			"INVALID_TX_STRUCTURE",
			"custom_json.required_posting_auths must be an empty array",
		);
	}
}

function validateCustomJsonProtocol(cj: Record<string, unknown>, protocolId: string): void {
	if (cj.id !== protocolId) {
		throw createMultisigError(
			"INVALID_PROTOCOL_PAYLOAD",
			`custom_json.id must be '${protocolId}', got '${String(cj.id)}'`,
		);
	}

	if (typeof cj.json !== "string") {
		throw createMultisigError("INVALID_PROTOCOL_PAYLOAD", "custom_json.json must be a string");
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(cj.json);
	} catch {
		throw createMultisigError("INVALID_PROTOCOL_PAYLOAD", "custom_json.json is not valid JSON");
	}

	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw createMultisigError("INVALID_PROTOCOL_PAYLOAD", "Parsed custom_json.json must be an object");
	}

	const payload = parsed as Record<string, unknown>;
	if (payload.action !== ACTION_BUY) {
		throw createMultisigError(
			"INVALID_PROTOCOL_PAYLOAD",
			`Payload action must be '${ACTION_BUY}', got '${String(payload.action)}'`,
		);
	}

	const data = payload.data as Record<string, unknown> | undefined;
	if (!data || typeof data !== "object") {
		throw createMultisigError("INVALID_PROTOCOL_PAYLOAD", "Payload must have a 'data' object");
	}
}

/**
 * Validates that the custom_json buy payload contains matching listingId and listTxId.
 * SAFETY: This function MUST only be called after validateCustomJsonOperation(),
 * which guarantees: lastOp exists, is custom_json, has valid JSON, has data object.
 */
function validateBuyPayloadData(
	ops: ReadonlyArray<readonly [string, Record<string, unknown>]>,
	expectedListingId: string,
	expectedListTxId: string,
): void {
	const lastOp = ops[ops.length - 1];
	if (!lastOp) {
		throw createMultisigError("INVALID_TX_STRUCTURE", "No operations found");
	}
	const cj = lastOp[1] as Record<string, unknown>;
	const parsed = JSON.parse(cj.json as string) as Record<string, unknown>;
	const data = parsed.data as Record<string, unknown>;

	if (data.listingId !== expectedListingId) {
		throw createMultisigError(
			"INVALID_PROTOCOL_PAYLOAD",
			`Payload listingId mismatch: expected '${expectedListingId}', got '${String(data.listingId)}'`,
		);
	}

	if (data.listTxId !== expectedListTxId) {
		throw createMultisigError(
			"INVALID_PROTOCOL_PAYLOAD",
			`Payload listTxId mismatch: expected '${expectedListTxId}', got '${String(data.listTxId)}'`,
		);
	}
}

// ============ AMOUNT PARSING ============

function parseHiveAmount(amountStr: string): ParsedAmount {
	const parts = amountStr.split(" ");
	if (parts.length !== 2) {
		throw createMultisigError("INVALID_TX_STRUCTURE", `Invalid Hive amount format: '${amountStr}'`);
	}

	if (!/^\d+\.\d{3}$/.test(parts[0]!)) {
		throw createMultisigError("INVALID_TX_STRUCTURE", `Hive amount must have exactly 3 decimal places: '${amountStr}'`);
	}

	const amount = parseFloat(parts[0]!);
	const currency = parts[1]!;

	if (Number.isNaN(amount) || amount <= 0) {
		throw createMultisigError("INVALID_TX_STRUCTURE", `Invalid amount value in: '${amountStr}'`);
	}

	return { amount, currency };
}

// ============ TRANSFER EXTRACTION ============

function extractTransfers(
	ops: ReadonlyArray<readonly [string, Record<string, unknown>]>,
	buyer: string,
): ReadonlyArray<TransferRecord> {
	const transferOps = ops.slice(0, -1);
	return transferOps.map(op => {
		const body = op[1] as Record<string, unknown>;
		const parsed = parseHiveAmount(body.amount as string);
		return {
			from: buyer,
			to: body.to as string,
			amount: parsed.amount,
			currency: parsed.currency,
		};
	});
}

// ============ NFT STATE VALIDATION ============

async function validateNftState(
	nftId: string,
	buyer: string,
	db: Queryable,
): Promise<NftStateResult> {
	const nftWithRules = await getNftWithCollectionRules(nftId, db);
	if (!nftWithRules) {
		throw createMultisigError("NFT_NOT_FOUND", `NFT '${nftId}' not found`);
	}

	if (nftWithRules.status !== "listed") {
		throw createMultisigError("NFT_NOT_LISTED", `NFT '${nftId}' is not listed (status: ${nftWithRules.status})`);
	}

	if (nftWithRules.listing_expires_at) {
		const expiresAt = new Date(nftWithRules.listing_expires_at).getTime();
		if (Date.now() > expiresAt) {
			throw createMultisigError("NFT_EXPIRED_LISTING", `Listing for NFT '${nftId}' has expired`);
		}
	}

	if (buyer === nftWithRules.owner) {
		throw createMultisigError("CANNOT_BUY_OWN", "Buyer cannot purchase their own NFT");
	}

	if (!nftWithRules.transferable) {
		throw createMultisigError("NFT_NOT_TRANSFERABLE", `Collection '${nftWithRules.collection_id}' is not transferable — co-sign rejected`);
	}

	const nft: NftProcessingRow = nftWithRules;
	const rules = {
		id: nftWithRules.collection_id,
		creator: nftWithRules.creator,
		transferable: nftWithRules.transferable,
		burnable: nftWithRules.burnable,
		replicable: nftWithRules.replicable,
		royalty_pct: nftWithRules.royalty_pct,
		royalty_recipient: nftWithRules.royalty_recipient,
	} satisfies MultisigRules;

	return { nft, rules };
}

// ============ PAYMENT SPLIT VALIDATION ============

function validatePaymentSplit(
	transfers: ReadonlyArray<TransferRecord>,
	nft: NftProcessingRow,
	rules: MultisigRules,
	nodeAccount: string,
): void {
	if (!nft.listing_price || !nft.listing_currency) {
		throw createMultisigError("NFT_NOT_LISTED", "NFT has no listing price or currency");
	}

	const totalPrice = parseFloat(nft.listing_price);
	if (Number.isNaN(totalPrice) || totalPrice <= 0) {
		throw createMultisigError("INTERNAL_ERROR", "NFT listing price is invalid");
	}

	try {
		const split = verifyTransfers({
			transfers: transfers as TransferRecord[],
			buyer: transfers[0]?.from ?? "",
			seller: nft.owner,
			totalPrice,
			currency: nft.listing_currency,
			royaltyPct: rules.royalty_pct,
			royaltyRecipient: rules.royalty_recipient,
			feeAccount: nodeAccount,
		});

		// Validate exact transfer count — reject extra transfers
		let expectedCount = 0;
		if (split.sellerAmount > 0) expectedCount++;
		if (split.royaltyAmount > 0 && split.royaltyRecipient) expectedCount++;
		if (split.feeAmount > 0) expectedCount++;

		if (transfers.length !== expectedCount) {
			throw new Error(
				`Expected exactly ${expectedCount} transfers, got ${transfers.length}`,
			);
		}
	} catch (err) {
		throw createMultisigError(
			"INVALID_PAYMENT_SPLIT",
			err instanceof Error ? err.message : "Payment split verification failed",
		);
	}
}

// ============ TRANSACTION SIGNING ============

interface SignResult {
	readonly signature: string;
	readonly digest: string;
}

function signTransaction(tx: HiveTransactionObject, activeKey: string): SignResult {
	const hiveTx = new Transaction();

	// Set the internal transaction object directly.
	// The tx already has ref_block_num, ref_block_prefix, expiration, and operations
	// from the client. We reconstruct it with mutable signatures for signing.
	// Cast operations to the hive-tx expected type.
	// We have already validated the structure above, so this narrowing is safe.
	const operations = tx.operations as unknown as [OperationName, OperationBody<OperationName>][];

	const txData: TransactionType = {
		ref_block_num: tx.ref_block_num,
		ref_block_prefix: tx.ref_block_prefix,
		expiration: tx.expiration,
		operations,
		extensions: (tx.extensions ?? []) as [],
		signatures: [],
	};
	hiveTx.transaction = txData;

	// Create key per-request, never store
	const key = PrivateKey.from(activeKey);
	hiveTx.sign(key);

	const signed = hiveTx.transaction;
	if (!signed || signed.signatures.length === 0) {
		throw createMultisigError("INTERNAL_ERROR", "Signing produced no signature");
	}

	const signature = signed.signatures[0]!;
	const { txId } = hiveTx.digest();

	return { signature, digest: txId };
}

// ============ ERROR HANDLING ============

class MultisigError extends Error {
	readonly code: MultisigErrorCode;

	constructor(code: MultisigErrorCode, message: string) {
		super(message);
		this.code = code;
		this.name = "MultisigError";
	}
}

function createMultisigError(code: MultisigErrorCode, message: string): MultisigError {
	return new MultisigError(code, message);
}

function mapErrorToMultisigResponse(err: unknown): MultisigResponse {
	if (err instanceof MultisigError) {
		return { ok: false, code: err.code, message: err.message };
	}

	// Unknown error — never leak sensitive details
	const message = err instanceof Error ? err.message : "An unexpected error occurred";
	return { ok: false, code: "INTERNAL_ERROR", message };
}
