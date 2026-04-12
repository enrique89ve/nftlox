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
import { validateHiveUsername } from "@/protocol/index.ts";
import { verifyTransfers, type TransferRecord } from "@/utils/validation.ts";
import type {
	MultisigProcessContext,
	MultisigRules,
	NftStateResult,
	ValidatedBuyPayload,
	ValidatedBuyTransaction,
} from "./types.ts";

export async function processBuyRequest(
	rawBody: unknown,
	ctx: MultisigProcessContext,
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

	const { nft, rules, nftTxId } = await validateNftState(request.nftId, request.buyer, ctx);
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

	validatePaymentSplit(
		extractTransfers(request.transaction.transferOperations),
		nft,
		request.nftId,
		rules,
		ctx.nodeAccount,
	);

	return ctx.sign(request.transaction);
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
	ctx: MultisigProcessContext,
): Promise<NftStateResult> {
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
	} catch (cause) {
		throw createMultisigError(
			"INVALID_PAYMENT_SPLIT",
			cause instanceof Error ? cause.message : "Payment split verification failed",
			cause,
		);
	}
}
