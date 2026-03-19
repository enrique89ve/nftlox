// HafSQL API Client for NFTLox Protocol
// Queries custom_json operations from Hive blockchain

import { MIN_PROTOCOL_VERSION, PROTOCOL_ID } from "nftlox-sdk";

const HAFSQL_BASE_URL = "https://hafsql-api.mahdiyari.info";

export { MIN_PROTOCOL_VERSION };

// ============ TYPES ============

export interface HafSQLOperation {
	id: string;
	timestamp: string;
	required_auths: string[];
	required_posting_auths: string[];
	custom_id: string;
	json: string;
	block_num: number;
}

export interface ParsedOperation<T = unknown> {
	id: string;
	timestamp: Date;
	blockNum: number;
	signer: string;
	protocol: string;
	version: string;
	action: string;
	data: T;
}

export interface NFTMintData {
	id: string;
	collectionId: string;
	edition: number;
	owner: string;
	dna?: string;
	originDna?: string;
	instanceDna?: string;
	uniqueAccessKey: string;
	metadata: {
		name: string;
		description?: string;
		imageUrl: string;
		imageHash: string;
	};
	maxReplicas: number;
	createdAt: number;
	birthBlock?: number;
	birthTx?: string;
	mintedBy?: string;
}

export interface CollectionData {
	id: string;
	jsonId?: string;
	name: string;
	symbol: string;
	creator: string;
	maxSupply?: number;
	totalPotential?: number;
	originDna?: string;
	metadata: {
		description: string;
		image: string;
		externalUrl?: string;
	};
	rules: {
		transferable: boolean;
		burnable: boolean;
		royaltyPct: number;
		royaltyRecipient?: string;
	};
	createdAt?: number;
}

export interface TransferData {
	nftId: string;
	to: string;
}

export interface BurnData {
	nftId: string;
}

export interface ListingData {
	nftId: string;
	price: {
		amount: string;
		currency: string;
	};
	expiresAt?: number;
}

export type ProtocolAction =
	| "create_collection"
	| "mint"
	| "transfer"
	| "burn"
	| "replicate"
	| "distribute"
	| "list"
	| "unlist"
	| "buy"
	| "offer"
	| "accept_offer"
	| "reject_offer";

const VALID_ACTIONS: ProtocolAction[] = [
	"create_collection",
	"mint",
	"transfer",
	"burn",
	"replicate",
	"distribute",
	"list",
	"unlist",
	"buy",
	"offer",
	"accept_offer",
	"reject_offer",
];

// ============ VERSION VALIDATION ============

/**
 * Compara dos versiones semánticas.
 * Retorna: -1 si a < b, 0 si a == b, 1 si a > b
 */
function compareVersions(a: string, b: string): number {
	const partsA = a.split(".").map(Number);
	const partsB = b.split(".").map(Number);

	for (let i = 0; i < 3; i++) {
		const numA = partsA[i] || 0;
		const numB = partsB[i] || 0;
		if (numA < numB) return -1;
		if (numA > numB) return 1;
	}
	return 0;
}

/**
 * Valida que una operación cumpla con el protocolo.
 * Retorna true si es válida, false si debe ser ignorada.
 */
function isValidProtocolPayload(payload: unknown): boolean {
	if (!payload || typeof payload !== "object") {
		return false;
	}

	const p = payload as Record<string, unknown>;

	// Verificar campos requeridos
	if (typeof p.protocol !== "string" || p.protocol !== PROTOCOL_ID) {
		return false;
	}

	if (typeof p.version !== "string") {
		return false;
	}

	// Verificar versión mínima
	if (compareVersions(p.version, MIN_PROTOCOL_VERSION) < 0) {
		return false;
	}

	if (typeof p.action !== "string" || !VALID_ACTIONS.includes(p.action as ProtocolAction)) {
		return false;
	}

	if (!p.data || typeof p.data !== "object") {
		return false;
	}

	return true;
}

// ============ API CLIENT ============

export interface FetchOperationsOptions {
	start?: string;
	limit?: number;
	protocolId?: string;
}

export async function fetchOperations(
	options: FetchOperationsOptions = {},
): Promise<HafSQLOperation[]> {
	const { start, limit = 100, protocolId = PROTOCOL_ID } = options;

	const url = new URL(`${HAFSQL_BASE_URL}/operations/custom_json/${protocolId}`);

	if (start) {
		url.searchParams.set("start", start);
	}
	url.searchParams.set("limit", String(limit));

	const response = await fetch(url.toString());

	if (!response.ok) {
		throw new Error(`HafSQL API error: ${response.status} ${response.statusText}`);
	}

	return response.json();
}

export function parseOperation<T = unknown>(op: HafSQLOperation): ParsedOperation<T> | null {
	try {
		const payload = JSON.parse(op.json);

		// Validar que cumpla con el protocolo
		if (!isValidProtocolPayload(payload)) {
			return null;
		}

		return {
			id: op.id,
			timestamp: new Date(op.timestamp),
			blockNum: op.block_num,
			signer: op.required_posting_auths[0] || op.required_auths[0] || "unknown",
			protocol: payload.protocol,
			version: payload.version,
			action: payload.action,
			data: payload.data as T,
		};
	} catch {
		return null;
	}
}

// ============ SPECIALIZED FETCHERS ============

export async function fetchAllOperations(
	options: FetchOperationsOptions = {},
): Promise<ParsedOperation[]> {
	const ops = await fetchOperations(options);
	return ops.map(parseOperation).filter((op): op is ParsedOperation => op !== null);
}

export async function fetchMintOperations(
	options: FetchOperationsOptions = {},
): Promise<ParsedOperation<NFTMintData>[]> {
	const allOps = await fetchAllOperations(options);
	return allOps.filter(
		(op): op is ParsedOperation<NFTMintData> => op.action === "mint",
	);
}

export async function fetchCollectionOperations(
	options: FetchOperationsOptions = {},
): Promise<ParsedOperation<CollectionData>[]> {
	const allOps = await fetchAllOperations(options);
	return allOps.filter(
		(op): op is ParsedOperation<CollectionData> => op.action === "create_collection",
	);
}

export async function fetchTransferOperations(
	options: FetchOperationsOptions = {},
): Promise<ParsedOperation<TransferData>[]> {
	const allOps = await fetchAllOperations(options);
	return allOps.filter(
		(op): op is ParsedOperation<TransferData> => op.action === "transfer",
	);
}

export async function fetchByAction(
	action: ProtocolAction,
	options: FetchOperationsOptions = {},
): Promise<ParsedOperation[]> {
	const allOps = await fetchAllOperations(options);
	return allOps.filter((op) => op.action === action);
}

// ============ AGGREGATION HELPERS ============

export interface NFTState {
	id: string;
	collectionId: string;
	name: string;
	imageUrl: string;
	imageHash?: string;
	owner: string;
	edition: number;
	dna: string;
	originDna?: string;
	instanceDna?: string;
	mintedAt: Date;
	mintedBy: string;
	blockNum: number;
	burned: boolean;
	listed: boolean;
	listingPrice?: { amount: string; currency: string };
	// Replica fields
	isReplica?: boolean;
	originalId?: string;
	// Seed fields
	isSeed?: boolean;
	maxSupply?: number;
	distributed?: number;
	// Instance fields (spawned from seed)
	seedId?: string;
	instanceNumber?: number;
}

export interface CollectionState {
	id: string;
	name: string;
	symbol: string;
	creator: string;
	originDna?: string;
	totalPotential?: number;
	createdAt: Date;
	blockNum: number;
}

export interface DuplicateEntry {
	id: string;
	reason: "DUPLICATE_COLLECTION" | "DUPLICATE_SEED" | "DUPLICATE_INSTANCE";
	existingBlockNum: number;
	attemptedBlockNum: number;
}

export interface ReplicaData {
	id: string;
	originalId: string;
	newOwner: string;
	originDna: string;
	instanceDna: string;
	uniqueAccessKey: string;
}

export interface DistributeData {
	seedId: string;
	instanceId: string;
	to: string;
	instanceNumber: number;
}

export interface BuildStateResult {
	nftMap: Map<string, NFTState>;
	collectionMap: Map<string, CollectionState>;
	duplicates: DuplicateEntry[];
}

export async function buildNFTState(
	options: FetchOperationsOptions = {},
): Promise<Map<string, NFTState>> {
	const result = await buildFullState(options);
	return result.nftMap;
}

/**
 * Builds full protocol state including collections, NFTs, and duplicate tracking.
 * Duplicates are detected but not included in the state maps.
 */
export async function buildFullState(
	options: FetchOperationsOptions = {},
): Promise<BuildStateResult> {
	const allOps = await fetchAllOperations({ ...options, limit: 1000 });
	const nftMap = new Map<string, NFTState>();
	const collectionMap = new Map<string, CollectionState>();
	const duplicates: DuplicateEntry[] = [];

	// Sort by block number (oldest first)
	const sortedOps = allOps.sort((a, b) => a.blockNum - b.blockNum);

	for (const op of sortedOps) {
		switch (op.action) {
			case "create_collection": {
				const data = op.data as CollectionData;
				// Check for duplicate collection
				if (collectionMap.has(data.id)) {
					const existing = collectionMap.get(data.id)!;
					duplicates.push({
						id: data.id,
						reason: "DUPLICATE_COLLECTION",
						existingBlockNum: existing.blockNum,
						attemptedBlockNum: op.blockNum,
					});
					continue; // Skip duplicate
				}
				collectionMap.set(data.id, {
					id: data.id,
					name: data.name,
					symbol: data.symbol,
					creator: data.creator,
					originDna: data.originDna,
					totalPotential: data.totalPotential,
					createdAt: op.timestamp,
					blockNum: op.blockNum,
				});
				break;
			}
			case "mint": {
				const data = op.data as NFTMintData;
				// Check for duplicate NFT/seed
				if (nftMap.has(data.id)) {
					const existing = nftMap.get(data.id)!;
					duplicates.push({
						id: data.id,
						reason: existing.isSeed ? "DUPLICATE_SEED" : "DUPLICATE_INSTANCE",
						existingBlockNum: existing.blockNum,
						attemptedBlockNum: op.blockNum,
					});
					continue; // Skip duplicate
				}
				const isSeed = data.id.startsWith("seed_");
				nftMap.set(data.id, {
					id: data.id,
					collectionId: data.collectionId,
					name: data.metadata.name,
					imageUrl: data.metadata.imageUrl,
					owner: data.owner,
					edition: data.edition,
					dna: data.instanceDna || data.dna || "",
					originDna: data.originDna,
					instanceDna: data.instanceDna,
					mintedAt: op.timestamp,
					mintedBy: data.mintedBy || op.signer,
					blockNum: op.blockNum,
					burned: false,
					listed: false,
					isSeed,
					maxSupply: isSeed ? (data.maxReplicas || 1) : undefined,
					distributed: isSeed ? 0 : undefined,
				});
				break;
			}
			case "transfer": {
				const data = op.data as TransferData;
				const nft = nftMap.get(data.nftId);
				if (nft) {
					nft.owner = data.to;
					nft.listed = false;
					nft.listingPrice = undefined;
				}
				break;
			}
			case "burn": {
				const data = op.data as BurnData;
				const nft = nftMap.get(data.nftId);
				if (nft) {
					nft.burned = true;
					nft.listed = false;
				}
				break;
			}
			case "list": {
				const data = op.data as ListingData;
				const nft = nftMap.get(data.nftId);
				if (nft) {
					nft.listed = true;
					nft.listingPrice = data.price;
				}
				break;
			}
			case "unlist": {
				const data = op.data as { nftId: string };
				const nft = nftMap.get(data.nftId);
				if (nft) {
					nft.listed = false;
					nft.listingPrice = undefined;
				}
				break;
			}
			case "replicate": {
				const data = op.data as ReplicaData;
				const original = nftMap.get(data.originalId);
				if (original) {
					nftMap.set(data.id, {
						id: data.id,
						collectionId: original.collectionId,
						name: `${original.name} (Replica)`,
						imageUrl: original.imageUrl,
						owner: data.newOwner,
						edition: original.edition,
						dna: data.instanceDna,
						originDna: data.originDna,
						instanceDna: data.instanceDna,
						mintedAt: op.timestamp,
						mintedBy: op.signer,
						blockNum: op.blockNum,
						burned: false,
						listed: false,
						isReplica: true,
						originalId: data.originalId,
					});
				}
				break;
			}
			case "distribute": {
				const data = op.data as DistributeData;
				// Check for duplicate instance
				if (nftMap.has(data.instanceId)) {
					const existing = nftMap.get(data.instanceId)!;
					duplicates.push({
						id: data.instanceId,
						reason: "DUPLICATE_INSTANCE",
						existingBlockNum: existing.blockNum,
						attemptedBlockNum: op.blockNum,
					});
					continue; // Skip duplicate
				}
				const seed = nftMap.get(data.seedId);
				if (seed && seed.isSeed) {
					if ((seed.distributed || 0) >= (seed.maxSupply || 0)) {
						break;
					}
					nftMap.set(data.instanceId, {
						id: data.instanceId,
						collectionId: seed.collectionId,
						name: seed.name,
						imageUrl: seed.imageUrl,
						owner: data.to,
						edition: seed.edition,
						dna: seed.dna,
						originDna: seed.originDna,
						instanceDna: seed.instanceDna,
						mintedAt: op.timestamp,
						mintedBy: op.signer,
						blockNum: op.blockNum,
						burned: false,
						listed: false,
						seedId: data.seedId,
						instanceNumber: data.instanceNumber,
					});
					seed.distributed = (seed.distributed || 0) + 1;
				}
				break;
			}
		}
	}

	return { nftMap, collectionMap, duplicates };
}

export async function getNFTsByOwner(owner: string): Promise<NFTState[]> {
	const nftMap = await buildNFTState();
	return Array.from(nftMap.values()).filter(
		(nft) => nft.owner === owner && !nft.burned,
	);
}

export async function getNFTsByCollection(collectionId: string): Promise<NFTState[]> {
	const nftMap = await buildNFTState();
	return Array.from(nftMap.values()).filter(
		(nft) => nft.collectionId === collectionId && !nft.burned,
	);
}

export async function getListedNFTs(): Promise<NFTState[]> {
	const nftMap = await buildNFTState();
	return Array.from(nftMap.values()).filter(
		(nft) => nft.listed && !nft.burned,
	);
}

// ============ STATS ============

export interface ProtocolStats {
	totalOperations: number;
	totalMints: number;
	totalTransfers: number;
	totalBurns: number;
	totalListings: number;
	uniqueCollections: Set<string>;
	uniqueUsers: Set<string>;
}

export async function getProtocolStats(): Promise<ProtocolStats> {
	const allOps = await fetchAllOperations({ limit: 1000 });

	const stats: ProtocolStats = {
		totalOperations: allOps.length,
		totalMints: 0,
		totalTransfers: 0,
		totalBurns: 0,
		totalListings: 0,
		uniqueCollections: new Set(),
		uniqueUsers: new Set(),
	};

	for (const op of allOps) {
		stats.uniqueUsers.add(op.signer);

		switch (op.action) {
			case "mint":
				stats.totalMints++;
				stats.uniqueCollections.add((op.data as NFTMintData).collectionId);
				break;
			case "transfer":
				stats.totalTransfers++;
				break;
			case "burn":
				stats.totalBurns++;
				break;
			case "list":
				stats.totalListings++;
				break;
			case "create_collection":
				stats.uniqueCollections.add((op.data as CollectionData).id);
				break;
		}
	}

	return stats;
}

// ============ DEBUG: FILTERING STATS ============

export interface FilteringStats {
	total: number;
	accepted: number;
	rejected: number;
	rejectionReasons: {
		invalidJson: number;
		wrongProtocol: number;
		versionTooOld: number;
		invalidAction: number;
		missingData: number;
	};
	minVersionRequired: string;
}

export async function getFilteringStats(
	options: FetchOperationsOptions = {},
): Promise<FilteringStats> {
	const ops = await fetchOperations({ ...options, limit: 1000 });

	const stats: FilteringStats = {
		total: ops.length,
		accepted: 0,
		rejected: 0,
		rejectionReasons: {
			invalidJson: 0,
			wrongProtocol: 0,
			versionTooOld: 0,
			invalidAction: 0,
			missingData: 0,
		},
		minVersionRequired: MIN_PROTOCOL_VERSION,
	};

	for (const op of ops) {
		let payload: Record<string, unknown>;
		try {
			payload = JSON.parse(op.json);
		} catch {
			stats.rejected++;
			stats.rejectionReasons.invalidJson++;
			continue;
		}

		if (typeof payload.protocol !== "string" || payload.protocol !== PROTOCOL_ID) {
			stats.rejected++;
			stats.rejectionReasons.wrongProtocol++;
			continue;
		}

		if (typeof payload.version !== "string" || compareVersions(payload.version, MIN_PROTOCOL_VERSION) < 0) {
			stats.rejected++;
			stats.rejectionReasons.versionTooOld++;
			continue;
		}

		if (typeof payload.action !== "string" || !VALID_ACTIONS.includes(payload.action as ProtocolAction)) {
			stats.rejected++;
			stats.rejectionReasons.invalidAction++;
			continue;
		}

		if (!payload.data || typeof payload.data !== "object") {
			stats.rejected++;
			stats.rejectionReasons.missingData++;
			continue;
		}

		stats.accepted++;
	}

	return stats;
}

// ============ NFT BY ID & HISTORY (Procedencia) ============

export async function getNFTById(nftId: string): Promise<NFTState | null> {
	const nftMap = await buildNFTState();
	return nftMap.get(nftId) || null;
}

export type HistoryEventType =
	| "mint"
	| "transfer"
	| "sale"
	| "list"
	| "unlist"
	| "burn"
	| "replicate"
	| "offer"
	| "offer_accepted"
	| "offer_rejected";

export interface HistoryEvent {
	id: string;
	nftId: string;
	eventType: HistoryEventType;
	block: number;
	txId: string;
	timestamp: number;
	from?: string;
	to?: string;
	price?: { amount: string; currency: string };
}

export async function getNFTHistory(nftId: string): Promise<HistoryEvent[]> {
	const allOps = await fetchAllOperations({ limit: 1000 });

	return allOps
		.filter((op) => {
			const data = op.data as { nftId?: string; id?: string };
			return data.nftId === nftId || data.id === nftId;
		})
		.map((op) => {
			const data = op.data as {
				to?: string;
				owner?: string;
				price?: { amount: string; currency: string };
			};
			return {
				id: op.id,
				nftId: nftId,
				eventType: op.action as HistoryEventType,
				block: op.blockNum,
				txId: op.id,
				timestamp: op.timestamp.getTime(),
				from: op.signer,
				to: data.to || data.owner,
				price: data.price,
			};
		})
		.sort((a, b) => a.block - b.block);
}

export interface TransferValidation {
	valid: boolean;
	error?: string;
	warning?: string;
	nft?: NFTState;
}

// ============ OWNERSHIP RECORD (Procedencia) ============

export interface OwnershipRecord {
	owner: string;
	acquiredAt: number;
	acquiredFrom: string | null;
	price?: { amount: string; currency: string };
	txHash: string;
	block: number;
}

export async function validateTransfer(
	nftId: string,
	currentUser: string,
): Promise<TransferValidation> {
	const nft = await getNFTById(nftId);

	if (!nft) {
		return { valid: false, error: "NFT not found on blockchain" };
	}

	if (nft.burned) {
		return { valid: false, error: "NFT has been burned" };
	}

	if (nft.owner.toLowerCase() !== currentUser.toLowerCase()) {
		return {
			valid: false,
			error: `You are not the owner (@${nft.owner})`,
		};
	}

	if (nft.listed) {
		return {
			valid: true,
			warning: "Warning: Transfer will unlist NFT from marketplace",
			nft,
		};
	}

	return { valid: true, nft };
}

// ============ OWNERSHIP HISTORY (Cadena de Propiedad) ============

export async function getOwnershipHistory(nftId: string): Promise<OwnershipRecord[]> {
	const history = await getNFTHistory(nftId);
	const records: OwnershipRecord[] = [];

	for (const event of history) {
		if (event.eventType === "mint") {
			records.push({
				owner: event.to!,
				acquiredAt: event.timestamp,
				acquiredFrom: null,
				txHash: event.txId,
				block: event.block,
			});
		} else if (event.eventType === "transfer" || event.eventType === "sale") {
			records.push({
				owner: event.to!,
				acquiredAt: event.timestamp,
				acquiredFrom: event.from!,
				price: event.price,
				txHash: event.txId,
				block: event.block,
			});
		}
	}

	return records;
}

// ============ EXISTENCE CHECKS (Anti-Duplication) ============

/**
 * Checks if a collection already exists on the blockchain.
 */
export async function collectionExists(collectionId: string): Promise<boolean> {
	const { collectionMap } = await buildFullState();
	return collectionMap.has(collectionId);
}

/**
 * Checks if a seed already exists on the blockchain.
 */
export async function seedExists(seedId: string): Promise<boolean> {
	const nftMap = await buildNFTState();
	const nft = nftMap.get(seedId);
	return nft !== undefined && nft.isSeed === true;
}

/**
 * Checks if an NFT/instance already exists on the blockchain.
 */
export async function nftExists(nftId: string): Promise<boolean> {
	const nftMap = await buildNFTState();
	return nftMap.has(nftId);
}

/**
 * Batch check for multiple seed IDs.
 * Returns a map of seedId -> exists boolean.
 */
export async function checkSeedsExistence(
	seedIds: string[],
): Promise<Map<string, boolean>> {
	const nftMap = await buildNFTState();
	const result = new Map<string, boolean>();

	for (const seedId of seedIds) {
		const nft = nftMap.get(seedId);
		result.set(seedId, nft !== undefined && nft.isSeed === true);
	}

	return result;
}

/**
 * Get collection by ID if it exists.
 */
export async function getCollectionById(
	collectionId: string,
): Promise<CollectionState | null> {
	const { collectionMap } = await buildFullState();
	return collectionMap.get(collectionId) || null;
}

/**
 * Get all detected duplicates from the blockchain state.
 */
export async function getDetectedDuplicates(): Promise<DuplicateEntry[]> {
	const { duplicates } = await buildFullState();
	return duplicates;
}
