import { z } from "zod";
import {
	assetApproveInputSchema,
	assetApproveAllInputSchema,
	assetTransferFromInputSchema,
	dataOperatorApproveInputSchema,
	usernameSchema,
} from "../schemas";
import { formatZodError, withProvenance } from "./helpers";
import { createSdkPayload } from "../sdk-payload";
import type { KeychainResult } from "./types";
import {
	createHiveOperation,
	getKeyType,
	type AssetApproveData,
	type AssetApproveAllData,
	type AssetTransferFromData,
	type DataOperatorApproveData,
} from "@nftlox/protocol";

export const assetApproveBuilderSchema = assetApproveInputSchema.extend({
	owner: usernameSchema,
});
export type AssetApproveBuilderInput = z.infer<typeof assetApproveBuilderSchema>;

export function buildAssetApprove(input: AssetApproveBuilderInput): KeychainResult<AssetApproveData> {
	const parsed = assetApproveBuilderSchema.safeParse(input);
	if (!parsed.success) {
		return { success: false, errors: formatZodError(parsed.error) };
	}
	const data = parsed.data;

	const assetApproveData: AssetApproveData = {
		spender: data.spender,
		instanceId: data.instanceId,
		approved: data.approved,
	};

	const payload = createSdkPayload("asset_approve", assetApproveData);
	const operation = createHiveOperation(payload, data.owner);

	return {
		success: true,
		operations: [operation],
		keyType: getKeyType("asset_approve"),
		signer: data.owner,
		payload,
	};
}

export const assetApproveAllBuilderSchema = assetApproveAllInputSchema.extend({
	owner: usernameSchema,
});
export type AssetApproveAllBuilderInput = z.infer<typeof assetApproveAllBuilderSchema>;

export function buildAssetApproveAll(input: AssetApproveAllBuilderInput): KeychainResult<AssetApproveAllData> {
	const parsed = assetApproveAllBuilderSchema.safeParse(input);
	if (!parsed.success) {
		return { success: false, errors: formatZodError(parsed.error) };
	}
	const data = parsed.data;

	const assetApproveAllData: AssetApproveAllData = {
		spender: data.spender,
		collectionId: data.collectionId,
		approved: data.approved,
	};

	const payload = createSdkPayload("asset_approve_all", assetApproveAllData);
	const operation = createHiveOperation(payload, data.owner);

	return {
		success: true,
		operations: [operation],
		keyType: getKeyType("asset_approve_all"),
		signer: data.owner,
		payload,
	};
}

export const assetTransferFromBuilderSchema = assetTransferFromInputSchema.extend({
	operator: usernameSchema,
});
export type AssetTransferFromBuilderInput = z.infer<typeof assetTransferFromBuilderSchema>;

export function buildAssetTransferFrom(input: AssetTransferFromBuilderInput): KeychainResult<AssetTransferFromData> {
	const parsed = assetTransferFromBuilderSchema.safeParse(input);
	if (!parsed.success) {
		return { success: false, errors: formatZodError(parsed.error) };
	}
	const data = parsed.data;

	const assetTransferFromData: AssetTransferFromData = {
		from: data.from,
		to: data.to,
		instanceId: data.instanceId,
		...withProvenance(data),
	};

	const payload = createSdkPayload("asset_transfer_from", assetTransferFromData);
	const operation = createHiveOperation(payload, data.operator);

	return {
		success: true,
		operations: [operation],
		keyType: getKeyType("asset_transfer_from"),
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

	const payload = createSdkPayload("data_operator_approve", dataOperatorApproveData);
	const operation = createHiveOperation(payload, data.creator);

	return {
		success: true,
		operations: [operation],
		keyType: getKeyType("data_operator_approve"),
		signer: data.creator,
		payload,
	};
}
