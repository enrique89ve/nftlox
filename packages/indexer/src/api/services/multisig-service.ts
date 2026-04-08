/**
 * Multisig service — validates and co-signs multisig buy transactions.
 *
 * Pure functions with explicit dependencies. No module-level state.
 * Signing is delegated to beekeeper (WASM) — the private key never
 * lives in JS heap memory after initialization.
 */

import { Transaction, type CustomJsonOperation, type TransactionType, type TransferOperation } from "hive-tx";
import { signWithBeekeeper } from "@/api/services/beekeeper-signer.ts";
import { createLogger } from "@/utils/logger.ts";
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
	type ValidatedTransaction,
} from "@/protocol/index.ts";

// ============ CONSTANTS ============

const log = createLogger("multisig-service");
const MIN_EXPIRATION_MS = 30_000;
const MAX_EXPIRATION_MS = 120_000;
const MIN_OPERATIONS = 2; // minimum: 1 transfer (seller) + 1 custom_json

// ============ TYPES (internal) ============

type ValidatedRequest = Readonly<{
	readonly buyer: string;
	readonly nftId: string;
	readonly listingId: string;
	readonly listTxId: string;
	readonly transaction: ValidatedTransaction;
}>;

type RequestShape = Readonly<{
	readonly buyer: string;
	readonly nftId: string;
	readonly listingId: string;
	readonly listTxId: string;
	readonly transaction: Record<string, unknown>;
}>;

type ValidatedTransferOp = ValidatedTransaction["transferOperations"][number];
type ValidatedCustomJsonOp = ValidatedTransaction["customJsonOperation"];
type ValidatedBuyPayload = ValidatedCustomJsonOp["payload"];
type ParsedAmount = ValidatedTransferOp["parsedAmount"];

type MultisigRules = Pick<CollectionRulesRow, "id" | "creator" | "transferable" | "burnable" | "replicable" | "royalty_pct" | "royalty_recipient">;

type TransactionOperationInput = Readonly<{
	readonly name: string;
	readonly body: Record<string, unknown>;
}>;

type NftStateResult = Readonly<{
	readonly nft: NftProcessingRow;
	readonly rules: MultisigRules;
	readonly nftTxId: string;
}>;

type SignResult = Readonly<{
	readonly signature: string;
	readonly digest: string;
}>;

// ============ PUBLIC API ============

export async function processMultisigRequest(
	rawBody: unknown,
	db: Queryable,
	nodeAccount: string,
	protocolId: string,
): Promise<MultisigResponse> {
	try {
		const requestShape = validateRequestShape(rawBody);
		const request: ValidatedRequest = {
			...requestShape,
			transaction: validateTransactionStructure(
				requestShape.transaction,
				requestShape.buyer,
				nodeAccount,
				protocolId,
			),
		};

		const { nft, rules, nftTxId } = await validateNftState(request.nftId, request.buyer, db);

		if (nft.listing_id !== request.listingId) {
			throw createMultisigError("INVALID_PROTOCOL_PAYLOAD", "listingId does not match current listing");
		}
		if (nft.listing_tx_id !== request.listTxId) {
			throw createMultisigError("INVALID_PROTOCOL_PAYLOAD", "listTxId does not match current listing");
		}

		validateBuyPayloadData(
			request.transaction.customJsonOperation.payload,
			request.nftId,
			nftTxId,
			request.listingId,
			request.listTxId,
		);

		const transfers = extractTransfers(request.transaction.transferOperations);
		validatePaymentSplit(transfers, nft, request.nftId, rules, nodeAccount);

		const signResult = signTransaction(request.transaction);
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

function validateRequestShape(raw: unknown): RequestShape {
	if (!isRecord(raw)) {
		throw createMultisigError("INVALID_TX_STRUCTURE", "Request body must be a JSON object");
	}

	const buyer = validateNonEmptyString(raw.buyer, "Field 'buyer' must be a non-empty string");
	const usernameError = validateHiveUsername(buyer);
	if (usernameError) {
		throw createMultisigError("INVALID_TX_STRUCTURE", `Invalid buyer username: ${usernameError}`);
	}

	return {
		buyer,
		nftId: validateNonEmptyString(raw.nftId, "Field 'nftId' must be a non-empty string"),
		listingId: validateNonEmptyString(raw.listingId, "Field 'listingId' must be a non-empty string"),
		listTxId: validateNonEmptyString(raw.listTxId, "Field 'listTxId' must be a non-empty string"),
		transaction: validateRecord(raw.transaction, "INVALID_TX_STRUCTURE", "Field 'transaction' must be an object"),
	};
}

// ============ TRANSACTION STRUCTURE VALIDATION ============

function validateTransactionStructure(
	tx: Record<string, unknown>,
	buyer: string,
	nodeAccount: string,
	protocolId: string,
): ValidatedTransaction {
	const ref_block_num = validateUnsignedInteger(tx.ref_block_num, "Transaction 'ref_block_num'");
	const ref_block_prefix = validateUnsignedInteger(tx.ref_block_prefix, "Transaction 'ref_block_prefix'");
	const expiration = validateExpiration(tx.expiration);
	const signatures = validateSignaturesEmpty(tx.signatures);
	const extensions = validateExtensions(tx.extensions);
	const operations = validateOperationsArray(tx.operations);

	validateOperationCount(operations);

	const lastOperation = operations[operations.length - 1];
	if (!lastOperation) {
		throw createMultisigError("INVALID_TX_STRUCTURE", "No operations found");
	}

	return {
		ref_block_num,
		ref_block_prefix,
		expiration,
		transferOperations: validateTransferOperations(operations.slice(0, -1), buyer),
		customJsonOperation: validateCustomJsonOperation(lastOperation, nodeAccount, protocolId),
		extensions,
		signatures,
	};
}

function validateUnsignedInteger(value: unknown, fieldName: string): number {
	if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
		throw createMultisigError(
			"INVALID_TX_STRUCTURE",
			`${fieldName} must be a non-negative integer`,
		);
	}

	return value;
}

function validateOperationsArray(value: unknown): ReadonlyArray<TransactionOperationInput> {
	if (!Array.isArray(value)) {
		throw createMultisigError("INVALID_TX_STRUCTURE", "Transaction 'operations' must be an array");
	}

	return value.map((operation, index) => validateOperationTuple(operation, index));
}

function validateOperationTuple(value: unknown, index: number): TransactionOperationInput {
	if (!Array.isArray(value) || value.length !== 2) {
		throw createMultisigError(
			"INVALID_TX_STRUCTURE",
			`Operation at index ${index} must be a [name, body] tuple`,
		);
	}

	const [name, body] = value;
	if (typeof name !== "string") {
		throw createMultisigError(
			"INVALID_TX_STRUCTURE",
			`Operation at index ${index} must have a string name`,
		);
	}

	if (!isRecord(body)) {
		throw createMultisigError(
			"INVALID_TX_STRUCTURE",
			`Operation at index ${index} must have an object body`,
		);
	}

	return { name, body };
}

function validateExpiration(expiration: unknown): string {
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

	return expiration;
}

function validateSignaturesEmpty(signatures: unknown): readonly [] {
	if (!Array.isArray(signatures) || signatures.length !== 0) {
		throw createMultisigError("INVALID_TX_STRUCTURE", "Transaction must have an empty signatures array");
	}

	return [];
}

function validateExtensions(extensions: unknown): ReadonlyArray<unknown> {
	if (extensions === undefined) {
		return [];
	}

	if (!Array.isArray(extensions)) {
		throw createMultisigError("INVALID_TX_STRUCTURE", "Transaction 'extensions' must be an array");
	}

	for (const extension of extensions) {
		if (!Array.isArray(extension)) {
			throw createMultisigError("INVALID_TX_STRUCTURE", "Transaction 'extensions' entries must be arrays");
		}
	}

	return extensions;
}

function validateOperationCount(ops: ReadonlyArray<TransactionOperationInput>): void {
	if (ops.length < MIN_OPERATIONS || ops.length > MAX_MULTISIG_OPERATIONS) {
		throw createMultisigError(
			"INVALID_TX_STRUCTURE",
			`Expected ${MIN_OPERATIONS}-${MAX_MULTISIG_OPERATIONS} operations, got ${ops.length}`,
		);
	}
}

function validateTransferOperations(
	ops: ReadonlyArray<TransactionOperationInput>,
	buyer: string,
): ReadonlyArray<ValidatedTransferOp> {
	return ops.map((op) => {
		if (op.name !== "transfer") {
			throw createMultisigError(
				"INVALID_TX_STRUCTURE",
				`Expected 'transfer' operation, got '${String(op.name)}'`,
			);
		}

		const { from, to, amount, memo } = validateTransferBody(op.body);
		if (from !== buyer) {
			throw createMultisigError(
				"MISSING_BUYER_AUTH",
				`Transfer 'from' must be the buyer ('${buyer}'), got '${String(from)}'`,
			);
		}

		return {
			from,
			to,
			amount,
			memo,
			parsedAmount: parseHiveAmount(amount),
		};
	});
}

function validateTransferBody(body: Record<string, unknown>): Readonly<{
	from: string;
	to: string;
	amount: string;
	memo: string;
}> {
	const { from, to, amount, memo } = body;
	if (
		typeof from !== "string" ||
		typeof to !== "string" ||
		typeof amount !== "string" ||
		typeof memo !== "string"
	) {
		throw createMultisigError("INVALID_TX_STRUCTURE", "Transfer operation missing required fields (from, to, amount, memo)");
	}

	return { from, to, amount, memo };
}

function validateCustomJsonOperation(
	op: TransactionOperationInput,
	nodeAccount: string,
	protocolId: string,
): ValidatedCustomJsonOp {
	if (op.name !== "custom_json") {
		throw createMultisigError(
			"INVALID_TX_STRUCTURE",
			`Last operation must be 'custom_json', got '${String(op.name)}'`,
		);
	}

	const required_auths = validateRequiredAuths(op.body.required_auths, nodeAccount);
	const required_posting_auths = validateRequiredPostingAuths(op.body.required_posting_auths);
	const id = validateCustomJsonId(op.body.id, protocolId);
	const json = validateCustomJsonString(op.body.json);

	return {
		required_auths,
		required_posting_auths,
		id,
		json,
		payload: parseBuyPayload(json),
	};
}

function validateRequiredAuths(value: unknown, nodeAccount: string): readonly [string] {
	if (!Array.isArray(value) || value.length !== 1 || value[0] !== nodeAccount) {
		throw createMultisigError(
			"NODE_ACCOUNT_MISMATCH",
			"custom_json.required_auths must be [nodeAccount]",
		);
	}

	return [nodeAccount] as const;
}

function validateRequiredPostingAuths(value: unknown): readonly [] {
	if (!Array.isArray(value) || value.length !== 0) {
		throw createMultisigError(
			"INVALID_TX_STRUCTURE",
			"custom_json.required_posting_auths must be an empty array",
		);
	}

	return [];
}

function validateCustomJsonId(value: unknown, protocolId: string): string {
	if (value !== protocolId) {
		throw createMultisigError(
			"INVALID_PROTOCOL_PAYLOAD",
			`custom_json.id must be '${protocolId}', got '${String(value)}'`,
		);
	}

	return protocolId;
}

function validateCustomJsonString(value: unknown): string {
	if (typeof value !== "string") {
		throw createMultisigError("INVALID_PROTOCOL_PAYLOAD", "custom_json.json must be a string");
	}

	return value;
}

function parseBuyPayload(json: string): ValidatedBuyPayload {
	let parsed: unknown;
	try {
		parsed = JSON.parse(json);
	} catch {
		throw createMultisigError("INVALID_PROTOCOL_PAYLOAD", "custom_json.json is not valid JSON");
	}

	if (!isRecord(parsed)) {
		throw createMultisigError("INVALID_PROTOCOL_PAYLOAD", "Parsed custom_json.json must be an object");
	}

	if (parsed.action !== ACTION_BUY) {
		throw createMultisigError(
			"INVALID_PROTOCOL_PAYLOAD",
			`Payload action must be '${ACTION_BUY}', got '${String(parsed.action)}'`,
		);
	}

	const data = parsed.data;
	if (!isRecord(data)) {
		throw createMultisigError("INVALID_PROTOCOL_PAYLOAD", "Payload must have a 'data' object");
	}

	return {
		action: ACTION_BUY,
		data: {
			nftId: validatePayloadDataString(data.nftId, "nftId"),
			txId: validatePayloadDataString(data.txId, "txId"),
			listingId: validatePayloadDataString(data.listingId, "listingId"),
			listTxId: validatePayloadDataString(data.listTxId, "listTxId"),
		},
	};
}

function validatePayloadDataString(value: unknown, fieldName: string): string {
	if (typeof value !== "string") {
		throw createMultisigError("INVALID_PROTOCOL_PAYLOAD", `Payload data.${fieldName} must be a string`);
	}

	return value;
}

function validateBuyPayloadData(
	payload: ValidatedBuyPayload,
	expectedNftId: string,
	expectedTxId: string,
	expectedListingId: string,
	expectedListTxId: string,
): void {
	if (payload.data.nftId !== expectedNftId) {
		throw createMultisigError(
			"INVALID_PROTOCOL_PAYLOAD",
			`Payload nftId mismatch: expected '${expectedNftId}', got '${payload.data.nftId}'`,
		);
	}

	if (payload.data.txId !== expectedTxId) {
		throw createMultisigError(
			"INVALID_PROTOCOL_PAYLOAD",
			`Payload txId mismatch: expected '${expectedTxId}', got '${payload.data.txId}'`,
		);
	}

	if (payload.data.listingId !== expectedListingId) {
		throw createMultisigError(
			"INVALID_PROTOCOL_PAYLOAD",
			`Payload listingId mismatch: expected '${expectedListingId}', got '${payload.data.listingId}'`,
		);
	}

	if (payload.data.listTxId !== expectedListTxId) {
		throw createMultisigError(
			"INVALID_PROTOCOL_PAYLOAD",
			`Payload listTxId mismatch: expected '${expectedListTxId}', got '${payload.data.listTxId}'`,
		);
	}
}

// ============ AMOUNT PARSING ============

function parseHiveAmount(amountStr: string): ParsedAmount {
	const parts = amountStr.split(" ");
	if (parts.length !== 2) {
		throw createMultisigError("INVALID_TX_STRUCTURE", `Invalid Hive amount format: '${amountStr}'`);
	}

	const amountPart = parts[0];
	const currencyPart = parts[1];
	if (!amountPart || !currencyPart || !/^\d+\.\d{3}$/.test(amountPart)) {
		throw createMultisigError("INVALID_TX_STRUCTURE", `Hive amount must have exactly 3 decimal places: '${amountStr}'`);
	}

	const amount = parseFloat(amountPart);
	if (Number.isNaN(amount) || amount <= 0) {
		throw createMultisigError("INVALID_TX_STRUCTURE", `Invalid amount value in: '${amountStr}'`);
	}

	return { amount, currency: currencyPart };
}

// ============ TRANSFER EXTRACTION ============

function extractTransfers(ops: ReadonlyArray<ValidatedTransferOp>): TransferRecord[] {
	return ops.map((op) => ({
		from: op.from,
		to: op.to,
		amount: op.parsedAmount.amount,
		currency: op.parsedAmount.currency,
		memo: op.memo,
	}));
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
		throw createMultisigError("NFT_NOT_LISTED", "NFT is not currently listed for sale");
	}

	if (nftWithRules.listing_expires_at) {
		const expiresAt = new Date(nftWithRules.listing_expires_at).getTime();
		if (Date.now() > expiresAt) {
			throw createMultisigError("NFT_EXPIRED_LISTING", "Listing has expired");
		}
	}

	if (buyer === nftWithRules.owner) {
		throw createMultisigError("CANNOT_BUY_OWN", "Buyer cannot purchase their own NFT");
	}

	if (!nftWithRules.transferable) {
		throw createMultisigError("NFT_NOT_TRANSFERABLE", "NFT cannot be transferred");
	}

	if (nftWithRules.nft_type === "seed" && nftWithRules.distributed > 0) {
		throw createMultisigError("SEED_HAS_INSTANCES", "Seed with distributed instances cannot be sold");
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

	return { nft, rules, nftTxId: nftWithRules.tx_id };
}

// ============ PAYMENT SPLIT VALIDATION ============

function validatePaymentSplit(
	transfers: TransferRecord[],
	nft: NftProcessingRow,
	nftId: string,
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

	const royaltyPct = Number(rules.royalty_pct);
	if (Number.isNaN(royaltyPct) || royaltyPct < 0 || royaltyPct > 50) {
		throw createMultisigError("INTERNAL_ERROR", "Collection royalty_pct is invalid");
	}

	try {
		const split = verifyTransfers({
			transfers,
			buyer: transfers[0]?.from ?? "",
			seller: nft.owner,
			totalPrice,
			currency: nft.listing_currency,
			royaltyPct,
			royaltyRecipient: rules.royalty_recipient,
			feeAccount: nodeAccount,
			nftId,
		});

		let expectedCount = 0;
		if (split.sellerAmount > 0) expectedCount++;
		if (split.royaltyAmount > 0 && split.royaltyRecipient) expectedCount++;
		if (split.feeAmount > 0) expectedCount++;

		if (transfers.length !== expectedCount) {
			throw new Error(`Expected exactly ${expectedCount} transfers, got ${transfers.length}`);
		}
	} catch (err) {
		throw createMultisigError(
			"INVALID_PAYMENT_SPLIT",
			err instanceof Error ? err.message : "Payment split verification failed",
		);
	}
}

// ============ TRANSACTION SIGNING ============

function signTransaction(tx: ValidatedTransaction): SignResult {
	const hiveTx = new Transaction();

	const txData: TransactionType = {
		ref_block_num: tx.ref_block_num,
		ref_block_prefix: tx.ref_block_prefix,
		expiration: tx.expiration,
		operations: toHiveTxOperations(tx),
		extensions: toHiveTxExtensions(tx.extensions),
		signatures: [],
	};
	hiveTx.transaction = txData;

	const { digest, txId } = hiveTx.digest();
	const sigDigestHex = Buffer.from(digest).toString("hex");
	const signature = signWithBeekeeper(sigDigestHex);

	return { signature, digest: txId };
}

function toHiveTxOperations(tx: ValidatedTransaction): TransactionType["operations"] {
	const operations: TransactionType["operations"] = [];

	for (const transfer of tx.transferOperations) {
		const body: TransferOperation = {
			from: transfer.from,
			to: transfer.to,
			amount: transfer.amount,
			memo: transfer.memo,
		};
		operations.push(["transfer", body]);
	}

	// Interop boundary: convert the validated internal transaction shape into the
	// exact operation structs expected by hive-tx before digest/signing via beekeeper.
	const customJsonBody: CustomJsonOperation = {
		required_auths: [...tx.customJsonOperation.required_auths],
		required_posting_auths: [...tx.customJsonOperation.required_posting_auths],
		id: tx.customJsonOperation.id,
		json: tx.customJsonOperation.json,
	};
	operations.push(["custom_json", customJsonBody]);

	return operations;
}

function toHiveTxExtensions(extensions: ReadonlyArray<unknown>): TransactionType["extensions"] {
	const result: TransactionType["extensions"] = [];

	for (const extension of extensions) {
		if (!Array.isArray(extension)) {
			throw createMultisigError("INVALID_TX_STRUCTURE", "Transaction 'extensions' entries must be arrays");
		}
		result.push(extension);
	}

	return result;
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

	log.error("Unexpected multisig error", { error: err instanceof Error ? err.message : String(err) });
	const message = "An unexpected error occurred";
	return { ok: false, code: "INTERNAL_ERROR", message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateRecord(value: unknown, code: MultisigErrorCode, message: string): Record<string, unknown> {
	if (!isRecord(value)) {
		throw createMultisigError(code, message);
	}

	return value;
}

function validateNonEmptyString(value: unknown, message: string): string {
	if (typeof value !== "string" || value === "") {
		throw createMultisigError("INVALID_TX_STRUCTURE", message);
	}

	return value;
}
