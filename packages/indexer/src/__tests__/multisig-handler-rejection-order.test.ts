// P3 — rejection-order pin between multisig and handler validators.
//
// Companion to `multisig-collection-payload-parity.test.ts`. That file proves
// OUTCOME parity ([[project_multisig_handler_parity_invariant]]): both sides
// reject the SAME set of malformed create_collection payloads. This file pins
// rejection-PATH parity: for payloads that violate MULTIPLE gates at once,
// which gate each side reports first. The two sides currently differ in one
// known place (originDna vs metadata.* — multisig hashes the canonical id
// before validating metadata; the handler validates metadata before hashing),
// and that residual edge is the entire reason this pin exists.
//
// Forward-regression-detector mechanic:
//   - Each fixture combines 2+ violations and asserts the *first* substring
//     each path surfaces. Same-gate parity entries assert IDENTICAL substrings
//     on both sides; the documented-divergence entry asserts DIFFERENT ones.
//   - Any reorder that rotates which gate fires first on either side will
//     flip a substring and break the assertion. The author then must either
//     mirror the reorder on the opposite side (preferred) or consciously
//     update the fixture's expectations and explain the new divergence in
//     this file's doc-comment.
//
// Handler invocation note: the router dispatches the fee-transfer payment
// before reaching `handleCreateCollection`, so `op.payment` is populated by
// the test fixture to mirror that pre-handler contract.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { useSingletonLock } from "./helpers/singleton-lock.ts";
import { makeOp } from "./helpers/make-op.ts";
import { seedActiveSettlementNode } from "./helpers/settlement-node.ts";
import { sql, withTransaction } from "@/db/client.ts";
import { processCollectionRequest } from "@/api/services/multisig/create-collection.ts";
import { handleCreateCollection } from "@/processor/handlers/core/create-collection.ts";
import { isMultisigError } from "@/api/services/multisig/errors.ts";
import { config } from "@/config.ts";
import {
	ACTION_CREATE_COLLECTION,
	INSTANCE_FEE_PER_N,
	MAX_INSTANCES_PER_COLLECTION,
	MIN_PROTOCOL_VERSION,
	PROTOCOL_COLLECTION_FEE_HBD,
	PROTOCOL_ID,
	generateDeterministicCollectionId,
	generateOriginDna,
} from "@/protocol/index.ts";
import type { ParsedOperation } from "@/scanner/operation-parser.ts";
import type {
	CollectionLockHandle,
	MultisigCollectionContext,
	MultisigSign,
} from "@/api/services/multisig/types.ts";

const NODE_ACCOUNT = config.hiveAccount;
// Test-local creator name so cleanup never collides with stub rows seeded by
// other suites running against the same Postgres dev DB.
const CREATOR = "rejorderpin";
const NAME = "OrderPin";
const SYMBOL = "PIN";
const FEE_AMOUNT_NUMERIC = parseFloat(PROTOCOL_COLLECTION_FEE_HBD);
const FEE_AMOUNT_STRING = `${PROTOCOL_COLLECTION_FEE_HBD} HBD`;

const collectionLockStub: CollectionLockHandle = {
	acquire: async () => ({ acquired: true }),
	release: async () => {},
};

const unreachableSign: MultisigSign = async () => {
	throw new Error("sign must not be reached when payload validation fails");
};

function buildCollectionCtx(): MultisigCollectionContext {
	return {
		db: sql,
		nodeAccount: NODE_ACCOUNT,
		protocolId: PROTOCOL_ID,
		sign: unreachableSign,
		collectionLock: collectionLockStub,
	};
}

async function clearDivergentFlag(): Promise<void> {
	await sql`UPDATE state_meta SET divergent_at_block = NULL WHERE id = 1`;
}

async function seedSyncStateForTimeWindow(): Promise<void> {
	await sql`UPDATE sync_state SET last_block = 1, hive_head_time = NOW(), hive_head_block = 1, hive_irreversible_block = 1 WHERE id = 1`;
}

async function clearCollectionForCreator(): Promise<void> {
	await sql`DELETE FROM collections WHERE creator = ${CREATOR}`;
}

function expirationFromNow(offsetMs: number): string {
	return new Date(Date.now() + offsetMs).toISOString().replace(/\.\d{3}Z$/, "");
}

type FixtureOverrides = Readonly<{
	readonly id?: unknown;
	readonly name?: unknown;
	readonly originDna?: unknown;
	readonly description?: unknown;
	readonly royaltyPct?: number;
	readonly maxInstances?: unknown;
}>;

async function buildPayloadData(overrides: FixtureOverrides): Promise<Record<string, unknown>> {
	const canonicalId = await generateDeterministicCollectionId(CREATOR, NAME, SYMBOL);
	const originDna = await generateOriginDna(canonicalId);
	const royaltyPct = overrides.royaltyPct ?? 0;
	return {
		id: "id" in overrides ? overrides.id : canonicalId,
		name: "name" in overrides ? overrides.name : NAME,
		symbol: SYMBOL,
		originDna: "originDna" in overrides ? overrides.originDna : originDna,
		totalPotential: 5,
		maxInstances: "maxInstances" in overrides ? overrides.maxInstances : 0,
		metadata: {
			description: "description" in overrides ? overrides.description : "order-pin fixture",
			image: "https://example.com/order-pin.png",
		},
		rules: {
			transferable: true,
			burnable: false,
			royaltyPct,
		},
	};
}

async function buildMultisigBody(overrides: FixtureOverrides): Promise<Record<string, unknown>> {
	const data = await buildPayloadData(overrides);
	const canonicalId = await generateDeterministicCollectionId(CREATOR, NAME, SYMBOL);
	const json = JSON.stringify({
		protocol: PROTOCOL_ID,
		version: MIN_PROTOCOL_VERSION,
		action: ACTION_CREATE_COLLECTION,
		data,
	});
	return {
		transaction: {
			ref_block_num: 1,
			ref_block_prefix: 1,
			expiration: expirationFromNow(45_000),
			extensions: [],
			signatures: [],
			operations: [
				[
					"transfer",
					{
						from: CREATOR,
						to: NODE_ACCOUNT,
						amount: FEE_AMOUNT_STRING,
						memo: `NFTLox FEE-COL:${canonicalId}`,
					},
				],
				[
					"custom_json",
					{
						id: PROTOCOL_ID,
						required_auths: [NODE_ACCOUNT],
						required_posting_auths: [],
						json,
					},
				],
			],
		},
	};
}

async function buildHandlerOp(overrides: FixtureOverrides): Promise<ParsedOperation> {
	const data = await buildPayloadData(overrides);
	const pairedTransfers = [
		{
			from: CREATOR,
			to: NODE_ACCOUNT,
			amount: FEE_AMOUNT_NUMERIC,
			currency: "HBD",
			memo: `NFTLox FEE-COL:${String(data.id)}`,
		},
	];
	const op = makeOp({
		action: ACTION_CREATE_COLLECTION,
		data,
		signer: NODE_ACCOUNT,
		pairedTransfers,
	});
	op.payment = {
		kind: "fixed",
		payer: CREATOR,
		amount: FEE_AMOUNT_NUMERIC,
		currency: "HBD",
		consumedIndices: [0],
	};
	return op;
}

type RejectionSnapshot = Readonly<{ kind: "thrown"; message: string }>;

async function captureMultisigRejection(body: unknown): Promise<RejectionSnapshot> {
	try {
		await processCollectionRequest(body, buildCollectionCtx());
	} catch (err) {
		if (isMultisigError(err)) {
			return { kind: "thrown", message: err.message };
		}
		return { kind: "thrown", message: err instanceof Error ? err.message : String(err) };
	}
	throw new Error("multisig path did not throw for a fixture expected to fail");
}

async function captureHandlerRejection(op: ParsedOperation): Promise<RejectionSnapshot> {
	try {
		await withTransaction((txn) => handleCreateCollection(op, txn));
	} catch (err) {
		return { kind: "thrown", message: err instanceof Error ? err.message : String(err) };
	}
	throw new Error("handler path did not throw for a fixture expected to fail");
}

// First fixture asserts the "happy" same-gate parity at the very front of
// both validation chains. Middle fixture documents the one known divergence
// (originDna vs metadata.*); see file header. Last fixture asserts same-gate
// parity for a deeper-in-the-chain check (royaltyPct out-of-range), so the
// pin captures three distinct points along the gate cascade rather than just
// the boundary.
const FIXTURES = [
	{
		label: "id-shape malformed + name empty → both reject id-shape first",
		overrides: { id: "wrong-prefix-id", name: "" } as FixtureOverrides,
		multisigContains: "col_<20 hex>",
		handlerContains: "col_<20 hex>",
	},
	{
		label:
			"originDna tampered + metadata.description empty → DIVERGENCE: multisig=originDna, handler=metadata",
		// originDna shape-valid (16 chars: "o" prefix + 15 hex) but non-canonical.
		// A shape-invalid value would short-circuit on the exact-length gate
		// before reaching the canonical-equality check we're trying to pin.
		overrides: {
			originDna: "oDEADBEEFDEADBEE",
			description: "",
		} as FixtureOverrides,
		multisigContains: "Non-canonical originDna",
		handlerContains: "metadata.description",
	},
	{
		label: "royaltyPct out-of-range + maxInstances oversized → both reject royaltyPct first",
		overrides: {
			royaltyPct: 99,
			maxInstances: MAX_INSTANCES_PER_COLLECTION + INSTANCE_FEE_PER_N,
		} as FixtureOverrides,
		multisigContains: "royaltyPct",
		handlerContains: "royaltyPct",
	},
] as const;

describe("P3 — multisig <-> handler rejection-order pin", () => {
	useSingletonLock();

	beforeAll(async () => {
		await seedSyncStateForTimeWindow();
	});

	beforeEach(async () => {
		await clearDivergentFlag();
		await seedActiveSettlementNode(NODE_ACCOUNT, { registeredBlock: 1 });
		await clearCollectionForCreator();
	});

	afterAll(async () => {
		await clearCollectionForCreator();
	});

	for (const fixture of FIXTURES) {
		test(fixture.label, async () => {
			const body = await buildMultisigBody(fixture.overrides);
			const op = await buildHandlerOp(fixture.overrides);

			const multisigRej = await captureMultisigRejection(body);
			const handlerRej = await captureHandlerRejection(op);

			expect(multisigRej.message).toContain(fixture.multisigContains);
			expect(handlerRej.message).toContain(fixture.handlerContains);
		});
	}
});
