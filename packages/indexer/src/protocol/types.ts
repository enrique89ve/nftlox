// NFTLox Protocol Types used by the indexer.

import type { ProtocolAction, SupportedCurrency } from "./constants.ts";

// ============ VALIDATION ============

export interface ValidationError {
	field: string;
	message: string;
	code: string;
}

// ============ SCHEMA TYPES ============

export type SchemaFieldType =
	| "string" | "bool"
	| "uint8" | "uint16" | "uint32" | "uint64"
	| "int8" | "int16" | "int32" | "int64"
	| "float" | "double"
	| "string[]" | "bool[]"
	| "uint8[]" | "uint16[]" | "uint32[]" | "uint64[]"
	| "int8[]" | "int16[]" | "int32[]" | "int64[]"
	| "float[]" | "double[]";

export type SchemaField = {
	readonly name: string;
	readonly type: SchemaFieldType;
};

export type CollectionSchema = {
	readonly immutable: readonly SchemaField[];
	readonly mutable: readonly SchemaField[];
};

// ============ PAYMENT SPLIT ============

export interface PaymentSplit {
	sellerAmount: number;
	royaltyAmount: number;
	royaltyRecipient: string | null;
	feeAmount: number;
	feeAccount: string;
	totalPrice: number;
	currency: string;
}

// ============ PRICE TYPE ============

export interface Price {
	amount: string;
	currency: SupportedCurrency;
}

// ============ HIVE OPERATION TYPES ============

export type HiveTransactionObject = Readonly<{
	ref_block_num: number;
	ref_block_prefix: number;
	expiration: string;
	operations: ReadonlyArray<readonly [string, Record<string, unknown>]>;
	extensions: ReadonlyArray<unknown>;
	signatures: ReadonlyArray<string>;
}>;

export type ValidatedTransaction = Readonly<{
	ref_block_num: number;
	ref_block_prefix: number;
	expiration: string;
	transferOperations: ReadonlyArray<Readonly<{
		from: string;
		to: string;
		amount: string;
		memo: string;
		parsedAmount: Readonly<{
			amount: number;
			currency: string;
		}>;
	}>>;
	customJsonOperation: Readonly<{
		required_auths: readonly [string];
		required_posting_auths: readonly [];
		id: string;
		json: string;
		payload: Readonly<{
			action: "buy";
			data: Readonly<{
				nftId: string;
				txId: string;
				listingId: string;
				listTxId: string;
			}>;
		}>;
	}>;
	extensions: ReadonlyArray<unknown>;
	signatures: readonly [];
}>;

export type MultisigErrorCode =
	| "NFT_LOCKED"
	| "RATE_LIMITED"
	| "INVALID_TX_STRUCTURE"
	| "NFT_NOT_FOUND"
	| "NFT_NOT_LISTED"
	| "NFT_NOT_INSTANCE"
	| "NFT_NOT_TRANSFERABLE"
	| "NFT_EXPIRED_LISTING"
	| "CANNOT_BUY_OWN"
	| "SEED_HAS_INSTANCES"
	| "INVALID_PAYMENT_SPLIT"
	| "INVALID_PROTOCOL_PAYLOAD"
	| "NODE_ACCOUNT_MISMATCH"
	| "MISSING_BUYER_AUTH"
	| "MULTISIG_DISABLED"
	| "POW_REQUIRED"
	| "INVALID_POW"
	| "POW_EXPIRED"
	| "POW_REPLAYED"
	| "SIGNING_QUEUE_FULL"
	| "SIGNING_TIMEOUT"
	| "INTERNAL_ERROR";

export type MultisigResponse =
	| Readonly<{ ok: true; signature: string; digest: string; expiration: string }>
	| Readonly<{ ok: false; code: MultisigErrorCode; message: string }>;

// ============ PROTOCOL PAYLOAD ============

export interface ProtocolPayload<T = unknown> {
	readonly protocol: string;
	readonly version: string;
	readonly action: ProtocolAction;
	readonly data: T;
}
