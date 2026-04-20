import { getNftWithCollectionRules, NFT_KIND_INSTANCE, type NftProcessingRow } from "@/db/queries/nfts.ts";
import { createMultisigError } from "@/api/services/multisig/errors.ts";
import {
	extractTransfers,
	getLastOperation,
	parseBuyPayload,
	validateBuyRequestShape,
	validateCommonTransactionStructure,
	validateCustomJsonOperation,
	validateOperationCount,
	validateTransferOperations,
	validatePayloadDataString,
	validateNonEmptyString,
} from "@/api/services/multisig/transaction.ts";
import { validateHiveUsername, UNLIST_DELAY_BLOCKS } from "@/protocol/index.ts";
import { verifyTransfers, requireSupportedCurrency, type TransferRecord } from "@/utils/validation.ts";
import type { Queryable } from "@/db/client.ts";
import type {
	MultisigBaseContext,
	MultisigBuyContext,
	MultisigRules,
	NftStateResult,
	ValidatedBuyPayload,
	ValidatedBuyTransaction,
} from "./types.ts";

export async function processBuyRequest(
	rawBody: unknown,
	ctx: MultisigBuyContext,
) {
	const requestShape = validateBuyRequestShape(rawBody);
	const usernameError = validateHiveUsername(requestShape.buyer);
	if (usernameError) {
		throw createMultisigError("INVALID_TX_STRUCTURE", `Invalid buyer username: ${usernameError}`);
	}

	const request = {
		...requestShape,
		transaction: validateBuyTransactionStructure(
			requestShape.transaction,
			requestShape.buyer,
			ctx.nodeAccount,
			ctx.protocolId,
		),
	};

	// Lag gate: before signing, the indexer must be caught up to within
	// lagMaxBlocks of Hive's observed HEAD. Otherwise the NFT state we're
	// validating against is stale and the signing node could co-sign against
	// a listing that has since been unlisted/transferred/burned. Clients get
	// a 503 with retryAfterMs so the UX can back off gracefully.
	const syncState = await readSyncState(ctx.db);
	const lag = syncState.hiveHeadBlock - syncState.lastBlock;
	if (lag > ctx.lagMaxBlocks) {
		const retryAfterMs = estimateLagRetryMs(lag, ctx.lagMaxBlocks);
		throw createMultisigError(
			"INDEXER_LAGGED",
			`Indexer is ${lag} blocks behind Hive HEAD (max ${ctx.lagMaxBlocks}); retry in ~${retryAfterMs}ms`,
			{ retryAfterMs },
		);
	}

	const { nft, rules, nftTxId } = await validateNftState(request.nftId, request.buyer, ctx);
	if (nft.listing_id !== request.listingId) {
		throw createMultisigError("INVALID_PROTOCOL_PAYLOAD", "listingId does not match current listing");
	}
	if (nft.listing_tx_id !== request.listTxId) {
		throw createMultisigError("INVALID_PROTOCOL_PAYLOAD", "listTxId does not match current listing");
	}

	// If the seller has already broadcast `unlist`, the NFT keeps status='listed'
	// during UNLIST_DELAY_BLOCKS but a fresh buy signed now would likely land
	// past the deadline and be rejected by the indexer. Refuse to sign unless
	// the deadline is at least one block past the assumed landing block
	// (hive_head_block + 1, conservative).
	if (nft.pending_unlist_block !== null) {
		const deadline = nft.pending_unlist_block + UNLIST_DELAY_BLOCKS;
		const assumedLanding = syncState.hiveHeadBlock + 1;
		if (assumedLanding > deadline) {
			throw createMultisigError(
				"NFT_NOT_LISTED",
				`NFT ${request.nftId} has a pending unlist (block ${nft.pending_unlist_block}); ` +
					`deadline ${deadline} is past assumed landing ${assumedLanding}`,
			);
		}
	}

	validateBuyPayloadData(
		request.transaction.customJsonOperation.payload,
		request.nftId,
		nftTxId,
		request.listingId,
		request.listTxId,
	);

	validatePaymentSplit(
		extractTransfers(request.transaction.transferOperations),
		nft,
		request.nftId,
		rules,
		ctx.nodeAccount,
	);

	// Per-NFT lock lives for MULTISIG_EXPIRATION_MS and is consulted by the
	// indexer's transfer/transfer_from/unlist/burn/lend handlers. While a
	// matching lock exists those actions are rejected; only the matching buy
	// (same listing_id + list_tx_id) consumes it on landing. Deliberately
	// acquired AFTER all validation so an unvalidated body can never pin
	// arbitrary NFTs — the earlier route-level acquisition was a DoS vector.
	const lockResult = await ctx.nftLock.acquire({
		nftId: request.nftId,
		buyer: request.buyer,
		listingId: request.listingId,
		listTxId: request.listTxId,
		snapshotBlock: syncState.lastBlock,
		expirationMs: ctx.lockExpirationMs,
	});
	if (!lockResult.acquired) {
		throw createMultisigError(
			"NFT_LOCKED",
			`NFT ${request.nftId} is being purchased by '${lockResult.heldBy}'. Retry after ${lockResult.retryAfterMs}ms`,
			{ retryAfterMs: lockResult.retryAfterMs },
		);
	}

	try {
		const response = await ctx.sign(request.transaction);
		if (!response.ok) {
			// Sign failed: release so another buyer can retry immediately.
			// On success we let the lock expire naturally to protect the
			// signed tx's broadcast window.
			await ctx.nftLock.release(request.nftId, request.buyer);
		}
		return response;
	} catch (err) {
		await ctx.nftLock.release(request.nftId, request.buyer);
		throw err;
	}
}

type SyncStateSnapshot = Readonly<{ readonly lastBlock: number; readonly hiveHeadBlock: number }>;

async function readSyncState(db: Queryable): Promise<SyncStateSnapshot> {
	const [row] = await db`SELECT last_block, hive_head_block FROM sync_state WHERE id = 1`;
	if (!row) {
		throw createMultisigError("INTERNAL_ERROR", "sync_state row missing — indexer not initialized");
	}
	const lastBlock = Number(row.last_block);
	const hiveHeadBlock = Number(row.hive_head_block);
	if (!Number.isFinite(lastBlock) || !Number.isFinite(hiveHeadBlock)) {
		throw createMultisigError("INTERNAL_ERROR", "sync_state row has invalid block numbers");
	}
	return { lastBlock, hiveHeadBlock };
}

// Hive block time is 3s. Back-pressure the client long enough that the
// indexer can catch up (overshoot the deficit by one block) so a naive
// retry loop converges rather than hammering the API.
const HIVE_BLOCK_TIME_MS = 3000;
function estimateLagRetryMs(lag: number, lagMaxBlocks: number): number {
	const deficit = Math.max(1, lag - lagMaxBlocks + 1);
	return deficit * HIVE_BLOCK_TIME_MS;
}

function validateBuyTransactionStructure(
	tx: Record<string, unknown>,
	buyer: string,
	nodeAccount: string,
	protocolId: string,
): ValidatedBuyTransaction {
	const validated = validateCommonTransactionStructure(tx);
	validateOperationCount(validated.operations);

	return {
		...validated,
		transferOperations: validateTransferOperations(validated.operations.slice(0, -1), buyer),
		customJsonOperation: validateCustomJsonOperation(
			getLastOperation(validated.operations),
			nodeAccount,
			protocolId,
			parseBuyPayload,
		),
	};
}

function validateBuyPayloadData(
	payload: ValidatedBuyPayload,
	expectedNftId: string,
	expectedTxId: string,
	expectedListingId: string,
	expectedListTxId: string,
): void {
	validateNonEmptyString(payload.data.nftId, "Payload data.nftId must be a non-empty string");
	validatePayloadDataString(payload.data.txId, "txId");

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

async function validateNftState(
	nftId: string,
	buyer: string,
	ctx: MultisigBaseContext,
): Promise<NftStateResult> {
	// Plain read — no FOR UPDATE. Concurrency between buyer requests is
	// serialized by ctx.nftLock in processBuyRequest; concurrent non-multisig
	// mutations (direct unlist/transfer broadcast to Hive by the seller) are
	// irreducible and handled post-hoc via orphaned_buys.
	const nftWithRules = await getNftWithCollectionRules(nftId, ctx.db);
	if (!nftWithRules) {
		throw createMultisigError("NFT_NOT_FOUND", `NFT '${nftId}' not found`);
	}

	if (nftWithRules.status !== "listed") {
		throw createMultisigError("NFT_NOT_LISTED", "NFT is not currently listed for sale");
	}

	if (nftWithRules.listing_expires_at) {
		const expiresAt = new Date(nftWithRules.listing_expires_at).getTime();
		if (Date.now() >= expiresAt) {
			throw createMultisigError("NFT_EXPIRED_LISTING", "Listing has expired");
		}
	}

	if (nftWithRules.nft_type !== NFT_KIND_INSTANCE) {
		throw createMultisigError("NFT_NOT_INSTANCE", "Only instances can be bought through marketplace");
	}

	if (buyer === nftWithRules.owner) {
		throw createMultisigError("CANNOT_BUY_OWN", "Buyer cannot purchase their own NFT");
	}

	if (!nftWithRules.transferable) {
		throw createMultisigError("NFT_NOT_TRANSFERABLE", "NFT cannot be transferred");
	}

	const nft: NftProcessingRow = nftWithRules;
	const rules = {
		id: nftWithRules.collection_id,
		creator: nftWithRules.creator,
		transferable: nftWithRules.transferable,
		burnable: nftWithRules.burnable,
		royalty_pct: nftWithRules.royalty_pct,
		royalty_recipient: nftWithRules.royalty_recipient,
	} satisfies MultisigRules;

	return { nft, rules, nftTxId: nftWithRules.created_tx_id };
}

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

	const totalPrice = Number(nft.listing_price);
	if (Number.isNaN(totalPrice) || totalPrice <= 0) {
		throw createMultisigError("INTERNAL_ERROR", "NFT listing price is invalid");
	}

	const royaltyPct = Number(rules.royalty_pct);
	if (Number.isNaN(royaltyPct) || royaltyPct < 0 || royaltyPct > 50) {
		throw createMultisigError("INTERNAL_ERROR", "Collection royalty_pct is invalid");
	}

	try {
		// buyer is derived by verifyTransfers from the unique seller-leg
		// transfer (memo-bound + amount-bound), so no positional read is
		// needed here. The multisig path consumes `buyerFromTransfer` below
		// only for the count check; downstream authorization of the buy is
		// enforced by required_posting_auths in validateMultisigBuyRequest.
		const { split } = verifyTransfers({
			transfers,
			seller: nft.owner,
			totalPrice,
			currency: requireSupportedCurrency(nft.listing_currency, "listing_currency"),
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
	} catch (cause) {
		throw createMultisigError(
			"INVALID_PAYMENT_SPLIT",
			cause instanceof Error ? cause.message : "Payment split verification failed",
			{ cause },
		);
	}
}
