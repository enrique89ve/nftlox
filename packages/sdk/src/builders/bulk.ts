import { z } from "zod";
import { usernameSchema, bulkDistributeInputSchema } from "../schemas";
import { formatZodError } from "./helpers";
import type { KeychainResult } from "./types";
import {
	createPayload,
	createHiveOperation,
	getKeyType,
	toWireUrl,
	type BulkDistributeData,
	type ImageOverride,
} from "@nftlox/protocol";

function normalizeOverride(override: ImageOverride): ImageOverride {
	return {
		...(override.imageUrl !== undefined && { imageUrl: toWireUrl(override.imageUrl) }),
		...(override.imageHash !== undefined && { imageHash: override.imageHash }),
	};
}

function normalizeImageOverrides(
	overrides: Readonly<Record<string, ImageOverride>>,
): Readonly<Record<string, ImageOverride>> {
	const normalized: Record<string, ImageOverride> = {};
	for (const [key, override] of Object.entries(overrides)) {
		normalized[key] = normalizeOverride(override);
	}
	return normalized;
}

export const bulkDistributeBuilderSchema = bulkDistributeInputSchema.extend({
	signer: usernameSchema,
});
export type BulkDistributeBuilderInput = z.infer<typeof bulkDistributeBuilderSchema>;

export function buildBulkDistribute(
	input: BulkDistributeBuilderInput,
): KeychainResult<BulkDistributeData> {
	const parsed = bulkDistributeBuilderSchema.safeParse(input);
	if (!parsed.success) {
		return { success: false, errors: formatZodError(parsed.error) };
	}

	const data = parsed.data;
	const bulkData: BulkDistributeData = {
		...(data.to !== undefined && { to: data.to }),
		items: data.items.map((item) => ({
			seedId: item.seedId,
			quantity: item.quantity,
			seedTxId: item.seedTxId,
		})),
		...(data.imageOverrides !== undefined && {
			imageOverrides: normalizeImageOverrides(data.imageOverrides),
		}),
		...(data.mutableData !== undefined && { mutableData: data.mutableData }),
	};

	const payload = createPayload("bulk_distribute", bulkData);
	const operation = createHiveOperation(payload, data.signer);

	return {
		success: true,
		operations: [operation],
		keyType: getKeyType("bulk_distribute"),
		signer: data.signer,
		payload,
	};
}
