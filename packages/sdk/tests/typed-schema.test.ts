import { test, expect, describe } from "bun:test";
import {
	validateSchemaDefinition,
	validateValueAgainstType,
	validateMintData,
	validateMutableUpdate,
	validateMutableSnapshot,
	mergeSchemas,
	canonicalJson,
	computeDataHash,
	VALID_SCHEMA_TYPES,
} from "../src/schema-validation";
import {
	createSchemaBuilder,
	GAMING_SCHEMA,
	RAGNAROK_MINION_SCHEMA,
} from "../src/schema-templates";
import {
	collectionSchemaSchema,
	schemaFieldSchema,
	extendSchemaInputSchema,
} from "../src/schemas";
import type { CollectionSchema } from "../src/types";

// ============ validateValueAgainstType ============

describe("validateValueAgainstType", () => {
	describe("string", () => {
		test("accepts string", () => expect(validateValueAgainstType("hello", "string")).toBe(true));
		test("accepts empty string", () => expect(validateValueAgainstType("", "string")).toBe(true));
		test("rejects number", () => expect(validateValueAgainstType(42, "string")).toBe(false));
		test("rejects boolean", () => expect(validateValueAgainstType(true, "string")).toBe(false));
	});

	describe("bool", () => {
		test("accepts true", () => expect(validateValueAgainstType(true, "bool")).toBe(true));
		test("accepts false", () => expect(validateValueAgainstType(false, "bool")).toBe(true));
		test("rejects 0", () => expect(validateValueAgainstType(0, "bool")).toBe(false));
		test("rejects 1", () => expect(validateValueAgainstType(1, "bool")).toBe(false));
		test("rejects string true", () => expect(validateValueAgainstType("true", "bool")).toBe(false));
	});

	describe("uint8", () => {
		test("accepts 0", () => expect(validateValueAgainstType(0, "uint8")).toBe(true));
		test("accepts 255", () => expect(validateValueAgainstType(255, "uint8")).toBe(true));
		test("rejects 256", () => expect(validateValueAgainstType(256, "uint8")).toBe(false));
		test("rejects -1", () => expect(validateValueAgainstType(-1, "uint8")).toBe(false));
		test("rejects float", () => expect(validateValueAgainstType(1.5, "uint8")).toBe(false));
		test("rejects string", () => expect(validateValueAgainstType("5", "uint8")).toBe(false));
	});

	describe("uint16", () => {
		test("accepts 0", () => expect(validateValueAgainstType(0, "uint16")).toBe(true));
		test("accepts 65535", () => expect(validateValueAgainstType(65535, "uint16")).toBe(true));
		test("rejects 65536", () => expect(validateValueAgainstType(65536, "uint16")).toBe(false));
	});

	describe("uint32", () => {
		test("accepts 0", () => expect(validateValueAgainstType(0, "uint32")).toBe(true));
		test("accepts 4294967295", () => expect(validateValueAgainstType(4294967295, "uint32")).toBe(true));
		test("rejects 4294967296", () => expect(validateValueAgainstType(4294967296, "uint32")).toBe(false));
	});

	describe("uint64", () => {
		test("accepts 0", () => expect(validateValueAgainstType(0, "uint64")).toBe(true));
		test("accepts MAX_SAFE_INTEGER", () => expect(validateValueAgainstType(Number.MAX_SAFE_INTEGER, "uint64")).toBe(true));
		test("rejects negative", () => expect(validateValueAgainstType(-1, "uint64")).toBe(false));
	});

	describe("int8", () => {
		test("accepts -128", () => expect(validateValueAgainstType(-128, "int8")).toBe(true));
		test("accepts 127", () => expect(validateValueAgainstType(127, "int8")).toBe(true));
		test("rejects 128", () => expect(validateValueAgainstType(128, "int8")).toBe(false));
		test("rejects -129", () => expect(validateValueAgainstType(-129, "int8")).toBe(false));
	});

	describe("int16", () => {
		test("accepts -32768", () => expect(validateValueAgainstType(-32768, "int16")).toBe(true));
		test("accepts 32767", () => expect(validateValueAgainstType(32767, "int16")).toBe(true));
		test("rejects 32768", () => expect(validateValueAgainstType(32768, "int16")).toBe(false));
	});

	describe("int32", () => {
		test("accepts -2147483648", () => expect(validateValueAgainstType(-2147483648, "int32")).toBe(true));
		test("accepts 2147483647", () => expect(validateValueAgainstType(2147483647, "int32")).toBe(true));
		test("rejects 2147483648", () => expect(validateValueAgainstType(2147483648, "int32")).toBe(false));
	});

	describe("float", () => {
		test("accepts 3.14", () => expect(validateValueAgainstType(3.14, "float")).toBe(true));
		test("accepts 0", () => expect(validateValueAgainstType(0, "float")).toBe(true));
		test("accepts negative", () => expect(validateValueAgainstType(-1.5, "float")).toBe(true));
		test("rejects Infinity", () => expect(validateValueAgainstType(Infinity, "float")).toBe(false));
		test("rejects NaN", () => expect(validateValueAgainstType(NaN, "float")).toBe(false));
		test("rejects string", () => expect(validateValueAgainstType("3.14", "float")).toBe(false));
	});

	describe("double", () => {
		test("accepts large float", () => expect(validateValueAgainstType(1.7976931348623157e+308, "double")).toBe(true));
		test("rejects Infinity", () => expect(validateValueAgainstType(Infinity, "double")).toBe(false));
	});

	describe("array types", () => {
		test("string[] accepts string array", () => expect(validateValueAgainstType(["a", "b"], "string[]")).toBe(true));
		test("string[] accepts empty array", () => expect(validateValueAgainstType([], "string[]")).toBe(true));
		test("string[] rejects mixed array", () => expect(validateValueAgainstType(["a", 1], "string[]")).toBe(false));
		test("string[] rejects non-array", () => expect(validateValueAgainstType("hello", "string[]")).toBe(false));

		test("uint32[] accepts number array", () => expect(validateValueAgainstType([1, 2, 3], "uint32[]")).toBe(true));
		test("uint32[] rejects negative", () => expect(validateValueAgainstType([1, -1], "uint32[]")).toBe(false));
		test("uint32[] rejects out of range", () => expect(validateValueAgainstType([4294967296], "uint32[]")).toBe(false));

		test("bool[] accepts booleans", () => expect(validateValueAgainstType([true, false], "bool[]")).toBe(true));
		test("bool[] rejects numbers", () => expect(validateValueAgainstType([0, 1], "bool[]")).toBe(false));
	});
});

// ============ validateSchemaDefinition ============

describe("validateSchemaDefinition", () => {
	test("valid schema passes", () => {
		const errors = validateSchemaDefinition(GAMING_SCHEMA);
		expect(errors).toHaveLength(0);
	});

	test("ragnarok schema passes", () => {
		const errors = validateSchemaDefinition(RAGNAROK_MINION_SCHEMA);
		expect(errors).toHaveLength(0);
	});

	test("empty schema fails", () => {
		const errors = validateSchemaDefinition({ immutable: [], mutable: [] });
		expect(errors.length).toBeGreaterThan(0);
		expect(errors[0]!.code).toBe("SCHEMA_EMPTY");
	});

	test("duplicate field name across sections fails", () => {
		const errors = validateSchemaDefinition({
			immutable: [{ name: "level", type: "uint16" }],
			mutable: [{ name: "level", type: "uint32" }],
		});
		expect(errors.some((e) => e.code === "FIELD_NAME_DUPLICATE")).toBe(true);
	});

	test("invalid type fails", () => {
		const errors = validateSchemaDefinition({
			immutable: [],
			mutable: [{ name: "foo", type: "varchar" as unknown as CollectionSchema["mutable"][number]["type"] }],
		});
		expect(errors.some((e) => e.code === "FIELD_TYPE_INVALID")).toBe(true);
	});

	test("invalid field name (uppercase) fails", () => {
		const errors = validateSchemaDefinition({
			immutable: [],
			mutable: [{ name: "MyField", type: "string" }],
		});
		expect(errors.some((e) => e.code === "FIELD_NAME_INVALID")).toBe(true);
	});

	test("invalid field name (starts with number) fails", () => {
		const errors = validateSchemaDefinition({
			immutable: [],
			mutable: [{ name: "1field", type: "string" }],
		});
		expect(errors.some((e) => e.code === "FIELD_NAME_INVALID")).toBe(true);
	});

	test("field name with hyphens fails", () => {
		const errors = validateSchemaDefinition({
			immutable: [],
			mutable: [{ name: "my-field", type: "string" }],
		});
		expect(errors.some((e) => e.code === "FIELD_NAME_INVALID")).toBe(true);
	});

	test("field name with underscores passes", () => {
		const errors = validateSchemaDefinition({
			immutable: [],
			mutable: [{ name: "my_field", type: "string" }],
		});
		expect(errors).toHaveLength(0);
	});

	test("exceeding 64 fields fails", () => {
		const fields = Array.from({ length: 65 }, (_, i) => ({ name: `field_${i}`, type: "string" as const }));
		const errors = validateSchemaDefinition({ immutable: fields, mutable: [] });
		expect(errors.some((e) => e.code === "SCHEMA_TOO_LARGE")).toBe(true);
	});
});

// ============ validateMintData ============

describe("validateMintData", () => {
	const schema: CollectionSchema = {
		immutable: [
			{ name: "rarity", type: "string" },
			{ name: "power", type: "uint32" },
		],
		mutable: [
			{ name: "level", type: "uint16" },
			{ name: "xp", type: "uint32" },
		],
	};

	test("valid immutable + mutable data passes", () => {
		const errors = validateMintData(
			schema,
			{ rarity: "legendary", power: 500 },
			{ level: 1, xp: 0 },
		);
		expect(errors).toHaveLength(0);
	});

	test("missing immutableData fails when schema has immutable fields", () => {
		const errors = validateMintData(schema, undefined, { level: 1 });
		expect(errors.some((e) => e.code === "IMMUTABLE_DATA_REQUIRED")).toBe(true);
	});

	test("wrong type in immutableData fails", () => {
		const errors = validateMintData(
			schema,
			{ rarity: 42, power: 500 },
		);
		expect(errors.some((e) => e.code === "FIELD_TYPE_MISMATCH")).toBe(true);
	});

	test("missing required immutable field fails (strict mode)", () => {
		const errors = validateMintData(
			schema,
			{ rarity: "legendary" },
		);
		expect(errors.some((e) => e.code === "FIELD_MISSING")).toBe(true);
	});

	test("null immutable field in strict mode fails", () => {
		const errors = validateMintData(
			schema,
			{ rarity: null, power: 500 },
		);
		expect(errors.some((e) => e.code === "FIELD_NULL_STRICT")).toBe(true);
	});

	test("unknown field in immutableData fails", () => {
		const errors = validateMintData(
			schema,
			{ rarity: "legendary", power: 500, unknown_field: "hack" },
		);
		expect(errors.some((e) => e.code === "FIELD_UNKNOWN")).toBe(true);
	});

	test("mutableData is optional at mint", () => {
		const errors = validateMintData(
			schema,
			{ rarity: "legendary", power: 500 },
		);
		expect(errors).toHaveLength(0);
	});

	test("wrong type in mutableData fails", () => {
		const errors = validateMintData(
			schema,
			{ rarity: "legendary", power: 500 },
			{ level: "quince", xp: 0 },
		);
		expect(errors.some((e) => e.code === "FIELD_TYPE_MISMATCH")).toBe(true);
	});

	test("uint32 out of range in immutableData fails", () => {
		const errors = validateMintData(
			schema,
			{ rarity: "legendary", power: 4294967296 },
		);
		expect(errors.some((e) => e.code === "FIELD_TYPE_MISMATCH")).toBe(true);
	});
});

// ============ validateMutableUpdate ============

describe("validateMutableUpdate", () => {
	const schema: CollectionSchema = {
		immutable: [
			{ name: "rarity", type: "string" },
		],
		mutable: [
			{ name: "level", type: "uint16" },
			{ name: "xp", type: "uint32" },
			{ name: "equipped", type: "string[]" },
		],
	};

	test("valid partial update passes", () => {
		const errors = validateMutableUpdate(schema, { level: 5 });
		expect(errors).toHaveLength(0);
	});

	test("valid full update passes", () => {
		const errors = validateMutableUpdate(schema, { level: 5, xp: 1200, equipped: ["sword"] });
		expect(errors).toHaveLength(0);
	});

	test("attempting to modify immutable field fails", () => {
		const errors = validateMutableUpdate(schema, { rarity: "common" });
		expect(errors.some((e) => e.code === "FIELD_IMMUTABLE")).toBe(true);
	});

	test("unknown field fails", () => {
		const errors = validateMutableUpdate(schema, { speed: 50 });
		expect(errors.some((e) => e.code === "FIELD_UNKNOWN")).toBe(true);
	});

	test("wrong type fails", () => {
		const errors = validateMutableUpdate(schema, { level: "alto" });
		expect(errors.some((e) => e.code === "FIELD_TYPE_MISMATCH")).toBe(true);
	});

	test("array type validated correctly", () => {
		const errors = validateMutableUpdate(schema, { equipped: "sword" });
		expect(errors.some((e) => e.code === "FIELD_TYPE_MISMATCH")).toBe(true);
	});

	test("negative uint16 fails", () => {
		const errors = validateMutableUpdate(schema, { level: -1 });
		expect(errors.some((e) => e.code === "FIELD_TYPE_MISMATCH")).toBe(true);
	});

	test("uint16 overflow fails", () => {
		const errors = validateMutableUpdate(schema, { level: 70000 });
		expect(errors.some((e) => e.code === "FIELD_TYPE_MISMATCH")).toBe(true);
	});
});

describe("validateMutableSnapshot", () => {
	const schema: CollectionSchema = {
		immutable: [
			{ name: "rarity", type: "string" },
		],
		mutable: [
			{ name: "level", type: "uint16" },
			{ name: "xp", type: "uint32" },
			{ name: "equipped", type: "string[]" },
		],
	};

	test("valid full snapshot passes", () => {
		const errors = validateMutableSnapshot(schema, {
			level: 5,
			xp: 1200,
			equipped: ["sword"],
		});
		expect(errors).toHaveLength(0);
	});

	test("missing mutable field fails in strict mode", () => {
		const errors = validateMutableSnapshot(schema, {
			level: 5,
			xp: 1200,
		});
		expect(errors.some((e) => e.code === "FIELD_MISSING")).toBe(true);
	});

	test("immutable field is still rejected", () => {
		const errors = validateMutableSnapshot(schema, {
			rarity: "common",
			level: 5,
			xp: 1200,
			equipped: ["sword"],
		});
		expect(errors.some((e) => e.code === "FIELD_IMMUTABLE")).toBe(true);
	});
});

// ============ mergeSchemas ============

describe("mergeSchemas", () => {
	const base: CollectionSchema = {
		immutable: [{ name: "rarity", type: "string" }],
		mutable: [{ name: "level", type: "uint16" }],
	};

	test("adds new mutable fields", () => {
		const { merged, errors } = mergeSchemas(base, {
			newMutableFields: [{ name: "xp", type: "uint32" }],
		});
		expect(errors).toHaveLength(0);
		expect(merged.mutable).toHaveLength(2);
		expect(merged.mutable[1]!.name).toBe("xp");
	});

	test("adds new immutable fields", () => {
		const { merged, errors } = mergeSchemas(base, {
			newImmutableFields: [{ name: "element", type: "string" }],
		});
		expect(errors).toHaveLength(0);
		expect(merged.immutable).toHaveLength(2);
	});

	test("rejects duplicate field name", () => {
		const { errors } = mergeSchemas(base, {
			newMutableFields: [{ name: "rarity", type: "uint32" }],
		});
		expect(errors.some((e) => e.code === "FIELD_ALREADY_EXISTS")).toBe(true);
	});

	test("rejects empty extension", () => {
		const { errors } = mergeSchemas(base, {});
		expect(errors.some((e) => e.code === "EXTENSION_EMPTY")).toBe(true);
	});

	test("preserves original fields", () => {
		const { merged } = mergeSchemas(base, {
			newMutableFields: [{ name: "xp", type: "uint32" }],
		});
		expect(merged.immutable[0]!.name).toBe("rarity");
		expect(merged.mutable[0]!.name).toBe("level");
	});
});

// ============ canonicalJson ============

describe("canonicalJson", () => {
	test("keys are sorted alphabetically", () => {
		const json = canonicalJson({ z: 1, a: 2, m: 3 });
		expect(json).toBe('{"a":2,"m":3,"z":1}');
	});

	test("nested keys are sorted", () => {
		const json = canonicalJson({ b: { z: 1, a: 2 }, a: 1 });
		expect(json).toBe('{"a":1,"b":{"a":2,"z":1}}');
	});

	test("same data different order produces same JSON", () => {
		const json1 = canonicalJson({ level: 5, xp: 100 });
		const json2 = canonicalJson({ xp: 100, level: 5 });
		expect(json1).toBe(json2);
	});

	test("arrays preserve order", () => {
		const json = canonicalJson({ items: ["b", "a", "c"] });
		expect(json).toBe('{"items":["b","a","c"]}');
	});

	test("ignores __proto__ key", () => {
		const obj = JSON.parse('{"__proto__": "hack", "name": "safe"}');
		const json = canonicalJson(obj);
		expect(json).toBe('{"name":"safe"}');
	});
});

// ============ computeDataHash ============

describe("computeDataHash", () => {
	test("produces sha256 prefixed hash", async () => {
		const hash = await computeDataHash({ level: 5 });
		expect(hash.startsWith("sha256:")).toBe(true);
		expect(hash.length).toBe(7 + 64); // "sha256:" + 64 hex chars
	});

	test("same data different key order produces same hash", async () => {
		const hash1 = await computeDataHash({ level: 5, xp: 100 });
		const hash2 = await computeDataHash({ xp: 100, level: 5 });
		expect(hash1).toBe(hash2);
	});

	test("different data produces different hash", async () => {
		const hash1 = await computeDataHash({ level: 5 });
		const hash2 = await computeDataHash({ level: 6 });
		expect(hash1).not.toBe(hash2);
	});

	test("deterministic across calls", async () => {
		const data = { rarity: "legendary", power: 500, equipped: ["sword", "shield"] };
		const hash1 = await computeDataHash(data);
		const hash2 = await computeDataHash(data);
		expect(hash1).toBe(hash2);
	});
});

// ============ createSchemaBuilder ============

describe("createSchemaBuilder", () => {
	test("builds a valid schema", () => {
		const schema = createSchemaBuilder()
			.immutable("rarity", "string")
			.immutable("element", "string")
			.mutable("level", "uint16")
			.mutable("xp", "uint32")
			.build();

		expect(schema.immutable).toHaveLength(2);
		expect(schema.mutable).toHaveLength(2);
		expect(schema.immutable[0]!.name).toBe("rarity");
		expect(schema.mutable[1]!.type).toBe("uint32");
	});

	test("built schema passes validation", () => {
		const schema = createSchemaBuilder()
			.immutable("name", "string")
			.mutable("score", "uint32")
			.build();

		const errors = validateSchemaDefinition(schema);
		expect(errors).toHaveLength(0);
	});
});

// ============ Zod schemas for schema fields ============

describe("Zod schema field validation", () => {
	test("valid field passes", () => {
		const result = schemaFieldSchema.safeParse({ name: "level", type: "uint16" });
		expect(result.success).toBe(true);
	});

	test("invalid type fails", () => {
		const result = schemaFieldSchema.safeParse({ name: "level", type: "varchar" });
		expect(result.success).toBe(false);
	});

	test("uppercase name fails", () => {
		const result = schemaFieldSchema.safeParse({ name: "Level", type: "uint16" });
		expect(result.success).toBe(false);
	});

	test("empty name fails", () => {
		const result = schemaFieldSchema.safeParse({ name: "", type: "uint16" });
		expect(result.success).toBe(false);
	});
});

describe("Zod collectionSchemaSchema", () => {
	test("valid schema passes", () => {
		const result = collectionSchemaSchema.safeParse({
			immutable: [{ name: "rarity", type: "string" }],
			mutable: [{ name: "level", type: "uint16" }],
		});
		expect(result.success).toBe(true);
	});

	test("empty mutable fails", () => {
		const result = collectionSchemaSchema.safeParse({
			immutable: [{ name: "rarity", type: "string" }],
			mutable: [],
		});
		expect(result.success).toBe(false);
	});

	test("immutable can be empty", () => {
		const result = collectionSchemaSchema.safeParse({
			immutable: [],
			mutable: [{ name: "level", type: "uint16" }],
		});
		expect(result.success).toBe(true);
	});
});

describe("Zod extendSchemaInputSchema", () => {
	test("valid extend input passes", () => {
		const result = extendSchemaInputSchema.safeParse({
			collectionId: "col_test123",
			newMutableFields: [{ name: "wins", type: "uint32" }],
		});
		expect(result.success).toBe(true);
	});

	test("missing collectionId fails", () => {
		const result = extendSchemaInputSchema.safeParse({
			newMutableFields: [{ name: "wins", type: "uint32" }],
		});
		expect(result.success).toBe(false);
	});
});

// ============ VALID_SCHEMA_TYPES coverage ============

describe("VALID_SCHEMA_TYPES", () => {
	test("contains all 24 expected types (12 scalar + 12 array)", () => {
		expect(VALID_SCHEMA_TYPES.size).toBe(24);
	});

	test("contains all scalar types", () => {
		for (const t of ["string", "bool", "uint8", "uint16", "uint32", "uint64", "int8", "int16", "int32", "int64", "float", "double"]) {
			expect(VALID_SCHEMA_TYPES.has(t)).toBe(true);
		}
	});

	test("contains all array types", () => {
		for (const t of ["string[]", "bool[]", "uint8[]", "uint16[]", "uint32[]", "uint64[]", "int8[]", "int16[]", "int32[]", "int64[]", "float[]", "double[]"]) {
			expect(VALID_SCHEMA_TYPES.has(t)).toBe(true);
		}
	});
});
