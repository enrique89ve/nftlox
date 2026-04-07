import { describe, test, expect } from "bun:test";
import type { ConsensusHead } from "../scanner/head-consensus.ts";
import { selectConsensusSample } from "../scanner/head-consensus.ts";

function sample(headBlock: number, irreversibleBlock: number): ConsensusHead {
	return { headBlock, irreversibleBlock };
}

describe("selectConsensusSample", () => {
	test("returns the only available sample", () => {
		expect(selectConsensusSample([sample(120, 100)], head => head)).toEqual({
			headBlock: 120,
			irreversibleBlock: 100,
		});
	});

	test("chooses the lower irreversible block when two endpoints disagree", () => {
		expect(selectConsensusSample([
			sample(121, 100),
			sample(125, 104),
		], head => head)).toEqual({
			headBlock: 121,
			irreversibleBlock: 100,
		});
	});

	test("rejects a single high outlier with three endpoints", () => {
		expect(selectConsensusSample([
			sample(130, 100),
			sample(131, 101),
			sample(140, 140),
		], head => head)).toEqual({
			headBlock: 131,
			irreversibleBlock: 101,
		});
	});
});
