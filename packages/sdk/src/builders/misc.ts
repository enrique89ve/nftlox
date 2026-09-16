import { z } from "zod";
import {
	burnInputSchema,
	setDataInputSchema,
	setDataFromInputSchema,
	assetLendInputSchema,
	assetReturnInputSchema,
	usernameSchema,
	nodeRegisterInputSchema,
	nodeHeartbeatInputSchema,
} from "../schemas";
import { formatZodError, withProvenance } from "./helpers";
import type { KeychainResult } from "./types";
import { createSdkPayload } from "../sdk-payload";
import {
	BURN_RECIPIENT,
	createHiveOperation,
	getKeyType,
	type TransferData,
	type SetDataData,
	type SetDataFromData,
	type AssetLendData,
	type AssetReturnData,
	type NodeRegisterData,
	type NodeHeartbeatData,
} from "@nftlox/protocol";

export const burnBuilderSchema = burnInputSchema;
export type BurnBuilderInput = z.infer<typeof burnBuilderSchema>;

// Burn = transfer to BURN_RECIPIENT (Hive's native burn account). Supports
// single assetId or bulk assetIds.
export function buildBurn(input: BurnBuilderInput): KeychainResult<TransferData> {
	const parsed = burnBuilderSchema.safeParse(input);
	if (!parsed.success) {
		return { success: false, errors: formatZodError(parsed.error) };
	}
	const data = parsed.data;

	const transferData: TransferData = data.assetIds
		? { assetIds: data.assetIds, to: BURN_RECIPIENT }
		: { assetId: data.assetId!, to: BURN_RECIPIENT };

	const payload = createSdkPayload("transfer", transferData);
	const operation = createHiveOperation(payload, data.owner);

	return {
		success: true,
		operations: [operation],
		keyType: getKeyType("transfer"),
		signer: data.owner,
		payload,
	};
}

export const setDataBuilderSchema = setDataInputSchema.extend({
	owner: usernameSchema,
});
export type SetDataBuilderInput = z.infer<typeof setDataBuilderSchema>;

export function buildSetData(input: SetDataBuilderInput): KeychainResult<SetDataData> {
	const parsed = setDataBuilderSchema.safeParse(input);
	if (!parsed.success) {
		return { success: false, errors: formatZodError(parsed.error) };
	}
	const data = parsed.data;

	const setDataData: SetDataData = {
		assetId: data.assetId,
		assetDna: data.assetDna,
		...(data.mutableData && { mutableData: data.mutableData }),
		...withProvenance(data),
	};

	const payload = createSdkPayload("set_data", setDataData);
	const operation = createHiveOperation(payload, data.owner);

	return {
		success: true,
		operations: [operation],
		keyType: getKeyType("set_data"),
		signer: data.owner,
		payload,
	};
}

export const setDataFromBuilderSchema = setDataFromInputSchema.extend({
	operator: usernameSchema,
});
export type SetDataFromBuilderInput = z.infer<typeof setDataFromBuilderSchema>;

export function buildSetDataFrom(input: SetDataFromBuilderInput): KeychainResult<SetDataFromData> {
	const parsed = setDataFromBuilderSchema.safeParse(input);
	if (!parsed.success) {
		return { success: false, errors: formatZodError(parsed.error) };
	}
	const data = parsed.data;

	const setDataFromData: SetDataFromData = {
		assetId: data.assetId,
		assetDna: data.assetDna,
		...(data.mutableData && { mutableData: data.mutableData }),
		...withProvenance(data),
	};

	const payload = createSdkPayload("set_data_from", setDataFromData);
	const operation = createHiveOperation(payload, data.operator);

	return {
		success: true,
		operations: [operation],
		keyType: getKeyType("set_data_from"),
		signer: data.operator,
		payload,
	};
}

export const assetLendBuilderSchema = assetLendInputSchema.extend({
	owner: usernameSchema,
});
export type AssetLendBuilderInput = z.infer<typeof assetLendBuilderSchema>;

export function buildAssetLend(input: AssetLendBuilderInput): KeychainResult<AssetLendData> {
	const parsed = assetLendBuilderSchema.safeParse(input);
	if (!parsed.success) {
		return { success: false, errors: formatZodError(parsed.error) };
	}
	const data = parsed.data;

	if (data.owner === data.borrower) {
		return { success: false, errors: [{ field: "borrower", message: "Cannot lend to yourself", code: "LEND_TO_SELF" }] };
	}

	const assetLendData: AssetLendData = {
		instanceId: data.instanceId,
		borrower: data.borrower,
		...withProvenance(data),
	};

	const payload = createSdkPayload("asset_lend", assetLendData);
	const operation = createHiveOperation(payload, data.owner);

	return {
		success: true,
		operations: [operation],
		keyType: getKeyType("asset_lend"),
		signer: data.owner,
		payload,
	};
}

export const assetReturnBuilderSchema = assetReturnInputSchema.extend({
	owner: usernameSchema, // The borrower returning it
});
export type AssetReturnBuilderInput = z.infer<typeof assetReturnBuilderSchema>;

export function buildAssetReturn(input: AssetReturnBuilderInput): KeychainResult<AssetReturnData> {
	const parsed = assetReturnBuilderSchema.safeParse(input);
	if (!parsed.success) {
		return { success: false, errors: formatZodError(parsed.error) };
	}
	const data = parsed.data;

	const assetReturnData: AssetReturnData = {
		instanceId: data.instanceId,
		...withProvenance(data),
	};

	const payload = createSdkPayload("asset_return", assetReturnData);
	const operation = createHiveOperation(payload, data.owner);

	return {
		success: true,
		operations: [operation],
		keyType: getKeyType("asset_return"),
		signer: data.owner,
		payload,
	};
}

export const nodeRegisterBuilderSchema = nodeRegisterInputSchema.extend({
	nodeAccount: usernameSchema,
});
export type NodeRegisterBuilderInput = z.infer<typeof nodeRegisterBuilderSchema>;

export function buildNodeRegister(input: NodeRegisterBuilderInput): KeychainResult<NodeRegisterData> {
	const parsed = nodeRegisterBuilderSchema.safeParse(input);
	if (!parsed.success) {
		return { success: false, errors: formatZodError(parsed.error) };
	}
	const data = parsed.data;

	const nodeRegisterData: NodeRegisterData = {
		endpoint: data.endpoint,
	};

	const payload = createSdkPayload("node_register", nodeRegisterData);
	const operation = createHiveOperation(payload, data.nodeAccount);

	return {
		success: true,
		operations: [operation],
		keyType: getKeyType("node_register"),
		signer: data.nodeAccount,
		payload,
	};
}

export const nodeHeartbeatBuilderSchema = nodeHeartbeatInputSchema.extend({
	nodeAccount: usernameSchema,
});
export type NodeHeartbeatBuilderInput = z.infer<typeof nodeHeartbeatBuilderSchema>;

export function buildNodeHeartbeat(input: NodeHeartbeatBuilderInput): KeychainResult<NodeHeartbeatData> {
	const parsed = nodeHeartbeatBuilderSchema.safeParse(input);
	if (!parsed.success) {
		return { success: false, errors: formatZodError(parsed.error) };
	}
	const data = parsed.data;

	const nodeHeartbeatData: NodeHeartbeatData = {
		blockNum: data.blockNum,
		stateRoot: data.stateRoot,
		indexerVersion: data.indexerVersion,
	};

	const payload = createSdkPayload("node_heartbeat", nodeHeartbeatData);
	const operation = createHiveOperation(payload, data.nodeAccount);

	return {
		success: true,
		operations: [operation],
		keyType: getKeyType("node_heartbeat"),
		signer: data.nodeAccount,
		payload,
	};
}
