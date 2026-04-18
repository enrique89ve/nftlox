import { z } from "zod";
import { createCollectionInputSchema, usernameSchema } from "../schemas";
import { seedInputSchema } from "./seed";
import { formatZodError } from "./helpers";
import type { ValidationError, CoSigner } from "./types";
import { buildCollection, type BuildCollectionOptions } from "./collection";
import { buildSeed, buildSeedBatch, type SeedBatchPlanItem } from "./seed";
import { splitIntoBatches, calculateMaxOperationsPerTx } from "../utils/tx-sizing";
import {
	MAX_OPERATIONS_PER_TX,
	type HiveOperation,
	type CollectionData,
	type ProtocolPayload,
	type HiveTransferOperation,
} from "@nftlox/protocol";

// ─── Input Schema ────────────────────────────────────────

export const collectionWithSeedsInputSchema = createCollectionInputSchema.extend({
	seeds: z.array(seedInputSchema).min(1, "At least one seed required"),
	owner: usernameSchema.optional(),
	editionStart: z.number().int().min(1).default(1),
});

export type CollectionWithSeedsInput = z.infer<typeof collectionWithSeedsInputSchema>;

// ─── Output Types ────────────────────────────────────────

export type CollectionCreationPlan =
	| {
			readonly success: true;
			readonly collectionId: string;
			readonly signer: string;
			readonly totalSeedCount: number;
			readonly collectionStep: {
				readonly operations: ReadonlyArray<HiveOperation | HiveTransferOperation>;
				readonly keyType: "Active";
				readonly coSigners: readonly CoSigner[];
				readonly payload: ProtocolPayload<CollectionData>;
				readonly generatedIds: Readonly<{ readonly collectionId: string; readonly originDna: string }>;
			};
			readonly seedBatches: ReadonlyArray<{
				readonly batchNumber: number;
				readonly operations: ReadonlyArray<HiveOperation>;
				readonly keyType: "Posting";
				readonly signer: string;
				readonly seeds: ReadonlyArray<{ readonly artId: string; readonly seedId: string; readonly name: string }>;
				readonly warnings?: readonly string[] | undefined;
			}>;
			readonly generatedIds: Readonly<Record<string, string>>;
			readonly warnings?: readonly string[] | undefined;
	  }
	| { readonly success: false; readonly errors: readonly ValidationError[] };

// ─── Main Orchestrator ────────────────────────────────────

export async function buildCollectionWithSeeds(
	input: CollectionWithSeedsInput,
	options: BuildCollectionOptions,
): Promise<CollectionCreationPlan> {
	const parsed = collectionWithSeedsInputSchema.safeParse(input);
	if (!parsed.success) {
		return { success: false, errors: formatZodError(parsed.error) };
	}

	const data = parsed.data;

	// Step 1: Build collection
	const collectionResult = await buildCollection(data, options);
	if (!collectionResult.success) {
		return { success: false, errors: collectionResult.errors };
	}

	const collectionId = collectionResult.generatedIds?.collectionId;
	if (!collectionId) {
		return {
			success: false,
			errors: [{ field: "collectionId", message: "Failed to generate collection ID", code: "INTERNAL_ERROR" }],
		};
	}

	// Step 2: Plan seeds (validate + pre-compute IDs)
	const seedBatchPlan = await buildSeedBatch({
		collectionId,
		signer: data.creator,
		owner: data.owner,
		seeds: data.seeds,
	});

	if (!seedBatchPlan.success) {
		return { success: false, errors: seedBatchPlan.errors };
	}

	// Step 3: Determine optimal batch size using tx-sizing
	const firstSeed = data.seeds[0];
	if (!firstSeed) {
		return {
			success: false,
			errors: [{ field: "seeds", message: "At least one seed is required", code: "INVALID_INPUT" }],
		};
	}

	const sampleBuildResult = await buildSeed({
		artId: firstSeed.artId,
		name: firstSeed.name,
		imageUrl: firstSeed.imageUrl,
		maxSupply: firstSeed.maxSupply,
		brief: firstSeed.brief,
		immutableData: firstSeed.immutableData,
		collectionId,
		signer: data.creator,
		owner: data.owner,
		edition: data.editionStart ?? 1,
	});

	if (!sampleBuildResult.success) {
		return { success: false, errors: sampleBuildResult.errors };
	}

	const sampleOp = sampleBuildResult.operations[0] as HiveOperation;
	const maxOpsPerTx = calculateMaxOperationsPerTx(sampleOp);
	const effectiveBatchSize = Math.min(maxOpsPerTx, MAX_OPERATIONS_PER_TX);

	// Step 4: Split seeds into batches
	const seedBatches = splitIntoBatches([...seedBatchPlan.seeds], effectiveBatchSize);

	// Step 5: Build operations for each batch
	type SeedBatchOutput = {
		batchNumber: number;
		operations: ReadonlyArray<HiveOperation>;
		keyType: "Posting";
		signer: string;
		seeds: ReadonlyArray<{ artId: string; seedId: string; name: string }>;
		warnings?: readonly string[] | undefined;
	};

	const builtBatches: SeedBatchOutput[] = [];
	const allErrors: ValidationError[] = [];
	const allWarnings: string[] = [];
	const allGeneratedIds: Record<string, string> = { ...seedBatchPlan.generatedIds };

	let absoluteSeedIndex = 0;

	for (let batchNumber = 0; batchNumber < seedBatches.length; batchNumber++) {
		const batch = seedBatches[batchNumber];
		if (!batch) break;

		const batchOperations: HiveOperation[] = [];
		const batchSeeds: Array<{ artId: string; seedId: string; name: string }> = [];
		const batchWarnings: string[] = [];

		const batchResults = await Promise.all(
			batch.map((planItem) => {
				const edition = (data.editionStart ?? 1) + absoluteSeedIndex;
				absoluteSeedIndex++;
				const seedRecord = data.seeds.find((s) => s.artId === planItem.artId);

				if (!seedRecord) {
					return {
						success: false as const,
						errors: [{ field: "artId", message: `Seed not found: ${planItem.artId}`, code: "INTERNAL_ERROR" }],
					};
				}

				return buildSeed({
					artId: planItem.artId,
					name: planItem.name,
					imageUrl: planItem.imageUrl,
					maxSupply: planItem.maxSupply,
					brief: planItem.brief,
					immutableData: planItem.immutableData,
					collectionId,
					signer: data.creator,
					owner: data.owner,
					edition,
				});
			}),
		);

		for (const result of batchResults) {
			if (!result.success) {
				allErrors.push(...result.errors);
			} else {
				batchOperations.push(...(result.operations as HiveOperation[]));
				batchSeeds.push({
					artId: seedBatchPlan.seeds.find((s) => s.seedId === result.generatedIds?.seedId)?.artId ?? "",
					seedId: result.generatedIds?.seedId ?? "",
					name: result.payload.data.metadata.name,
				});
				if (result.warnings) {
					batchWarnings.push(...result.warnings);
				}
			}
		}

		if (batchOperations.length > 0) {
			builtBatches.push({
				batchNumber: batchNumber + 1,
				operations: batchOperations,
				keyType: "Posting",
				signer: data.creator,
				seeds: batchSeeds,
				...(batchWarnings.length > 0 && { warnings: batchWarnings }),
			});
		}
	}

	if (allErrors.length > 0) {
		return { success: false, errors: allErrors };
	}

	if (collectionResult.warnings) {
		allWarnings.push(...collectionResult.warnings);
	}
	if (seedBatchPlan.warnings) {
		allWarnings.push(...seedBatchPlan.warnings);
	}

	const plan: CollectionCreationPlan = {
		success: true,
		collectionId,
		signer: data.creator,
		totalSeedCount: data.seeds.length,
		collectionStep: {
			operations: collectionResult.operations,
			keyType: "Active",
			coSigners: collectionResult.coSigners ?? [],
			payload: collectionResult.payload as ProtocolPayload<CollectionData>,
			generatedIds: {
				collectionId: collectionResult.generatedIds?.collectionId ?? "",
				originDna: collectionResult.generatedIds?.originDna ?? "",
			},
		},
		seedBatches: builtBatches,
		generatedIds: allGeneratedIds,
		...(allWarnings.length > 0 && { warnings: allWarnings }),
	};

	return plan;
}

