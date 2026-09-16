// NFTLox Protocol - Playground Utilities
// Funciones para generar operaciones de prueba

import {
	PROTOCOL_ID,
	PROTOCOL_VERSION,
	buildCollection,
	buildSeed,
	generateDeterministicCollectionId,
	generateDeterministicSeedId,
	type CreateCollectionInput,
	type CollectionData,
	type HiveOperation,
	type ImportedAsset,
	type ProtocolPayload,
	type SeedAssetWithArtId,
} from "nftlox-sdk";

// ============ TYPES ============

export interface BatchMintResult {
	collectionId: string;
	seeds: Array<{
		seedId: string;
		name: string;
		maxSupply: number;
		operation: HiveOperation;
	}>;
	totalOperations: number;
}

// ============ COLLECTION CREATION ============

export interface CollectionOptions {
	image?: string;
	description?: string;
}

function buildCollectionInput(
	creator: string,
	name: string,
	symbol: string,
	totalPotential: number,
	options?: CollectionOptions,
): CreateCollectionInput {
	return {
		name,
		symbol,
		creator,
		totalPotential,
		// Default to 0 (unlimited) — playground UI sets a real value when the
		// user opts into a per-collection cap.
		maxInstances: 0,
		metadata: {
			description: options?.description || `${name} - NFTLox Protocol Collection`,
			image: options?.image || "https://placehold.co/400x400?text=Asset",
		},
		rules: {
			transferable: true,
			burnable: true,
			royaltyPct: 5,
			royaltyRecipient: creator,
		},
	};
}

function findCustomJsonOperation(
	operations: ReadonlyArray<readonly [string, Record<string, unknown>]>,
): HiveOperation {
	const op = operations.find((candidate) => candidate[0] === "custom_json");
	if (!op) throw new Error("Expected a custom_json operation in build output");
	return op as unknown as HiveOperation;
}

export async function createTestCollection(
	creator: string,
	name: string,
	symbol: string,
	totalPotential: number,
	nodeAccount: string,
	options?: CollectionOptions,
): Promise<{
	payload: ProtocolPayload<CollectionData>;
	operation: HiveOperation;
}> {
	const input = buildCollectionInput(creator, name, symbol, totalPotential, options);
	const result = await buildCollection(input, { nodeAccount });
	if (!result.success) {
		throw new Error(`Collection build failed: ${result.errors.map((e) => e.message).join(", ")}`);
	}
	return {
		payload: result.payload,
		operation: findCustomJsonOperation(result.operations),
	};
}

// ============ SEED MINTING ============

// ============ BATCH HELPERS ============

/**
 * Splits operations into batches to avoid exceeding per-transaction limits.
 */
export function splitOperationsIntoBatches(
	operations: HiveOperation[],
	maxPerBatch = 5,
): HiveOperation[][] {
	const batches: HiveOperation[][] = [];

	for (let i = 0; i < operations.length; i += maxPerBatch) {
		batches.push(operations.slice(i, i + maxPerBatch));
	}

	return batches;
}

/**
 * Returns the size in bytes of a single operation.
 */
export function getOperationSize(operation: HiveOperation): number {
	return JSON.stringify(operation).length;
}

/**
 * Verifies that every operation carries the expected protocol version.
 */
export function validateOperationsVersion(
	operations: HiveOperation[],
	expectedVersion = PROTOCOL_VERSION,
): { valid: boolean; errors: string[] } {
	const errors: string[] = [];

	for (let i = 0; i < operations.length; i++) {
		const op = operations[i]!;
		try {
			const payload = JSON.parse(op[1].json);
			if (payload.version !== expectedVersion) {
				errors.push(`Operation ${i}: version ${payload.version} !== ${expectedVersion}`);
			}
			if (payload.protocol !== PROTOCOL_ID) {
				errors.push(`Operation ${i}: protocol ${payload.protocol} !== ${PROTOCOL_ID}`);
			}
		} catch {
			errors.push(`Operation ${i}: invalid JSON`);
		}
	}

	return {
		valid: errors.length === 0,
		errors,
	};
}

// ============ SAMPLE DATA LOADER ============

/**
 * Carga y parsea un archivo JSON de Assets de muestra.
 */
export async function loadSampleAssets(filePath: string): Promise<SeedAssetWithArtId[]> {
	const file = Bun.file(filePath);
	const raw = await file.json();

	// Support unified format { collection, seeds } or plain array
	const data = Array.isArray(raw) ? raw : raw.seeds;

	return data.map((item: ImportedAsset & { maxSupply?: number }) => ({
		assetId: item.assetId,
		name: item.name,
		brief: item.brief,
		imageUrl: item.imageUrl,
		maxSupply: item.maxSupply ?? 1,
	}));
}

// ============ PREVIEW HELPERS ============

/**
 * Genera un preview de las operaciones sin ejecutarlas.
 */
export function previewBatchMint(
	assets: SeedAssetWithArtId[],
	collectionName: string,
): {
	collection: { name: string; symbol: string; totalPotential: number };
	seeds: Array<{ name: string; maxSupply: number }>;
	summary: { totalSeeds: number; totalPotentialInstances: number };
} {
	const totalPotential = assets.reduce((sum, asset) => sum + asset.maxSupply, 0);
	const symbol = collectionName.slice(0, 8).toUpperCase().replace(/[^A-Z0-9]/g, "");

	return {
		collection: {
			name: collectionName,
			symbol: symbol.length >= 3 ? symbol : symbol.padEnd(3, "X"),
			totalPotential,
		},
		seeds: assets.map((asset) => ({
			name: asset.name,
			maxSupply: asset.maxSupply,
		})),
		summary: {
			totalSeeds: assets.length,
			totalPotentialInstances: totalPotential,
		},
	};
}

// ============ DETERMINISTIC FUNCTIONS (Anti-Duplication) ============

export interface DeterministicBatchMintResult {
	collectionId: string;
	seeds: Array<{
		artId: string;
		seedId: string;
		name: string;
		maxSupply: number;
		operation: HiveOperation;
	}>;
	totalOperations: number;
}

/**
 * Generates seed mint operations with deterministic seedIds from artIds.
 * Same collectionId + artId always produces the same seedId.
 */
export async function createDeterministicSeedMintOperations(
	assets: SeedAssetWithArtId[],
	collectionId: string,
	owner: string,
): Promise<DeterministicBatchMintResult> {
	const seeds: DeterministicBatchMintResult["seeds"] = [];

	for (let i = 0; i < assets.length; i++) {
		const asset = assets[i]!;
		const result = await buildSeed({
			artId: asset.artId,
			collectionId,
			signer: owner,
			owner,
			edition: i + 1,
			name: asset.name,
			imageUrl: asset.imageUrl,
			maxSupply: asset.maxSupply,
			...(asset.brief !== undefined && { brief: asset.brief }),
		});
		if (!result.success) {
			throw new Error(`Seed build failed for artId=${asset.artId}: ${result.errors.map((e) => e.message).join(", ")}`);
		}

		seeds.push({
			artId: asset.artId,
			seedId: result.generatedIds!.seedId!,
			name: asset.name,
			maxSupply: asset.maxSupply,
			operation: findCustomJsonOperation(result.operations),
		});
	}

	return {
		collectionId,
		seeds,
		totalOperations: seeds.length,
	};
}

/**
 * Loads and parses a JSON file of Assets with artId.
 */
export async function loadSampleAssetsWithArtId(filePath: string): Promise<SeedAssetWithArtId[]> {
	const file = Bun.file(filePath);
	const raw = await file.json();

	// Support unified format { collection, seeds } or plain array
	const data = Array.isArray(raw) ? raw : raw.seeds;

	return data.map((item: ImportedAsset & { artId?: string; maxSupply?: number }) => ({
		artId: item.artId || "",
		name: item.name,
		brief: item.brief,
		imageUrl: item.imageUrl,
		maxSupply: item.maxSupply ?? 1,
	}));
}

/**
 * Generates a preview with artId information.
 */
export async function previewBatchMintWithArtId(
	assets: SeedAssetWithArtId[],
	collectionName: string,
	creator: string,
	symbol: string,
): Promise<{
	collection: { name: string; symbol: string; totalPotential: number; collectionId: string };
	seeds: Array<{ artId: string; seedId: string; name: string; maxSupply: number }>;
	summary: { totalSeeds: number; totalPotentialInstances: number };
}> {
	const totalPotential = assets.reduce((sum, asset) => sum + asset.maxSupply, 0);
	const normalizedSymbol = symbol.toUpperCase().replace(/[^A-Z0-9]/g, "");
	const finalSymbol = normalizedSymbol.length >= 3 ? normalizedSymbol : normalizedSymbol.padEnd(3, "X");

	const collectionId = await generateDeterministicCollectionId(creator, collectionName, finalSymbol);

	return {
		collection: {
			name: collectionName,
			symbol: finalSymbol,
			totalPotential,
			collectionId,
		},
		seeds: await Promise.all(assets.map(async (asset) => ({
			artId: asset.artId,
			seedId: await generateDeterministicSeedId(collectionId, asset.artId),
			name: asset.name,
			maxSupply: asset.maxSupply,
		}))),
		summary: {
			totalSeeds: assets.length,
			totalPotentialInstances: totalPotential,
		},
	};
}
