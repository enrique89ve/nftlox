import { describe, expect, test } from "bun:test";
import { validateGenesisBlockSelection } from "@/protocol/genesis-guard.ts";
import { PROTOCOL_GENESIS_BLOCK } from "@/protocol/constants.ts";

describe("validateGenesisBlockSelection", () => {
	test("accepts the canonical protocol genesis block", () => {
		expect(() => validateGenesisBlockSelection({
			genesisBlock: PROTOCOL_GENESIS_BLOCK,
		})).not.toThrow();
	});

	test("rejects any value other than the canonical genesis", () => {
		expect(() => validateGenesisBlockSelection({
			genesisBlock: PROTOCOL_GENESIS_BLOCK - 1,
		})).toThrow("does not match protocol canonical genesis");

		expect(() => validateGenesisBlockSelection({
			genesisBlock: PROTOCOL_GENESIS_BLOCK + 1,
		})).toThrow("does not match protocol canonical genesis");
	});

	test("rejects non-positive integers", () => {
		expect(() => validateGenesisBlockSelection({ genesisBlock: 0 })).toThrow(
			"must be a positive integer",
		);
		expect(() => validateGenesisBlockSelection({ genesisBlock: -1 })).toThrow(
			"must be a positive integer",
		);
		expect(() => validateGenesisBlockSelection({ genesisBlock: 1.5 })).toThrow(
			"must be a positive integer",
		);
	});
});
