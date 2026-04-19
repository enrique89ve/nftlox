import type { ProtocolAction, SupportedCurrency } from "./constants";
import {
	ACTION_ARCHIVE_COLLECTION,
	ACTION_BULK_DISTRIBUTE,
	ACTION_BUY,
	ACTION_CREATE_COLLECTION,
	ACTION_DATA_OPERATOR_APPROVE,
	ACTION_EXTEND_SCHEMA,
	ACTION_LIST,
	ACTION_MINT,
	ACTION_NFT_APPROVE,
	ACTION_NFT_APPROVE_ALL,
	ACTION_NFT_LEND,
	ACTION_NFT_RETURN,
	ACTION_NFT_TRANSFER_FROM,
	ACTION_NODE_HEARTBEAT,
	ACTION_NODE_REGISTER,
	ACTION_SET_DATA,
	ACTION_SET_DATA_FROM,
	ACTION_TRANSFER,
	ACTION_UNLIST,
} from "./constants";
import type {
	ArchiveCollectionData,
	BulkDistributeData,
	BuyData,
	CollectionData,
	DataOperatorApproveData,
	ExtendSchemaData,
	ListingData,
	NFTData,
	NftApproveAllData,
	NftApproveData,
	NftLendData,
	NftReturnData,
	NftTransferFromData,
	NodeHeartbeatData,
	NodeRegisterData,
	SetDataData,
	SetDataFromData,
	TransferData,
	UnlistData,
} from "./action-data";

// Validation

export type ValidationError = {
	readonly field: string;
	readonly message: string;
	readonly code: string;
};

// Schema Types

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

// Price

export type Price = {
	readonly amount: string;
	readonly currency: SupportedCurrency;
};

// Payment Split

export type PaymentSplit = {
	readonly sellerAmount: number;
	readonly royaltyAmount: number;
	readonly royaltyRecipient: string | null;
	readonly feeAmount: number;
	readonly feeAccount: string;
	readonly totalPrice: number;
	readonly currency: SupportedCurrency;
};

// Seed Provenance

export type SeedProvenance = {
	readonly seedId?: string | undefined;
	readonly seedTxId?: string | undefined;
};

// Hive Operation Types

export type HiveCustomJsonBody = {
	readonly required_auths: readonly string[];
	readonly required_posting_auths: readonly string[];
	readonly id: string;
	readonly json: string;
};

export type HiveOperation = readonly ["custom_json", HiveCustomJsonBody];

export type HiveTransferBody = {
	readonly from: string;
	readonly to: string;
	readonly amount: string;
	readonly memo: string;
};

export type HiveTransferOperation = readonly ["transfer", HiveTransferBody];

export type HiveTransactionObject = {
	readonly ref_block_num: number;
	readonly ref_block_prefix: number;
	readonly expiration: string;
	readonly operations: ReadonlyArray<readonly [string, Record<string, unknown>]>;
	readonly extensions: ReadonlyArray<unknown>;
	readonly signatures: ReadonlyArray<string>;
};

// Protocol Payload

export type ProtocolPayload<T = unknown> = {
	readonly protocol: string;
	readonly version: string;
	readonly action: ProtocolAction;
	readonly data: T;
};

// Multisig Types

export type MultisigErrorCode =
	| "NFT_LOCKED"
	| "COLLECTION_LOCKED"
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
	| "INDEXER_LAGGED"
	| "INTERNAL_ERROR";

export type MultisigResponse =
	| {
			readonly ok: true;
			readonly signature: string;
			readonly digest: string;
			readonly expiration: string;
	  }
	| {
			readonly ok: false;
			readonly code: MultisigErrorCode;
			readonly message: string;
			readonly retryAfterMs?: number | undefined;
	  };

// Discriminated payload form — correlates `action` with `data` at the type level.

export type PayloadDataByAction = {
	readonly [ACTION_CREATE_COLLECTION]: CollectionData;
	readonly [ACTION_MINT]: NFTData;
	readonly [ACTION_BULK_DISTRIBUTE]: BulkDistributeData;
	readonly [ACTION_TRANSFER]: TransferData;
	readonly [ACTION_SET_DATA]: SetDataData;
	readonly [ACTION_EXTEND_SCHEMA]: ExtendSchemaData;
	readonly [ACTION_ARCHIVE_COLLECTION]: ArchiveCollectionData;
	readonly [ACTION_NODE_REGISTER]: NodeRegisterData;
	readonly [ACTION_NODE_HEARTBEAT]: NodeHeartbeatData;
	readonly [ACTION_LIST]: ListingData;
	readonly [ACTION_UNLIST]: UnlistData;
	readonly [ACTION_BUY]: BuyData;
	readonly [ACTION_NFT_APPROVE]: NftApproveData;
	readonly [ACTION_NFT_APPROVE_ALL]: NftApproveAllData;
	readonly [ACTION_NFT_TRANSFER_FROM]: NftTransferFromData;
	readonly [ACTION_DATA_OPERATOR_APPROVE]: DataOperatorApproveData;
	readonly [ACTION_SET_DATA_FROM]: SetDataFromData;
	readonly [ACTION_NFT_LEND]: NftLendData;
	readonly [ACTION_NFT_RETURN]: NftReturnData;
};

export type TypedProtocolPayload<A extends ProtocolAction = ProtocolAction> = {
	readonly [K in A]: {
		readonly protocol: string;
		readonly version: string;
		readonly action: K;
		readonly data: PayloadDataByAction[K];
	};
}[A];

/**
 * Runtime narrowing. Returns the payload typed as
 * `TypedProtocolPayload<A>` when `payload.action === action`, else `null`.
 * Handlers can opt into the stronger typing without changing their body —
 * the function only closes the `data: unknown` gap in the type system,
 * runtime field validation still required.
 */
export function narrowPayload<A extends ProtocolAction>(
	payload: ProtocolPayload<Record<string, unknown>>,
	action: A,
): TypedProtocolPayload<A> | null {
	if (payload.action !== action) return null;
	return payload as TypedProtocolPayload<A>;
}
