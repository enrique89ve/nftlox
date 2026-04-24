import { z } from "zod";
import { seedProvenanceSchema, usernameSchema } from "../schemas";
import { formatZodError } from "./helpers";
import type { KeychainResult } from "./types";
import {
	generateImageHash,
	createPayload,
	createHiveOperation,
	getKeyType,
	toWireUrl,
	type TransferData,
} from "@nftlox/protocol";

export const transferBuilderSchema = seedProvenanceSchema.extend({
	nftId: z.string().min(1, "Invalid NFT ID format"),
	from: usernameSchema,
	to: usernameSchema,
	imageUrl: z.string().url("Invalid image URL format").optional(),
	imageHash: z.string().optional(),
}).refine((data) => data.from !== data.to, {
	message: "Cannot transfer to yourself",
	path: ["to"],
});
export type TransferBuilderInput = z.infer<typeof transferBuilderSchema>;

export async function buildTransfer(
	input: TransferBuilderInput,
): Promise<KeychainResult<TransferData>> {
	const parsed = transferBuilderSchema.safeParse(input);
	if (!parsed.success) {
		return { success: false, errors: formatZodError(parsed.error) };
	}

	const data = parsed.data;
	const warnings: string[] = [];

	if (!data.imageUrl) {
		warnings.push("imageUrl not provided - recommended for indexer verification");
	}

	const imageHash = data.imageHash || (data.imageUrl ? await generateImageHash(data.imageUrl) : undefined);

	const transferData: TransferData = {
		nftId: data.nftId,
		from: data.from,
		to: data.to,
		...(data.imageUrl && { imageUrl: toWireUrl(data.imageUrl) }),
		...(imageHash && { imageHash }),
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
		...(warnings.length > 0 && { warnings }),
	};
}
