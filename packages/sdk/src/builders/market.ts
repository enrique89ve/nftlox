import { z } from "zod";
import { usernameSchema, listInputSchema, unlistInputSchema, buyInputSchema } from "../schemas";
import { formatZodError } from "./helpers";
import type { KeychainResult } from "./types";
import {
	generateListingNonce,
	generateListingId,
	createPayload,
	createHiveOperation,
	getKeyType,
	MEMO_PREFIX_BUY,
	MEMO_PREFIX_ROYALTY,
	MEMO_PREFIX_FEE,
	type ListingData,
	type UnlistData,
	type BuyData,
	type HiveTransferOperation,
} from "@nftlox/protocol";

export const listBuilderSchema = listInputSchema.extend({
	owner: usernameSchema,
});
export type ListBuilderInput = z.infer<typeof listBuilderSchema>;

export async function buildList(
	input: ListBuilderInput,
): Promise<KeychainResult<ListingData>> {
	const parsed = listBuilderSchema.safeParse(input);
	if (!parsed.success) {
		return { success: false, errors: formatZodError(parsed.error) };
	}

	const data = parsed.data;

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

	const listingData: ListingData = {
		nftId: data.nftId,
		listingId,
		listingNonce,
		price: data.price,
		...(data.expiresAt && { expiresAt: data.expiresAt }),
		...(data.seedId && { seedId: data.seedId }),
		...(data.seedTxId && { seedTxId: data.seedTxId }),
		...(data.marketplace && { marketplace: data.marketplace }),
	};

	const payload = createPayload("list", listingData);
	const operation = createHiveOperation(payload, data.owner);

	return {
		success: true,
		operations: [operation],
		keyType: getKeyType("list"),
		signer: data.owner,
		payload,
		generatedIds: { listingId, listingNonce },
	};
}

export const unlistBuilderSchema = unlistInputSchema.extend({
	owner: usernameSchema,
});
export type UnlistBuilderInput = z.infer<typeof unlistBuilderSchema>;

export function buildUnlist(
	input: UnlistBuilderInput,
): KeychainResult<UnlistData> {
	const parsed = unlistBuilderSchema.safeParse(input);
	if (!parsed.success) {
		return { success: false, errors: formatZodError(parsed.error) };
	}

	const data = parsed.data;

	const unlistData: UnlistData = {
		nftId: data.nftId,
		...(data.seedId && { seedId: data.seedId }),
		...(data.seedTxId && { seedTxId: data.seedTxId }),
	};

	const payload = createPayload("unlist", unlistData);
	const operation = createHiveOperation(payload, data.owner);

	return {
		success: true,
		operations: [operation],
		keyType: getKeyType("unlist"),
		signer: data.owner,
		payload,
	};
}

export const paymentSplitSchema = z.object({
	sellerAmount: z.number().nonnegative(),
	royaltyAmount: z.number().nonnegative(),
	royaltyRecipient: z.string().nullable(),
	feeAmount: z.number().nonnegative(),
	feeAccount: usernameSchema,
	totalPrice: z.number().positive(),
	currency: z.enum(["HIVE", "HBD"]),
});

export const buyBuilderSchema = buyInputSchema.extend({
	buyer: usernameSchema,
	seller: usernameSchema,
	paymentSplit: paymentSplitSchema,
	nodeAccount: usernameSchema.optional(),
});
export type BuyBuilderInput = z.infer<typeof buyBuilderSchema>;

export function buildBuy(input: BuyBuilderInput): KeychainResult<BuyData> {
	const parsed = buyBuilderSchema.safeParse(input);
	if (!parsed.success) {
		return { success: false, errors: formatZodError(parsed.error) };
	}

	const data = parsed.data;

	if (data.buyer === data.seller) {
		return { success: false, errors: [{ field: "buyer", message: "Cannot buy your own NFT", code: "CANNOT_BUY_OWN" }] };
	}

	const buyData: BuyData = {
		nftId: data.nftId,
		listingId: data.listingId,
		listTxId: data.listTxId,
	};

	const payload = createPayload("buy", buyData);
	const nodeAccount = data.nodeAccount ?? data.paymentSplit.feeAccount;
	const buyCustomJson = createHiveOperation(payload, nodeAccount);

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
		operations: [...transfers, buyCustomJson],
		keyType: getKeyType("buy"),
		signer: data.buyer,
		coSigners: [{
			op: transfers.length,
			account: nodeAccount,
			keyType: getKeyType("buy"),
			via: "multisig",
		}],
		payload,
	};
}
