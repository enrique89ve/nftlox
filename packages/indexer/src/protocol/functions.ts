// NFTLox Protocol Functions (self-contained copy for indexer)
// Pure functions — no SDK-specific imports. Uses Web Crypto API (works in Bun natively).

import {
  MAX_ROYALTY_PCT,
  PROTOCOL_FEE_BPS,
  BASIS_POINTS_DENOMINATOR,
  ORIGIN_DNA_LENGTH,
  INSTANCE_DNA_LENGTH,
  ACCESS_KEY_LENGTH,
  INSTANCE_ID_HASH_LENGTH,
  LISTING_ID_PREFIX,
  LISTING_HASH_LENGTH,
  LISTING_NONCE_LENGTH,
  MAX_SCHEMA_FIELDS,
  MAX_FIELD_NAME_LENGTH,
} from "./constants.ts";
import type {
  PaymentSplit,
  CollectionSchema,
  SchemaField,
  SchemaFieldType,
  ValidationError,
} from "./types.ts";
import { canonicalJson } from "@/utils/canonical-json.ts";

// ============ HIVE USERNAME VALIDATION ============

export function validateHiveUsername(username: string): string | null {
  if (!username) return "Account name should not be empty.";
  if (username.length < 3) return "Account name should be longer.";
  if (username.length > 16) return "Account name should be shorter.";

  const suffix = /\./.test(username)
    ? "Each account segment should "
    : "Account name should ";

  for (const segment of username.split(".")) {
    if (!/^[a-z]/.test(segment))
      return suffix + "start with a lowercase letter.";
    if (!/^[a-z0-9-]*$/.test(segment))
      return suffix + "have only lowercase letters, digits, or dashes.";
    if (!/[a-z0-9]$/.test(segment))
      return suffix + "end with a lowercase letter or digit.";
    if (segment.length < 3) return suffix + "be longer.";
  }
  return null;
}

// ============ PAYMENT SPLIT ============

/** Round to 3 decimal places (Hive precision) */
export function roundHive(n: number): number {
  return Math.round(n * 1000) / 1000;
}

export function percentageToBasisPoints(percentage: number): number {
  return Math.round(percentage * 100);
}

export function calculateBasisPointsAmount(
  totalAmount: number,
  basisPoints: number,
): number {
  return roundHive((totalAmount * basisPoints) / BASIS_POINTS_DENOMINATOR);
}

/**
 * Calculate the payment split for an NFT sale.
 *
 * Protocol fee (100 bps = 1.0%) always goes to the co-signing node.
 * Marketplace fees are handled off-chain by the marketplace frontend.
 *
 * If royaltyRecipient === seller -> royalty merges into seller amount.
 * If feeAccount === seller -> fee merges into seller amount.
 */
export function calculatePaymentSplit(
  totalPrice: number,
  currency: string,
  royaltyPct: number,
  royaltyRecipient: string | null,
  seller: string,
  feeAccount: string,
): PaymentSplit {
  if (royaltyPct < 0 || royaltyPct > MAX_ROYALTY_PCT) {
    throw new Error(
      `royaltyPct out of range: ${royaltyPct} (max ${MAX_ROYALTY_PCT})`,
    );
  }

  const feeAmount = calculateBasisPointsAmount(totalPrice, PROTOCOL_FEE_BPS);

  let royaltyAmount = 0;
  let effectiveRoyaltyRecipient: string | null = null;
  if (royaltyRecipient && royaltyPct > 0) {
    if (royaltyRecipient === seller) {
      royaltyAmount = 0;
      effectiveRoyaltyRecipient = null;
    } else {
      royaltyAmount = calculateBasisPointsAmount(
        totalPrice,
        percentageToBasisPoints(royaltyPct),
      );
      effectiveRoyaltyRecipient = royaltyRecipient;
    }
  }

  let effectiveFee = feeAmount;
  if (feeAccount === seller) {
    effectiveFee = 0;
  }

  const sellerAmount = roundHive(
    Math.max(0, totalPrice - royaltyAmount - effectiveFee),
  );

  return {
    sellerAmount,
    royaltyAmount,
    royaltyRecipient: effectiveRoyaltyRecipient,
    feeAmount: effectiveFee,
    feeAccount,
    totalPrice,
    currency,
  };
}

// ============ HASH FUNCTIONS ============

/**
 * SHA-256 hash using Web Crypto (crypto.subtle). Async.
 * Used for all identity generation (DNA, IDs, access keys, listing IDs).
 */
export async function generateHash(input: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(input);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ============ CANONICAL JSON & HASHING ============

export async function computeDataHash(
  data: Record<string, unknown>,
): Promise<string> {
  const json = canonicalJson(data);
  const encoded = new TextEncoder().encode(json);
  const buffer = await crypto.subtle.digest("SHA-256", encoded);
  const hex = Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `sha256:${hex}`;
}

// ============ SCHEMA VALIDATION ============

const SCALAR_TYPES = new Set<string>([
  "string",
  "bool",
  "uint8",
  "uint16",
  "uint32",
  "uint64",
  "int8",
  "int16",
  "int32",
  "int64",
  "float",
  "double",
]);

const ARRAY_TYPES = new Set<string>([
  "string[]",
  "bool[]",
  "uint8[]",
  "uint16[]",
  "uint32[]",
  "uint64[]",
  "int8[]",
  "int16[]",
  "int32[]",
  "int64[]",
  "float[]",
  "double[]",
]);

export const VALID_SCHEMA_TYPES: ReadonlySet<string> = new Set([
  ...SCALAR_TYPES,
  ...ARRAY_TYPES,
]);

const INT_RANGES: Record<string, { min: number; max: number }> = {
  uint8: { min: 0, max: 255 },
  uint16: { min: 0, max: 65535 },
  uint32: { min: 0, max: 4294967295 },
  uint64: { min: 0, max: Number.MAX_SAFE_INTEGER },
  int8: { min: -128, max: 127 },
  int16: { min: -32768, max: 32767 },
  int32: { min: -2147483648, max: 2147483647 },
  int64: { min: Number.MIN_SAFE_INTEGER, max: Number.MAX_SAFE_INTEGER },
};

const FIELD_NAME_REGEX = /^[a-z][a-z0-9_]*$/;

export function validateValueAgainstType(
  value: unknown,
  type: SchemaFieldType,
): boolean {
  if (type.endsWith("[]")) {
    if (!Array.isArray(value)) return false;
    const baseType = type.slice(0, -2) as SchemaFieldType;
    return value.every((item) => validateValueAgainstType(item, baseType));
  }

  switch (type) {
    case "string":
      return typeof value === "string";

    case "bool":
      return typeof value === "boolean";

    case "float":
    case "double":
      return typeof value === "number" && Number.isFinite(value);

    case "uint8":
    case "uint16":
    case "uint32":
    case "uint64":
    case "int8":
    case "int16":
    case "int32":
    case "int64": {
      if (typeof value !== "number") return false;
      if (!Number.isInteger(value)) return false;
      const range = INT_RANGES[type];
      if (!range) return false;
      return value >= range.min && value <= range.max;
    }

    default:
      return false;
  }
}

export function validateSchemaDefinition(
  schema: CollectionSchema,
): ValidationError[] {
  const errors: ValidationError[] = [];
  const allNames = new Set<string>();
  const totalFields = schema.immutable.length + schema.mutable.length;

  if (totalFields === 0) {
    errors.push({
      field: "schema",
      message: "Schema must have at least one field",
      code: "SCHEMA_EMPTY",
    });
    return errors;
  }

  if (totalFields > MAX_SCHEMA_FIELDS) {
    errors.push({
      field: "schema",
      message: `Schema exceeds maximum of ${MAX_SCHEMA_FIELDS} fields (got ${totalFields})`,
      code: "SCHEMA_TOO_LARGE",
    });
  }

  const validateFields = (fields: readonly SchemaField[], section: string) => {
    for (const field of fields) {
      const prefix = `schema.${section}.${field.name}`;

      if (!field.name || typeof field.name !== "string") {
        errors.push({
          field: prefix,
          message: "Field name is required",
          code: "FIELD_NAME_MISSING",
        });
        continue;
      }

      if (field.name.length > MAX_FIELD_NAME_LENGTH) {
        errors.push({
          field: prefix,
          message: `Field name exceeds ${MAX_FIELD_NAME_LENGTH} characters`,
          code: "FIELD_NAME_TOO_LONG",
        });
      }

      if (!FIELD_NAME_REGEX.test(field.name)) {
        errors.push({
          field: prefix,
          message:
            "Field name must start with lowercase letter and contain only lowercase letters, numbers, and underscores",
          code: "FIELD_NAME_INVALID",
        });
      }

      if (!VALID_SCHEMA_TYPES.has(field.type)) {
        errors.push({
          field: prefix,
          message: `Invalid type "${field.type}". Valid types: ${[...VALID_SCHEMA_TYPES].join(", ")}`,
          code: "FIELD_TYPE_INVALID",
        });
      }

      if (allNames.has(field.name)) {
        errors.push({
          field: prefix,
          message: `Duplicate field name "${field.name}" across immutable and mutable sections`,
          code: "FIELD_NAME_DUPLICATE",
        });
      }
      allNames.add(field.name);
    }
  };

  validateFields(schema.immutable, "immutable");
  validateFields(schema.mutable, "mutable");

  return errors;
}

// ============ DATA VALIDATION AGAINST SCHEMA FIELDS ============

function validateDataAgainstFields(
  data: Record<string, unknown>,
  fields: readonly SchemaField[],
  fieldLabel: string,
  mode: "strict" | "partial",
): ValidationError[] {
  const errors: ValidationError[] = [];
  const fieldMap = new Map(fields.map((f) => [f.name, f]));

  for (const key of Object.keys(data)) {
    if (!fieldMap.has(key)) {
      errors.push({
        field: `${fieldLabel}.${key}`,
        message: `Unknown field "${key}" not defined in schema`,
        code: "FIELD_UNKNOWN",
      });
    }
  }

  for (const [key, value] of Object.entries(data)) {
    const fieldDef = fieldMap.get(key);
    if (!fieldDef) continue;

    if (value === null || value === undefined) {
      if (mode === "strict") {
        errors.push({
          field: `${fieldLabel}.${key}`,
          message: `Field "${key}" cannot be null in strict mode (expected type "${fieldDef.type}")`,
          code: "FIELD_NULL_STRICT",
        });
      }
      continue;
    }

    if (!validateValueAgainstType(value, fieldDef.type)) {
      errors.push({
        field: `${fieldLabel}.${key}`,
        message: `Expected type "${fieldDef.type}" for field "${key}", got ${typeof value}`,
        code: "FIELD_TYPE_MISMATCH",
      });
    }
  }

  if (mode === "strict") {
    for (const field of fields) {
      if (!(field.name in data)) {
        errors.push({
          field: `${fieldLabel}.${field.name}`,
          message: `Required field "${field.name}" is missing`,
          code: "FIELD_MISSING",
        });
      }
    }
  }

  return errors;
}

// ============ MINT VALIDATION ============

export function validateMintData(
  schema: CollectionSchema,
  immutableData?: Record<string, unknown>,
  mutableData?: Record<string, unknown>,
): ValidationError[] {
  const errors: ValidationError[] = [];

  if (schema.immutable.length > 0) {
    if (!immutableData || Object.keys(immutableData).length === 0) {
      errors.push({
        field: "immutableData",
        message:
          "immutableData is required when schema defines immutable fields",
        code: "IMMUTABLE_DATA_REQUIRED",
      });
    } else {
      errors.push(
        ...validateDataAgainstFields(
          immutableData,
          schema.immutable,
          "immutableData",
          "strict",
        ),
      );
    }
  }

  if (mutableData && Object.keys(mutableData).length > 0) {
    errors.push(
      ...validateDataAgainstFields(
        mutableData,
        schema.mutable,
        "mutableData",
        "partial",
      ),
    );
  }

  return errors;
}

// ============ MUTABLE UPDATE VALIDATION ============

export function validateMutableUpdate(
  schema: CollectionSchema,
  mutableData: Record<string, unknown>,
): ValidationError[] {
  const errors: ValidationError[] = [];

  const immutableNames = new Set(schema.immutable.map((f) => f.name));
  for (const key of Object.keys(mutableData)) {
    if (immutableNames.has(key)) {
      errors.push({
        field: `mutableData.${key}`,
        message: `Field "${key}" is immutable and cannot be modified`,
        code: "FIELD_IMMUTABLE",
      });
    }
  }

  errors.push(
    ...validateDataAgainstFields(
      mutableData,
      schema.mutable,
      "mutableData",
      "partial",
    ),
  );

  return errors;
}

export function validateMutableSnapshot(
  schema: CollectionSchema,
  mutableData: Record<string, unknown>,
): ValidationError[] {
  const errors: ValidationError[] = [];

  const immutableNames = new Set(schema.immutable.map((f) => f.name));
  for (const key of Object.keys(mutableData)) {
    if (immutableNames.has(key)) {
      errors.push({
        field: `mutableData.${key}`,
        message: `Field "${key}" is immutable and cannot be modified`,
        code: "FIELD_IMMUTABLE",
      });
    }
  }

  errors.push(
    ...validateDataAgainstFields(
      mutableData,
      schema.mutable,
      "mutableData",
      "strict",
    ),
  );

  return errors;
}

// ============ SCHEMA EXTENSION (APPEND-ONLY) ============

export function mergeSchemas(
  existing: CollectionSchema,
  extension: {
    newImmutableFields?: readonly SchemaField[];
    newMutableFields?: readonly SchemaField[];
  },
): { merged: CollectionSchema; errors: ValidationError[] } {
  const errors: ValidationError[] = [];
  const existingNames = new Set([
    ...existing.immutable.map((f) => f.name),
    ...existing.mutable.map((f) => f.name),
  ]);

  const newImmutable = extension.newImmutableFields ?? [];
  const newMutable = extension.newMutableFields ?? [];

  if (newImmutable.length === 0 && newMutable.length === 0) {
    errors.push({
      field: "extension",
      message: "At least one new field is required",
      code: "EXTENSION_EMPTY",
    });
    return { merged: existing, errors };
  }

  for (const field of [...newImmutable, ...newMutable]) {
    if (existingNames.has(field.name)) {
      errors.push({
        field: `extension.${field.name}`,
        message: `Field "${field.name}" already exists in the schema`,
        code: "FIELD_ALREADY_EXISTS",
      });
    }
  }

  const merged: CollectionSchema = {
    immutable: [...existing.immutable, ...newImmutable],
    mutable: [...existing.mutable, ...newMutable],
  };

  const totalFields = merged.immutable.length + merged.mutable.length;
  if (totalFields > MAX_SCHEMA_FIELDS) {
    errors.push({
      field: "schema",
      message: `Extended schema exceeds maximum of ${MAX_SCHEMA_FIELDS} fields (got ${totalFields})`,
      code: "SCHEMA_TOO_LARGE",
    });
  }

  for (const field of [...newImmutable, ...newMutable]) {
    if (!field.name || !FIELD_NAME_REGEX.test(field.name)) {
      errors.push({
        field: `extension.${field.name}`,
        message: "Invalid field name format",
        code: "FIELD_NAME_INVALID",
      });
    }
    if (!VALID_SCHEMA_TYPES.has(field.type)) {
      errors.push({
        field: `extension.${field.name}`,
        message: `Invalid type "${field.type}"`,
        code: "FIELD_TYPE_INVALID",
      });
    }
  }

  return { merged, errors };
}

// ============ DNA GENERATION ============

export async function generateOriginDna(collectionId: string): Promise<string> {
  const input = `nftlox:origin:${collectionId}`;
  const fullHash = await generateHash(input);
  return "o" + fullHash.slice(0, ORIGIN_DNA_LENGTH - 1).toUpperCase();
}

export async function generateInstanceDna(
  nftId: string,
  originDna: string,
  edition: number,
  imageHash: string,
): Promise<string> {
  const input = `nftlox:instance:${nftId}:${originDna}:${edition}:${imageHash}`;
  const fullHash = await generateHash(input);
  return "i" + fullHash.slice(0, INSTANCE_DNA_LENGTH - 1).toUpperCase();
}

export async function generateDeterministicCollectionId(
  creator: string,
  name: string,
  symbol: string,
): Promise<string> {
  const input = `nftlox:col:${creator.toLowerCase()}:${name}:${symbol.toUpperCase()}`;
  const hash = await generateHash(input);
  return `col_${hash.slice(0, 14)}`;
}

export async function generateDeterministicSeedId(
  collectionId: string,
  artId: string,
): Promise<string> {
  const input = `nftlox:seed:${collectionId}:${artId.toLowerCase()}`;
  const hash = await generateHash(input);
  return `seed_${hash.slice(0, 20)}`;
}

export async function generateDeterministicInstanceId(
  seedId: string,
  instanceNumber: number,
): Promise<string> {
  const input = `nftlox:inst:${seedId}:${instanceNumber}`;
  const hash = await generateHash(input);
  const seedSuffix = seedId.replace("seed_", "");
  return `nft_${seedSuffix}_${instanceNumber}_${hash.slice(0, INSTANCE_ID_HASH_LENGTH)}`;
}

export async function generateDeterministicInstanceDna(
  seedId: string,
  instanceNumber: number,
  txId: string,
  blockNum: number,
): Promise<string> {
  const input = `nftlox:dna:${seedId}:${instanceNumber}:${txId}:${blockNum}`;
  const fullHash = await generateHash(input);
  return "i" + fullHash.slice(0, INSTANCE_DNA_LENGTH - 1).toUpperCase();
}

export async function generateDeterministicAccessKey(
  instanceDna: string,
  owner: string,
  txId: string,
): Promise<string> {
  const input = `nftlox:key:${instanceDna}:${owner}:${txId}`;
  const fullHash = await generateHash(input);
  return fullHash.slice(0, ACCESS_KEY_LENGTH).toUpperCase();
}

export async function generateListingId(params: {
  nftId: string;
  owner: string;
  marketplace: string;
  priceAmount: string;
  priceCurrency: string;
  expiresAt: number;
  nonce: string;
}): Promise<string> {
  const input = `nftlox:listing:v1:${params.nftId}:${params.owner}:${params.marketplace}:${params.priceAmount}:${params.priceCurrency}:${params.expiresAt}:${params.nonce}`;
  const hash = await generateHash(input);
  return LISTING_ID_PREFIX + hash.slice(0, LISTING_HASH_LENGTH);
}

export function generateListingNonce(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, LISTING_NONCE_LENGTH);
}
