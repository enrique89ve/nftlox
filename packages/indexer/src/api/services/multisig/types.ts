import type { Queryable } from "@/db/client.ts";
import type { CollectionRulesRow } from "@/db/queries/collections.ts";
import type { NftProcessingRow } from "@/db/queries/nfts.ts";
import type { NftLockAcquireInput, NftLockAcquireResult } from "@/api/services/multisig-nft-lock.ts";
import {
	ACTION_BUY,
	ACTION_CREATE_COLLECTION,
	type MultisigResponse,
} from "@/protocol/index.ts";

export type SupportedMultisigAction = typeof ACTION_BUY | typeof ACTION_CREATE_COLLECTION;

export type ParsedAmount = Readonly<{
	readonly amount: number;
	readonly currency: "HIVE" | "HBD";
}>;

export type ValidatedTransferOp = Readonly<{
	readonly from: string;
	readonly to: string;
	readonly amount: string;
	readonly memo: string;
	readonly parsedAmount: ParsedAmount;
}>;

export type ValidatedBuyPayload = Readonly<{
	readonly action: typeof ACTION_BUY;
	readonly data: Readonly<{
		readonly nftId: string;
		readonly txId: string;
		readonly listingId: string;
		readonly listTxId: string;
	}>;
}>;

export type ValidatedCollectionPayload = Readonly<{
	readonly action: typeof ACTION_CREATE_COLLECTION;
	readonly data: Record<string, unknown>;
}>;

export type ValidatedPayload = ValidatedBuyPayload | ValidatedCollectionPayload;

export type ValidatedCustomJsonOp<Payload extends ValidatedPayload> = Readonly<{
	readonly required_auths: readonly [string];
	readonly required_posting_auths: readonly [];
	readonly id: string;
	readonly json: string;
	readonly payload: Payload;
}>;

export type ValidatedTransactionBase = Readonly<{
	readonly ref_block_num: number;
	readonly ref_block_prefix: number;
	readonly expiration: string;
	readonly transferOperations: ReadonlyArray<ValidatedTransferOp>;
	readonly extensions: ReadonlyArray<unknown>;
	readonly signatures: readonly [];
}>;

export type ValidatedBuyTransaction = ValidatedTransactionBase & Readonly<{
	readonly customJsonOperation: ValidatedCustomJsonOp<ValidatedBuyPayload>;
}>;

export type ValidatedCollectionTransaction = ValidatedTransactionBase & Readonly<{
	readonly customJsonOperation: ValidatedCustomJsonOp<ValidatedCollectionPayload>;
}>;

export type ValidatedTransaction = ValidatedBuyTransaction | ValidatedCollectionTransaction;

export type BuyRequestShape = Readonly<{
	readonly buyer: string;
	readonly nftId: string;
	readonly listingId: string;
	readonly listTxId: string;
	readonly transaction: Record<string, unknown>;
}>;

export type CollectionRequestShape = Readonly<{
	readonly transaction: Record<string, unknown>;
}>;

export type TransactionOperationInput = Readonly<{
	readonly name: string;
	readonly body: Record<string, unknown>;
}>;

export type MultisigRules = Pick<
	CollectionRulesRow,
	"id" | "creator" | "transferable" | "burnable" | "royalty_pct" | "royalty_recipient"
>;

export type NftStateResult = Readonly<{
	readonly nft: NftProcessingRow;
	readonly rules: MultisigRules;
	readonly nftTxId: string;
}>;

export type SignResult = Readonly<{
	readonly signature: string;
	readonly digest: string;
}>;

export type MultisigSign = (transaction: ValidatedTransaction) => Promise<MultisigResponse>;

export type CollectionLockAcquisition =
	| Readonly<{ readonly acquired: true }>
	| Readonly<{ readonly acquired: false; readonly heldBy: string; readonly retryAfterMs: number }>;

export type CollectionLockHandle = Readonly<{
	readonly acquire: (creator: string, symbol: string) => Promise<CollectionLockAcquisition>;
	readonly release: (creator: string, symbol: string) => Promise<void>;
}>;

// Buy path needs only the shared services; create-collection also needs the
// per-(creator,symbol) lock. Splitting the context type lets TypeScript reject
// any attempt to read collectionLock from the buy handler and lets the service
// layer skip UUID allocation for the buy dispatch.
export type MultisigBaseContext = Readonly<{
	readonly db: Queryable;
	readonly nodeAccount: string;
	readonly protocolId: string;
	readonly sign: MultisigSign;
}>;

export type MultisigCollectionContext = MultisigBaseContext & Readonly<{
	readonly collectionLock: CollectionLockHandle;
}>;

// NftLock handle exposed to the buy service. Acquisition happens AFTER all
// payload/state validation so an unvalidated body can't plant a lock — that
// was a DoS vector when acquisition ran at the route boundary.
export type NftLockHandle = Readonly<{
	readonly acquire: (input: NftLockAcquireInput) => Promise<NftLockAcquireResult>;
	readonly release: (nftId: string, buyer: string) => Promise<void>;
}>;

export type MultisigBuyContext = MultisigBaseContext & Readonly<{
	readonly nftLock: NftLockHandle;
	readonly lockExpirationMs: number;
	readonly lagMaxBlocks: number;
}>;
