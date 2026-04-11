import { z } from "zod";
import { usernameSchema, listInputSchema, unlistInputSchema, buyInputSchema } from "../schemas";
import { formatZodError } from "./helpers";
import { generateImageHash, generateListingNonce, generateListingId } from "../dna";
import { ACTION_LIST, ACTION_BUY, ACTION_UNLIST, MEMO_PREFIX_BUY, MEMO_PREFIX_ROYALTY, MEMO_PREFIX_FEE } from "../constants";
import { makePayload, toHiveOperation, createBuyOperation } from "../payloads";
import type { BuildResult, ListingData, UnlistData, ProtocolPayload, HiveOperation, BuyData, HiveTransferOperation } from "../types";

export const listBuilderSchema = listInputSchema.extend({
	owner: usernameSchema,
});
export type ListBuilderInput = z.infer<typeof listBuilderSchema>;

export async function buildList(input: ListBuilderInput): Promise<BuildResult<ListingData>> {
	const parsed = listBuilderSchema.safeParse(input);
	if (!parsed.success) {
		return { success: false, errors: formatZodError(parsed.error) };
	}

	const data = parsed.data;
	const warnings: string[] = [];

	if (!data.imageUrl) {
		warnings.push("imageUrl not provided - recommended for indexer verification");
	}

	const imageHash = data.imageHash || (data.imageUrl ? await generateImageHash(data.imageUrl) : undefined);

	const listingNonce = generateListingNonce();
	const listingId = await generateListingId({
		nftId: data.nftId,
		owner: data.owner,
		marketplace: data.marketplace ?? "",
		priceAmount: data.price.amount,
		priceCurrency: data.price.currency,
		expiresAt: data.expiresAt ?? 0,
		nonce: listingNonce,
	});

	const payloadData: ListingData = {
		nftId: data.nftId,
		listingId,
		listingNonce,
		price: data.price,
		...(data.expiresAt && { expiresAt: data.expiresAt }),
		...(data.imageUrl && { imageUrl: data.imageUrl }),
		...(imageHash && { imageHash }),
		...(data.seedId && { seedId: data.seedId }),
		...(data.seedTxId && { seedTxId: data.seedTxId }),
		...(data.marketplace && { marketplace: data.marketplace }),
	};

	const payload: ProtocolPayload<ListingData> = makePayload(ACTION_LIST, payloadData);
	const operation = toHiveOperation(payload, data.owner);

	return {
		success: true,
		payload,
		operation,
		warnings: warnings.length > 0 ? warnings : undefined,
	};
}

export const unlistBuilderSchema = unlistInputSchema.extend({
	owner: usernameSchema,
});
export type UnlistBuilderInput = z.infer<typeof unlistBuilderSchema>;

export async function buildUnlist(input: UnlistBuilderInput): Promise<BuildResult<UnlistData>> {
	const parsed = unlistBuilderSchema.safeParse(input);
	if (!parsed.success) {
		return { success: false, errors: formatZodError(parsed.error) };
	}

	const data = parsed.data;
	const warnings: string[] = [];

	if (!data.imageUrl) {
		warnings.push("imageUrl not provided - recommended for indexer verification");
	}

	const imageHash = data.imageHash || (data.imageUrl ? await generateImageHash(data.imageUrl) : undefined);

	const payloadData: UnlistData = {
		nftId: data.nftId,
		...(data.imageUrl && { imageUrl: data.imageUrl }),
		...(imageHash && { imageHash }),
		...(data.seedId && { seedId: data.seedId }),
		...(data.seedTxId && { seedTxId: data.seedTxId }),
	};

	const payload: ProtocolPayload<UnlistData> = makePayload(ACTION_UNLIST, payloadData);
	const operation = toHiveOperation(payload, data.owner);

	return {
		success: true,
		payload,
		operation,
		warnings: warnings.length > 0 ? warnings : undefined,
	};
}

export const paymentSplitSchema = z.object({
	sellerAmount: z.number().nonnegative(),
	royaltyAmount: z.number().nonnegative(),
	royaltyRecipient: z.string().nullable(),
	feeAmount: z.number().nonnegative(),
	feeAccount: z.string(),
	totalPrice: z.number().positive(),
	currency: z.enum(["HIVE", "HBD"]),
});

export const buyBuilderSchema = buyInputSchema.extend({
	buyer: usernameSchema,
	seller: usernameSchema,
	nodeAccount: usernameSchema,
	paymentSplit: paymentSplitSchema,
});
export type BuyBuilderInput = z.infer<typeof buyBuilderSchema>;

export function buildBuy(input: BuyBuilderInput): BuildResult<BuyData> {
	const parsed = buyBuilderSchema.safeParse(input);
	if (!parsed.success) {
		return { success: false, errors: formatZodError(parsed.error) };
	}

	const data = parsed.data;
	const warnings: string[] = [];

	if (data.buyer === data.seller) {
		return { success: false, errors: [{ field: "buyer", message: "Cannot buy your own NFT", code: "CANNOT_BUY_OWN" }] };
	}

	const payload: ProtocolPayload<BuyData> = makePayload(ACTION_BUY, {
		nftId: data.nftId,
		listingId: data.listingId,
		listTxId: data.listTxId,
		txId: data.txId,
		...(data.seedId && { seedId: data.seedId }),
		...(data.seedTxId && { seedTxId: data.seedTxId }),
	});

	const payloadOperation = createBuyOperation(payload.data, data.nodeAccount);

	const paymentSplit = data.paymentSplit;
	const currencyExt = paymentSplit.currency;
	const precision = 3;

	const formatAmount = (amt: number) => amt.toFixed(precision) + " " + currencyExt;

	const transfers: HiveTransferOperation[] = [];
	if (paymentSplit.sellerAmount > 0) {
		transfers.push([
			"transfer",
			{
				from: data.buyer,
				to: data.seller,
				amount: formatAmount(paymentSplit.sellerAmount),
				memo: `${MEMO_PREFIX_BUY}${data.nftId}`,
			},
		]);
	}
	if (paymentSplit.royaltyAmount > 0 && paymentSplit.royaltyRecipient) {
		transfers.push([
			"transfer",
			{
				from: data.buyer,
				to: paymentSplit.royaltyRecipient,
				amount: formatAmount(paymentSplit.royaltyAmount),
				memo: `${MEMO_PREFIX_ROYALTY}${data.nftId}`,
			},
		]);
	}
	if (paymentSplit.feeAmount > 0) {
		transfers.push([
			"transfer",
			{
				from: data.buyer,
				to: paymentSplit.feeAccount,
				amount: formatAmount(paymentSplit.feeAmount),
				memo: `${MEMO_PREFIX_FEE}${data.nftId}`,
			},
		]);
	}

	return {
		success: true,
		payload,
		hiveOperations: [...transfers, payloadOperation],
		warnings: warnings.length > 0 ? warnings : undefined,
	};
}
