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
} from "./constants";

import type {
	CreateCollectionInput,
	MintInput,
	ListInput,
	OfferInput,
	Price,
	ImportedNFT,
	HiveOperation,
} from "./types";

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
