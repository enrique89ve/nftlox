// NFTLox PayloadBuilder - Robust Payload Construction
// Integrates validation, sanitization, and deterministic ID generation

import {
	generateDeterministicCollectionId,
	generateDeterministicSeedId,
	generateDeterministicInstanceId,
	generateDeterministicPackId,
	validateArtId,
	validateArtIdArray,
	generateOriginDnaSync,
	generateInstanceDna,
	generateAccessKey,
	generateImageHash,
	deterministicHash,
	type ArtIdValidationResult,
} from "./dna";

import {
	createDeterministicCollectionPayload,
	createDeterministicMintPayload,
	createDeterministicDistributePayload,
	createCollectionOperation,
	createMintOperation,
	createDistributeOperation,
	createTransferOperation,
	createListOperation,
	createUnlistPayload,
	createBurnPayload,
	createBuyPayload,
	createPackCreatePayload,
	createPackBuyPayload,
	createPackTransferPayload,
	createPackOpenPayload,
	createPackCreateOperation,
	createPackBuyOperation,
	createPackTransferOperation,
	createPackOpenOperation,
	type DeterministicCollectionInput,
	type DeterministicMintInput,
} from "./payloads";

import {
	type ValidationResult,
	validateCollectionInput,
	validateMintInput,
	validateListInput,
	validatePrice,
	validatePackCreateInput,
	validatePackBuyInput,
	validatePackTransferInput,
	validatePackOpenInput,
} from "./validation";

import {
	MAX_NAME_LENGTH,
	MAX_DESCRIPTION_LENGTH,
	MAX_IMAGE_URL_LENGTH,
	MAX_ROYALTY_PCT,
	SUPPORTED_CURRENCIES,
	MIN_SYMBOL_LENGTH,
	MAX_SYMBOL_LENGTH,
	PROTOCOL_ID,
	PROTOCOL_VERSION,
	HASH_VERSION,
	ACTION_CREATE_COLLECTION,
	ACTION_MINT,
	ACTION_DISTRIBUTE,
	ACTION_BURN,
	ACTION_UNLIST,
	ACTION_BUY,
	ACTION_PACK_CREATE,
	ACTION_PACK_BUY,
	ACTION_PACK_TRANSFER,
	ACTION_PACK_OPEN,
} from "./constants";

import type {
	HiveOperation,
	Price,
	CollectionData,
	NFTData,
	DistributeData,
	ListingData,
	UnlistData,
	BuyData,
	BurnData,
	TransferData,
	PackCreateData,
	PackBuyData,
	PackTransferData,
	PackOpenData,
	PackCreateInput,
	PackBuyInput,
	PackTransferInput,
	PackOpenInput,
	ProtocolPayload,
	DistributeInput,
	ListInput,
} from "./types";

// ============ BUILD RESULT INTERFACE ============

export interface ValidationError {
	field: string;
	message: string;
	code: string;
}

export interface BuildResult<T> {
	success: boolean;
	payload?: ProtocolPayload<T>;
	operation?: HiveOperation;
	errors?: ValidationError[];
	warnings?: string[];
	generatedId?: string;
	generatedIds?: Record<string, string>;
}

// ============ SEED BATCH TYPES ============

export interface SeedInput {
	artId: string;
	name: string;
	imageUrl: string;
	maxSupply: number;
	brief?: string;
}

export interface SeedBatchInput {
	collectionId: string;
	owner: string;
	seeds: SeedInput[];
}

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

// ============ PAYLOAD BUILDER CLASS ============

export class PayloadBuilder {
	// ============ SANITIZATION ============

	private sanitize(input: string): string {
		return input
			.replace(/&/g, "&amp;")
			.replace(/</g, "&lt;")
			.replace(/>/g, "&gt;")
			.replace(/"/g, "&quot;")
			.replace(/'/g, "&#x27;")
			.replace(/\//g, "&#x2F;")
			.replace(/\\/g, "&#x5C;")
			.replace(/[\x00-\x1F\x7F]/g, "")
			.trim();
	}

	private sanitizeOptional(input: string | undefined): string | undefined {
		return input ? this.sanitize(input) : undefined;
	}

	// ============ VALIDATION HELPERS ============

	private isValidHiveUsername(username: string): boolean {
		return /^[a-z][a-z0-9\-\.]{2,15}$/.test(username);
	}

	private isValidUrl(url: string): boolean {
		try {
			const parsed = new URL(url);
			return parsed.protocol === "http:" || parsed.protocol === "https:";
		} catch {
			return false;
		}
	}

	private isValidSymbol(symbol: string): boolean {
		return (
			symbol.length >= MIN_SYMBOL_LENGTH &&
			symbol.length <= MAX_SYMBOL_LENGTH &&
			/^[A-Z0-9]+$/.test(symbol)
		);
	}

	private isValidSeedId(seedId: string): boolean {
		return /^seed_[a-z0-9]{8,}$/.test(seedId);
	}

	private isValidNftId(nftId: string): boolean {
		return /^nft_[a-z0-9_]+$/.test(nftId) || /^seed_[a-z0-9]+$/.test(nftId);
	}

	private isValidDecimal(value: string): boolean {
		return /^\d+(\.\d{1,3})?$/.test(value) && parseFloat(value) > 0;
	}

	// ============ BUILD COLLECTION ============

	public buildCollection(input: {
		creator: string;
		name: string;
		symbol: string;
		totalPotential?: number;
		description?: string;
		image?: string;
		royaltyPct?: number;
	}): BuildResult<CollectionData> {
		const errors: ValidationError[] = [];
		const warnings: string[] = [];

		const sanitizedName = this.sanitize(input.name);
		const sanitizedDescription = this.sanitizeOptional(input.description);
		const normalizedSymbol = input.symbol.toUpperCase().trim();
		const totalPotential = input.totalPotential ?? 0;
		const royaltyPct = input.royaltyPct ?? 0;

		if (!this.isValidHiveUsername(input.creator)) {
			errors.push({
				field: "creator",
				message: "Invalid Hive username format (3-16 chars, lowercase, alphanumeric, -, .)",
				code: "INVALID_USERNAME",
			});
		}

		if (!sanitizedName || sanitizedName.length === 0) {
			errors.push({ field: "name", message: "Name is required", code: "NAME_REQUIRED" });
		} else if (sanitizedName.length > MAX_NAME_LENGTH) {
			errors.push({
				field: "name",
				message: `Name must be at most ${MAX_NAME_LENGTH} characters`,
				code: "NAME_TOO_LONG",
			});
		} else if (sanitizedName.length > MAX_NAME_LENGTH * 0.9) {
			warnings.push("Name is close to maximum length, consider shortening");
		}

		if (!this.isValidSymbol(normalizedSymbol)) {
			errors.push({
				field: "symbol",
				message: `Symbol must be ${MIN_SYMBOL_LENGTH}-${MAX_SYMBOL_LENGTH} uppercase alphanumeric characters`,
				code: "INVALID_SYMBOL",
			});
		}

		if (totalPotential < 0) {
			errors.push({ field: "totalPotential", message: "Total potential must be non-negative", code: "INVALID_TOTAL_POTENTIAL" });
		}

		if (!sanitizedDescription) {
			errors.push({ field: "description", message: "Description is required", code: "DESCRIPTION_REQUIRED" });
		} else if (sanitizedDescription.length > MAX_DESCRIPTION_LENGTH) {
			errors.push({
				field: "description",
				message: `Description must be at most ${MAX_DESCRIPTION_LENGTH} characters`,
				code: "DESCRIPTION_TOO_LONG",
			});
		}

		if (!input.image) {
			errors.push({ field: "image", message: "Image URL is required", code: "IMAGE_REQUIRED" });
		} else if (!this.isValidUrl(input.image)) {
			errors.push({ field: "image", message: "Invalid image URL format", code: "INVALID_IMAGE_URL" });
		} else if (input.image.length > MAX_IMAGE_URL_LENGTH) {
			errors.push({
				field: "image",
				message: `Image URL must be at most ${MAX_IMAGE_URL_LENGTH} characters`,
				code: "IMAGE_URL_TOO_LONG",
			});
		}

		if (royaltyPct < 0 || royaltyPct > MAX_ROYALTY_PCT) {
			errors.push({
				field: "royaltyPct",
				message: `Royalty percentage must be between 0 and ${MAX_ROYALTY_PCT}`,
				code: "INVALID_ROYALTY",
			});
		} else if (royaltyPct > 25) {
			warnings.push("Royalty percentage is high (>25%), consider reducing");
		}

		if (errors.length > 0) {
			return { success: false, errors };
		}

		const generatedId = generateDeterministicCollectionId(
			input.creator,
			sanitizedName,
			normalizedSymbol,
		);
		const originDna = generateOriginDnaSync(generatedId);

		const collectionInput: DeterministicCollectionInput = {
			creator: input.creator,
			name: sanitizedName,
			symbol: normalizedSymbol,
			totalPotential,
			metadata: {
				description: sanitizedDescription!,
				image: input.image!,
			},
			rules: {
				transferable: true,
				burnable: true,
				royaltyPct,
				royaltyRecipient: input.creator,
			},
		};

		const payload = createDeterministicCollectionPayload(collectionInput);
		const operation = createCollectionOperation({
			...collectionInput,
			jsonId: payload.data.jsonId,
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

	// ============ BUILD SEED ============

	public buildSeed(input: {
		artId: string;
		collectionId: string;
		name: string;
		imageUrl: string;
		maxSupply: number;
		owner: string;
		edition: number;
		brief?: string;
	}): BuildResult<NFTData> {
		const errors: ValidationError[] = [];
		const warnings: string[] = [];

		const artIdValidation = validateArtId(input.artId);
		if (!artIdValidation.valid) {
			errors.push({ field: "artId", message: artIdValidation.error!, code: "INVALID_ARTID" });
		}

		const sanitizedName = this.sanitize(input.name);
		const sanitizedBrief = this.sanitizeOptional(input.brief);

		if (!sanitizedName || sanitizedName.length === 0) {
			errors.push({ field: "name", message: "Name is required", code: "NAME_REQUIRED" });
		} else if (sanitizedName.length > MAX_NAME_LENGTH) {
			errors.push({
				field: "name",
				message: `Name must be at most ${MAX_NAME_LENGTH} characters`,
				code: "NAME_TOO_LONG",
			});
		}

		if (sanitizedBrief && sanitizedBrief.length > MAX_DESCRIPTION_LENGTH) {
			errors.push({
				field: "brief",
				message: `Brief must be at most ${MAX_DESCRIPTION_LENGTH} characters`,
				code: "BRIEF_TOO_LONG",
			});
		}

		if (!this.isValidUrl(input.imageUrl)) {
			errors.push({ field: "imageUrl", message: "Invalid image URL format", code: "INVALID_IMAGE_URL" });
		} else if (input.imageUrl.length > MAX_IMAGE_URL_LENGTH) {
			errors.push({
				field: "imageUrl",
				message: `Image URL must be at most ${MAX_IMAGE_URL_LENGTH} characters`,
				code: "IMAGE_URL_TOO_LONG",
			});
		}

		if (input.maxSupply <= 0) {
			errors.push({ field: "maxSupply", message: "Max supply must be greater than 0", code: "INVALID_MAX_SUPPLY" });
		} else if (input.maxSupply > 10000) {
			warnings.push("Max supply is very large (>10000), ensure this is intentional");
		}

		if (input.edition < 1) {
			errors.push({ field: "edition", message: "Edition must be at least 1", code: "INVALID_EDITION" });
		}

		if (!this.isValidHiveUsername(input.owner)) {
			errors.push({
				field: "owner",
				message: "Invalid Hive username format",
				code: "INVALID_USERNAME",
			});
		}

		if (!input.collectionId) {
			errors.push({ field: "collectionId", message: "Collection ID is required", code: "COLLECTION_ID_REQUIRED" });
		}

		if (errors.length > 0) {
			return { success: false, errors };
		}

		const generatedId = generateDeterministicSeedId(input.collectionId, input.artId);
		const originDna = generateOriginDnaSync(input.collectionId);

		const mintInput: DeterministicMintInput = {
			artId: input.artId,
			collectionId: input.collectionId,
			collectionOriginDna: originDna,
			edition: input.edition,
			owner: input.owner,
			name: sanitizedName,
			description: sanitizedBrief,
			imageUrl: input.imageUrl,
			maxReplicas: input.maxSupply,
		};

		const payload = createDeterministicMintPayload(mintInput);
		const operation = createMintOperation({
			collectionId: input.collectionId,
			collectionOriginDna: originDna,
			edition: input.edition,
			owner: input.owner,
			name: sanitizedName,
			description: sanitizedBrief,
			imageUrl: input.imageUrl,
			maxReplicas: input.maxSupply,
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

	// ============ BUILD SEED BATCH ============

	public buildSeedBatch(input: SeedBatchInput): BuildResult<SeedBatchPayload> {
		const errors: ValidationError[] = [];
		const warnings: string[] = [];

		if (!this.isValidHiveUsername(input.owner)) {
			errors.push({
				field: "owner",
				message: "Invalid Hive username format",
				code: "INVALID_USERNAME",
			});
		}

		if (!input.collectionId) {
			errors.push({ field: "collectionId", message: "Collection ID is required", code: "COLLECTION_ID_REQUIRED" });
		}

		if (!input.seeds || input.seeds.length === 0) {
			errors.push({ field: "seeds", message: "At least one seed is required", code: "SEEDS_REQUIRED" });
			return { success: false, errors };
		}

		const artIds = input.seeds.map((seed) => seed.artId);
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

		for (let i = 0; i < input.seeds.length; i++) {
			const seed = input.seeds[i]!;
			const sanitizedName = this.sanitize(seed.name);
			const sanitizedBrief = this.sanitizeOptional(seed.brief);

			if (!sanitizedName || sanitizedName.length === 0) {
				errors.push({
					field: `seeds[${i}].name`,
					message: "Name is required",
					code: "NAME_REQUIRED",
				});
			} else if (sanitizedName.length > MAX_NAME_LENGTH) {
				errors.push({
					field: `seeds[${i}].name`,
					message: `Name must be at most ${MAX_NAME_LENGTH} characters`,
					code: "NAME_TOO_LONG",
				});
			}

			if (sanitizedBrief && sanitizedBrief.length > MAX_DESCRIPTION_LENGTH) {
				errors.push({
					field: `seeds[${i}].brief`,
					message: `Brief must be at most ${MAX_DESCRIPTION_LENGTH} characters`,
					code: "BRIEF_TOO_LONG",
				});
			}

			if (!this.isValidUrl(seed.imageUrl)) {
				errors.push({
					field: `seeds[${i}].imageUrl`,
					message: "Invalid image URL format",
					code: "INVALID_IMAGE_URL",
				});
			} else if (seed.imageUrl.length > MAX_IMAGE_URL_LENGTH) {
				errors.push({
					field: `seeds[${i}].imageUrl`,
					message: `Image URL must be at most ${MAX_IMAGE_URL_LENGTH} characters`,
					code: "IMAGE_URL_TOO_LONG",
				});
			}

			if (seed.maxSupply <= 0) {
				errors.push({
					field: `seeds[${i}].maxSupply`,
					message: "Max supply must be greater than 0",
					code: "INVALID_MAX_SUPPLY",
				});
			} else if (seed.maxSupply > 10000) {
				warnings.push(`Seed ${i}: Max supply is very large (>10000)`);
			}
		}

		if (errors.length > 0) {
			return { success: false, errors };
		}

		const processedSeeds = input.seeds.map((seed) => {
			const seedId = generateDeterministicSeedId(input.collectionId, seed.artId);
			return {
				seedId,
				artId: seed.artId,
				name: this.sanitize(seed.name),
				imageUrl: seed.imageUrl,
				maxSupply: seed.maxSupply,
				brief: this.sanitizeOptional(seed.brief),
			};
		});

		const payload: ProtocolPayload<SeedBatchPayload> = {
			protocol: PROTOCOL_ID,
			version: PROTOCOL_VERSION,
			action: ACTION_MINT,
			data: {
				collectionId: input.collectionId,
				owner: input.owner,
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

	// ============ BUILD DISTRIBUTE ============

	public buildDistribute(input: {
		seedId: string;
		to: string;
		instanceNumber: number;
		owner: string;
	}): BuildResult<DistributeData> {
		const errors: ValidationError[] = [];

		if (!this.isValidSeedId(input.seedId)) {
			errors.push({
				field: "seedId",
				message: "Invalid seed ID format (must start with 'seed_')",
				code: "INVALID_SEED_ID",
			});
		}

		if (!this.isValidHiveUsername(input.to)) {
			errors.push({
				field: "to",
				message: "Invalid Hive username format",
				code: "INVALID_USERNAME",
			});
		}

		if (!this.isValidHiveUsername(input.owner)) {
			errors.push({
				field: "owner",
				message: "Invalid Hive username format",
				code: "INVALID_USERNAME",
			});
		}

		if (input.instanceNumber <= 0) {
			errors.push({
				field: "instanceNumber",
				message: "Instance number must be greater than 0",
				code: "INVALID_INSTANCE_NUMBER",
			});
		}

		if (errors.length > 0) {
			return { success: false, errors };
		}

		const generatedId = generateDeterministicInstanceId(input.seedId, input.instanceNumber);

		const distributeInput: DistributeInput = {
			seedId: input.seedId,
			to: input.to,
			instanceNumber: input.instanceNumber,
		};

		const payload = createDeterministicDistributePayload(distributeInput);
		const operation = createDistributeOperation(distributeInput, input.owner);

		return {
			success: true,
			payload,
			operation,
			generatedId,
			generatedIds: { instanceId: generatedId },
		};
	}

	// ============ BUILD TRANSFER ============

	public buildTransfer(input: {
		nftId: string;
		from: string;
		to: string;
		imageUrl?: string;
		imageHash?: string;
	}): BuildResult<TransferData> {
		const errors: ValidationError[] = [];
		const warnings: string[] = [];

		if (!this.isValidNftId(input.nftId)) {
			errors.push({
				field: "nftId",
				message: "Invalid NFT ID format",
				code: "INVALID_NFT_ID",
			});
		}

		if (!this.isValidHiveUsername(input.from)) {
			errors.push({
				field: "from",
				message: "Invalid Hive username format",
				code: "INVALID_USERNAME",
			});
		}

		if (!this.isValidHiveUsername(input.to)) {
			errors.push({
				field: "to",
				message: "Invalid Hive username format",
				code: "INVALID_USERNAME",
			});
		}

		if (input.from === input.to) {
			errors.push({
				field: "to",
				message: "Cannot transfer to yourself",
				code: "TRANSFER_TO_SELF",
			});
		}

		if (input.imageUrl && !this.isValidUrl(input.imageUrl)) {
			errors.push({
				field: "imageUrl",
				message: "Invalid image URL format",
				code: "INVALID_IMAGE_URL",
			});
		}

		if (!input.imageUrl) {
			warnings.push("imageUrl not provided - recommended for indexer verification");
		}

		if (errors.length > 0) {
			return { success: false, errors };
		}

		// Generate imageHash if imageUrl provided but no hash
		const imageHash = input.imageHash || (input.imageUrl ? generateImageHash(input.imageUrl) : undefined);

		const payload: ProtocolPayload<TransferData> = {
			protocol: PROTOCOL_ID,
			version: PROTOCOL_VERSION,
			action: "transfer",
			data: {
				nftId: input.nftId,
				from: input.from,
				to: input.to,
				...(input.imageUrl && { imageUrl: input.imageUrl }),
				...(imageHash && { imageHash }),
			},
		};

		const operation: HiveOperation = [
			"custom_json",
			{
				required_auths: [],
				required_posting_auths: [input.from],
				id: PROTOCOL_ID,
				json: JSON.stringify(payload),
			},
		];

		return {
			success: true,
			payload,
			operation,
			warnings: warnings.length > 0 ? warnings : undefined,
		};
	}

	// ============ BUILD LIST ============

	public buildList(input: {
		nftId: string;
		price: { amount: string; currency: "HIVE" | "HBD" };
		owner: string;
		expiresAt?: number;
		imageUrl?: string;
		imageHash?: string;
	}): BuildResult<ListingData> {
		const errors: ValidationError[] = [];
		const warnings: string[] = [];

		if (!this.isValidNftId(input.nftId)) {
			errors.push({
				field: "nftId",
				message: "Invalid NFT ID format",
				code: "INVALID_NFT_ID",
			});
		}

		if (!this.isValidHiveUsername(input.owner)) {
			errors.push({
				field: "owner",
				message: "Invalid Hive username format",
				code: "INVALID_USERNAME",
			});
		}

		if (!this.isValidDecimal(input.price.amount)) {
			errors.push({
				field: "price.amount",
				message: "Invalid price amount (must be decimal > 0)",
				code: "INVALID_PRICE_AMOUNT",
			});
		}

		const amount = parseFloat(input.price.amount);
		if (amount < 0.001) {
			errors.push({
				field: "price.amount",
				message: "Price must be at least 0.001",
				code: "PRICE_TOO_LOW",
			});
		}

		if (!SUPPORTED_CURRENCIES.includes(input.price.currency)) {
			errors.push({
				field: "price.currency",
				message: `Currency must be one of: ${SUPPORTED_CURRENCIES.join(", ")}`,
				code: "INVALID_CURRENCY",
			});
		}

		if (input.expiresAt && input.expiresAt < Date.now()) {
			errors.push({
				field: "expiresAt",
				message: "Expiration date must be in the future",
				code: "EXPIRED_DATE",
			});
		}

		if (input.imageUrl && !this.isValidUrl(input.imageUrl)) {
			errors.push({
				field: "imageUrl",
				message: "Invalid image URL format",
				code: "INVALID_IMAGE_URL",
			});
		}

		if (!input.imageUrl) {
			warnings.push("imageUrl not provided - recommended for marketplace display");
		}

		if (errors.length > 0) {
			return { success: false, errors };
		}

		// Generate imageHash if imageUrl provided but no hash
		const imageHash = input.imageHash || (input.imageUrl ? generateImageHash(input.imageUrl) : undefined);

		const payload: ProtocolPayload<ListingData> = {
			protocol: PROTOCOL_ID,
			version: PROTOCOL_VERSION,
			action: "list",
			data: {
				nftId: input.nftId,
				price: {
					amount: input.price.amount,
					currency: input.price.currency,
				},
				...(input.expiresAt && { expiresAt: input.expiresAt }),
				...(input.imageUrl && { imageUrl: input.imageUrl }),
				...(imageHash && { imageHash }),
			},
		};

		const operation: HiveOperation = [
			"custom_json",
			{
				required_auths: [],
				required_posting_auths: [input.owner],
				id: PROTOCOL_ID,
				json: JSON.stringify(payload),
			},
		];

		return {
			success: true,
			payload,
			operation,
			warnings: warnings.length > 0 ? warnings : undefined,
		};
	}

	// ============ BUILD BURN ============

	public buildBurn(input: {
		nftId: string;
		owner: string;
		imageUrl?: string;
		imageHash?: string;
	}): BuildResult<BurnData> {
		const errors: ValidationError[] = [];

		if (!this.isValidNftId(input.nftId)) {
			errors.push({
				field: "nftId",
				message: "Invalid NFT ID format",
				code: "INVALID_NFT_ID",
			});
		}

		if (!this.isValidHiveUsername(input.owner)) {
			errors.push({
				field: "owner",
				message: "Invalid Hive username format",
				code: "INVALID_USERNAME",
			});
		}

		if (input.imageUrl && !this.isValidUrl(input.imageUrl)) {
			errors.push({
				field: "imageUrl",
				message: "Invalid image URL format",
				code: "INVALID_IMAGE_URL",
			});
		}

		if (errors.length > 0) {
			return { success: false, errors };
		}

		// Generate imageHash if imageUrl provided but no hash
		const imageHash = input.imageHash || (input.imageUrl ? generateImageHash(input.imageUrl) : undefined);

		const payload: ProtocolPayload<BurnData> = {
			protocol: PROTOCOL_ID,
			version: PROTOCOL_VERSION,
			action: ACTION_BURN,
			data: {
				nftId: input.nftId,
				...(input.imageUrl && { imageUrl: input.imageUrl }),
				...(imageHash && { imageHash }),
			},
		};

		const operation: HiveOperation = [
			"custom_json",
			{
				required_auths: [],
				required_posting_auths: [input.owner],
				id: PROTOCOL_ID,
				json: JSON.stringify(payload),
			},
		];

		return {
			success: true,
			payload,
			operation,
		};
	}

	// ============ BUILD UNLIST ============

	public buildUnlist(input: {
		nftId: string;
		owner: string;
		imageUrl?: string;
		imageHash?: string;
	}): BuildResult<UnlistData> {
		const errors: ValidationError[] = [];

		if (!this.isValidNftId(input.nftId)) {
			errors.push({
				field: "nftId",
				message: "Invalid NFT ID format",
				code: "INVALID_NFT_ID",
			});
		}

		if (!this.isValidHiveUsername(input.owner)) {
			errors.push({
				field: "owner",
				message: "Invalid Hive username format",
				code: "INVALID_USERNAME",
			});
		}

		if (input.imageUrl && !this.isValidUrl(input.imageUrl)) {
			errors.push({
				field: "imageUrl",
				message: "Invalid image URL format",
				code: "INVALID_IMAGE_URL",
			});
		}

		if (errors.length > 0) {
			return { success: false, errors };
		}

		// Generate imageHash if imageUrl provided but no hash
		const imageHash = input.imageHash || (input.imageUrl ? generateImageHash(input.imageUrl) : undefined);

		const payload: ProtocolPayload<UnlistData> = {
			protocol: PROTOCOL_ID,
			version: PROTOCOL_VERSION,
			action: ACTION_UNLIST,
			data: {
				nftId: input.nftId,
				...(input.imageUrl && { imageUrl: input.imageUrl }),
				...(imageHash && { imageHash }),
			},
		};

		const operation: HiveOperation = [
			"custom_json",
			{
				required_auths: [],
				required_posting_auths: [input.owner],
				id: PROTOCOL_ID,
				json: JSON.stringify(payload),
			},
		];

		return {
			success: true,
			payload,
			operation,
		};
	}

	// ============ BUILD BUY ============

	public buildBuy(input: {
		nftId: string;
		buyer: string;
		paymentTxId: string;
		imageUrl?: string;
		imageHash?: string;
	}): BuildResult<BuyData> {
		const errors: ValidationError[] = [];

		if (!this.isValidNftId(input.nftId)) {
			errors.push({
				field: "nftId",
				message: "Invalid NFT ID format",
				code: "INVALID_NFT_ID",
			});
		}

		if (!this.isValidHiveUsername(input.buyer)) {
			errors.push({
				field: "buyer",
				message: "Invalid Hive username format",
				code: "INVALID_USERNAME",
			});
		}

		if (!input.paymentTxId || input.paymentTxId.length === 0) {
			errors.push({
				field: "paymentTxId",
				message: "Payment transaction ID is required",
				code: "PAYMENT_TX_REQUIRED",
			});
		}

		if (input.imageUrl && !this.isValidUrl(input.imageUrl)) {
			errors.push({
				field: "imageUrl",
				message: "Invalid image URL format",
				code: "INVALID_IMAGE_URL",
			});
		}

		if (errors.length > 0) {
			return { success: false, errors };
		}

		// Generate imageHash if imageUrl provided but no hash
		const imageHash = input.imageHash || (input.imageUrl ? generateImageHash(input.imageUrl) : undefined);

		const payload: ProtocolPayload<BuyData> = {
			protocol: PROTOCOL_ID,
			version: PROTOCOL_VERSION,
			action: ACTION_BUY,
			data: {
				nftId: input.nftId,
				paymentTxId: input.paymentTxId,
				...(input.imageUrl && { imageUrl: input.imageUrl }),
				...(imageHash && { imageHash }),
			},
		};

		const operation: HiveOperation = [
			"custom_json",
			{
				required_auths: [],
				required_posting_auths: [input.buyer],
				id: PROTOCOL_ID,
				json: JSON.stringify(payload),
			},
		];

		return {
			success: true,
			payload,
			operation,
		};
	}

	// ============ BUILD PACK CREATE ============

	public buildPackCreate(input: {
		collectionId: string;
		name: string;
		creator: string;
		description?: string;
		imageUrl?: string;
		dropTable: Array<{ seedId: string; weight: number }>;
		itemsPerPack: number;
		price?: { amount: string; currency: "HIVE" | "HBD" };
		maxSupply: number;
	}): BuildResult<PackCreateData> {
		const errors: ValidationError[] = [];

		const sanitizedName = this.sanitize(input.name);
		const sanitizedDescription = this.sanitizeOptional(input.description);

		if (!this.isValidHiveUsername(input.creator)) {
			errors.push({
				field: "creator",
				message: "Invalid Hive username format",
				code: "INVALID_USERNAME",
			});
		}

		const packInput: PackCreateInput = {
			collectionId: input.collectionId,
			name: sanitizedName,
			description: sanitizedDescription,
			imageUrl: input.imageUrl,
			dropTable: input.dropTable,
			itemsPerPack: input.itemsPerPack,
			price: input.price,
			maxSupply: input.maxSupply,
		};

		const validation = validatePackCreateInput(packInput);
		if (!validation.valid) {
			errors.push({
				field: "input",
				message: validation.error!,
				code: "VALIDATION_FAILED",
			});
		}

		if (errors.length > 0) {
			return { success: false, errors };
		}

		const generatedId = generateDeterministicPackId(input.collectionId, sanitizedName);
		const payload = createPackCreatePayload(packInput, input.creator);
		const operation = createPackCreateOperation(packInput, input.creator);

		return {
			success: true,
			payload,
			operation,
			generatedId,
			generatedIds: { packId: generatedId },
		};
	}

	// ============ BUILD PACK BUY ============

	public buildPackBuy(input: {
		packId: string;
		buyer: string;
		quantity: number;
	}): BuildResult<PackBuyData> {
		const errors: ValidationError[] = [];

		if (!this.isValidHiveUsername(input.buyer)) {
			errors.push({
				field: "buyer",
				message: "Invalid Hive username format",
				code: "INVALID_USERNAME",
			});
		}

		const buyInput: PackBuyInput = {
			packId: input.packId,
			quantity: input.quantity,
		};

		const validation = validatePackBuyInput(buyInput);
		if (!validation.valid) {
			errors.push({
				field: "input",
				message: validation.error!,
				code: "VALIDATION_FAILED",
			});
		}

		if (errors.length > 0) {
			return { success: false, errors };
		}

		const payload = createPackBuyPayload(buyInput);
		const operation = createPackBuyOperation(buyInput, input.buyer);

		return { success: true, payload, operation };
	}

	// ============ BUILD PACK TRANSFER ============

	public buildPackTransfer(input: {
		packId: string;
		from: string;
		to: string;
		quantity: number;
	}): BuildResult<PackTransferData> {
		const errors: ValidationError[] = [];

		if (!this.isValidHiveUsername(input.from)) {
			errors.push({
				field: "from",
				message: "Invalid Hive username format",
				code: "INVALID_USERNAME",
			});
		}

		const transferInput: PackTransferInput = {
			packId: input.packId,
			to: input.to,
			quantity: input.quantity,
		};

		const validation = validatePackTransferInput(transferInput);
		if (!validation.valid) {
			errors.push({
				field: "input",
				message: validation.error!,
				code: "VALIDATION_FAILED",
			});
		}

		if (input.from === input.to) {
			errors.push({
				field: "to",
				message: "Cannot transfer to yourself",
				code: "TRANSFER_TO_SELF",
			});
		}

		if (errors.length > 0) {
			return { success: false, errors };
		}

		const payload = createPackTransferPayload(transferInput);
		const operation = createPackTransferOperation(transferInput, input.from);

		return { success: true, payload, operation };
	}

	// ============ BUILD PACK OPEN ============

	public buildPackOpen(input: {
		packId: string;
		opener: string;
		quantity: number;
	}): BuildResult<PackOpenData> {
		const errors: ValidationError[] = [];

		if (!this.isValidHiveUsername(input.opener)) {
			errors.push({
				field: "opener",
				message: "Invalid Hive username format",
				code: "INVALID_USERNAME",
			});
		}

		const openInput: PackOpenInput = {
			packId: input.packId,
			quantity: input.quantity,
		};

		const validation = validatePackOpenInput(openInput);
		if (!validation.valid) {
			errors.push({
				field: "input",
				message: validation.error!,
				code: "VALIDATION_FAILED",
			});
		}

		if (errors.length > 0) {
			return { success: false, errors };
		}

		const payload = createPackOpenPayload(openInput);
		const operation = createPackOpenOperation(openInput, input.opener);

		return { success: true, payload, operation };
	}

	// ============ UTILITY METHODS ============

	/**
	 * Preview IDs that would be generated for a collection and seeds.
	 * Useful for pre-validation before minting.
	 */
	public previewIds(input: {
		creator: string;
		name: string;
		symbol: string;
		seeds: Array<{ artId: string }>;
	}): {
		collectionId: string;
		originDna: string;
		seedIds: Map<string, string>;
	} {
		const collectionId = generateDeterministicCollectionId(
			input.creator.toLowerCase(),
			input.name,
			input.symbol.toUpperCase(),
		);
		const originDna = generateOriginDnaSync(collectionId);
		const seedIds = new Map<string, string>();

		for (const seed of input.seeds) {
			const seedId = generateDeterministicSeedId(collectionId, seed.artId);
			seedIds.set(seed.artId, seedId);
		}

		return { collectionId, originDna, seedIds };
	}

	/**
	 * Get version info for the PayloadBuilder.
	 */
	public getVersionInfo(): {
		protocolId: string;
		protocolVersion: string;
		hashVersion: string;
	} {
		return {
			protocolId: PROTOCOL_ID,
			protocolVersion: PROTOCOL_VERSION,
			hashVersion: HASH_VERSION,
		};
	}
}

// Singleton instance for convenience
export const payloadBuilder = new PayloadBuilder();
