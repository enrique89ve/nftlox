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
// Scope = N-4 tranche (id/shape guards + genesis anchor + LIMIT_SCHEDULE
// query) PLUS the N-5 closure tranche (marketplace TTL constants, node-
// operator cadence, payment-requirements helpers, input validators).
// `assertNeverPaymentKind` is intentionally NOT covered here — see
// `protocol-exports.ts` §"Payment requirements" for the rationale.

import { describe, expect, it } from "bun:test";
import * as sdk from "../src/protocol-exports";

// Each entry pairs the symbol name with the JS typeof its runtime value.
// Pinning typeof prevents an accidental `export type` swap from masking a
// regression: a missing value-export and a renamed type-export both produce
// `undefined`, but a successful re-export must match the expected typeof.
const REQUIRED_REEXPORTS: ReadonlyArray<{
	readonly name: string;
	readonly typeofValue: "function" | "string" | "number" | "object";
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
	// N-5: marketplace timing — buy/commitment TTLs for pre-broadcast windows.
	{ name: "BUY_TX_TTL_MS", typeofValue: "number" },
	{ name: "BUY_COMMITMENT_TTL_BLOCKS", typeofValue: "number" },
	{ name: "BUY_API_LAG_MAX_BLOCKS", typeofValue: "number" },
	{ name: "BUY_API_HEAD_STALENESS_MAX_MS", typeofValue: "number" },
	// N-5: node-operator cadence — caps + heartbeat windows the whole network applies.
	{ name: "MAX_ACTIVE_COMMITMENTS_PER_NODE", typeofValue: "number" },
	{ name: "MIN_HEARTBEAT_INTERVAL_BLOCKS", typeofValue: "number" },
	{ name: "MAX_NODE_HEARTBEAT_STALENESS_BLOCKS", typeofValue: "number" },
	// N-5: payment requirements — pure dispatch over ACTION_PAYMENT.
	{ name: "ACTION_PAYMENT", typeofValue: "object" },
	{ name: "getPaymentRequirement", typeofValue: "function" },
	{ name: "requiresTransferEnrichment", typeofValue: "function" },
	{ name: "resolvePaymentRecipient", typeofValue: "function" },
	{ name: "castPayloadByAction", typeofValue: "function" },
	// N-5: input validators — null-on-ok string predicates.
	{ name: "validateHiveUsername", typeofValue: "function" },
	{ name: "validateNodeEndpoint", typeofValue: "function" },
	{ name: "normalizeNodeEndpoint", typeofValue: "function" },
	// Marketplace NFC hardening — cap hashed into listingId via generateListingId.
	{ name: "MAX_MARKETPLACE_LENGTH", typeofValue: "number" },
];

describe("SDK re-export coverage (N-4 + N-5 tranches)", () => {
	for (const { name, typeofValue } of REQUIRED_REEXPORTS) {
		it(`re-exports ${name} as ${typeofValue}`, () => {
			const value = (sdk as Readonly<Record<string, unknown>>)[name];
			expect(value).toBeDefined();
			expect(typeof value).toBe(typeofValue);
		});
	}
});
