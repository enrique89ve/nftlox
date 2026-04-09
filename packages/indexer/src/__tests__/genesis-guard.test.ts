import { describe, expect, test } from "bun:test";
import { validateGenesisBlockSelection } from "@/protocol/genesis-guard.ts";
import { PROTOCOL_GENESIS_BLOCK } from "@/protocol/constants.ts";

describe("validateGenesisBlockSelection", () => {
	test("accepts the canonical protocol genesis block", () => {
		expect(() => validateGenesisBlockSelection({
			genesisBlock: PROTOCOL_GENESIS_BLOCK,
			allowUnsafeGenesisBlock: false,
		})).not.toThrow();
	});

	test("accepts earlier genesis blocks", () => {
		expect(() => validateGenesisBlockSelection({
			genesisBlock: PROTOCOL_GENESIS_BLOCK - 1,
			allowUnsafeGenesisBlock: false,
		})).not.toThrow();
	});

	test("rejects later genesis blocks by default", () => {
		expect(() => validateGenesisBlockSelection({
			genesisBlock: PROTOCOL_GENESIS_BLOCK + 1,
			allowUnsafeGenesisBlock: false,
		})).toThrow("Unsafe GENESIS_BLOCK");
	});

	test("allows later genesis blocks only with explicit override", () => {
		expect(() => validateGenesisBlockSelection({
			genesisBlock: PROTOCOL_GENESIS_BLOCK + 1,
			allowUnsafeGenesisBlock: true,
		})).not.toThrow();
	});
});
