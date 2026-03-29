import { z } from "zod";
import { usernameSchema, packCreateInputSchema, packBuyInputSchema, packTransferInputSchema, packOpenInputSchema } from "../schemas";
import { formatZodError } from "./helpers";
import { generateDeterministicPackId } from "../dna";
import {
	createPackCreatePayload,
	createPackBuyPayload,
	createPackTransferPayload,
	createPackOpenPayload,
	createPackBuyOperation,
	createPackTransferOperation,
	createPackOpenOperation,
	toHiveOperation,
} from "../payloads";
import type { BuildResult, PackCreateData, PackBuyData, PackTransferData, PackOpenData } from "../types";

export const packCreateBuilderSchema = packCreateInputSchema.extend({
	creator: usernameSchema,
});
export type PackCreateBuilderInput = z.infer<typeof packCreateBuilderSchema>;

export function buildPackCreate(input: PackCreateBuilderInput): BuildResult<PackCreateData> {
	const parsed = packCreateBuilderSchema.safeParse(input);
	if (!parsed.success) {
		return { success: false, errors: formatZodError(parsed.error) };
	}
	const data = parsed.data;
	const warnings: string[] = [];

	const totalWeight = data.dropTable.reduce((acc, entry) => acc + entry.weight, 0);
	if (totalWeight < 100) {
		warnings.push("Total drop table weight is low, consider normalizing to 10000 for better precision");
	}

	const generatedId = generateDeterministicPackId(data.collectionId, data.name);

	const payload = createPackCreatePayload(data, data.creator);
	const operation = toHiveOperation(payload, data.creator);

	return {
		success: true,
		payload,
		operation,
		generatedId,
		warnings: warnings.length > 0 ? warnings : undefined,
	};
}

export const packBuyBuilderSchema = packBuyInputSchema.extend({
	buyer: usernameSchema,
});
export type PackBuyBuilderInput = z.infer<typeof packBuyBuilderSchema>;

export function buildPackBuy(input: PackBuyBuilderInput): BuildResult<PackBuyData> {
	const parsed = packBuyBuilderSchema.safeParse(input);
	if (!parsed.success) {
		return { success: false, errors: formatZodError(parsed.error) };
	}
	const data = parsed.data;

	const payload = createPackBuyPayload(data);
	const operation = createPackBuyOperation(data, data.buyer);

	return { success: true, payload, operation };
}

export const packTransferBuilderSchema = packTransferInputSchema.extend({
	from: usernameSchema,
});
export type PackTransferBuilderInput = z.infer<typeof packTransferBuilderSchema>;

export function buildPackTransfer(input: PackTransferBuilderInput): BuildResult<PackTransferData> {
	const parsed = packTransferBuilderSchema.safeParse(input);
	if (!parsed.success) {
		return { success: false, errors: formatZodError(parsed.error) };
	}
	const data = parsed.data;

	if (data.from === data.to) {
		return { success: false, errors: [{ field: "to", message: "Cannot transfer to yourself", code: "TRANSFER_TO_SELF" }] };
	}

	const payload = createPackTransferPayload(data);
	const operation = createPackTransferOperation(data, data.from);

	return { success: true, payload, operation };
}

export const packOpenBuilderSchema = packOpenInputSchema.extend({
	owner: usernameSchema,
});
export type PackOpenBuilderInput = z.infer<typeof packOpenBuilderSchema>;

export function buildPackOpen(input: PackOpenBuilderInput): BuildResult<PackOpenData> {
	const parsed = packOpenBuilderSchema.safeParse(input);
	if (!parsed.success) {
		return { success: false, errors: formatZodError(parsed.error) };
	}
	const data = parsed.data;

	const payload = createPackOpenPayload(data);
	const operation = createPackOpenOperation(data, data.owner);

	return { success: true, payload, operation };
}
