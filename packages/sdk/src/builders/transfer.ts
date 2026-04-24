import { z } from "zod";
import { seedProvenanceSchema, usernameSchema } from "../schemas";
import { formatZodError } from "./helpers";
import type { KeychainResult } from "./types";
import {
	createPayload,
	createHiveOperation,
	getKeyType,
	type TransferData,
} from "@nftlox/protocol";

export const transferBuilderSchema = seedProvenanceSchema.extend({
	nftId: z.string().min(1, "Invalid NFT ID format"),
	from: usernameSchema,
	to: usernameSchema,
}).refine((data) => data.from !== data.to, {
	message: "Cannot transfer to yourself",
	path: ["to"],
});
export type TransferBuilderInput = z.infer<typeof transferBuilderSchema>;

export function buildTransfer(
	input: TransferBuilderInput,
): KeychainResult<TransferData> {
	const parsed = transferBuilderSchema.safeParse(input);
	if (!parsed.success) {
		return { success: false, errors: formatZodError(parsed.error) };
	}

	const data = parsed.data;

	const transferData: TransferData = {
		nftId: data.nftId,
		to: data.to,
		...(data.seedId && { seedId: data.seedId }),
		...(data.seedTxId && { seedTxId: data.seedTxId }),
	};

	const payload = createPayload("transfer", transferData);
	const operation = createHiveOperation(payload, data.from);

	return {
		success: true,
		operations: [operation],
		keyType: getKeyType("transfer"),
		signer: data.from,
		payload,
	};
}
