import { z } from "zod";
import {
	nftApproveInputSchema,
	nftApproveAllInputSchema,
	nftTransferFromInputSchema,
	dataOperatorApproveInputSchema,
} from "../schemas";
import { formatZodError } from "./helpers";
import { usernameSchema } from "../schemas";
import {
	createNftApprovePayload,
	createNftApproveAllPayload,
	createNftTransferFromPayload,
	createDataOperatorApprovePayload,
	toHiveOperation,
} from "../payloads";
import type { BuildResult, NftApproveData, NftApproveAllData, NftTransferFromData, DataOperatorApproveData } from "../types";

export const nftApproveBuilderSchema = nftApproveInputSchema.extend({
	owner: usernameSchema,
});
export type NftApproveBuilderInput = z.infer<typeof nftApproveBuilderSchema>;

export function buildNftApprove(input: NftApproveBuilderInput): BuildResult<NftApproveData> {
	const parsed = nftApproveBuilderSchema.safeParse(input);
	if (!parsed.success) {
		return { success: false, errors: formatZodError(parsed.error) };
	}
	const data = parsed.data;

	const payload = createNftApprovePayload(data);
	const operation = toHiveOperation(payload, data.owner);

	return { success: true, payload, operation };
}

export const nftApproveAllBuilderSchema = nftApproveAllInputSchema.extend({
	owner: usernameSchema,
});
export type NftApproveAllBuilderInput = z.infer<typeof nftApproveAllBuilderSchema>;

export function buildNftApproveAll(input: NftApproveAllBuilderInput): BuildResult<NftApproveAllData> {
	const parsed = nftApproveAllBuilderSchema.safeParse(input);
	if (!parsed.success) {
		return { success: false, errors: formatZodError(parsed.error) };
	}
	const data = parsed.data;

	const payload = createNftApproveAllPayload(data);
	const operation = toHiveOperation(payload, data.owner);

	return { success: true, payload, operation };
}

export const nftTransferFromBuilderSchema = nftTransferFromInputSchema.extend({
	operator: usernameSchema,
});
export type NftTransferFromBuilderInput = z.infer<typeof nftTransferFromBuilderSchema>;

export function buildNftTransferFrom(input: NftTransferFromBuilderInput): BuildResult<NftTransferFromData> {
	const parsed = nftTransferFromBuilderSchema.safeParse(input);
	if (!parsed.success) {
		return { success: false, errors: formatZodError(parsed.error) };
	}
	const data = parsed.data;

	const payload = createNftTransferFromPayload(data);
	const operation = toHiveOperation(payload, data.operator);

	return { success: true, payload, operation };
}

export const dataOperatorApproveBuilderSchema = dataOperatorApproveInputSchema.extend({
	creator: usernameSchema,
});
export type DataOperatorApproveBuilderInput = z.infer<typeof dataOperatorApproveBuilderSchema>;

export function buildDataOperatorApprove(input: DataOperatorApproveBuilderInput): BuildResult<DataOperatorApproveData> {
	const parsed = dataOperatorApproveBuilderSchema.safeParse(input);
	if (!parsed.success) {
		return { success: false, errors: formatZodError(parsed.error) };
	}
	const data = parsed.data;

	const payload = createDataOperatorApprovePayload(data);
	const operation = toHiveOperation(payload, data.creator);

	return { success: true, payload, operation };
}
