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
	MAX_DROP_TABLE_ENTRIES,
	MAX_ITEMS_PER_PACK,
	MAX_PACK_OPEN_BATCH,
	MIN_DROP_WEIGHT,
	MAX_DROP_WEIGHT,
	MAX_BULK_DISTRIBUTE_ITEMS,
} from "./constants";

const SYMBOL_REGEX = /^[A-Z0-9]+$/;
const TX_ID_REGEX = /^[0-9a-f]{40}$/;
// Hive asset precision: exactly 3 decimal places, no leading zeros (except "0.xxx")
const HIVE_DECIMAL_REGEX = /^(0|[1-9]\d*)\.\d{3}$/;

// Safe URL: only http:// and https:// protocols (blocks javascript:, data:, etc.)
const httpUrlSchema = z.string().url().refine(
	(val) => /^https?:\/\//i.test(val),
	{ message: "URL must use http or https protocol" },
);

// ============ HIVE USERNAME VALIDATION ============
// Mirrors hive-tx validateUsername() rules exactly:
// - 3-16 chars total
// - Dot-separated segments, each >= 3 chars
// - Each segment starts with lowercase letter
// - Each segment contains only lowercase letters, digits, hyphens
// - Each segment ends with lowercase letter or digit

export function validateHiveUsername(username: string): string | null {
	if (!username) return "Account name should not be empty.";
	if (username.length < 3) return "Account name should be longer.";
	if (username.length > 16) return "Account name should be shorter.";

	const suffix = /\./.test(username)
		? "Each account segment should "
		: "Account name should ";

	for (const segment of username.split(".")) {
		if (!/^[a-z]/.test(segment)) return suffix + "start with a lowercase letter.";
		if (!/^[a-z0-9-]*$/.test(segment)) return suffix + "have only lowercase letters, digits, or dashes.";
		if (!/[a-z0-9]$/.test(segment)) return suffix + "end with a lowercase letter or digit.";
		if (segment.length < 3) return suffix + "be longer.";
	}
	return null;
}

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
	.regex(SYMBOL_REGEX, "Symbol must contain only uppercase letters and numbers (A-Z, 0-9)");

export const priceSchema = z.object({
	amount: z.string()
		.regex(HIVE_DECIMAL_REGEX, "Price must be in Hive decimal format (e.g. \"1.000\")")
		.refine(
			(val) => parseFloat(val) >= parseFloat(MIN_PRICE_AMOUNT),
			{ message: `Price amount must be at least ${MIN_PRICE_AMOUNT}` },
		),
	currency: z.enum(SUPPORTED_CURRENCIES),
});

export const seedProvenanceSchema = z.object({
	seedId: z.string().optional(),
	birthTx: z.string().optional(),
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

export const setOwnerDataInputSchema = z.object({
	nftId: z.string().min(1),
	instanceDna: z.string().min(1),
	data: z.record(z.string(), z.unknown()),
});
export type SetOwnerDataInput = z.infer<typeof setOwnerDataInputSchema>;

// ============ INPUT SCHEMAS ============

export const createCollectionInputSchema = z.object({
	jsonId: z.string().min(1, "jsonId is required for indexing"),
	name: z.string().min(1, "Name is required").max(MAX_NAME_LENGTH, `Name must be at most ${MAX_NAME_LENGTH} characters`),
	symbol: symbolSchema,
	creator: usernameSchema,
	totalPotential: z.number().nonnegative("Total potential must be non-negative"),
	metadata: z.object({
		description: z.string().min(1, "Description is required").max(MAX_DESCRIPTION_LENGTH, `Description must be at most ${MAX_DESCRIPTION_LENGTH} characters`),
		image: httpUrlSchema.max(MAX_IMAGE_URL_LENGTH, `Image URL must be at most ${MAX_IMAGE_URL_LENGTH} characters`),
		externalUrl: httpUrlSchema.optional(),
	}),
	rules: z.object({
		transferable: z.boolean(),
		burnable: z.boolean(),
		replicable: z.boolean(),
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
	name: z.string().min(1, "Name is required").max(MAX_NAME_LENGTH),
	description: z.string().max(MAX_DESCRIPTION_LENGTH).optional(),
	imageUrl: httpUrlSchema.max(MAX_IMAGE_URL_LENGTH),
	imageHash: z.string().optional(),
	maxReplicas: z.number().int().min(1, "Max replicas must be at least 1").optional(),
	birthBlock: z.number().optional(),
	birthTx: z.string().optional(),
	data: z.record(z.string(), z.unknown()).optional(),
	immutableData: z.record(z.string(), z.unknown()).optional(),
	mutableData: z.record(z.string(), z.unknown()).optional(),
	collectionBlock: z.number().int().nonnegative("collectionBlock must be a non-negative integer"),
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

export const importedNftSchema = z.object({
	nftId: z.string().min(1, "NFT ID is required"),
	name: z.string().min(1, "Name is required"),
	brief: z.string().max(MAX_DESCRIPTION_LENGTH).optional(),
	imageUrl: httpUrlSchema,
	imageHash: z.string().optional(),
	maxReplicas: z.number().int().min(1).default(1),
});
export type ImportedNFT = z.infer<typeof importedNftSchema>;

export const packDropEntrySchema = z.object({
	seedId: z.string().min(1, "seedId is required"),
	weight: z.number().min(MIN_DROP_WEIGHT).max(MAX_DROP_WEIGHT),
});
export type PackDropEntry = z.infer<typeof packDropEntrySchema>;

export const packCreateInputSchema = z.object({
	collectionId: z.string().min(1, "Collection ID is required"),
	name: z.string().min(1, "Pack name is required").max(MAX_NAME_LENGTH),
	description: z.string().max(MAX_DESCRIPTION_LENGTH).optional(),
	imageUrl: httpUrlSchema.max(MAX_IMAGE_URL_LENGTH).optional(),
	dropTable: z.array(packDropEntrySchema).min(1).max(MAX_DROP_TABLE_ENTRIES),
	itemsPerPack: z.number().int().min(1).max(MAX_ITEMS_PER_PACK),
	price: priceSchema.optional(),
	maxSupply: z.number().int().nonnegative(),
});
export type PackCreateInput = z.infer<typeof packCreateInputSchema>;

export const packBuyInputSchema = z.object({
	packId: z.string().min(1, "Pack ID is required"),
	quantity: z.number().int().min(1, "Quantity must be a positive integer").max(MAX_PACK_OPEN_BATCH, `Cannot buy more than ${MAX_PACK_OPEN_BATCH} packs at once`),
});
export type PackBuyInput = z.infer<typeof packBuyInputSchema>;

export const packTransferInputSchema = z.object({
	packId: z.string().min(1, "Pack ID is required"),
	to: usernameSchema,
	quantity: z.number().int().min(1, "Quantity must be a positive integer"),
});
export type PackTransferInput = z.infer<typeof packTransferInputSchema>;

export const packOpenInputSchema = z.object({
	packId: z.string().min(1, "Pack ID is required"),
	quantity: z.number().int().min(1).max(MAX_PACK_OPEN_BATCH, `Cannot open more than ${MAX_PACK_OPEN_BATCH} packs at once`),
});
export type PackOpenInput = z.infer<typeof packOpenInputSchema>;

export const bulkDistributeItemSchema = z.object({
	seedId: z.string().min(1, "seedId is required"),
	quantity: z.number().int().min(1, "Quantity must be positive"),
	originBlock: z.number().int().nonnegative("originBlock must be a non-negative integer"),
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
	imageOverrides: z.record(z.string(), z.object({ imageUrl: z.string().optional(), imageHash: z.string().optional() })).optional(),
	data: z.record(z.string(), z.unknown()).optional(),
	mutableData: z.record(z.string(), z.unknown()).optional(),
});
export type BulkDistributeInput = z.infer<typeof bulkDistributeInputSchema>;

// And other simple types:

export const replicateInputSchema = seedProvenanceSchema.extend({
	originalId: z.string().min(1),
	originDna: z.string().min(1),
	originalInstanceDna: z.string().min(1),
	newOwner: usernameSchema,
	currentOwner: usernameSchema,
});
export type ReplicateInput = z.infer<typeof replicateInputSchema>;

export const burnInputSchema = seedProvenanceSchema.extend({
	nftId: z.string().min(1),
	imageUrl: httpUrlSchema.optional(),
	imageHash: z.string().optional(),
});
export type BurnInput = z.infer<typeof burnInputSchema>;

export const unlistInputSchema = z.object({
	nftId: z.string().min(1),
	imageUrl: httpUrlSchema.optional(),
	imageHash: z.string().optional(),
});
export type UnlistInput = z.infer<typeof unlistInputSchema>;

export const packApproveInputSchema = z.object({
	spender: usernameSchema,
	packId: z.string().min(1),
	quantity: z.number().int().min(1),
	approved: z.boolean(),
});
export type PackApproveInput = z.infer<typeof packApproveInputSchema>;

export const packTransferFromInputSchema = z.object({
	from: usernameSchema,
	to: usernameSchema,
	packId: z.string().min(1),
	quantity: z.number().int().min(1),
});
export type PackTransferFromInput = z.infer<typeof packTransferFromInputSchema>;

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
	data: z.record(z.string(), z.unknown()).optional(),
	mutableData: z.record(z.string(), z.unknown()).optional(),
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
	data: z.record(z.string(), z.unknown()).optional(),
	mutableData: z.record(z.string(), z.unknown()).optional(),
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

export const atomicTransferInputSchema = seedProvenanceSchema.extend({
	nftId: z.string().min(1),
	collectionId: z.string().min(1),
	edition: z.number().int().min(1),
	instanceDna: z.string().min(1),
	from: usernameSchema,
	to: usernameSchema,
	memo: z.string().optional(),
	imageUrl: httpUrlSchema.optional(),
	imageHash: z.string().optional(),
});
export type AtomicTransferInput = z.infer<typeof atomicTransferInputSchema>;
