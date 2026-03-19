// NFTLox Protocol - Playground Utilities (Refactored)
// Clean architecture with proper separation of concerns

import {
	PROTOCOL_ID,
	PROTOCOL_VERSION,
	createCollectionPayload,
	createMintPayload,
	createDistributePayload,
	createDeterministicCollectionPayload,
	createDeterministicMintPayload,
	generateSeedId,
	generateDeterministicCollectionId,
	generateDeterministicSeedId,
	type CreateCollectionInput,
	type MintInput,
	type DistributeInput,
	type HiveOperation,
	type ImportedNFT,
	type SeedNFTWithArtId,
} from "nftlox-sdk";

import {
	DEFAULT_COLLECTION_IMAGE,
	TEST_COLLECTION_SUFFIX,
	PRODUCTION_COLLECTION_SUFFIX,
	DEFAULT_ROYALTY_PCT,
	DEFAULT_TRANSFERABLE,
	DEFAULT_BURNABLE,
	DEFAULT_STARTING_INSTANCE_NUMBER,
	CollectionType,
} from "./constants";

import { normalizeSymbolForCollection, generateSymbolFromName, getArrayElement } from "./utils";

// ============ TYPES ============

export interface SeedNFT {
	nftId?: string;
	name: string;
	brief?: string;
	imageUrl: string;
	maxSupply: number;
}

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

export interface DistributeBatchResult {
	seedId: string;
	instances: Array<{
		instanceId: string;
		to: string;
		instanceNumber: number;
		operation: HiveOperation;
	}>;
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

export interface CollectionPreview {
	collection: {
		name: string;
		symbol: string;
		totalPotential: number;
	};
	seeds: Array<{
		name: string;
		maxSupply: number;
	}>;
	summary: {
		totalSeeds: number;
		totalPotentialInstances: number;
	};
}

export interface DeterministicCollectionPreview {
	collection: {
		name: string;
		symbol: string;
		totalPotential: number;
		collectionId: string;
	};
	seeds: Array<{
		artId: string;
		seedId: string;
		name: string;
		maxSupply: number;
	}>;
	summary: {
		totalSeeds: number;
		totalPotentialInstances: number;
	};
}

// ============ COLLECTION CREATION ============

/**
 * Creates collection metadata for a given collection type.
 */
function createCollectionMetadata(
	name: string,
	collectionType: CollectionType,
): { description: string; image: string } {
	const suffix =
		collectionType === CollectionType.TEST
			? TEST_COLLECTION_SUFFIX
			: PRODUCTION_COLLECTION_SUFFIX;

	return {
		description: `${name} ${suffix}`,
		image: DEFAULT_COLLECTION_IMAGE,
	};
}

/**
 * Creates collection rules with default values.
 */
function createCollectionRules(creator: string) {
	return {
		transferable: DEFAULT_TRANSFERABLE,
		burnable: DEFAULT_BURNABLE,
		royaltyPct: DEFAULT_ROYALTY_PCT,
		royaltyRecipient: creator,
	};
}

/**
 * Creates a Hive operation wrapper for a payload.
 */
function createHiveOperation(payload: unknown, creator: string): HiveOperation {
	return [
		"custom_json",
		{
			required_auths: [],
			required_posting_auths: [creator],
			id: PROTOCOL_ID,
			json: JSON.stringify(payload),
		},
	];
}

/**
 * Creates a test collection with standard configuration.
 */
export function createTestCollection(
	creator: string,
	name: string,
	symbol: string,
	totalPotential: number,
): {
	payload: ReturnType<typeof createCollectionPayload>;
	operation: HiveOperation;
} {
	const metadata = createCollectionMetadata(name, CollectionType.TEST);
	const rules = createCollectionRules(creator);

	const input: CreateCollectionInput = {
		jsonId: `json_${Date.now()}`,
		name,
		symbol,
		creator,
		totalPotential,
		metadata,
		rules,
	};

	const payload = createCollectionPayload(input);
	const operation = createHiveOperation(payload, creator);

	return { payload, operation };
}

// ============ SEED MINTING ============

/**
 * Creates a single seed mint operation.
 */
function createSeedMintOperation(
	nft: SeedNFT,
	collectionId: string,
	collectionOriginDna: string,
	owner: string,
	edition: number,
): {
	seedId: string;
	name: string;
	maxSupply: number;
	operation: HiveOperation;
} {
	const seedId = generateSeedId();

	const input: MintInput = {
		collectionId,
		collectionOriginDna,
		edition,
		owner,
		name: nft.name,
		description: nft.brief,
		imageUrl: nft.imageUrl,
		maxReplicas: nft.maxSupply,
	};

	const payload = createMintPayload(input);
	payload.data.id = seedId;

	const operation = createHiveOperation(payload, owner);

	return {
		seedId,
		name: nft.name,
		maxSupply: nft.maxSupply,
		operation,
	};
}

/**
 * Generates mint operations for seeds from an array of NFTs.
 * Each seed has maxSupply defining how many instances it can generate.
 */
export function createSeedMintOperations(
	nfts: SeedNFT[],
	collectionId: string,
	collectionOriginDna: string,
	owner: string,
): BatchMintResult {
	const seeds: BatchMintResult["seeds"] = [];

	for (let i = 0; i < nfts.length; i++) {
		const nft = getArrayElement(nfts, i, "createSeedMintOperations");
		const edition = i + 1;

		const seed = createSeedMintOperation(nft, collectionId, collectionOriginDna, owner, edition);
		seeds.push(seed);
	}

	return {
		collectionId,
		collectionOriginDna,
		seeds,
		totalOperations: seeds.length,
	};
}

// ============ INSTANCE DISTRIBUTION ============

/**
 * Creates a single distribute operation.
 */
function createSingleDistributeOperation(
	seedId: string,
	recipient: string,
	owner: string,
	instanceNumber: number,
): {
	instanceId: string;
	to: string;
	instanceNumber: number;
	operation: HiveOperation;
} {
	const input: DistributeInput = {
		seedId,
		to: recipient,
		instanceNumber,
	};

	const payload = createDistributePayload(input);
	const operation = createHiveOperation(payload, owner);

	return {
		instanceId: payload.data.instanceId,
		to: recipient,
		instanceNumber,
		operation,
	};
}

/**
 * Generates distribute operations to create instances from a seed.
 */
export function createDistributeOperations(
	seedId: string,
	recipients: string[],
	owner: string,
	startingInstanceNumber: number = DEFAULT_STARTING_INSTANCE_NUMBER,
): DistributeBatchResult {
	const instances: DistributeBatchResult["instances"] = [];

	for (let i = 0; i < recipients.length; i++) {
		const recipient = getArrayElement(recipients, i, "createDistributeOperations");
		const instanceNumber = startingInstanceNumber + i;

		const instance = createSingleDistributeOperation(seedId, recipient, owner, instanceNumber);
		instances.push(instance);
	}

	return {
		seedId,
		instances,
	};
}

// ============ SAMPLE DATA LOADING ============

/**
 * Loads and parses a JSON file of sample NFTs.
 */
export async function loadSampleNFTs(filePath: string): Promise<SeedNFT[]> {
	try {
		const file = Bun.file(filePath);
		const data = await file.json();

		if (!Array.isArray(data)) {
			throw new Error(`Expected array in ${filePath}, got ${typeof data}`);
		}

		return data.map((item: ImportedNFT & { maxSupply?: number }) => ({
			nftId: item.nftId,
			name: item.name,
			brief: item.brief,
			imageUrl: item.imageUrl,
			maxSupply: item.maxSupply ?? item.maxReplicas ?? 1,
		}));
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		throw new Error(`[loadSampleNFTs] Failed to load ${filePath}: ${errorMessage}`);
	}
}

// ============ PREVIEW HELPERS ============

/**
 * Calculates total potential instances from NFT array.
 */
function calculateTotalPotential(nfts: SeedNFT[]): number {
	return nfts.reduce((sum, nft) => sum + nft.maxSupply, 0);
}

/**
 * Generates a preview of batch mint without executing operations.
 */
export function previewBatchMint(nfts: SeedNFT[], collectionName: string): CollectionPreview {
	const totalPotential = calculateTotalPotential(nfts);
	const symbol = generateSymbolFromName(collectionName);

	return {
		collection: {
			name: collectionName,
			symbol,
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
 * Creates a collection with deterministic ID.
 * Same creator + name + symbol always produces the same collectionId.
 */
export function createDeterministicCollection(
	creator: string,
	name: string,
	symbol: string,
	totalPotential: number,
): {
	payload: ReturnType<typeof createDeterministicCollectionPayload>;
	operation: HiveOperation;
	collectionId: string;
} {
	const collectionId = generateDeterministicCollectionId(creator, name, symbol);
	const metadata = createCollectionMetadata(name, CollectionType.PRODUCTION);
	const rules = createCollectionRules(creator);

	const payload = createDeterministicCollectionPayload({
		name,
		symbol,
		creator,
		totalPotential,
		metadata,
		rules,
	});

	const operation = createHiveOperation(payload, creator);

	return { payload, operation, collectionId };
}

/**
 * Creates a single deterministic seed mint operation.
 */
function createDeterministicSeedOperation(
	nft: SeedNFTWithArtId,
	collectionId: string,
	collectionOriginDna: string,
	owner: string,
	edition: number,
): {
	artId: string;
	seedId: string;
	name: string;
	maxSupply: number;
	operation: HiveOperation;
} {
	const seedId = generateDeterministicSeedId(collectionId, nft.artId);

	const payload = createDeterministicMintPayload({
		artId: nft.artId,
		collectionId,
		collectionOriginDna,
		edition,
		owner,
		name: nft.name,
		description: nft.brief,
		imageUrl: nft.imageUrl,
		maxReplicas: nft.maxSupply,
	});

	const operation = createHiveOperation(payload, owner);

	return {
		artId: nft.artId,
		seedId,
		name: nft.name,
		maxSupply: nft.maxSupply,
		operation,
	};
}

/**
 * Generates seed mint operations with deterministic seedIds from artIds.
 * Same collectionId + artId always produces the same seedId.
 */
export function createDeterministicSeedMintOperations(
	nfts: SeedNFTWithArtId[],
	collectionId: string,
	collectionOriginDna: string,
	owner: string,
): DeterministicBatchMintResult {
	const seeds: DeterministicBatchMintResult["seeds"] = [];

	for (let i = 0; i < nfts.length; i++) {
		const nft = getArrayElement(nfts, i, "createDeterministicSeedMintOperations");
		const edition = i + 1;

		const seed = createDeterministicSeedOperation(
			nft,
			collectionId,
			collectionOriginDna,
			owner,
			edition,
		);
		seeds.push(seed);
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
	try {
		const file = Bun.file(filePath);
		const data = await file.json();

		if (!Array.isArray(data)) {
			throw new Error(`Expected array in ${filePath}, got ${typeof data}`);
		}

		return data.map((item: ImportedNFT & { artId?: string; maxSupply?: number }) => ({
			artId: item.artId || "",
			name: item.name,
			brief: item.brief,
			imageUrl: item.imageUrl,
			maxSupply: item.maxSupply ?? item.maxReplicas ?? 1,
		}));
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		throw new Error(`[loadSampleNFTsWithArtId] Failed to load ${filePath}: ${errorMessage}`);
	}
}

/**
 * Calculates total potential instances from NFTs with artId.
 */
function calculateTotalPotentialWithArtId(nfts: SeedNFTWithArtId[]): number {
	return nfts.reduce((sum, nft) => sum + nft.maxSupply, 0);
}

/**
 * Generates a preview with artId information.
 */
export function previewBatchMintWithArtId(
	nfts: SeedNFTWithArtId[],
	collectionName: string,
	creator: string,
	symbol: string,
): DeterministicCollectionPreview {
	const totalPotential = calculateTotalPotentialWithArtId(nfts);
	const finalSymbol = normalizeSymbolForCollection(symbol);
	const collectionId = generateDeterministicCollectionId(creator, collectionName, finalSymbol);

	return {
		collection: {
			name: collectionName,
			symbol: finalSymbol,
			totalPotential,
			collectionId,
		},
		seeds: nfts.map((nft) => ({
			artId: nft.artId,
			seedId: generateDeterministicSeedId(collectionId, nft.artId),
			name: nft.name,
			maxSupply: nft.maxSupply,
		})),
		summary: {
			totalSeeds: nfts.length,
			totalPotentialInstances: totalPotential,
		},
	};
}
