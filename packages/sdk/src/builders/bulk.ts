import { z } from "zod";
import { usernameSchema, bulkDistributeInputSchema, type BulkDistributeInput } from "../schemas";
import { formatZodError } from "./helpers";
import {
	createBulkDistributePayload,
	createBulkDistributeOperation,
} from "../payloads";
import type { BuildResult, BulkDistributeData } from "../types";

export const bulkDistributeBuilderSchema = bulkDistributeInputSchema.extend({
	signer: usernameSchema,
});
export type BulkDistributeBuilderInput = z.infer<typeof bulkDistributeBuilderSchema>;

export function buildBulkDistribute(input: BulkDistributeBuilderInput): BuildResult<BulkDistributeData> {
	const parsed = bulkDistributeBuilderSchema.safeParse(input);
	if (!parsed.success) {
		return { success: false, errors: formatZodError(parsed.error) };
	}

	const data = parsed.data;

	const bulkInput: BulkDistributeInput = {
		...(data.to && { to: data.to }),
		items: data.items,
		...(data.imageOverrides && { imageOverrides: data.imageOverrides }),
		...(data.data && { data: data.data }),
		...(data.mutableData && { mutableData: data.mutableData }),
	};

	const payload = createBulkDistributePayload(bulkInput);
	const operation = createBulkDistributeOperation(bulkInput, data.signer);

	return {
		success: true,
		payload,
		operation,
	};
}
