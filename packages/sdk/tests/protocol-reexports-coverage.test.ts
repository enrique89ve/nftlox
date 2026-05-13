// Guardrail for the SDK's runtime re-export coverage of recently-added
// protocol symbols.
//
// Sister to `protocol-exports-surface.test.ts`: that file pins `Object.keys(
// @nftlox/protocol).sort()` so additions to the protocol package surface a
// diff; this file pins the subset of *integrator-facing* symbols the SDK
// MUST re-export through `protocol-exports.ts`. A protocol symbol can pass
// the surface test (allowlist updated) while being silently absent from the
// SDK's public API — this test closes that gap for the categories we know
// integrators reach for.
//
// Scope = N-4 tranche: id/shape guards added in N-2/N-3 + the genesis-anchor
// surface + the LIMIT_SCHEDULE query. Categories beyond this tranche
// (payment-requirements helpers, node-endpoint validators, marketplace TTL
// constants) are tracked separately and intentionally not covered here.

import { describe, expect, it } from "bun:test";
import * as sdk from "../src/protocol-exports";

// Each entry pairs the symbol name with the JS typeof its runtime value.
// Pinning typeof prevents an accidental `export type` swap from masking a
// regression: a missing value-export and a renamed type-export both produce
// `undefined`, but a successful re-export must match the expected typeof.
const REQUIRED_REEXPORTS: ReadonlyArray<{
	readonly name: string;
	readonly typeofValue: "function" | "string" | "number";
}> = [
	// Shape guards — same predicates the multisig + handler reject on.
	{ name: "isCollectionId", typeofValue: "function" },
	{ name: "isHiveTxId", typeofValue: "function" },
	{ name: "isListingId", typeofValue: "function" },
	{ name: "isSymbol", typeofValue: "function" },
	// Genesis anchor — SPV light clients pin these to reject hostile bootstraps.
	{ name: "PROTOCOL_GENESIS_BLOCK", typeofValue: "number" },
	{ name: "PROTOCOL_GENESIS_BLOCK_ID", typeofValue: "string" },
	{ name: "validateGenesisBlockSelection", typeofValue: "function" },
	// Consensus cap query — integrators verify caps pre-broadcast.
	{ name: "getLimit", typeofValue: "function" },
];

describe("SDK re-export coverage (N-4 tranche)", () => {
	for (const { name, typeofValue } of REQUIRED_REEXPORTS) {
		it(`re-exports ${name} as ${typeofValue}`, () => {
			const value = (sdk as Readonly<Record<string, unknown>>)[name];
			expect(value).toBeDefined();
			expect(typeof value).toBe(typeofValue);
		});
	}
});
