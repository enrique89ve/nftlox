// NFTLox Schema Validation Module
// Pure functions for validating data against CollectionSchema definitions.
// Shared by SDK builders (client-side) and indexer handlers (server-side).

import type { CollectionSchema, SchemaField, SchemaFieldType, ValidationError } from "./types";

// ============ SUPPORTED TYPES ============

const SCALAR_TYPES = new Set<string>([
	"string", "bool",
	"uint8", "uint16", "uint32", "uint64",
	"int8", "int16", "int32", "int64",
	"float", "double",
]);

const ARRAY_TYPES = new Set<string>([
	"string[]", "bool[]",
	"uint8[]", "uint16[]", "uint32[]", "uint64[]",
	"int8[]", "int16[]", "int32[]", "int64[]",
	"float[]", "double[]",
]);

export const VALID_SCHEMA_TYPES: ReadonlySet<string> = new Set([...SCALAR_TYPES, ...ARRAY_TYPES]);

// ============ RANGE CONSTANTS ============

const INT_RANGES: Record<string, { min: number; max: number }> = {
	uint8:  { min: 0, max: 255 },
	uint16: { min: 0, max: 65535 },
	uint32: { min: 0, max: 4294967295 },
	uint64: { min: 0, max: Number.MAX_SAFE_INTEGER },
	int8:   { min: -128, max: 127 },
	int16:  { min: -32768, max: 32767 },
	int32:  { min: -2147483648, max: 2147483647 },
	int64:  { min: Number.MIN_SAFE_INTEGER, max: Number.MAX_SAFE_INTEGER },
};

// ============ FIELD NAME VALIDATION ============

const FIELD_NAME_REGEX = /^[a-z][a-z0-9_]*$/;
const MAX_FIELD_NAME_LENGTH = 64;
const MAX_SCHEMA_FIELDS = 64;

// ============ CANONICAL JSON & HASHING ============

function sortKeysDeep(value: unknown): unknown {
	if (value === null || value === undefined) return value;
	if (Array.isArray(value)) return value.map(sortKeysDeep);
	if (typeof value === "object") {
		const sorted: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
		for (const key of Object.keys(value as Record<string, unknown>).sort()) {
			if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
			sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
		}
		return sorted;
	}
	return value;
}

export function canonicalJson(data: Record<string, unknown>): string {
	return JSON.stringify(sortKeysDeep(data));
}

export async function computeDataHash(data: Record<string, unknown>): Promise<string> {
	const json = canonicalJson(data);
	const encoded = new TextEncoder().encode(json);
	const buffer = await crypto.subtle.digest("SHA-256", encoded);
	const hex = Array.from(new Uint8Array(buffer))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
	return `sha256:${hex}`;
}

export function computeDataHashSync(data: Record<string, unknown>): string {
	const json = canonicalJson(data);
	const hash = Bun.CryptoHasher.hash("sha256", json, "hex");
	return `sha256:${hash}`;
}

// ============ SINGLE VALUE VALIDATION ============

export function validateValueAgainstType(value: unknown, type: SchemaFieldType): boolean {
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

// ============ SCHEMA DEFINITION VALIDATION ============

export function validateSchemaDefinition(schema: CollectionSchema): ValidationError[] {
	const errors: ValidationError[] = [];
	const allNames = new Set<string>();
	const totalFields = schema.immutable.length + schema.mutable.length;

	if (totalFields === 0) {
		errors.push({ field: "schema", message: "Schema must have at least one field", code: "SCHEMA_EMPTY" });
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
				errors.push({ field: prefix, message: "Field name is required", code: "FIELD_NAME_MISSING" });
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
					message: "Field name must start with lowercase letter and contain only lowercase letters, numbers, and underscores",
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

	// Check for unknown fields
	for (const key of Object.keys(data)) {
		if (!fieldMap.has(key)) {
			errors.push({
				field: `${fieldLabel}.${key}`,
				message: `Unknown field "${key}" not defined in schema`,
				code: "FIELD_UNKNOWN",
			});
		}
	}

	// Check types for provided fields
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

	// In strict mode, all fields must be present
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

	// Immutable data is required at mint if schema has immutable fields
	if (schema.immutable.length > 0) {
		if (!immutableData || Object.keys(immutableData).length === 0) {
			errors.push({
				field: "immutableData",
				message: "immutableData is required when schema defines immutable fields",
				code: "IMMUTABLE_DATA_REQUIRED",
			});
		} else {
			errors.push(...validateDataAgainstFields(immutableData, schema.immutable, "immutableData", "strict"));
		}
	}

	// Mutable data is optional at mint (defaults can be set later)
	if (mutableData && Object.keys(mutableData).length > 0) {
		errors.push(...validateDataAgainstFields(mutableData, schema.mutable, "mutableData", "partial"));
	}

	return errors;
}

// ============ MUTABLE UPDATE VALIDATION ============

export function validateMutableUpdate(
	schema: CollectionSchema,
	mutableData: Record<string, unknown>,
): ValidationError[] {
	const errors: ValidationError[] = [];

	// Reject any attempt to write immutable fields
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

	// Validate against mutable fields only (partial mode: not all fields required)
	errors.push(...validateDataAgainstFields(mutableData, schema.mutable, "mutableData", "partial"));

	return errors;
}

// ============ SCHEMA EXTENSION (APPEND-ONLY) ============

export function mergeSchemas(
	existing: CollectionSchema,
	extension: { newImmutableFields?: readonly SchemaField[]; newMutableFields?: readonly SchemaField[] },
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

	// Check for collisions with existing fields
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

	// Validate the merged schema as a whole
	const totalFields = merged.immutable.length + merged.mutable.length;
	if (totalFields > MAX_SCHEMA_FIELDS) {
		errors.push({
			field: "schema",
			message: `Extended schema exceeds maximum of ${MAX_SCHEMA_FIELDS} fields (got ${totalFields})`,
			code: "SCHEMA_TOO_LARGE",
		});
	}

	// Validate new field definitions
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
