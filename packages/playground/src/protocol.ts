// NFTLox Protocol - Playground Utilities
// Funciones para generar operaciones de prueba

import {
	PROTOCOL_ID,
	PROTOCOL_VERSION,
	createDeterministicCollectionPayload,
	createDeterministicMintPayload,
	toHiveOperation,
	generateDeterministicCollectionId,
	generateDeterministicSeedId,
	type DeterministicCollectionInput,
	type HiveOperation,
	type ImportedNFT,
	type SeedNFTWithArtId,
} from "nftlox-sdk";

// ============ TYPES ============

export interface BatchMintResult {
	collectionId: string;
	collectionOriginDna: string;
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

export async function createTestCollection(
	creator: string,
	name: string,
	symbol: string,
	totalPotential: number,
	options?: CollectionOptions,
) {
	const input: DeterministicCollectionInput = {
		name,
		symbol,
		creator,
		totalPotential,
		metadata: {
			description: options?.description || `${name} - NFTLox Protocol Collection`,
			image: options?.image || "",
		},
		rules: {
			transferable: true,
			burnable: true,
			replicable: true,
			royaltyPct: 5,
			royaltyRecipient: creator,
		},
	};

	const payload = await createDeterministicCollectionPayload(input);
	const operation = toHiveOperation(payload, creator);

	return { payload, operation };
}

// ============ SEED MINTING ============

// ============ BATCH HELPERS ============

/**
 * Divide operaciones en lotes para evitar exceder límites de transacción.
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
 * Calcula el tamaño en bytes de una operación.
 */
export function getOperationSize(operation: HiveOperation): number {
	return JSON.stringify(operation).length;
}

/**
 * Verifica que todas las operaciones tengan la versión correcta.
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
 * Carga y parsea un archivo JSON de NFTs de muestra.
 */
export async function loadSampleNFTs(filePath: string): Promise<SeedNFTWithArtId[]> {
	const file = Bun.file(filePath);
	const raw = await file.json();

	// Support unified format { collection, seeds } or plain array
	const data = Array.isArray(raw) ? raw : raw.seeds;

	return data.map((item: ImportedNFT & { maxSupply?: number }) => ({
		nftId: item.nftId,
		name: item.name,
		brief: item.brief,
		imageUrl: item.imageUrl,
		maxSupply: item.maxSupply ?? item.maxReplicas ?? 1,
	}));
}

// ============ PREVIEW HELPERS ============

/**
 * Genera un preview de las operaciones sin ejecutarlas.
 */
export function previewBatchMint(
	nfts: SeedNFTWithArtId[],
	collectionName: string,
): {
	collection: { name: string; symbol: string; totalPotential: number };
	seeds: Array<{ name: string; maxSupply: number }>;
	summary: { totalSeeds: number; totalPotentialInstances: number };
} {
	const totalPotential = nfts.reduce((sum, nft) => sum + nft.maxSupply, 0);
	const symbol = collectionName.slice(0, 8).toUpperCase().replace(/[^A-Z0-9]/g, "");

	return {
		collection: {
			name: collectionName,
			symbol: symbol.length >= 3 ? symbol : symbol.padEnd(3, "X"),
			totalPotential,
		},
		seeds: nfts.map((nft) => ({
			name: nft.name,
			maxSupply: nft.maxSupply,
		})),
		summary: {
			totalSeeds: nfts.length,
			totalPotentialInstances: totalPotential,
		},
	};
}

// ============ DETERMINISTIC FUNCTIONS (Anti-Duplication) ============

/**
 * Creates a test collection with deterministic ID.
 * Same creator + name + symbol always produces the same collectionId.
 */
export async function createDeterministicCollection(
	creator: string,
	name: string,
	symbol: string,
	totalPotential: number,
	options?: CollectionOptions,
): Promise<{
	payload: Awaited<ReturnType<typeof createDeterministicCollectionPayload>>;
	operation: HiveOperation;
	collectionId: string;
}> {
	const collectionId = await generateDeterministicCollectionId(creator, name, symbol);

	const payload = await createDeterministicCollectionPayload({
		name,
		symbol,
		creator,
		totalPotential,
		metadata: {
			description: options?.description || `${name} - NFTLox Protocol Collection`,
			image: options?.image || "",
		},
		rules: {
			transferable: true,
			burnable: true,
			replicable: true,
			royaltyPct: 5,
			royaltyRecipient: creator,
		},
	});

	const operation: HiveOperation = [
		"custom_json",
		{
			required_auths: [],
			required_posting_auths: [creator],
			id: PROTOCOL_ID,
			json: JSON.stringify(payload),
		},
	];

	return { payload, operation, collectionId };
}

export interface DeterministicBatchMintResult {
	collectionId: string;
	collectionOriginDna: string;
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
	nfts: SeedNFTWithArtId[],
	collectionId: string,
	collectionOriginDna: string,
	owner: string,
): Promise<DeterministicBatchMintResult> {
	const seeds: DeterministicBatchMintResult["seeds"] = [];

	for (let i = 0; i < nfts.length; i++) {
		const nft = nfts[i]!;
		const seedId = await generateDeterministicSeedId(collectionId, nft.artId);

		const payload = await createDeterministicMintPayload({
			artId: nft.artId,
			collectionId,
			collectionOriginDna,
			edition: i + 1,
			owner,
			name: nft.name,
			description: nft.brief,
			imageUrl: nft.imageUrl,
			maxReplicas: nft.maxSupply,
		});

		const operation: HiveOperation = [
			"custom_json",
			{
				required_auths: [],
				required_posting_auths: [owner],
				id: PROTOCOL_ID,
				json: JSON.stringify(payload),
			},
		];

		seeds.push({
			artId: nft.artId,
			seedId,
			name: nft.name,
			maxSupply: nft.maxSupply,
			operation,
		});
	}

	return {
		collectionId,
		collectionOriginDna,
		seeds,
		totalOperations: seeds.length,
	};
}

/**
 * Loads and parses a JSON file of NFTs with artId.
 */
export async function loadSampleNFTsWithArtId(filePath: string): Promise<SeedNFTWithArtId[]> {
	const file = Bun.file(filePath);
	const raw = await file.json();

	// Support unified format { collection, seeds } or plain array
	const data = Array.isArray(raw) ? raw : raw.seeds;

	return data.map((item: ImportedNFT & { artId?: string; maxSupply?: number }) => ({
		artId: item.artId || "",
		name: item.name,
		brief: item.brief,
		imageUrl: item.imageUrl,
		maxSupply: item.maxSupply ?? item.maxReplicas ?? 1,
	}));
}

/**
 * Generates a preview with artId information.
 */
export async function previewBatchMintWithArtId(
	nfts: SeedNFTWithArtId[],
	collectionName: string,
	creator: string,
	symbol: string,
): Promise<{
	collection: { name: string; symbol: string; totalPotential: number; collectionId: string };
	seeds: Array<{ artId: string; seedId: string; name: string; maxSupply: number }>;
	summary: { totalSeeds: number; totalPotentialInstances: number };
}> {
	const totalPotential = nfts.reduce((sum, nft) => sum + nft.maxSupply, 0);
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
		seeds: await Promise.all(nfts.map(async (nft) => ({
			artId: nft.artId,
			seedId: await generateDeterministicSeedId(collectionId, nft.artId),
			name: nft.name,
			maxSupply: nft.maxSupply,
		}))),
		summary: {
			totalSeeds: nfts.length,
			totalPotentialInstances: totalPotential,
		},
	};
}
