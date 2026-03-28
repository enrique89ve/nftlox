import { z } from "zod";
import { usernameSchema, listInputSchema, unlistInputSchema, seedProvenanceSchema, type ListInput, type UnlistInput } from "../schemas";
import { formatZodError } from "./helpers";
import { generateImageHash } from "../dna";
import { PROTOCOL_ID, PROTOCOL_VERSION, ACTION_LIST, ACTION_BUY, ACTION_UNLIST } from "../constants";
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

	const payloadData: ListingData = {
		nftId: data.nftId,
		price: data.price,
		...(data.expiresAt && { expiresAt: data.expiresAt }),
		...(data.imageUrl && { imageUrl: data.imageUrl }),
		...(imageHash && { imageHash }),
		...(data.seedId && { seedId: data.seedId }),
		...(data.birthTx && { birthTx: data.birthTx }),
		...(data.marketplace && { marketplace: data.marketplace }),
	};

	const payload: ProtocolPayload<ListingData> = {
		protocol: PROTOCOL_ID,
		version: PROTOCOL_VERSION,
		action: ACTION_LIST,
		data: payloadData,
	};

	const operation: HiveOperation = [
		"custom_json",
		{
			required_auths: [],
			required_posting_auths: [data.owner],
			id: PROTOCOL_ID,
			json: JSON.stringify(payload),
		},
	];

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
	};

	const payload: ProtocolPayload<UnlistData> = {
		protocol: PROTOCOL_ID,
		version: PROTOCOL_VERSION,
		action: ACTION_UNLIST,
		data: payloadData,
	};

	const operation: HiveOperation = [
		"custom_json",
		{
			required_auths: [],
			required_posting_auths: [data.owner],
			id: PROTOCOL_ID,
			json: JSON.stringify(payload),
		},
	];

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

export const buyBuilderSchema = seedProvenanceSchema.extend({
	nftId: z.string().min(1),
	buyer: usernameSchema,
	seller: usernameSchema,
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

	const payload: ProtocolPayload<BuyData> = {
		protocol: PROTOCOL_ID,
		version: PROTOCOL_VERSION,
		action: ACTION_BUY,
		data: { nftId: data.nftId },
	};

	const payloadOperation: HiveOperation = [
		"custom_json",
		{
			required_auths: [],
			required_posting_auths: [data.buyer],
			id: PROTOCOL_ID,
			json: JSON.stringify(payload),
		},
	];

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
				memo: `NFTLox BUY:${data.nftId}`,
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
				memo: `NFTLox ROY:${data.nftId}`,
			},
		]);
	}
	if (paymentSplit.feeAmount > 0 && paymentSplit.feeAccount) {
		transfers.push([
			"transfer",
			{
				from: data.buyer,
				to: paymentSplit.feeAccount,
				amount: formatAmount(paymentSplit.feeAmount),
				memo: `NFTLox FEE:${data.nftId}`,
			},
		]);
	}

	return {
		success: true,
		payload,
		hiveOperations: [payloadOperation, ...transfers],
		warnings: warnings.length > 0 ? warnings : undefined,
	};
}
