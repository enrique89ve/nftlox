import { z } from "zod";
import { usernameSchema } from "../schemas";
import { formatZodError } from "./helpers";
import {
	generateDeterministicSeedId,
	generateOriginDna,
	validateArtId,
	validateArtIdArray,
} from "../dna";
import {
	createDeterministicMintPayload,
	createMintOperation,
	type DeterministicMintInput,
} from "../payloads";
import type { BuildResult, NFTData, ProtocolPayload, ValidationError } from "../types";
import { MAX_NAME_LENGTH, MAX_DESCRIPTION_LENGTH, MAX_IMAGE_URL_LENGTH, PROTOCOL_ID, PROTOCOL_VERSION, ACTION_MINT } from "../constants";

// We keep SeedInput internal to builders as per old architecture, or export it.
export const seedInputSchema = z.object({
	artId: z.string(),
	name: z.string().min(1, "Name is required").max(MAX_NAME_LENGTH, `Name must be at most ${MAX_NAME_LENGTH} characters`),
	imageUrl: z.string().url("Invalid image URL format").max(MAX_IMAGE_URL_LENGTH, `Image URL must be at most ${MAX_IMAGE_URL_LENGTH} characters`),
	maxSupply: z.number().int().positive("Max supply must be greater than 0"),
	brief: z.string().max(MAX_DESCRIPTION_LENGTH, `Brief must be at most ${MAX_DESCRIPTION_LENGTH} characters`).optional(),
});
export type SeedInput = z.infer<typeof seedInputSchema>;

export const seedBuilderInputSchema = seedInputSchema.extend({
	collectionId: z.string().min(1, "Collection ID is required"),
	owner: usernameSchema,
	edition: z.number().int().min(1, "Edition must be at least 1"),
	collectionBlock: z.number().int().nonnegative().optional(),
});

export async function buildSeed(input: z.infer<typeof seedBuilderInputSchema>): Promise<BuildResult<NFTData>> {
	const parsed = seedBuilderInputSchema.safeParse(input);
	if (!parsed.success) {
		return { success: false, errors: formatZodError(parsed.error) };
	}
	const data = parsed.data;

	const artIdValidation = validateArtId(data.artId);
	if (!artIdValidation.valid) {
		return { success: false, errors: [{ field: "artId", message: artIdValidation.error!, code: "INVALID_ARTID" }] };
	}

	const warnings: string[] = [];
	if (data.maxSupply > 10000) {
		warnings.push("Max supply is very large (>10000), ensure this is intentional");
	}

	const generatedId = generateDeterministicSeedId(data.collectionId, data.artId);
	const originDna = await generateOriginDna(data.collectionId);

	const mintInput: DeterministicMintInput = {
		artId: data.artId,
		collectionId: data.collectionId,
		collectionOriginDna: originDna,
		edition: data.edition,
		owner: data.owner,
		name: data.name,
		description: data.brief,
		imageUrl: data.imageUrl,
		maxReplicas: data.maxSupply,
		...(data.collectionBlock !== undefined && { collectionBlock: data.collectionBlock }),
	};

	const payload = await createDeterministicMintPayload(mintInput);
	const operation = await createMintOperation({
		collectionId: data.collectionId,
		collectionOriginDna: originDna,
		edition: data.edition,
		owner: data.owner,
		name: data.name,
		description: data.brief,
		imageUrl: data.imageUrl,
		maxReplicas: data.maxSupply,
		collectionBlock: data.collectionBlock ?? 0,
	});

	return {
		success: true,
		payload,
		operation,
		generatedId,
		generatedIds: { seedId: generatedId },
		warnings: warnings.length > 0 ? warnings : undefined,
	};
}

export const seedBatchInputSchema = z.object({
	collectionId: z.string().min(1, "Collection ID is required"),
	owner: usernameSchema,
	seeds: z.array(seedInputSchema).min(1, "At least one seed is required"),
});
export type SeedBatchInput = z.infer<typeof seedBatchInputSchema>;

export interface SeedBatchPayload {
	collectionId: string;
	owner: string;
	seeds: Array<{
		seedId: string;
		artId: string;
		name: string;
		imageUrl: string;
		maxSupply: number;
		brief?: string;
	}>;
}

export function buildSeedBatch(input: SeedBatchInput): BuildResult<SeedBatchPayload> {
	const parsed = seedBatchInputSchema.safeParse(input);
	if (!parsed.success) {
		return { success: false, errors: formatZodError(parsed.error) };
	}
	const data = parsed.data;

	const errors: ValidationError[] = [];
	const warnings: string[] = [];

	const artIds = data.seeds.map((s) => s.artId);
	const artIdValidation = validateArtIdArray(artIds);

	if (!artIdValidation.valid) {
		for (const error of artIdValidation.formatErrors) {
			errors.push({ field: `seeds[${error.index}].artId`, message: error.error, code: "INVALID_ARTID" });
		}
		for (const duplicate of artIdValidation.duplicates) {
			errors.push({ field: "seeds", message: `Duplicate artId: ${duplicate}`, code: "DUPLICATE_ARTID" });
		}
	}

	data.seeds.forEach((seed, i) => {
		if (seed.maxSupply > 10000) {
			warnings.push(`Seed ${i}: Max supply is very large (>10000)`);
		}
	});

	if (errors.length > 0) {
		return { success: false, errors };
	}

	const processedSeeds = data.seeds.map((seed) => {
		const seedId = generateDeterministicSeedId(data.collectionId, seed.artId);
		return {
			seedId,
			artId: seed.artId,
			name: seed.name,
			imageUrl: seed.imageUrl,
			maxSupply: seed.maxSupply,
			brief: seed.brief,
		};
	});

	const payload: ProtocolPayload<SeedBatchPayload> = {
		protocol: PROTOCOL_ID,
		version: PROTOCOL_VERSION,
		action: ACTION_MINT,
		data: {
			collectionId: data.collectionId,
			owner: data.owner,
			seeds: processedSeeds,
		},
	};

	const seedIds: Record<string, string> = {};
	for (const seed of processedSeeds) {
		seedIds[seed.artId] = seed.seedId;
	}

	return {
		success: true,
		payload,
		generatedIds: seedIds,
		warnings: warnings.length > 0 ? warnings : undefined,
	};
}
