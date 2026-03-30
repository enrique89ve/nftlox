import { z } from "zod";
import { createCollectionInputSchema, archiveCollectionInputSchema, type CreateCollectionInput } from "../schemas";
import { formatZodError } from "./helpers";
import {
	generateDeterministicCollectionId,
	generateOriginDna,
} from "../dna";
import {
	createArchiveCollectionPayload,
	createDeterministicCollectionPayload,
	createArchiveCollectionOperation,
	toHiveOperation,
	type DeterministicCollectionInput,
} from "../payloads";
import type { ArchiveCollectionData, BuildResult, CollectionData } from "../types";
import { MAX_NAME_LENGTH } from "../constants";
import { usernameSchema } from "../schemas";

export async function buildCollection(input: CreateCollectionInput): Promise<BuildResult<CollectionData>> {
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

	const generatedId = await generateDeterministicCollectionId(
		data.creator,
		data.name,
		data.symbol,
	);
	const originDna = await generateOriginDna(generatedId);

	const collectionInput: DeterministicCollectionInput = {
		creator: data.creator,
		name: data.name,
		symbol: data.symbol,
		totalPotential: data.totalPotential,
		metadata: data.metadata,
		rules: data.rules,
		...(data.schema && { schema: data.schema }),
	};

	const payload = await createDeterministicCollectionPayload(collectionInput);
	const operation = toHiveOperation(payload, data.creator);

	return {
		success: true,
		payload,
		operation,
		generatedId,
		generatedIds: { collectionId: generatedId, originDna },
		warnings: warnings.length > 0 ? warnings : undefined,
	};
}

export const archiveCollectionBuilderSchema = archiveCollectionInputSchema.extend({
	creator: usernameSchema,
});
export type ArchiveCollectionBuilderInput = z.infer<typeof archiveCollectionBuilderSchema>;

export function buildArchiveCollection(
	input: ArchiveCollectionBuilderInput,
): BuildResult<ArchiveCollectionData> {
	const parsed = archiveCollectionBuilderSchema.safeParse(input);
	if (!parsed.success) {
		return { success: false, errors: formatZodError(parsed.error) };
	}

	const data = parsed.data;
	const payload = createArchiveCollectionPayload(data);
	const operation = createArchiveCollectionOperation(data, data.creator);

	return {
		success: true,
		payload,
		operation,
	};
}
