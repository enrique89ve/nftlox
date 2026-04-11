import { z } from "zod";
import { burnInputSchema, setDataInputSchema, setDataFromInputSchema, nftLendInputSchema, nftReturnInputSchema } from "../schemas";
import { formatZodError } from "./helpers";
import {
	createBurnPayload,
	createBulkBurnPayload,
	createSetDataPayload,
	createSetDataFromPayload,
	createNftLendPayload,
	createNftReturnPayload,
	createNodeRegisterPayload,
	toHiveOperation,
} from "../payloads";
import type { BuildResult, TransferData, SetDataData, SetDataFromData, NftLendData, NftReturnData, NodeRegisterData } from "../types";
import { usernameSchema, nodeRegisterInputSchema } from "../schemas";

export const burnBuilderSchema = burnInputSchema;
export type BurnBuilderInput = z.infer<typeof burnBuilderSchema>;

export function buildBurn(input: BurnBuilderInput): BuildResult<TransferData> {
	const parsed = burnBuilderSchema.safeParse(input);
	if (!parsed.success) {
		return { success: false, errors: formatZodError(parsed.error) };
	}
	const data = parsed.data;

	const isBulk = Boolean(data.nftIds);
	const payload = isBulk
		? createBulkBurnPayload(data.nftIds!, data.owner)
		: createBurnPayload(data.nftId!, data.owner);

	const operation = toHiveOperation(payload, data.owner);

	return { success: true, payload, operation };
}

export const setDataBuilderSchema = setDataInputSchema.extend({
	owner: usernameSchema,
});
export type SetDataBuilderInput = z.infer<typeof setDataBuilderSchema>;

export function buildSetData(input: SetDataBuilderInput): BuildResult<SetDataData> {
	const parsed = setDataBuilderSchema.safeParse(input);
	if (!parsed.success) {
		return { success: false, errors: formatZodError(parsed.error) };
	}
	const data = parsed.data;
	
	const payload = createSetDataPayload(data);
	const operation = toHiveOperation(payload, data.owner);

	return { success: true, payload, operation };
}

export const setDataFromBuilderSchema = setDataFromInputSchema.extend({
	operator: usernameSchema,
});
export type SetDataFromBuilderInput = z.infer<typeof setDataFromBuilderSchema>;

export function buildSetDataFrom(input: SetDataFromBuilderInput): BuildResult<SetDataFromData> {
	const parsed = setDataFromBuilderSchema.safeParse(input);
	if (!parsed.success) {
		return { success: false, errors: formatZodError(parsed.error) };
	}
	const data = parsed.data;

	const payload = createSetDataFromPayload(data);
	const operation = toHiveOperation(payload, data.operator);

	return { success: true, payload, operation };
}

export const nftLendBuilderSchema = nftLendInputSchema.extend({
	owner: usernameSchema,
});
export type NftLendBuilderInput = z.infer<typeof nftLendBuilderSchema>;

export function buildNftLend(input: NftLendBuilderInput): BuildResult<NftLendData> {
	const parsed = nftLendBuilderSchema.safeParse(input);
	if (!parsed.success) {
		return { success: false, errors: formatZodError(parsed.error) };
	}
	const data = parsed.data;

	if (data.owner === data.borrower) {
		return { success: false, errors: [{ field: "borrower", message: "Cannot lend to yourself", code: "LEND_TO_SELF" }] };
	}

	const payload = createNftLendPayload(data);
	const operation = toHiveOperation(payload, data.owner);

	return { success: true, payload, operation };
}

export const nftReturnBuilderSchema = nftReturnInputSchema.extend({
	owner: usernameSchema, // The borrower returning it
});
export type NftReturnBuilderInput = z.infer<typeof nftReturnBuilderSchema>;

export function buildNftReturn(input: NftReturnBuilderInput): BuildResult<NftReturnData> {
	const parsed = nftReturnBuilderSchema.safeParse(input);
	if (!parsed.success) {
		return { success: false, errors: formatZodError(parsed.error) };
	}
	const data = parsed.data;

	const payload = createNftReturnPayload(data);
	const operation = toHiveOperation(payload, data.owner);

	return { success: true, payload, operation };
}

export const nodeRegisterBuilderSchema = nodeRegisterInputSchema.extend({
	nodeAccount: usernameSchema,
});
export type NodeRegisterBuilderInput = z.infer<typeof nodeRegisterBuilderSchema>;

export function buildNodeRegister(input: NodeRegisterBuilderInput): BuildResult<NodeRegisterData> {
	const parsed = nodeRegisterBuilderSchema.safeParse(input);
	if (!parsed.success) {
		return { success: false, errors: formatZodError(parsed.error) };
	}
	const data = parsed.data;

	const payload = createNodeRegisterPayload(data);
	const operation = toHiveOperation(payload, data.nodeAccount);

	return { success: true, payload, operation };
}
