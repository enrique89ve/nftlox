import { createCollectionInputSchema, type CreateCollectionInput } from "../schemas";
import { formatZodError } from "./helpers";
import {
	generateDeterministicCollectionId,
	generateOriginDnaSync,
} from "../dna";
import {
	createDeterministicCollectionPayload,
	createCollectionOperation,
	type DeterministicCollectionInput,
} from "../payloads";
import type { BuildResult, CollectionData } from "../types";
import { MAX_NAME_LENGTH } from "../constants";

export function buildCollection(input: CreateCollectionInput): BuildResult<CollectionData> {
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

	const generatedId = generateDeterministicCollectionId(
		data.creator,
		data.name,
		data.symbol,
	);
	const originDna = generateOriginDnaSync(generatedId);

	const collectionInput: DeterministicCollectionInput = {
		creator: data.creator,
		name: data.name,
		symbol: data.symbol,
		totalPotential: data.totalPotential,
		metadata: data.metadata,
		rules: data.rules,
	};

	const payload = createDeterministicCollectionPayload(collectionInput);
	const operation = createCollectionOperation({
		...collectionInput,
		jsonId: data.jsonId, // using original non-deterministic jsonId
	});

	return {
		success: true,
		payload,
		operation,
		generatedId,
		generatedIds: { collectionId: generatedId, originDna },
		warnings: warnings.length > 0 ? warnings : undefined,
	};
}
