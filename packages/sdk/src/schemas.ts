import { z } from "zod";
import {
	MIN_SYMBOL_LENGTH,
	MAX_SYMBOL_LENGTH,
	MAX_NAME_LENGTH,
	MAX_DESCRIPTION_LENGTH,
	MAX_IMAGE_URL_LENGTH,
	MAX_ROYALTY_PCT,
	SUPPORTED_CURRENCIES,
	MIN_PRICE_AMOUNT,
	MAX_BULK_DISTRIBUTE_ITEMS,
	SYMBOL_REGEX,
	TX_ID_REGEX,
	validateHiveUsername,
} from "@nftlox/protocol";

export { validateHiveUsername };

// Safe URL: only http:// and https:// protocols (blocks javascript:, data:, etc.)
const httpUrlSchema = z.string().url().refine(
	(val) => /^https?:\/\//i.test(val),
	{ message: "URL must use http or https protocol" },
);

// ============ REUSABLE SCHEMAS ============

export const usernameSchema = z.string().refine(
	(val) => validateHiveUsername(val) === null,
	{ message: "Invalid Hive username format" },
);

export const txIdSchema = z.string().regex(TX_ID_REGEX, "Invalid transaction ID: expected 40-char hex string");

export const symbolSchema = z
	.string()
	.trim()
	.toUpperCase()
	.min(MIN_SYMBOL_LENGTH, `Symbol must be at least ${MIN_SYMBOL_LENGTH} characters`)
	.max(MAX_SYMBOL_LENGTH, `Symbol must be at most ${MAX_SYMBOL_LENGTH} characters`)
	.regex(SYMBOL_REGEX, "Symbol must start with a letter and contain only uppercase letters and numbers (A-Z, 0-9)");

export const priceSchema = z.object({
	amount: z.string()
		.refine(
			(val) => !isNaN(parseFloat(val)) && parseFloat(val) > 0,
			{ message: "Price must be a valid positive number" },
		)
		.transform((val) => parseFloat(val).toFixed(3))
		.refine(
			(val) => parseFloat(val) >= parseFloat(MIN_PRICE_AMOUNT),
			{ message: `Price amount must be at least ${MIN_PRICE_AMOUNT}` },
		),
	currency: z.enum(SUPPORTED_CURRENCIES),
});

export const seedProvenanceSchema = z.object({
	seedId: z.string().optional(),
	seedTxId: txIdSchema.optional(),
});

// ============ SCHEMA FIELD SCHEMAS ============

const SCHEMA_FIELD_TYPES = [
	"string", "bool",
	"uint8", "uint16", "uint32", "uint64",
	"int8", "int16", "int32", "int64",
	"float", "double",
	"string[]", "bool[]",
	"uint8[]", "uint16[]", "uint32[]", "uint64[]",
	"int8[]", "int16[]", "int32[]", "int64[]",
	"float[]", "double[]",
] as const;

export const schemaFieldSchema = z.object({
	name: z.string().min(1).max(64).regex(/^[a-z][a-z0-9_]*$/, "Field name must be lowercase with underscores"),
	type: z.enum(SCHEMA_FIELD_TYPES),
});

export const collectionSchemaSchema = z.object({
	immutable: z.array(schemaFieldSchema).default([]),
	mutable: z.array(schemaFieldSchema).min(1, "Schema must have at least one mutable field"),
});

export const extendSchemaInputSchema = z.object({
	collectionId: z.string().min(1, "Collection ID is required"),
	newImmutableFields: z.array(schemaFieldSchema).optional(),
	newMutableFields: z.array(schemaFieldSchema).optional(),
});
export type ExtendSchemaInput = z.infer<typeof extendSchemaInputSchema>;

export const archiveCollectionInputSchema = z.object({
	collectionId: z.string().min(1, "Collection ID is required"),
});
export type ArchiveCollectionInput = z.infer<typeof archiveCollectionInputSchema>;

// ============ INPUT SCHEMAS ============

export const createCollectionInputSchema = z.object({
	name: z.string().min(1, "Name is required").max(MAX_NAME_LENGTH, `Name must be at most ${MAX_NAME_LENGTH} characters`),
	symbol: symbolSchema,
	creator: usernameSchema,
	totalPotential: z.number().int("Total potential must be an integer").nonnegative("Total potential must be non-negative"),
	metadata: z.object({
		description: z.string().min(1, "Description is required").max(MAX_DESCRIPTION_LENGTH, `Description must be at most ${MAX_DESCRIPTION_LENGTH} characters`),
		image: httpUrlSchema.max(MAX_IMAGE_URL_LENGTH, `Image URL must be at most ${MAX_IMAGE_URL_LENGTH} characters`),
		externalUrl: httpUrlSchema.optional(),
	}),
	rules: z.object({
		transferable: z.boolean(),
		burnable: z.boolean(),
		royaltyPct: z.number().min(0).max(MAX_ROYALTY_PCT, `Royalty percentage must be between 0 and ${MAX_ROYALTY_PCT}`),
		royaltyRecipient: z.string().optional(),
	}),
	schema: collectionSchemaSchema.optional(),
});
export type CreateCollectionInput = z.infer<typeof createCollectionInputSchema>;

export const mintInputSchema = z.object({
	collectionId: z.string().min(1, "Collection ID is required"),
	collectionOriginDna: z.string().min(1, "Collection origin DNA is required"),
	edition: z.number().int().min(1, "Edition must be at least 1"),
	owner: usernameSchema,
	nftType: z.enum(["seed", "instance"]).optional(),
	name: z.string().min(1, "Name is required").max(MAX_NAME_LENGTH),
	description: z.string().max(MAX_DESCRIPTION_LENGTH).optional(),
	imageUrl: httpUrlSchema.max(MAX_IMAGE_URL_LENGTH),
	imageHash: z.string().optional(),
	maxSupply: z.number().int().min(1, "Max supply must be at least 1").optional(),
	data: z.record(z.string(), z.unknown()).optional().refine(
		(obj) => !obj || Object.keys(obj).length <= 64,
		"Data object cannot exceed 64 fields",
	),
	immutableData: z.record(z.string(), z.unknown()).optional().refine(
		(obj) => !obj || Object.keys(obj).length <= 64,
		"Data object cannot exceed 64 fields",
	),
	mutableData: z.record(z.string(), z.unknown()).optional().refine(
		(obj) => !obj || Object.keys(obj).length <= 64,
		"Data object cannot exceed 64 fields",
	),
	collectionBlock: z.number().int().nonnegative("collectionBlock must be a non-negative integer").optional(),
});
export type MintInput = z.infer<typeof mintInputSchema>;

export const listInputSchema = seedProvenanceSchema.extend({
	nftId: z.string().min(1, "NFT ID is required"),
	price: priceSchema,
	expiresAt: z.number().refine((v) => v > Date.now(), { message: "Expiration date must be in the future" }).optional(),
	imageUrl: httpUrlSchema.optional(),
	imageHash: z.string().optional(),
	marketplace: z.string().optional(),
});
export type ListInput = z.infer<typeof listInputSchema>;

export const buyInputSchema = z.object({
	nftId: z.string().min(1, "NFT ID is required"),
	listingId: z.string().min(1, "Listing ID is required"),
	listTxId: txIdSchema,
	txId: txIdSchema,
	seedId: z.string().optional(),
	seedTxId: txIdSchema.optional(),
});
export type BuyInput = z.infer<typeof buyInputSchema>;

export const importedNftSchema = z.object({
	nftId: z.string().min(1, "NFT ID is required"),
	name: z.string().min(1, "Name is required"),
	brief: z.string().max(MAX_DESCRIPTION_LENGTH).optional(),
	imageUrl: httpUrlSchema,
	imageHash: z.string().optional(),
	maxSupply: z.number().int().min(1).default(1),
});
export type ImportedNFT = z.infer<typeof importedNftSchema>;

export const bulkDistributeItemSchema = z.object({
	seedId: z.string().min(1, "seedId is required"),
	quantity: z.number().int().min(1, "Quantity must be positive"),
	seedTxId: txIdSchema,
});

export const bulkDistributeInputSchema = z.object({
	to: usernameSchema.optional(),
	items: z.array(bulkDistributeItemSchema)
		.min(1, "Items array cannot be empty")
		.max(MAX_BULK_DISTRIBUTE_ITEMS)
		.refine(
			(items) => {
				const unique = new Set(items.map(i => i.seedId));
				return unique.size === items.length;
			},
			{ message: "Duplicate seedId: aggregate quantities instead" }
		),
	imageOverrides: z.record(z.string(), z.object({ imageUrl: z.string().optional(), imageHash: z.string().optional() })).refine(
		(obj) => Object.keys(obj).length <= 50,
		"imageOverrides cannot exceed 50 entries",
	).optional(),
	data: z.record(z.string(), z.unknown()).optional().refine(
		(obj) => !obj || Object.keys(obj).length <= 64,
		"Data object cannot exceed 64 fields",
	),
	mutableData: z.record(z.string(), z.unknown()).optional().refine(
		(obj) => !obj || Object.keys(obj).length <= 64,
		"Data object cannot exceed 64 fields",
	),
});
export type BulkDistributeInput = z.infer<typeof bulkDistributeInputSchema>;

export const burnInputSchema = z.object({
	nftId: z.string().min(1).optional(),
	nftIds: z.array(z.string().min(1)).min(1).optional(),
	owner: usernameSchema,
}).refine(
	(data) => Boolean(data.nftId) || Boolean(data.nftIds),
	{ message: "Either nftId or nftIds is required" },
);
export type BurnInput = z.infer<typeof burnInputSchema>;

export const unlistInputSchema = z.object({
	nftId: z.string().min(1),
	imageUrl: httpUrlSchema.optional(),
	imageHash: z.string().optional(),
	seedId: z.string().optional(),
	seedTxId: z.string().optional(),
});
export type UnlistInput = z.infer<typeof unlistInputSchema>;

export const nftApproveInputSchema = z.object({
	spender: usernameSchema,
	instanceId: z.string().min(1),
	approved: z.boolean(),
});
export type NftApproveInput = z.infer<typeof nftApproveInputSchema>;

export const nftApproveAllInputSchema = z.object({
	spender: usernameSchema,
	collectionId: z.string().min(1),
	approved: z.boolean(),
});
export type NftApproveAllInput = z.infer<typeof nftApproveAllInputSchema>;

export const nftTransferFromInputSchema = seedProvenanceSchema.extend({
	from: usernameSchema,
	to: usernameSchema,
	instanceId: z.string().min(1),
});
export type NftTransferFromInput = z.infer<typeof nftTransferFromInputSchema>;

export const setDataInputSchema = z.object({
	nftId: z.string().min(1),
	instanceDna: z.string().min(1),
	data: z.record(z.string(), z.unknown()).optional().refine(
		(obj) => !obj || Object.keys(obj).length <= 64,
		"Data object cannot exceed 64 fields",
	),
	mutableData: z.record(z.string(), z.unknown()).optional().refine(
		(obj) => !obj || Object.keys(obj).length <= 64,
		"Data object cannot exceed 64 fields",
	),
	seedId: z.string().optional(),
	seedTxId: z.string().optional(),
});
export type SetDataInput = z.infer<typeof setDataInputSchema>;

export const dataOperatorApproveInputSchema = z.object({
	collectionId: z.string().min(1),
	operator: usernameSchema,
	approved: z.boolean(),
});
export type DataOperatorApproveInput = z.infer<typeof dataOperatorApproveInputSchema>;

export const setDataFromInputSchema = seedProvenanceSchema.extend({
	nftId: z.string().min(1),
	instanceDna: z.string().min(1),
	data: z.record(z.string(), z.unknown()).optional().refine(
		(obj) => !obj || Object.keys(obj).length <= 64,
		"Data object cannot exceed 64 fields",
	),
	mutableData: z.record(z.string(), z.unknown()).optional().refine(
		(obj) => !obj || Object.keys(obj).length <= 64,
		"Data object cannot exceed 64 fields",
	),
});
export type SetDataFromInput = z.infer<typeof setDataFromInputSchema>;

export const nftLendInputSchema = seedProvenanceSchema.extend({
	instanceId: z.string().min(1),
	borrower: usernameSchema,
});
export type NftLendInput = z.infer<typeof nftLendInputSchema>;

export const nftReturnInputSchema = seedProvenanceSchema.extend({
	instanceId: z.string().min(1),
});
export type NftReturnInput = z.infer<typeof nftReturnInputSchema>;

export const nodeRegisterInputSchema = z.object({
	endpoint: httpUrlSchema,
	publicKey: z.string().min(10, "Public key must be at least 10 characters"),
});
export type NodeRegisterInput = z.infer<typeof nodeRegisterInputSchema>;

// Format must match `formatStateRoot()` in the indexer: lowercase hex, 64 chars.
const stateRootSchema = z.string().regex(
	/^sha256:[0-9a-f]{64}$/,
	"stateRoot must be formatted as 'sha256:<64 lowercase hex chars>'",
);

export const nodeHeartbeatInputSchema = z.object({
	blockNum: z.number().int().nonnegative("blockNum must be a non-negative integer"),
	stateRoot: stateRootSchema,
	indexerVersion: z.string().trim().min(1, "indexerVersion is required").max(32, "indexerVersion must be at most 32 characters"),
});
export type NodeHeartbeatInput = z.infer<typeof nodeHeartbeatInputSchema>;
