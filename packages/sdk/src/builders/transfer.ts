import { z } from "zod";
import { usernameSchema, seedProvenanceSchema } from "../schemas";
import { formatZodError } from "./helpers";
import { generateImageHash } from "../dna";
import { PROTOCOL_ID, PROTOCOL_VERSION, ACTION_TRANSFER } from "../constants";
import type { BuildResult, TransferData, ProtocolPayload, HiveOperation } from "../types";

export const transferBuilderSchema = seedProvenanceSchema.extend({
	nftId: z.string().min(1, "Invalid NFT ID format"),
	from: usernameSchema,
	to: usernameSchema,
	imageUrl: z.string().url("Invalid image URL format").optional(),
	imageHash: z.string().optional(),
}).refine(data => data.from !== data.to, {
	message: "Cannot transfer to yourself",
	path: ["to"],
});

export type TransferBuilderInput = z.infer<typeof transferBuilderSchema>;

export async function buildTransfer(input: TransferBuilderInput): Promise<BuildResult<TransferData>> {
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

	const payload: ProtocolPayload<TransferData> = {
		protocol: PROTOCOL_ID,
		version: PROTOCOL_VERSION,
		action: ACTION_TRANSFER,
		data: {
			nftId: data.nftId,
			from: data.from,
			to: data.to,
			...(data.imageUrl && { imageUrl: data.imageUrl }),
			...(imageHash && { imageHash }),
			...(data.seedId && { seedId: data.seedId }),
			...(data.birthTx && { birthTx: data.birthTx }),
		},
	};

	const operation: HiveOperation = [
		"custom_json",
		{
			required_auths: [data.from],
			required_posting_auths: [],
			id: PROTOCOL_ID,
			json: JSON.stringify(payload),
		},
	];

	return {
		success: true,
		payload,
		operation,
		warnings: warnings.length > 0 ? warnings : undefined,
	};
}
