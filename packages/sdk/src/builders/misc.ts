import { z } from "zod";
import {
	burnInputSchema,
	setDataInputSchema,
	setDataFromInputSchema,
	nftLendInputSchema,
	nftReturnInputSchema,
	usernameSchema,
	nodeRegisterInputSchema,
	nodeHeartbeatInputSchema,
} from "../schemas";
import { formatZodError } from "./helpers";
import type { KeychainResult } from "./types";
import {
	createPayload,
	createHiveOperation,
	getKeyType,
	type TransferData,
	type SetDataData,
	type SetDataFromData,
	type NftLendData,
	type NftReturnData,
	type NodeRegisterData,
	type NodeHeartbeatData,
} from "@nftlox/protocol";

export const burnBuilderSchema = burnInputSchema;
export type BurnBuilderInput = z.infer<typeof burnBuilderSchema>;

// Burn = transfer to "null". Supports single nftId or bulk nftIds.
export function buildBurn(input: BurnBuilderInput): KeychainResult<TransferData> {
	const parsed = burnBuilderSchema.safeParse(input);
	if (!parsed.success) {
		return { success: false, errors: formatZodError(parsed.error) };
	}
	const data = parsed.data;

	const transferData: TransferData = data.nftIds
		? { nftIds: data.nftIds, from: data.owner, to: "null" }
		: { nftId: data.nftId!, from: data.owner, to: "null" };

	const payload = createPayload("transfer", transferData);
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
		nftId: data.nftId,
		instanceDna: data.instanceDna,
		...(data.data && { data: data.data }),
		...(data.mutableData && { mutableData: data.mutableData }),
		...(data.seedId && { seedId: data.seedId }),
		...(data.seedTxId && { seedTxId: data.seedTxId }),
	};

	const payload = createPayload("set_data", setDataData);
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
		nftId: data.nftId,
		instanceDna: data.instanceDna,
		...(data.data && { data: data.data }),
		...(data.mutableData && { mutableData: data.mutableData }),
		...(data.seedId && { seedId: data.seedId }),
		...(data.seedTxId && { seedTxId: data.seedTxId }),
	};

	const payload = createPayload("set_data_from", setDataFromData);
	const operation = createHiveOperation(payload, data.operator);

	return {
		success: true,
		operations: [operation],
		keyType: getKeyType("set_data_from"),
		signer: data.operator,
		payload,
	};
}

export const nftLendBuilderSchema = nftLendInputSchema.extend({
	owner: usernameSchema,
});
export type NftLendBuilderInput = z.infer<typeof nftLendBuilderSchema>;

export function buildNftLend(input: NftLendBuilderInput): KeychainResult<NftLendData> {
	const parsed = nftLendBuilderSchema.safeParse(input);
	if (!parsed.success) {
		return { success: false, errors: formatZodError(parsed.error) };
	}
	const data = parsed.data;

	if (data.owner === data.borrower) {
		return { success: false, errors: [{ field: "borrower", message: "Cannot lend to yourself", code: "LEND_TO_SELF" }] };
	}

	const nftLendData: NftLendData = {
		instanceId: data.instanceId,
		borrower: data.borrower,
		...(data.seedId && { seedId: data.seedId }),
		...(data.seedTxId && { seedTxId: data.seedTxId }),
	};

	const payload = createPayload("nft_lend", nftLendData);
	const operation = createHiveOperation(payload, data.owner);

	return {
		success: true,
		operations: [operation],
		keyType: getKeyType("nft_lend"),
		signer: data.owner,
		payload,
	};
}

export const nftReturnBuilderSchema = nftReturnInputSchema.extend({
	owner: usernameSchema, // The borrower returning it
});
export type NftReturnBuilderInput = z.infer<typeof nftReturnBuilderSchema>;

export function buildNftReturn(input: NftReturnBuilderInput): KeychainResult<NftReturnData> {
	const parsed = nftReturnBuilderSchema.safeParse(input);
	if (!parsed.success) {
		return { success: false, errors: formatZodError(parsed.error) };
	}
	const data = parsed.data;

	const nftReturnData: NftReturnData = {
		instanceId: data.instanceId,
		...(data.seedId && { seedId: data.seedId }),
		...(data.seedTxId && { seedTxId: data.seedTxId }),
	};

	const payload = createPayload("nft_return", nftReturnData);
	const operation = createHiveOperation(payload, data.owner);

	return {
		success: true,
		operations: [operation],
		keyType: getKeyType("nft_return"),
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

	const payload = createPayload("node_register", nodeRegisterData);
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

	const payload = createPayload("node_heartbeat", nodeHeartbeatData);
	const operation = createHiveOperation(payload, data.nodeAccount);

	return {
		success: true,
		operations: [operation],
		keyType: getKeyType("node_heartbeat"),
		signer: data.nodeAccount,
		payload,
	};
}
