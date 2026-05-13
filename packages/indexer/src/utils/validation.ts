/**
 * Runtime validation helpers for extracting typed values from unknown data.
 * Replaces blind `as` casts with fail-fast runtime checks at system boundaries.
 */

import {
	calculatePaymentSplit,
	validateHiveUsername,
	SYMBOL_REGEX,
	MEMO_PREFIX_BUY,
	MEMO_PREFIX_ROYALTY,
	MEMO_PREFIX_FEE,
	SUPPORTED_CURRENCIES,
	type PaymentSplit,
	type SupportedCurrency,
	type CollectionSchema,
	type SchemaField,
	type SchemaFieldType,
} from "@/protocol/index.ts";
import type { TransferDetail } from "@/scanner/operation-parser.ts";

// ============ TRANSFER VERIFICATION (source-agnostic) ============

const SUPPORTED_CURRENCIES_SET = new Set<string>(SUPPORTED_CURRENCIES);

export function requireSupportedCurrency(
	value: unknown,
	fieldName: string = "currency",
): SupportedCurrency {
	if (typeof value !== "string") {
		throw new Error(`${fieldName} must be a string, got ${typeof value}`);
	}
	const upper = value.toUpperCase();
	if (!SUPPORTED_CURRENCIES_SET.has(upper)) {
		throw new Error(
			`${fieldName} must be one of ${SUPPORTED_CURRENCIES.join(", ")}, got "${value}"`,
		);
	}
	return upper as SupportedCurrency;
}

export interface VerifyTransfersParams {
	transfers: ReadonlyArray<TransferDetail>;
	seller: string;
	totalPrice: number;
	currency: SupportedCurrency;
	royaltyPct: number;
	royaltyRecipient: string | null;
	feeAccount: string;
	nftId: string;
	consumedIndices?: ReadonlySet<number>;
}

/**
 * Verify that a set of transfers satisfies the payment split.
 * Source-agnostic: works with pairedTransfers, getTransfersInTransaction, or any transfer array.
 * Reusable for multisig pre-signing verification.
 *
 * `planVerifiedTransfers` is pure: it only returns the matching indices.
 * `verifyTransfers` wraps it and, when passed a mutable TransferPool `Set`,
 * commits those indices after ALL expected transfers are found. That prevents
 * a partial failed verification from dirtying the pool for the next operation
 * in the same Hive tx.
 */
export interface VerifyTransfersResult {
	readonly split: PaymentSplit;
	/**
	 * The `from` of the seller-leg transfer — the canonical buyer identity
	 * derived from the memo-bound transfer, replacing positional
	 * `pairedTransfers[0]?.from` access in the buy handler.
	 */
	readonly buyerFromTransfer: string;
	readonly consumedIndices: readonly number[];
}

function findUniqueTransferIndex(params: {
	readonly transfers: ReadonlyArray<TransferDetail>;
	readonly consumedIndices: ReadonlySet<number> | undefined;
	readonly staged: ReadonlySet<number>;
	readonly predicate: (transfer: TransferDetail) => boolean;
	readonly missingMessage: string;
	readonly ambiguousMessage: (count: number) => string;
}): number {
	const {
		transfers,
		consumedIndices,
		staged,
		predicate,
		missingMessage,
		ambiguousMessage,
	} = params;
	const candidates: number[] = [];

	for (let idx = 0; idx < transfers.length; idx++) {
		const transfer = transfers[idx];
		if (!transfer) continue;
		if (consumedIndices?.has(idx)) continue;
		if (staged.has(idx)) continue;
		if (!predicate(transfer)) continue;
		candidates.push(idx);
	}

	if (candidates.length === 0) {
		throw new Error(missingMessage);
	}
	if (candidates.length > 1) {
		throw new Error(ambiguousMessage(candidates.length));
	}

	return candidates[0]!;
}

export function planVerifiedTransfers(params: VerifyTransfersParams): VerifyTransfersResult {
	const { transfers, seller, totalPrice, currency, royaltyPct, royaltyRecipient, feeAccount, nftId, consumedIndices } = params;

	if (transfers.length === 0) {
		throw new Error("No transfers found. Payment split is required.");
	}

	const split = calculatePaymentSplit(totalPrice, currency, royaltyPct, royaltyRecipient, seller, feeAccount);

	const AMOUNT_TOLERANCE = 0.0005;
	const sellerMemo = `${MEMO_PREFIX_BUY}${nftId}`;

	// Seller leg uniquely identifies the buyer. Match by (to, amount, currency,
	// memo) WITHOUT a `from` filter — the `from` is exactly what we're trying
	// to discover. Ambiguity only applies when MORE THAN ONE transfer satisfies
	// the full predicate; a same-memo transfer that fails on amount/to/currency
	// no longer causes a false rejection.
	if (split.sellerAmount <= 0) {
		throw new Error(
			`verifyTransfers: non-positive seller payment (${split.sellerAmount}) — invalid listing`,
		);
	}

	const staged = new Set<number>();
	const sellerLegIdx = findUniqueTransferIndex({
		transfers,
		consumedIndices,
		staged,
		predicate: (transfer) =>
			transfer.to === seller &&
			transfer.currency === currency &&
			transfer.memo === sellerMemo &&
			Math.abs(transfer.amount - split.sellerAmount) < AMOUNT_TOLERANCE,
		missingMessage:
			`Missing seller payment: expected ${split.sellerAmount} ${currency} to @${seller} with memo '${sellerMemo}'`,
		ambiguousMessage: (count) =>
			`Ambiguous seller payment: ${count} transfers match (to @${seller}, ${split.sellerAmount} ${currency}, memo '${sellerMemo}')`,
	});
	staged.add(sellerLegIdx);
	const buyerFromTransfer = transfers[sellerLegIdx]!.from;

	const stagedIndices = [sellerLegIdx];

	function expectBuyerTransfer(to: string, expectedAmount: number, label: string, expectedMemo: string): void {
		const matchIndex = findUniqueTransferIndex({
			transfers,
			consumedIndices,
			staged,
			predicate: (transfer) =>
				transfer.from === buyerFromTransfer &&
				transfer.to === to &&
				transfer.currency === currency &&
				Math.abs(transfer.amount - expectedAmount) < AMOUNT_TOLERANCE &&
				transfer.memo === expectedMemo,
			missingMessage:
				`Missing ${label}: expected ${expectedAmount} ${currency} from @${buyerFromTransfer} to @${to} with memo '${expectedMemo}'`,
			ambiguousMessage: (count) =>
				`Ambiguous ${label}: ${count} transfers match (from @${buyerFromTransfer}, to @${to}, ${expectedAmount} ${currency}, memo '${expectedMemo}')`,
		});
		staged.add(matchIndex);
		stagedIndices.push(matchIndex);
	}

	if (split.royaltyAmount > 0 && split.royaltyRecipient) {
		expectBuyerTransfer(split.royaltyRecipient, split.royaltyAmount, "royalty payment", `${MEMO_PREFIX_ROYALTY}${nftId}`);
	}

	if (split.feeAmount > 0) {
		expectBuyerTransfer(split.feeAccount, split.feeAmount, "protocol fee", `${MEMO_PREFIX_FEE}${nftId}`);
	}

	return { split, buyerFromTransfer, consumedIndices: stagedIndices };
}

export function verifyTransfers(params: VerifyTransfersParams): VerifyTransfersResult {
	const result = planVerifiedTransfers(params);

	// Atomic commit: all expected matches succeeded, now publish to the shared pool.
	if (params.consumedIndices instanceof Set) {
		for (const idx of result.consumedIndices) params.consumedIndices.add(idx);
	}

	return result;
}

export function requireString(value: unknown, fieldName: string): string {
	if (typeof value !== "string" || value === "") {
		throw new Error(`Missing or invalid ${fieldName}: expected non-empty string`);
	}
	return value;
}

export function requireSymbol(value: unknown, fieldName: string): string {
	const str = requireString(value, fieldName);
	if (!SYMBOL_REGEX.test(str)) {
		throw new Error(
			`Invalid ${fieldName}: "${str}" must be 3-10 uppercase chars, start with letter (e.g. "CARD", "NFT01")`,
		);
	}
	return str;
}

export function requireBoundedString(value: unknown, fieldName: string, maxLength: number): string {
	const str = requireString(value, fieldName);
	if (str.length > maxLength) {
		throw new Error(`${fieldName} exceeds max length: ${str.length} > ${maxLength}`);
	}
	return str;
}

// Exact-length variant — mirrors validateExactLengthPayloadString in the
// multisig path. Use for fields whose protocol contract is a fixed length
// (DNA, hashes, access keys). Sibling requireBoundedString only enforces an
// upper bound, which is easy to misread when paired with a *_LENGTH constant.
export function requireExactLengthString(value: unknown, fieldName: string, length: number): string {
	const str = requireString(value, fieldName);
	if (str.length !== length) {
		throw new Error(`${fieldName} must be exactly ${length} characters, got ${str.length}`);
	}
	return str;
}

export function requireUsername(value: unknown, fieldName: string): string {
	const str = requireString(value, fieldName);
	const error = validateHiveUsername(str);
	if (error) {
		throw new Error(`Invalid Hive username for ${fieldName} ("${str}"): ${error}`);
	}
	return str;
}

/**
 * Validates a username only when a value is present. Use this for fields where
 * absence is legal (e.g. royaltyRecipient when royaltyPct === 0) but a garbage
 * string must be rejected. Returns null for undefined/null/empty input so the
 * caller can treat "no recipient" uniformly.
 */
export function optionalUsername(value: unknown, fieldName: string): string | null {
	if (value === undefined || value === null || value === "") return null;
	if (typeof value !== "string") {
		throw new Error(`Invalid ${fieldName}: expected string username, got ${typeof value}`);
	}
	const error = validateHiveUsername(value);
	if (error) {
		throw new Error(`Invalid Hive username for ${fieldName} ("${value}"): ${error}`);
	}
	return value;
}

const HIVE_DECIMAL_REGEX = /^(0|[1-9]\d*)\.\d{3}$/;

type HiveCurrency = "HIVE" | "HBD";

const SCHEMA_FIELD_TYPE_LOOKUP: Readonly<Record<SchemaFieldType, true>> = {
	string: true,
	bool: true,
	uint8: true,
	uint16: true,
	uint32: true,
	uint64: true,
	int8: true,
	int16: true,
	int32: true,
	int64: true,
	float: true,
	double: true,
	"string[]": true,
	"bool[]": true,
	"uint8[]": true,
	"uint16[]": true,
	"uint32[]": true,
	"uint64[]": true,
	"int8[]": true,
	"int16[]": true,
	"int32[]": true,
	"int64[]": true,
	"float[]": true,
	"double[]": true,
};

export function requireHiveAmount(value: unknown, fieldName: string): { amount: string; currency: HiveCurrency } {
	const price = requirePrice(value, fieldName);
	if (!HIVE_DECIMAL_REGEX.test(price.amount)) {
		throw new Error(`Invalid Hive decimal format for ${fieldName}.amount: "${price.amount}" (expected 3 decimal places, e.g. "1.000")`);
	}
	const currency = price.currency.toUpperCase();
	if (currency !== "HIVE" && currency !== "HBD") {
		throw new Error(`Invalid currency for ${fieldName}: "${price.currency}" (expected "HIVE" or "HBD")`);
	}
	return { amount: price.amount, currency };
}

export function requireNumber(value: unknown, fieldName: string): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new Error(`Missing or invalid ${fieldName}: expected finite number`);
	}
	return value;
}

export function requirePositiveInt(value: unknown, fieldName: string): number {
	const n = requireNumber(value, fieldName);
	if (!Number.isInteger(n) || n < 1) {
		throw new Error(`${fieldName} must be a positive integer, got ${n}`);
	}
	return n;
}

export function requireNonNegativeInt(value: unknown, fieldName: string): number {
	if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
		throw new Error(`Missing or invalid '${fieldName}' parameter: expected non-negative integer`);
	}
	return value;
}

export function optionalString(value: unknown): string | null {
	if (value === undefined || value === null) return null;
	if (typeof value !== "string") return null;
	return value;
}

export function optionalBoundedString(value: unknown, fieldName: string, maxLength: number): string | null {
	const str = optionalString(value);
	if (str && str.length > maxLength) {
		throw new Error(`${fieldName} exceeds max length: ${str.length} > ${maxLength}`);
	}
	return str;
}

export function optionalNumber(value: unknown, fallback?: number): number | null {
	if (value === undefined || value === null) return fallback ?? null;
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback ?? null;
	return value;
}

export function optionalBoolean(value: unknown, fallback: boolean): boolean {
	if (typeof value === "boolean") return value;
	return fallback;
}

export function requireObject(value: unknown, fieldName: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`Missing or invalid ${fieldName}: expected object`);
	}
	return value as Record<string, unknown>;
}

export function optionalObject(value: unknown): Record<string, unknown> | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	return value as Record<string, unknown>;
}

export function requireBoolean(value: unknown, fieldName: string): boolean {
	if (typeof value !== "boolean") {
		throw new Error(`Missing or invalid ${fieldName}: expected boolean`);
	}
	return value;
}

export function requireArray(value: unknown, fieldName: string): unknown[] {
	if (!Array.isArray(value)) {
		throw new Error(`Missing or invalid ${fieldName}: expected array`);
	}
	return value;
}

export function requireBoundedArray(value: unknown, fieldName: string, maxLength: number): unknown[] {
	const arr = requireArray(value, fieldName);
	if (arr.length === 0) {
		throw new Error(`${fieldName} cannot be empty`);
	}
	if (arr.length > maxLength) {
		throw new Error(`${fieldName} exceeds maximum length: ${arr.length} > ${maxLength}`);
	}
	return arr;
}

export function requirePrice(value: unknown, fieldName: string): { amount: string; currency: string } {
	const obj = requireObject(value, fieldName);
	return {
		amount: requireString(obj.amount, `${fieldName}.amount`),
		currency: requireString(obj.currency, `${fieldName}.currency`),
	};
}

function isSchemaFieldType(value: string): value is SchemaFieldType {
	return value in SCHEMA_FIELD_TYPE_LOOKUP;
}

function requireSchemaFieldType(value: unknown, fieldName: string): SchemaFieldType {
	const fieldType = requireString(value, fieldName);
	if (!isSchemaFieldType(fieldType)) {
		throw new Error(`Invalid ${fieldName}: "${fieldType}" is not a supported schema field type`);
	}
	return fieldType;
}

export function requireSchemaField(value: unknown, fieldName: string): SchemaField {
	const field = requireObject(value, fieldName);
	return {
		name: requireString(field.name, `${fieldName}.name`),
		type: requireSchemaFieldType(field.type, `${fieldName}.type`),
	};
}

export function requireSchemaFieldArray(value: unknown, fieldName: string): SchemaField[] {
	const fields = requireArray(value, fieldName);
	return fields.map((field, index) => requireSchemaField(field, `${fieldName}[${index}]`));
}

export function optionalSchemaFieldArray(
	value: unknown,
	fieldName: string,
): SchemaField[] | undefined {
	if (value === undefined) {
		return undefined;
	}
	return requireSchemaFieldArray(value, fieldName);
}

export function optionalCollectionSchema(value: unknown): CollectionSchema | null {
	if (value === undefined || value === null) {
		return null;
	}

	const schema = requireObject(value, "schema");

	return {
		immutable: requireSchemaFieldArray(schema.immutable, "schema.immutable"),
		mutable: requireSchemaFieldArray(schema.mutable, "schema.mutable"),
	};
}

export function collectionSchemaToRecord(schema: CollectionSchema): Record<string, unknown> {
	return {
		immutable: schema.immutable.map((field) => ({
			name: field.name,
			type: field.type,
		})),
		mutable: schema.mutable.map((field) => ({
			name: field.name,
			type: field.type,
		})),
	};
}
