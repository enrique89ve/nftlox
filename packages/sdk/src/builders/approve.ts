import { z } from "zod";
import {
	nftApproveInputSchema,
	nftApproveAllInputSchema,
	nftTransferFromInputSchema,
	dataOperatorApproveInputSchema,
	usernameSchema,
} from "../schemas";
import { formatZodError, withProvenance } from "./helpers";
import type { KeychainResult } from "./types";
import {
	createPayload,
	createHiveOperation,
	getKeyType,
	type NftApproveData,
	type NftApproveAllData,
	type NftTransferFromData,
	type DataOperatorApproveData,
} from "@nftlox/protocol";

export const nftApproveBuilderSchema = nftApproveInputSchema.extend({
	owner: usernameSchema,
});
export type NftApproveBuilderInput = z.infer<typeof nftApproveBuilderSchema>;

export function buildNftApprove(input: NftApproveBuilderInput): KeychainResult<NftApproveData> {
	const parsed = nftApproveBuilderSchema.safeParse(input);
	if (!parsed.success) {
		return { success: false, errors: formatZodError(parsed.error) };
	}
	const data = parsed.data;

	const nftApproveData: NftApproveData = {
		spender: data.spender,
		instanceId: data.instanceId,
		approved: data.approved,
	};

	const payload = createPayload("nft_approve", nftApproveData);
	const operation = createHiveOperation(payload, data.owner);

	return {
		success: true,
		operations: [operation],
		keyType: getKeyType("nft_approve"),
		signer: data.owner,
		payload,
	};
}

export const nftApproveAllBuilderSchema = nftApproveAllInputSchema.extend({
	owner: usernameSchema,
});
export type NftApproveAllBuilderInput = z.infer<typeof nftApproveAllBuilderSchema>;

export function buildNftApproveAll(input: NftApproveAllBuilderInput): KeychainResult<NftApproveAllData> {
	const parsed = nftApproveAllBuilderSchema.safeParse(input);
	if (!parsed.success) {
		return { success: false, errors: formatZodError(parsed.error) };
	}
	const data = parsed.data;

	const nftApproveAllData: NftApproveAllData = {
		spender: data.spender,
		collectionId: data.collectionId,
		approved: data.approved,
	};

	const payload = createPayload("nft_approve_all", nftApproveAllData);
	const operation = createHiveOperation(payload, data.owner);

	return {
		success: true,
		operations: [operation],
		keyType: getKeyType("nft_approve_all"),
		signer: data.owner,
		payload,
	};
}

export const nftTransferFromBuilderSchema = nftTransferFromInputSchema.extend({
	operator: usernameSchema,
});
export type NftTransferFromBuilderInput = z.infer<typeof nftTransferFromBuilderSchema>;

export function buildNftTransferFrom(input: NftTransferFromBuilderInput): KeychainResult<NftTransferFromData> {
	const parsed = nftTransferFromBuilderSchema.safeParse(input);
	if (!parsed.success) {
		return { success: false, errors: formatZodError(parsed.error) };
	}
	const data = parsed.data;

	const nftTransferFromData: NftTransferFromData = {
		from: data.from,
		to: data.to,
		instanceId: data.instanceId,
		...withProvenance(data),
	};

	const payload = createPayload("nft_transfer_from", nftTransferFromData);
	const operation = createHiveOperation(payload, data.operator);

	return {
		success: true,
		operations: [operation],
		keyType: getKeyType("nft_transfer_from"),
		signer: data.operator,
		payload,
	};
}

export const dataOperatorApproveBuilderSchema = dataOperatorApproveInputSchema.extend({
	creator: usernameSchema,
});
export type DataOperatorApproveBuilderInput = z.infer<typeof dataOperatorApproveBuilderSchema>;

export function buildDataOperatorApprove(input: DataOperatorApproveBuilderInput): KeychainResult<DataOperatorApproveData> {
	const parsed = dataOperatorApproveBuilderSchema.safeParse(input);
	if (!parsed.success) {
		return { success: false, errors: formatZodError(parsed.error) };
	}
	const data = parsed.data;

	const dataOperatorApproveData: DataOperatorApproveData = {
		collectionId: data.collectionId,
		operator: data.operator,
		approved: data.approved,
	};

	const payload = createPayload("data_operator_approve", dataOperatorApproveData);
	const operation = createHiveOperation(payload, data.creator);

	return {
		success: true,
		operations: [operation],
		keyType: getKeyType("data_operator_approve"),
		signer: data.creator,
		payload,
	};
}
