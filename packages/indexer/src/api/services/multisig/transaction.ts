import { Transaction, type CustomJsonOperation, type TransactionType, type TransferOperation } from "hive-tx";
import { signWithBeekeeper } from "@/api/services/beekeeper-signer.ts";
import { createMultisigError } from "@/api/services/multisig/errors.ts";
import { prototypePollutionReviver } from "@/utils/json-safety.ts";
import {
	ACTION_BUY,
	ACTION_CREATE_COLLECTION,
	HIVE_CUSTOM_JSON_MAX_BYTES,
	MIN_PROTOCOL_VERSION,
	MULTISIG_TX_MAX_EXPIRATION_MS,
	MULTISIG_TX_MIN_EXPIRATION_MS,
	compareVersions,
	isHiveTxId,
	isInstanceId,
	isListingId,
	isProtocolAction,
	parseProtocolVersion,
	type MultisigErrorCode,
	type ProtocolAction,
} from "@/protocol/index.ts";

import type {
	ParsedAmount,
	SignResult,
	SupportedMultisigAction,
	TransactionOperationInput,
	ValidatedBuyPayload,
	ValidatedCollectionPayload,
	ValidatedCustomJsonOp,
	ValidatedPayload,
	ValidatedTransaction,
	ValidatedTransferOp,
} from "./types.ts";

type TransactionHeader = Readonly<{
	readonly ref_block_num: number;
	readonly ref_block_prefix: number;
	readonly expiration: string;
	readonly operations: ReadonlyArray<TransactionOperationInput>;
	readonly extensions: ReadonlyArray<unknown>;
	readonly signatures: readonly [];
}>;

export type TransactionTimeValidation = Readonly<{
	readonly referenceTimeMs: number;
}>;

type ParsedProtocolPayload = Readonly<{
	readonly protocol: string;
	readonly version: string;
	readonly action: ProtocolAction;
	readonly data: Record<string, unknown>;
}>;

export function validateBaseRequestShape(raw: unknown): Readonly<{ readonly transaction: Record<string, unknown> }> {
	if (!isRecord(raw)) {
		throw createMultisigError("INVALID_TX_STRUCTURE", "Request body must be a JSON object");
	}

	return {
		transaction: validateRecord(raw.transaction, "INVALID_TX_STRUCTURE", "Field 'transaction' must be an object"),
	};
}

export function validateCommonTransactionStructure(
	tx: Record<string, unknown>,
	timeValidation?: TransactionTimeValidation,
): TransactionHeader {
	return {
		ref_block_num: validateUnsignedInteger(tx.ref_block_num, "Transaction 'ref_block_num'"),
		ref_block_prefix: validateUnsignedInteger(tx.ref_block_prefix, "Transaction 'ref_block_prefix'"),
		expiration: validateExpiration(tx.expiration, timeValidation),
		signatures: validateSignaturesEmpty(tx.signatures),
		extensions: validateExtensions(tx.extensions),
		operations: validateOperationsArray(tx.operations),
	};
}

/**
 * Buy-specific header validation that expects the buyer's active signature to
 * already be present. Hive signatures are lowercase 130-hex-char strings; we
 * validate only the format here, not authority — Hive will reject the final
 * broadcast if the signature does not recover to the buyer's active key.
 */
export function validateBuyTransactionStructureWithBuyerSig(
	tx: Record<string, unknown>,
	timeValidation?: TransactionTimeValidation,
): Readonly<{
	readonly ref_block_num: number;
	readonly ref_block_prefix: number;
	readonly expiration: string;
	readonly operations: ReadonlyArray<TransactionOperationInput>;
	readonly extensions: ReadonlyArray<unknown>;
	readonly buyerSignature: string;
}> {
	const signatures = validateBuyerSignatureArray(tx.signatures);
	return {
		ref_block_num: validateUnsignedInteger(tx.ref_block_num, "Transaction 'ref_block_num'"),
		ref_block_prefix: validateUnsignedInteger(tx.ref_block_prefix, "Transaction 'ref_block_prefix'"),
		expiration: validateExpiration(tx.expiration, timeValidation),
		extensions: validateExtensions(tx.extensions),
		operations: validateOperationsArray(tx.operations),
		buyerSignature: signatures[0],
	};
}

function validateBuyerSignatureArray(signatures: unknown): readonly [string] {
	if (!Array.isArray(signatures) || signatures.length !== 1) {
		throw createMultisigError(
			"BUYER_SIGNATURE_MISSING",
			"Transaction must contain exactly one signature (the buyer's active signature)",
		);
	}
	const [sig] = signatures;
	if (typeof sig !== "string" || !/^[0-9a-fA-F]{130}$/.test(sig)) {
		throw createMultisigError(
			"BUYER_SIGNATURE_MISSING",
			"Buyer signature must be a 130-character hex string",
		);
	}
	return [sig.toLowerCase()];
}

export function getLastOperation(operations: ReadonlyArray<TransactionOperationInput>): TransactionOperationInput {
	const lastOperation = operations[operations.length - 1];
	if (!lastOperation) {
		throw createMultisigError("INVALID_TX_STRUCTURE", "No operations found");
	}

	return lastOperation;
}

export function detectMultisigAction(
	tx: Record<string, unknown>,
	protocolId: string,
): SupportedMultisigAction {
	const operations = validateOperationsArray(tx.operations);
	const lastOperation = getLastOperation(operations);
	if (lastOperation.name !== "custom_json") {
		throw createMultisigError(
			"INVALID_TX_STRUCTURE",
			`Last operation must be 'custom_json', got '${String(lastOperation.name)}'`,
		);
	}

	validateCustomJsonId(lastOperation.body.id, protocolId);
	const payload = parseProtocolPayload(validateCustomJsonString(lastOperation.body.json), protocolId);
	if (payload.action === ACTION_BUY || payload.action === ACTION_CREATE_COLLECTION) {
		return payload.action;
	}

	throw createMultisigError(
		"INVALID_PROTOCOL_PAYLOAD",
		`Unsupported multisig action '${String(payload.action)}'`,
	);
}

export function validateTransferOperations(
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

export function validateTransferBody(body: Record<string, unknown>): Readonly<{
	readonly from: string;
	readonly to: string;
	readonly amount: string;
	readonly memo: string;
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

export function validateCustomJsonOperation<Payload extends ValidatedPayload>(
	op: TransactionOperationInput,
	nodeAccount: string,
	protocolId: string,
	parsePayload: (json: string, protocolId: string) => Payload,
): ValidatedCustomJsonOp<Payload> {
	if (op.name !== "custom_json") {
		throw createMultisigError(
			"INVALID_TX_STRUCTURE",
			`Last operation must be 'custom_json', got '${String(op.name)}'`,
		);
	}

	const json = validateCustomJsonString(op.body.json);
	return {
		required_auths: validateRequiredAuths(op.body.required_auths, nodeAccount),
		required_posting_auths: validateRequiredPostingAuths(op.body.required_posting_auths),
		id: validateCustomJsonId(op.body.id, protocolId),
		json,
		payload: parsePayload(json, protocolId),
	};
}

export function parseBuyPayload(json: string, protocolId: string): ValidatedBuyPayload {
	const parsed = parseProtocolPayload(json, protocolId);
	if (parsed.action !== ACTION_BUY) {
		throw createMultisigError(
			"INVALID_PROTOCOL_PAYLOAD",
			`Payload action must be '${ACTION_BUY}', got '${String(parsed.action)}'`,
		);
	}

	// Handler-side `handleBuy` / `handleBuyCommitment` apply the same shape
	// guards (isInstanceId / isListingId / isHiveTxId) and reject identical
	// payloads. Catching the mismatch pre-broadcast avoids orphaning the
	// protocol fee on a chain rejection.
	return {
		action: ACTION_BUY,
		data: {
			nftId: validateShapedPayloadString(parsed.data.nftId, "nftId", isInstanceId, "nft_<20 hex>_<instance>"),
			listingId: validateShapedPayloadString(parsed.data.listingId, "listingId", isListingId, "list_<32 hex>"),
			listTxId: validateShapedPayloadString(parsed.data.listTxId, "listTxId", isHiveTxId, "<40 lowercase hex>"),
		},
	};
}

export function parseCollectionPayload(json: string, protocolId: string): ValidatedCollectionPayload {
	const parsed = parseProtocolPayload(json, protocolId);
	if (parsed.action !== ACTION_CREATE_COLLECTION) {
		throw createMultisigError(
			"INVALID_PROTOCOL_PAYLOAD",
			`Payload action must be '${ACTION_CREATE_COLLECTION}', got '${String(parsed.action)}'`,
		);
	}

	return {
		action: ACTION_CREATE_COLLECTION,
		data: parsed.data,
	};
}

export function validatePayloadDataString(value: unknown, fieldName: string): string {
	if (typeof value !== "string") {
		throw createMultisigError("INVALID_PROTOCOL_PAYLOAD", `Payload data.${fieldName} must be a string`);
	}

	return value;
}

export function validateBoundedPayloadString(value: unknown, fieldName: string, maxLength: number): string {
	const str = validatePayloadDataString(value, fieldName);
	if (str.length > maxLength) {
		throw createMultisigError(
			"INVALID_PROTOCOL_PAYLOAD",
			`Payload data.${fieldName} exceeds max length ${maxLength}`,
		);
	}

	return str;
}

// Non-empty + bounded variant — use for fields the handler validates via
// `requireBoundedString` (which rejects "" via `requireString`). Accepting ""
// here while the handler rejects it would let the multisig co-sign a payload
// that the chain bounces post-broadcast, orphaning the protocol fee. Sibling
// validateBoundedPayloadString stays loose for fields the handler treats as
// optional (e.g. metadata.externalUrl via optionalBoundedString, which itself
// passes through "").
export function validateNonEmptyBoundedPayloadString(value: unknown, fieldName: string, maxLength: number): string {
	const str = validatePayloadDataString(value, fieldName);
	if (str === "") {
		throw createMultisigError(
			"INVALID_PROTOCOL_PAYLOAD",
			`Payload data.${fieldName} must be a non-empty string`,
		);
	}
	if (str.length > maxLength) {
		throw createMultisigError(
			"INVALID_PROTOCOL_PAYLOAD",
			`Payload data.${fieldName} exceeds max length ${maxLength}`,
		);
	}

	return str;
}

// Exact-length variant — use for fields whose protocol contract is a fixed
// length (DNA, hashes, access keys). Sibling validateBoundedPayloadString
// only enforces an upper bound; mixing it with a *_LENGTH constant relies on
// a downstream equality check, which is easy to forget when copying the
// pattern to a new validator (see feedback_bounded_payload_string_is_max_not_exact).
export function validateExactLengthPayloadString(value: unknown, fieldName: string, length: number): string {
	const str = validatePayloadDataString(value, fieldName);
	if (str.length !== length) {
		throw createMultisigError(
			"INVALID_PROTOCOL_PAYLOAD",
			`Payload data.${fieldName} must be exactly ${length} characters, got ${str.length}`,
		);
	}

	return str;
}

// Shape-guard variant — use for fields whose protocol contract is a regex
// (id prefixes, hex widths). The predicate is a pure protocol guard
// (`isInstanceId`, `isListingId`, `isHiveTxId`) so the multisig and handler
// reject the same string for the same reason. `shapeDescription` should name
// the canonical shape ("nft_<20 hex>_<n>") so client logs surface why the
// payload was rejected.
export function validateShapedPayloadString(
	value: unknown,
	fieldName: string,
	predicate: (s: string) => boolean,
	shapeDescription: string,
): string {
	const str = validatePayloadDataString(value, fieldName);
	if (!predicate(str)) {
		throw createMultisigError(
			"INVALID_PROTOCOL_PAYLOAD",
			`Payload data.${fieldName} does not match the canonical shape ${shapeDescription}`,
		);
	}

	return str;
}

export function parseHiveAmount(amountStr: string): ParsedAmount {
	const parts = amountStr.split(" ");
	if (parts.length !== 2) {
		throw createMultisigError("INVALID_TX_STRUCTURE", `Invalid Hive amount format: '${amountStr}'`);
	}

	const amountPart = parts[0];
	const currencyPart = parts[1];
	if (!amountPart || !currencyPart || !/^\d+\.\d{3}$/.test(amountPart)) {
		throw createMultisigError("INVALID_TX_STRUCTURE", `Hive amount must have exactly 3 decimal places: '${amountStr}'`);
	}

	if (currencyPart !== "HIVE" && currencyPart !== "HBD") {
		throw createMultisigError("INVALID_TX_STRUCTURE", `Unsupported Hive currency in amount: '${currencyPart}'`);
	}

	const amount = Number(amountPart);
	if (Number.isNaN(amount) || amount <= 0) {
		throw createMultisigError("INVALID_TX_STRUCTURE", `Invalid amount value in: '${amountStr}'`);
	}

	return { amount, currency: currencyPart };
}

export function extractTransfers(ops: ReadonlyArray<ValidatedTransferOp>) {
	return ops.map((op) => ({
		from: op.from,
		to: op.to,
		amount: op.parsedAmount.amount,
		currency: op.parsedAmount.currency,
		memo: op.memo,
	}));
}

export function signTransaction(tx: ValidatedTransaction): SignResult {
	const hiveTx = buildHiveTransaction(tx);
	const { digest, txId } = hiveTx.digest();
	const sigDigestHex = Buffer.from(digest).toString("hex");
	return { signature: signWithBeekeeper(sigDigestHex), digest: txId };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateRecord(value: unknown, code: MultisigErrorCode, message: string): Record<string, unknown> {
	if (!isRecord(value)) {
		throw createMultisigError(code, message);
	}

	return value;
}

function validateUnsignedInteger(value: unknown, fieldName: string): number {
	if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
		throw createMultisigError("INVALID_TX_STRUCTURE", `${fieldName} must be a non-negative integer`);
	}

	return value;
}

function buildHiveTransaction(tx: ValidatedTransaction): Transaction {
	const hiveTx = new Transaction();
	hiveTx.transaction = {
		ref_block_num: tx.ref_block_num,
		ref_block_prefix: tx.ref_block_prefix,
		expiration: tx.expiration,
		operations: toHiveTxOperations(tx),
		extensions: toHiveTxExtensions(tx.extensions),
		signatures: [],
	};
	return hiveTx;
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
		throw createMultisigError("INVALID_TX_STRUCTURE", `Operation at index ${index} must have a string name`);
	}

	if (!isRecord(body)) {
		throw createMultisigError("INVALID_TX_STRUCTURE", `Operation at index ${index} must have an object body`);
	}

	return { name, body };
}

function validateExpiration(
	expiration: unknown,
	timeValidation: TransactionTimeValidation | undefined,
): string {
	if (typeof expiration !== "string") {
		throw createMultisigError("INVALID_TX_STRUCTURE", "Transaction 'expiration' must be a string");
	}

	const expiresAt = parseTransactionExpirationMs(expiration);
	const referenceTimeMs = timeValidation?.referenceTimeMs ?? Date.now();
	const diffMs = expiresAt - referenceTimeMs;
	if (diffMs < MULTISIG_TX_MIN_EXPIRATION_MS) {
		throw createMultisigError(
			"INVALID_TX_STRUCTURE",
			`Transaction expires too soon (${Math.round(diffMs / 1000)}s). Minimum: ${MULTISIG_TX_MIN_EXPIRATION_MS / 1000}s`,
		);
	}

	if (diffMs > MULTISIG_TX_MAX_EXPIRATION_MS) {
		throw createMultisigError(
			"INVALID_TX_STRUCTURE",
			`Transaction expiration too far in the future (${Math.round(diffMs / 1000)}s). Maximum: ${MULTISIG_TX_MAX_EXPIRATION_MS / 1000}s`,
		);
	}

	return expiration;
}

function parseTransactionExpirationMs(expiration: string): number {
	const expiresAt = new Date(`${expiration}Z`).getTime();
	if (Number.isNaN(expiresAt)) {
		throw createMultisigError("INVALID_TX_STRUCTURE", "Transaction 'expiration' is not a valid date");
	}
	return expiresAt;
}

function validateSignaturesEmpty(signatures: unknown): readonly [] {
	if (!Array.isArray(signatures) || signatures.length !== 0) {
		throw createMultisigError("INVALID_TX_STRUCTURE", "Transaction must have an empty signatures array");
	}

	return [];
}

function validateExtensions(extensions: unknown): ReadonlyArray<unknown> {
	if (extensions === undefined) return [];
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

function validateRequiredAuths(value: unknown, nodeAccount: string): readonly [string] {
	if (!Array.isArray(value) || value.length !== 1 || value[0] !== nodeAccount) {
		throw createMultisigError("NODE_ACCOUNT_MISMATCH", "custom_json.required_auths must be [nodeAccount]");
	}

	return [nodeAccount] as const;
}

function validateRequiredPostingAuths(value: unknown): readonly [] {
	if (!Array.isArray(value) || value.length !== 0) {
		throw createMultisigError("INVALID_TX_STRUCTURE", "custom_json.required_posting_auths must be an empty array");
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

	const byteLength = Buffer.byteLength(value, "utf8");
	if (byteLength > HIVE_CUSTOM_JSON_MAX_BYTES) {
		throw createMultisigError(
			"INVALID_PROTOCOL_PAYLOAD",
			`custom_json.json exceeds Hive limit: ${byteLength} > ${HIVE_CUSTOM_JSON_MAX_BYTES} bytes`,
		);
	}

	return value;
}

function parseProtocolPayload(json: string, protocolId: string): ParsedProtocolPayload {
	let parsed: unknown;
	try {
		parsed = JSON.parse(json, prototypePollutionReviver);
	} catch (cause) {
		throw createMultisigError("INVALID_PROTOCOL_PAYLOAD", "custom_json.json is not valid JSON", { cause });
	}

	if (!isRecord(parsed)) {
		throw createMultisigError("INVALID_PROTOCOL_PAYLOAD", "Parsed custom_json.json must be an object");
	}

	if (parsed.protocol !== protocolId) {
		throw createMultisigError(
			"INVALID_PROTOCOL_PAYLOAD",
			`Payload protocol must be '${protocolId}', got '${String(parsed.protocol)}'`,
		);
	}

	const version = validateProtocolVersion(parsed.version);

	if (typeof parsed.action !== "string") {
		throw createMultisigError("INVALID_PROTOCOL_PAYLOAD", "Payload action must be a string");
	}

	if (!isProtocolAction(parsed.action)) {
		throw createMultisigError("INVALID_PROTOCOL_PAYLOAD", `Unknown action: ${parsed.action}`);
	}

	if (!isRecord(parsed.data)) {
		throw createMultisigError("INVALID_PROTOCOL_PAYLOAD", "Payload must have a 'data' object");
	}

	return { protocol: protocolId, version, action: parsed.action, data: parsed.data };
}

function validateProtocolVersion(value: unknown): string {
	if (typeof value !== "string") {
		throw createMultisigError("INVALID_PROTOCOL_PAYLOAD", "Missing or invalid version");
	}

	if (!parseProtocolVersion(value)) {
		throw createMultisigError("INVALID_PROTOCOL_PAYLOAD", `Invalid version format: ${value}`);
	}

	if (compareVersions(value, MIN_PROTOCOL_VERSION) < 0) {
		throw createMultisigError("INVALID_PROTOCOL_PAYLOAD", `Version ${value} below minimum ${MIN_PROTOCOL_VERSION}`);
	}

	return value;
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
