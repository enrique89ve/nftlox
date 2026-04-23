import type { ProtocolAction, SupportedCurrency } from "./constants";
import {
	ACTION_ARCHIVE_COLLECTION,
	ACTION_BULK_DISTRIBUTE,
	ACTION_BUY,
	ACTION_BUY_COMMITMENT,
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
	BuyCommitmentData,
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
	| "NODE_NOT_ACTIVE"
	| "MISSING_BUYER_AUTH"
	| "MULTISIG_DISABLED"
	| "POW_REQUIRED"
	| "INVALID_POW"
	| "POW_EXPIRED"
	| "POW_REPLAYED"
	| "SIGNING_QUEUE_FULL"
	| "SIGNING_TIMEOUT"
	| "INDEXER_LAGGED"
	| "INTERNAL_ERROR"
	// buy_commitment flow — node-last settlement
	| "CROSS_NODE_RESERVATION"
	| "COMMITMENT_INCLUSION_TIMEOUT"
	| "COMMITMENT_BROADCAST_FAILED"
	| "BUYER_SIGNATURE_MISSING"
	| "INVALID_BUYER_SIGNATURE"
	| "BUY_BROADCAST_FAILED";

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

/**
 * Response shape for POST /api/multisig/buy under the node-last flow: the node
 * orchestrates commitment broadcast, waits for cross-node-race resolution via
 * Hive block ordering, signs the buyer-provided partially-signed transaction,
 * and broadcasts the completed buy transaction. Callers receive the Hive tx_id
 * of the settled buy transaction (or a typed error).
 */
export type BuyMultisigResponse =
	| {
			readonly ok: true;
			/** tx_id of the broadcasted buy transaction. */
			readonly txId: string;
			/** tx_id of the buy_commitment op the node used to reserve the NFT. */
			readonly commitmentOpTxId: string;
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
	readonly [ACTION_BUY_COMMITMENT]: BuyCommitmentData;
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
 * ASSERTION, not validation. Verifies only the `action` discriminator and
 * casts `data` to `PayloadDataByAction[A]` WITHOUT inspecting its fields.
 *
 * Callers MUST perform explicit runtime validation of `data` (Zod, manual
 * guards, or the DB-schema crosscheck a handler already does) before trusting
 * any field. The cast exists so handlers can chain type-narrowed lookups
 * after they have independently proven the payload is well-formed.
 *
 * Returns `null` when the action doesn't match (short-circuit for callers
 * that route multiple payload shapes through a single helper).
 *
 * Named `assumePayload` — not `narrowPayload` — to make the trust boundary
 * obvious at the call site: the function assumes; it does not verify.
 */
export function assumePayload<A extends ProtocolAction>(
	payload: ProtocolPayload<Record<string, unknown>>,
	action: A,
): TypedProtocolPayload<A> | null {
	if (payload.action !== action) return null;
	return payload as TypedProtocolPayload<A>;
}
