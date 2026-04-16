import { z } from "zod";
import { usernameSchema } from "../schemas";
import { formatZodError } from "./helpers";
import { validateArtId, validateArtIdArray } from "../dna";
import type { KeychainResult } from "./types";
import type { ValidationError } from "./types";
import {
	generateDeterministicSeedId,
	generateOriginDna,
	generateImageHash,
	generateInstanceDna,
	generateDeterministicInstanceId,
	createPayload,
	createHiveOperation,
	getKeyType,
	MAX_NAME_LENGTH,
	MAX_DESCRIPTION_LENGTH,
	MAX_IMAGE_URL_LENGTH,
	type NFTData,
} from "@nftlox/protocol";

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
	signer: usernameSchema,
	owner: usernameSchema.optional(),
	edition: z.number().int().min(1, "Edition must be at least 1"),
	collectionBlock: z.number().int().nonnegative().optional(),
});

export async function buildSeed(
	input: z.infer<typeof seedBuilderInputSchema>,
): Promise<KeychainResult<NFTData>> {
	const parsed = seedBuilderInputSchema.safeParse(input);
	if (!parsed.success) {
		return { success: false, errors: formatZodError(parsed.error) };
	}
	const data = parsed.data;

	const artIdValidation = validateArtId(data.artId);
	if (!artIdValidation.valid) {
		return {
			success: false,
			errors: [{ field: "artId", message: artIdValidation.error!, code: "INVALID_ARTID" }],
		};
	}

	const warnings: string[] = [];
	if (data.maxSupply > 10000) {
		warnings.push("Max supply is very large (>10000), ensure this is intentional");
	}

	const seedId = await generateDeterministicSeedId(data.collectionId, data.artId);
	const originDna = await generateOriginDna(data.collectionId);
	const owner = data.owner ?? data.signer;
	const imageHash = await generateImageHash(data.imageUrl);
	const instanceDna = await generateInstanceDna(seedId, originDna, data.edition, imageHash);
	const nftId = await generateDeterministicInstanceId(seedId, data.edition);

	const nftData: NFTData = {
		id: nftId,
		collectionId: data.collectionId,
		edition: data.edition,
		owner,
		nftType: "seed",
		originDna,
		instanceDna,
		mintedBy: data.signer,
		...(data.collectionBlock !== undefined && { collectionBlock: data.collectionBlock }),
		metadata: {
			name: data.name,
			...(data.brief !== undefined && { description: data.brief }),
			imageUrl: data.imageUrl,
			imageHash,
		},
		maxSupply: data.maxSupply,
	};

	const payload = createPayload("mint", nftData);
	const operation = createHiveOperation(payload, data.signer);

	return {
		success: true,
		operations: [operation],
		keyType: getKeyType("mint"),
		signer: data.signer,
		payload,
		generatedIds: { seedId },
		...(warnings.length > 0 && { warnings }),
	};
}

// Batch seed planning: validates artIds + pre-computes seed IDs.
// Returns a plan (no operations). Consumers iterate and call buildSeed per item.

export const seedBatchInputSchema = z.object({
	collectionId: z.string().min(1, "Collection ID is required"),
	signer: usernameSchema,
	owner: usernameSchema.optional(),
	seeds: z.array(seedInputSchema).min(1, "At least one seed is required"),
});
export type SeedBatchInput = z.infer<typeof seedBatchInputSchema>;

export type SeedBatchPlanItem = {
	readonly seedId: string;
	readonly artId: string;
	readonly name: string;
	readonly imageUrl: string;
	readonly maxSupply: number;
	readonly brief?: string | undefined;
};

export type SeedBatchPlan =
	| {
		readonly success: true;
		readonly collectionId: string;
		readonly owner: string;
		readonly signer: string;
		readonly seeds: readonly SeedBatchPlanItem[];
		readonly generatedIds: Readonly<Record<string, string>>;
		readonly warnings?: readonly string[] | undefined;
	}
	| { readonly success: false; readonly errors: readonly ValidationError[] };

export async function buildSeedBatch(input: SeedBatchInput): Promise<SeedBatchPlan> {
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
			errors.push({
				field: `seeds[${error.index}].artId`,
				message: error.error,
				code: "INVALID_ARTID",
			});
		}
		for (const duplicate of artIdValidation.duplicates) {
			errors.push({
				field: "seeds",
				message: `Duplicate artId: ${duplicate}`,
				code: "DUPLICATE_ARTID",
			});
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

	const batchOwner = data.owner ?? data.signer;

	const processedSeeds: SeedBatchPlanItem[] = await Promise.all(
		data.seeds.map(async (seed) => {
			const seedId = await generateDeterministicSeedId(data.collectionId, seed.artId);
			return {
				seedId,
				artId: seed.artId,
				name: seed.name,
				imageUrl: seed.imageUrl,
				maxSupply: seed.maxSupply,
				...(seed.brief !== undefined && { brief: seed.brief }),
			};
		}),
	);

	const generatedIds: Record<string, string> = {};
	for (const seed of processedSeeds) {
		generatedIds[seed.artId] = seed.seedId;
	}

	return {
		success: true,
		collectionId: data.collectionId,
		owner: batchOwner,
		signer: data.signer,
		seeds: processedSeeds,
		generatedIds,
		...(warnings.length > 0 && { warnings }),
	};
}
