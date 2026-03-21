// NFTLox Validation Module
// Input validation and normalization utilities

import {
	MIN_SYMBOL_LENGTH,
	MAX_SYMBOL_LENGTH,
	SYMBOL_REGEX,
	MAX_NAME_LENGTH,
	MAX_DESCRIPTION_LENGTH,
	MAX_IMAGE_URL_LENGTH,
	MAX_JSON_SIZE,
	MAX_ROYALTY_PCT,
	SUPPORTED_CURRENCIES,
	MIN_PRICE_AMOUNT,
	MAX_DROP_TABLE_ENTRIES,
	MAX_ITEMS_PER_PACK,
	MAX_PACK_OPEN_BATCH,
	MIN_DROP_WEIGHT,
	MAX_DROP_WEIGHT,
	MAX_BULK_DISTRIBUTE_ITEMS,
	MAX_BULK_DISTRIBUTE_TOTAL,
} from "./constants";

import type {
	CreateCollectionInput,
	MintInput,
	ListInput,
	OfferInput,
	Price,
	ImportedNFT,
	HiveOperation,
	PackCreateInput,
	PackBuyInput,
	PackTransferInput,
	PackOpenInput,
	PackApproveInput,
	PackTransferFromInput,
	NftApproveInput,
	NftApproveAllInput,
	NftTransferFromInput,
	DataOperatorApproveInput,
	SetDataInput,
	SetDataFromInput,
	NftLendInput,
	NftReturnInput,
	BulkDistributeInput,
} from "./types";

// ============ SHARED CONSTANTS ============

const HIVE_USERNAME_REGEX = /^[a-z][a-z0-9\-\.]{2,15}$/;

// ============ VALIDATION RESULT ============

export interface ValidationResult {
	valid: boolean;
	error?: string;
}

// ============ SYMBOL VALIDATION ============

export function validateSymbol(symbol: string): ValidationResult {
	const normalized = symbol.toUpperCase().trim();

	if (normalized.length < MIN_SYMBOL_LENGTH) {
		return {
			valid: false,
			error: `Symbol must be at least ${MIN_SYMBOL_LENGTH} characters`,
		};
	}
	if (normalized.length > MAX_SYMBOL_LENGTH) {
		return {
			valid: false,
			error: `Symbol must be at most ${MAX_SYMBOL_LENGTH} characters`,
		};
	}
	if (!SYMBOL_REGEX.test(normalized)) {
		return {
			valid: false,
			error: "Symbol must contain only uppercase letters and numbers (A-Z, 0-9)",
		};
	}
	return { valid: true };
}

export function normalizeSymbol(symbol: string): string {
	return symbol.toUpperCase().trim().slice(0, MAX_SYMBOL_LENGTH);
}

// ============ PRICE VALIDATION ============

export function validatePrice(price: Price): ValidationResult {
	if (!price.amount || !price.currency) {
		return { valid: false, error: "Price must have amount and currency" };
	}

	const amount = parseFloat(price.amount);
	if (isNaN(amount) || amount < parseFloat(MIN_PRICE_AMOUNT)) {
		return {
			valid: false,
			error: `Price amount must be at least ${MIN_PRICE_AMOUNT}`,
		};
	}

	if (!SUPPORTED_CURRENCIES.includes(price.currency)) {
		return {
			valid: false,
			error: `Currency must be one of: ${SUPPORTED_CURRENCIES.join(", ")}`,
		};
	}

	return { valid: true };
}

// ============ COLLECTION VALIDATION ============

export function validateCollectionInput(
	input: CreateCollectionInput,
): ValidationResult {
	if (!input.name || input.name.length > MAX_NAME_LENGTH) {
		return {
			valid: false,
			error: `Name is required and must be at most ${MAX_NAME_LENGTH} characters`,
		};
	}

	const symbolValidation = validateSymbol(input.symbol);
	if (!symbolValidation.valid) {
		return symbolValidation;
	}

	if (!input.creator) {
		return { valid: false, error: "Creator is required" };
	}

	if (input.totalPotential < 0) {
		return { valid: false, error: "Total potential must be non-negative" };
	}

	if (!input.metadata?.description) {
		return { valid: false, error: "Description is required" };
	}

	if (input.metadata.description.length > MAX_DESCRIPTION_LENGTH) {
		return {
			valid: false,
			error: `Description must be at most ${MAX_DESCRIPTION_LENGTH} characters`,
		};
	}

	if (!input.metadata?.image) {
		return { valid: false, error: "Image URL is required" };
	}

	if (input.metadata.image.length > MAX_IMAGE_URL_LENGTH) {
		return {
			valid: false,
			error: `Image URL must be at most ${MAX_IMAGE_URL_LENGTH} characters`,
		};
	}

	if (input.rules.royaltyPct < 0 || input.rules.royaltyPct > MAX_ROYALTY_PCT) {
		return {
			valid: false,
			error: `Royalty percentage must be between 0 and ${MAX_ROYALTY_PCT}`,
		};
	}

	if (!input.jsonId) {
		return { valid: false, error: "jsonId is required for indexing" };
	}

	return { valid: true };
}

// ============ MINT VALIDATION ============

export function validateMintInput(input: MintInput): ValidationResult {
	if (!input.collectionId) {
		return { valid: false, error: "Collection ID is required" };
	}

	if (!input.collectionOriginDna) {
		return { valid: false, error: "Collection origin DNA is required" };
	}

	if (!input.owner) {
		return { valid: false, error: "Owner is required" };
	}

	if (input.edition < 1) {
		return { valid: false, error: "Edition must be at least 1" };
	}

	if (!input.name || input.name.length > MAX_NAME_LENGTH) {
		return {
			valid: false,
			error: `Name is required and must be at most ${MAX_NAME_LENGTH} characters`,
		};
	}

	if (input.description && input.description.length > MAX_DESCRIPTION_LENGTH) {
		return {
			valid: false,
			error: `Description must be at most ${MAX_DESCRIPTION_LENGTH} characters`,
		};
	}

	if (!input.imageUrl) {
		return { valid: false, error: "Image URL is required" };
	}

	if (input.imageUrl.length > MAX_IMAGE_URL_LENGTH) {
		return {
			valid: false,
			error: `Image URL must be at most ${MAX_IMAGE_URL_LENGTH} characters`,
		};
	}

	if (input.maxReplicas !== undefined && input.maxReplicas < 1) {
		return { valid: false, error: "Max replicas must be at least 1" };
	}

	return { valid: true };
}

// ============ LISTING VALIDATION ============

export function validateListInput(input: ListInput): ValidationResult {
	if (!input.nftId) {
		return { valid: false, error: "NFT ID is required" };
	}

	const priceValidation = validatePrice(input.price);
	if (!priceValidation.valid) {
		return priceValidation;
	}

	if (input.expiresAt !== undefined && input.expiresAt < Date.now()) {
		return { valid: false, error: "Expiration date must be in the future" };
	}

	return { valid: true };
}

// ============ OFFER VALIDATION ============

export function validateOfferInput(input: OfferInput): ValidationResult {
	if (!input.nftId) {
		return { valid: false, error: "NFT ID is required" };
	}

	const priceValidation = validatePrice(input.price);
	if (!priceValidation.valid) {
		return priceValidation;
	}

	if (input.expiresAt !== undefined && input.expiresAt < Date.now()) {
		return { valid: false, error: "Expiration date must be in the future" };
	}

	return { valid: true };
}

// ============ IMPORTED NFT VALIDATION ============

export function validateImportedNFTs(data: unknown): ImportedNFT[] {
	if (!Array.isArray(data)) {
		throw new Error("Data must be an array of NFTs");
	}

	return data.map((item, index) => {
		if (!item.nftId || typeof item.nftId !== "string") {
			throw new Error(`NFT at index ${index} is missing 'nftId'`);
		}
		if (!item.name || typeof item.name !== "string") {
			throw new Error(`NFT at index ${index} is missing 'name'`);
		}
		if (!item.imageUrl || typeof item.imageUrl !== "string") {
			throw new Error(`NFT at index ${index} is missing 'imageUrl'`);
		}

		const brief = item.brief ?? item.description;
		if (brief && brief.length > MAX_DESCRIPTION_LENGTH) {
			throw new Error(
				`NFT at index ${index}: brief exceeds ${MAX_DESCRIPTION_LENGTH} characters`,
			);
		}

		return {
			nftId: item.nftId,
			name: item.name,
			brief,
			imageUrl: item.imageUrl,
			imageHash: item.imageHash,
			maxReplicas: item.maxReplicas ?? 1,
		};
	});
}

// ============ OPERATION SIZE VALIDATION ============

export function estimateOperationSize(operation: HiveOperation): number {
	return new TextEncoder().encode(JSON.stringify(operation)).length;
}

export function validateOperationSize(operation: HiveOperation): ValidationResult {
	const size = estimateOperationSize(operation);
	if (size > MAX_JSON_SIZE) {
		return {
			valid: false,
			error: `Operation size (${size} bytes) exceeds maximum (${MAX_JSON_SIZE} bytes)`,
		};
	}
	return { valid: true };
}

// ============ BATCH UTILITIES ============

export function splitIntoBatches<T>(items: T[], maxBatchSize: number): T[][] {
	const batches: T[][] = [];
	for (let i = 0; i < items.length; i += maxBatchSize) {
		batches.push(items.slice(i, i + maxBatchSize));
	}
	return batches;
}

export function calculateMaxOperationsPerTx(
	sampleOperation: HiveOperation,
): number {
	const operationSize = estimateOperationSize(sampleOperation);
	const maxTxSize = 65000;
	const overhead = 500;
	return Math.floor((maxTxSize - overhead) / operationSize);
}

// ============ PACK VALIDATION ============

export function validatePackCreateInput(
	input: PackCreateInput,
): ValidationResult {
	if (!input.name || input.name.length === 0) {
		return { valid: false, error: "Pack name is required" };
	}
	if (input.name.length > MAX_NAME_LENGTH) {
		return {
			valid: false,
			error: `Pack name must be at most ${MAX_NAME_LENGTH} characters`,
		};
	}

	if (!input.collectionId) {
		return { valid: false, error: "Collection ID is required" };
	}

	if (!input.dropTable || input.dropTable.length === 0) {
		return { valid: false, error: "Drop table must have at least one entry" };
	}
	if (input.dropTable.length > MAX_DROP_TABLE_ENTRIES) {
		return {
			valid: false,
			error: `Drop table must have at most ${MAX_DROP_TABLE_ENTRIES} entries`,
		};
	}

	for (let i = 0; i < input.dropTable.length; i++) {
		const entry = input.dropTable[i]!;
		if (!entry.seedId) {
			return { valid: false, error: `Drop table entry ${i}: seedId is required` };
		}
		if (
			typeof entry.weight !== "number" ||
			entry.weight < MIN_DROP_WEIGHT ||
			entry.weight > MAX_DROP_WEIGHT
		) {
			return {
				valid: false,
				error: `Drop table entry ${i}: weight must be between ${MIN_DROP_WEIGHT} and ${MAX_DROP_WEIGHT}`,
			};
		}
	}

	if (
		typeof input.itemsPerPack !== "number" ||
		input.itemsPerPack < 1 ||
		input.itemsPerPack > MAX_ITEMS_PER_PACK
	) {
		return {
			valid: false,
			error: `Items per pack must be between 1 and ${MAX_ITEMS_PER_PACK}`,
		};
	}

	if (typeof input.maxSupply !== "number" || input.maxSupply < 0) {
		return { valid: false, error: "Max supply must be non-negative (0 = unlimited)" };
	}

	if (input.price) {
		const priceValidation = validatePrice(input.price);
		if (!priceValidation.valid) {
			return priceValidation;
		}
	}

	if (input.description && input.description.length > MAX_DESCRIPTION_LENGTH) {
		return {
			valid: false,
			error: `Description must be at most ${MAX_DESCRIPTION_LENGTH} characters`,
		};
	}

	if (input.imageUrl && input.imageUrl.length > MAX_IMAGE_URL_LENGTH) {
		return {
			valid: false,
			error: `Image URL must be at most ${MAX_IMAGE_URL_LENGTH} characters`,
		};
	}

	return { valid: true };
}

export function validatePackBuyInput(input: PackBuyInput): ValidationResult {
	if (!input.packId) {
		return { valid: false, error: "Pack ID is required" };
	}
	if (typeof input.quantity !== "number" || input.quantity < 1) {
		return { valid: false, error: "Quantity must be a positive integer" };
	}
	return { valid: true };
}

export function validatePackTransferInput(
	input: PackTransferInput,
): ValidationResult {
	if (!input.packId) {
		return { valid: false, error: "Pack ID is required" };
	}
	if (!input.to) {
		return { valid: false, error: "Recipient username is required" };
	}
	if (!HIVE_USERNAME_REGEX.test(input.to)) {
		return { valid: false, error: "Invalid recipient username format" };
	}
	if (typeof input.quantity !== "number" || input.quantity < 1) {
		return { valid: false, error: "Quantity must be a positive integer" };
	}
	return { valid: true };
}

export function validatePackOpenInput(input: PackOpenInput): ValidationResult {
	if (!input.packId) {
		return { valid: false, error: "Pack ID is required" };
	}
	if (typeof input.quantity !== "number" || input.quantity < 1) {
		return { valid: false, error: "Quantity must be a positive integer" };
	}
	if (input.quantity > MAX_PACK_OPEN_BATCH) {
		return {
			valid: false,
			error: `Cannot open more than ${MAX_PACK_OPEN_BATCH} packs at once`,
		};
	}
	return { valid: true };
}

// ============ APPROVE & TRANSFER_FROM VALIDATION ============

export function validatePackApproveInput(
	input: PackApproveInput,
): ValidationResult {
	if (!input.spender) {
		return { valid: false, error: "Spender is required" };
	}
	if (!HIVE_USERNAME_REGEX.test(input.spender)) {
		return { valid: false, error: "Invalid spender username format" };
	}
	if (!input.packId) {
		return { valid: false, error: "Pack ID is required" };
	}
	if (typeof input.approved !== "boolean") {
		return { valid: false, error: "Approved must be a boolean" };
	}
	if (input.approved && (typeof input.quantity !== "number" || input.quantity < 1)) {
		return { valid: false, error: "Quantity must be a positive integer when approving" };
	}
	return { valid: true };
}

export function validatePackTransferFromInput(
	input: PackTransferFromInput,
): ValidationResult {
	if (!input.from) {
		return { valid: false, error: "From account is required" };
	}
	if (!input.to) {
		return { valid: false, error: "To account is required" };
	}
	if (!HIVE_USERNAME_REGEX.test(input.to)) {
		return { valid: false, error: "Invalid recipient username format" };
	}
	if (!input.packId) {
		return { valid: false, error: "Pack ID is required" };
	}
	if (typeof input.quantity !== "number" || input.quantity < 1) {
		return { valid: false, error: "Quantity must be a positive integer" };
	}
	return { valid: true };
}

export function validateNftApproveInput(
	input: NftApproveInput,
): ValidationResult {
	if (!input.spender) {
		return { valid: false, error: "Spender is required" };
	}
	if (!HIVE_USERNAME_REGEX.test(input.spender)) {
		return { valid: false, error: "Invalid spender username format" };
	}
	if (!input.instanceId) {
		return { valid: false, error: "Instance ID is required" };
	}
	if (typeof input.approved !== "boolean") {
		return { valid: false, error: "Approved must be a boolean" };
	}
	return { valid: true };
}

export function validateNftApproveAllInput(
	input: NftApproveAllInput,
): ValidationResult {
	if (!input.spender) {
		return { valid: false, error: "Spender is required" };
	}
	if (!HIVE_USERNAME_REGEX.test(input.spender)) {
		return { valid: false, error: "Invalid spender username format" };
	}
	if (!input.collectionId) {
		return { valid: false, error: "Collection ID is required" };
	}
	if (typeof input.approved !== "boolean") {
		return { valid: false, error: "Approved must be a boolean" };
	}
	return { valid: true };
}

export function validateNftTransferFromInput(
	input: NftTransferFromInput,
): ValidationResult {
	if (!input.from) {
		return { valid: false, error: "From account is required" };
	}
	if (!input.to) {
		return { valid: false, error: "To account is required" };
	}
	if (!HIVE_USERNAME_REGEX.test(input.to)) {
		return { valid: false, error: "Invalid recipient username format" };
	}
	if (!input.instanceId) {
		return { valid: false, error: "Instance ID is required" };
	}
	return { valid: true };
}

// ============ SET_DATA VALIDATION ============

export function validateSetDataInput(
	input: SetDataInput,
): ValidationResult {
	if (!input.nftId) {
		return { valid: false, error: "NFT ID is required" };
	}
	if (!input.instanceDna) {
		return { valid: false, error: "Instance DNA is required" };
	}
	if (!input.data || typeof input.data !== "object" || Array.isArray(input.data)) {
		return { valid: false, error: "Data must be an object" };
	}
	return { valid: true };
}

// ============ DATA OPERATOR VALIDATION ============

export function validateDataOperatorApproveInput(
	input: DataOperatorApproveInput,
): ValidationResult {
	if (!input.collectionId) {
		return { valid: false, error: "Collection ID is required" };
	}
	if (!input.operator) {
		return { valid: false, error: "Operator is required" };
	}
	if (!HIVE_USERNAME_REGEX.test(input.operator)) {
		return { valid: false, error: "Invalid operator username format" };
	}
	if (typeof input.approved !== "boolean") {
		return { valid: false, error: "Approved must be a boolean" };
	}
	return { valid: true };
}

export function validateSetDataFromInput(
	input: SetDataFromInput,
): ValidationResult {
	if (!input.nftId) {
		return { valid: false, error: "NFT ID is required" };
	}
	if (!input.instanceDna) {
		return { valid: false, error: "Instance DNA is required" };
	}
	if (!input.data || typeof input.data !== "object" || Array.isArray(input.data)) {
		return { valid: false, error: "Data must be an object" };
	}
	return { valid: true };
}

// ============ LENDING VALIDATION ============

export function validateNftLendInput(
	input: NftLendInput,
): ValidationResult {
	if (!input.instanceId) {
		return { valid: false, error: "Instance ID is required" };
	}
	if (!input.borrower) {
		return { valid: false, error: "Borrower is required" };
	}
	if (!HIVE_USERNAME_REGEX.test(input.borrower)) {
		return { valid: false, error: "Invalid borrower username format" };
	}
	return { valid: true };
}

export function validateNftReturnInput(
	input: NftReturnInput,
): ValidationResult {
	if (!input.instanceId) {
		return { valid: false, error: "Instance ID is required" };
	}
	return { valid: true };
}

// ============ BULK DISTRIBUTE VALIDATION ============

export function validateBulkDistributeInput(
	input: BulkDistributeInput,
): ValidationResult {
	if (!input.items || input.items.length === 0) {
		return { valid: false, error: "Items array is required and cannot be empty" };
	}

	if (input.items.length > MAX_BULK_DISTRIBUTE_ITEMS) {
		return {
			valid: false,
			error: `Items array exceeds maximum of ${MAX_BULK_DISTRIBUTE_ITEMS} distinct seeds`,
		};
	}

	if (input.to && !HIVE_USERNAME_REGEX.test(input.to)) {
		return { valid: false, error: "Invalid recipient username format" };
	}

	const seenSeeds = new Set<string>();
	let totalQuantity = 0;

	for (let i = 0; i < input.items.length; i++) {
		const item = input.items[i]!;

		if (!item.seedId) {
			return { valid: false, error: `Item at index ${i}: seedId is required` };
		}

		if (seenSeeds.has(item.seedId)) {
			return { valid: false, error: `Duplicate seedId: ${item.seedId} — aggregate quantities instead` };
		}
		seenSeeds.add(item.seedId);

		if (typeof item.quantity !== "number" || item.quantity < 1) {
			return { valid: false, error: `Item at index ${i}: quantity must be a positive integer` };
		}

		totalQuantity += item.quantity;
	}

	if (totalQuantity > MAX_BULK_DISTRIBUTE_TOTAL) {
		return {
			valid: false,
			error: `Total quantity ${totalQuantity} exceeds maximum of ${MAX_BULK_DISTRIBUTE_TOTAL} instances per transaction`,
		};
	}

	return { valid: true };
}
