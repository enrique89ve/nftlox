import { z } from "zod";
import { createCollectionInputSchema, archiveCollectionInputSchema, usernameSchema, type CreateCollectionInput } from "../schemas";
import { formatZodError } from "./helpers";
import type { KeychainResult } from "./types";
import {
	generateDeterministicCollectionId,
	generateOriginDna,
	createPayload,
	createHiveOperation,
	getKeyType,
	MAX_NAME_LENGTH,
	type CollectionData,
	type ArchiveCollectionData,
} from "@nftlox/protocol";

export async function buildCollection(
	input: CreateCollectionInput,
): Promise<KeychainResult<CollectionData>> {
	const parsed = createCollectionInputSchema.safeParse(input);
	if (!parsed.success) {
		return { success: false, errors: formatZodError(parsed.error) };
	}

	const data = parsed.data;
	const warnings: string[] = [];

	if (data.name.length > MAX_NAME_LENGTH * 0.9) {
		warnings.push("Name is close to maximum length, consider shortening");
	}
	if (data.rules.royaltyPct > 25) {
		warnings.push("Royalty percentage is high (>25%), consider reducing");
	}

	const collectionId = await generateDeterministicCollectionId(
		data.creator,
		data.name,
		data.symbol,
	);
	const originDna = await generateOriginDna(collectionId);

	const collectionData: CollectionData = {
		id: collectionId,
		name: data.name,
		symbol: data.symbol.toUpperCase(),
		creator: data.creator,
		totalPotential: data.totalPotential,
		originDna,
		metadata: data.metadata,
		rules: data.rules,
		...(data.schema && { schema: data.schema }),
	};

	const payload = createPayload("create_collection", collectionData);
	const operation = createHiveOperation(payload, data.creator);

	return {
		success: true,
		operations: [operation],
		keyType: getKeyType("create_collection"),
		signer: data.creator,
		payload,
		generatedIds: { collectionId, originDna },
		...(warnings.length > 0 && { warnings }),
	};
}

export const archiveCollectionBuilderSchema = archiveCollectionInputSchema.extend({
	creator: usernameSchema,
});
export type ArchiveCollectionBuilderInput = z.infer<typeof archiveCollectionBuilderSchema>;

export function buildArchiveCollection(
	input: ArchiveCollectionBuilderInput,
): KeychainResult<ArchiveCollectionData> {
	const parsed = archiveCollectionBuilderSchema.safeParse(input);
	if (!parsed.success) {
		return { success: false, errors: formatZodError(parsed.error) };
	}

	const data = parsed.data;
	const payload = createPayload("archive_collection", {
		collectionId: data.collectionId,
	} satisfies ArchiveCollectionData);
	const operation = createHiveOperation(payload, data.creator);

	return {
		success: true,
		operations: [operation],
		keyType: getKeyType("archive_collection"),
		signer: data.creator,
		payload,
	};
}
