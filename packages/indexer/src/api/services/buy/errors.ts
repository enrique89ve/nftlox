// Buy-flow error model. Mirrors the shape of MultisigErrorCode but scoped to
// the /api/buy endpoint's state machine (pre-tx1 validation, tx1 broadcast,
// tx1 inclusion wait, tx2 cosign/broadcast). Distinct from multisig errors
// because the new flow has no multisig semantics — only tx1 (node posting)
// and tx2 (buyer-active + node-active) exist.

export type BuyErrorCode =
	| "NFT_NOT_FOUND"
	| "NFT_NOT_LISTED"
	| "NFT_NOT_INSTANCE"
	| "NFT_NOT_TRANSFERABLE"
	| "NFT_EXPIRED_LISTING"
	| "CANNOT_BUY_OWN"
	| "LISTING_MISMATCH"
	| "INVALID_PRESIGNED_TX2"
	| "INVALID_PAYMENT_SPLIT"
	| "INVALID_PROTOCOL_PAYLOAD"
	| "NODE_ACCOUNT_MISMATCH"
	| "NODE_NOT_ACTIVE"
	| "MISSING_BUYER_SIGNATURE"
	| "RATE_LIMITED"
	| "INDEXER_LAGGED"
	| "TOO_MANY_ACTIVE_LOCKS"
	| "POSTING_SIGNER_UNAVAILABLE"
	| "ACTIVE_SIGNER_UNAVAILABLE"
	| "TX1_BROADCAST_FAILED"
	| "TX1_REJECTED"
	| "TX1_INCLUSION_TIMEOUT"
	| "TX2_BROADCAST_FAILED"
	| "INTERNAL_ERROR";

export type BuyErrorOptions = Readonly<{
	readonly cause?: unknown;
	readonly retryAfterMs?: number;
}>;

export class BuyError extends Error {
	readonly code: BuyErrorCode;
	readonly retryAfterMs?: number;

	constructor(code: BuyErrorCode, message: string, options?: BuyErrorOptions) {
		super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
		this.name = "BuyError";
		this.code = code;
		if (options?.retryAfterMs !== undefined) {
			this.retryAfterMs = options.retryAfterMs;
		}
	}
}

export function createBuyError(
	code: BuyErrorCode,
	message: string,
	options?: BuyErrorOptions,
): BuyError {
	return new BuyError(code, message, options);
}

export function isBuyError(err: unknown): err is BuyError {
	return err instanceof BuyError;
}
