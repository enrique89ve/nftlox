// Guardrail: protocol source files (except constants.ts) must never contain
// raw id/DNA/hash prefix literals. Every emitter must go through the exported
// *_PREFIX / *_FORMAT_PREFIX / BURN_RECIPIENT constants so that changing one
// requires only the declaration change, not a scatter-refactor.

import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC_ROOT = join(import.meta.dir, "..", "src");
const DECLARATION_FILE = "constants.ts";

// Each pattern pairs a forbidden substring with the constant that should be
// imported instead. Match is substring-based (so `"seed_"` catches `"seed_foo"`
// in a string literal but not the identifier `SEED_ID_PREFIX`).
const FORBIDDEN_LITERALS: ReadonlyArray<{ pattern: string; use: string }> = [
	{ pattern: '"seed_"', use: "SEED_ID_PREFIX" },
	{ pattern: '"nft_"', use: "INSTANCE_ID_PREFIX" },
	{ pattern: '"col_"', use: "COLLECTION_ID_PREFIX" },
	{ pattern: '"img_"', use: "IMAGE_ID_PREFIX" },
	{ pattern: '"sha256:"', use: "HASH_FORMAT_PREFIX" },
	// Template literals such as `seed_${x}` emit the prefix without quotes.
	// Backtick check covers that variant.
	{ pattern: "`seed_", use: "SEED_ID_PREFIX" },
	{ pattern: "`nft_", use: "INSTANCE_ID_PREFIX" },
	{ pattern: "`col_", use: "COLLECTION_ID_PREFIX" },
	{ pattern: "`img_", use: "IMAGE_ID_PREFIX" },
	{ pattern: "`sha256:", use: "HASH_FORMAT_PREFIX" },
];

function listProtocolSources(): string[] {
	const files: string[] = [];
	for (const entry of readdirSync(SRC_ROOT)) {
		const abs = join(SRC_ROOT, entry);
		if (!statSync(abs).isFile()) continue;
		if (!entry.endsWith(".ts")) continue;
		if (entry === DECLARATION_FILE) continue;
		files.push(abs);
	}
	return files;
}

describe("no raw id/hash-prefix literals in protocol source", () => {
	const files = listProtocolSources();

	it("discovers at least one protocol source file", () => {
		expect(files.length).toBeGreaterThan(0);
	});

	for (const absPath of files) {
		const rel = absPath.slice(SRC_ROOT.length + 1);
		it(`${rel} contains no forbidden prefix literal`, () => {
			const content = readFileSync(absPath, "utf8");
			const hits = FORBIDDEN_LITERALS.flatMap(({ pattern, use }) =>
				content.includes(pattern) ? [`${pattern} (use ${use} instead)`] : [],
			);
			expect(hits).toEqual([]);
		});
	}
});
