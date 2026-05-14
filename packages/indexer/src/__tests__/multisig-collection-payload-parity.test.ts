// M5 — multisig <-> handler payload parity.
//
// The multisig pre-signing path and the on-chain handler must reject the same
// set of malformed/illegal create_collection payloads. Each test forces ONE
// invariant by mutating ONE field of a known-good fixture and asserts that
// processCollectionRequest throws INVALID_PROTOCOL_PAYLOAD with a message that
// identifies the offending field. Behaviour flows through the public seam only
// (processCollectionRequest); we never reach into helpers.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { useSingletonLock } from "./helpers/singleton-lock.ts";
import { sql } from "@/db/client.ts";
import { processCollectionRequest } from "@/api/services/multisig/create-collection.ts";
import { isMultisigError } from "@/api/services/multisig/errors.ts";
import {
	ACTION_CREATE_COLLECTION,
	INSTANCE_FEE_PER_N,
	MAX_INSTANCES_PER_COLLECTION,
	MIN_PROTOCOL_VERSION,
	PROTOCOL_COLLECTION_FEE_HBD,
	PROTOCOL_ID,
	generateDeterministicCollectionId,
	generateOriginDna,
	getLimit,
} from "@/protocol/index.ts";
import type {
	CollectionLockHandle,
	MultisigCollectionContext,
	MultisigSign,
} from "@/api/services/multisig/types.ts";
import type { MultisigErrorCode } from "@/protocol/index.ts";
import { config } from "@/config.ts";
import { seedActiveSettlementNode } from "./helpers/settlement-node.ts";

const NODE_ACCOUNT = config.hiveAccount;
const FEE_AMOUNT_STRING = `${PROTOCOL_COLLECTION_FEE_HBD} HBD`;
const CREATOR = "alice";
const COLLECTION_NAME = "Parity";
const COLLECTION_SYMBOL = "PRTY";

const collectionLockStub: CollectionLockHandle = {
	acquire: async () => ({ acquired: true }),
	release: async () => {},
};

const signStub: MultisigSign = async () => {
	throw new Error("sign should not be reached when validation fires");
};

const passingSignStub: MultisigSign = async () => ({
	ok: true,
	signature: "stub-signature",
	digest: "stub-digest",
	expiration: "2030-01-01T00:00:00",
});

function buildCollectionCtx(sign: MultisigSign = signStub): MultisigCollectionContext {
	return {
		db: sql,
		nodeAccount: NODE_ACCOUNT,
		protocolId: PROTOCOL_ID,
		sign,
		collectionLock: collectionLockStub,
	};
}

async function callCollection(rawBody: unknown): Promise<
	Readonly<
		| { thrown: true; code: MultisigErrorCode; message: string }
		| { thrown: false; ok: boolean; code?: MultisigErrorCode }
	>
> {
	try {
		const result = await processCollectionRequest(rawBody, buildCollectionCtx());
		return {
			thrown: false,
			ok: result.ok,
			code: result.ok ? undefined : result.code,
		};
	} catch (err) {
		if (isMultisigError(err)) {
			return { thrown: true, code: err.code, message: err.message };
		}
		throw err;
	}
}

async function clearDivergentFlag(): Promise<void> {
	await sql`UPDATE state_meta SET divergent_at_block = NULL WHERE id = 1`;
}

async function seedSyncStateForTimeWindow(): Promise<void> {
	await sql`UPDATE sync_state SET last_block = 1, hive_head_time = NOW(), hive_head_block = 1, hive_irreversible_block = 1 WHERE id = 1`;
}

async function clearCollectionForCreator(): Promise<void> {
	await sql`DELETE FROM collections WHERE creator = ${CREATOR} AND symbol = ${COLLECTION_SYMBOL}`;
}

// B-2 — collectionsPerCreator cap parity. Seeds the cap-many stub rows so the
// next create_collection request hits the same `assertWithinLimit` boundary
// the handler enforces at `processor/handlers/core/create-collection.ts:73`.
async function seedCollectionsAtCap(creator: string, count: number): Promise<void> {
	await sql`
		INSERT INTO collections (id, name, symbol, creator, origin_dna, block_num, tx_id, created_at)
		SELECT
			'coll-cap-stub-' || lpad(g::text, 3, '0'),
			'stub',
			'STB' || lpad(g::text, 3, '0'),
			${creator},
			'odna_cap_stub_' || lpad(g::text, 3, '0'),
			100,
			'tx-cap-stub-' || lpad(g::text, 3, '0'),
			NOW()
		FROM generate_series(1, ${count}) g
	`;
}

async function clearStubCollections(creator: string): Promise<void> {
	await sql`DELETE FROM collections WHERE creator = ${creator} AND id LIKE 'coll-cap-stub-%'`;
}

function expirationFromNow(offsetMs: number): string {
	return new Date(Date.now() + offsetMs).toISOString().replace(/\.\d{3}Z$/, "");
}

type CollectionPayloadOverrides = Readonly<{
	readonly id?: unknown;
	readonly name?: unknown;
	readonly symbol?: unknown;
	readonly description?: unknown;
	readonly image?: unknown;
	readonly originDna?: unknown;
	readonly maxInstances?: unknown;
	readonly royaltyPct?: number;
	readonly royaltyRecipient?: unknown;
	readonly feeMemo?: string;
}>;

async function buildPassingCollectionBody(
	overrides: CollectionPayloadOverrides = {},
): Promise<Record<string, unknown>> {
	const canonicalId = await generateDeterministicCollectionId(CREATOR, COLLECTION_NAME, COLLECTION_SYMBOL);
	const originDna = await generateOriginDna(canonicalId);
	const royaltyPct = overrides.royaltyPct ?? 0;
	const data: Record<string, unknown> = {
		id: "id" in overrides ? overrides.id : canonicalId,
		name: "name" in overrides ? overrides.name : COLLECTION_NAME,
		symbol: "symbol" in overrides ? overrides.symbol : COLLECTION_SYMBOL,
		originDna: "originDna" in overrides ? overrides.originDna : originDna,
		totalPotential: 5,
		maxInstances: "maxInstances" in overrides ? overrides.maxInstances : 0,
		metadata: {
			description: "description" in overrides ? overrides.description : "parity test collection",
			image: "image" in overrides ? overrides.image : "https://example.com/parity.png",
		},
		rules: {
			transferable: true,
			burnable: false,
			royaltyPct,
			...("royaltyRecipient" in overrides ? { royaltyRecipient: overrides.royaltyRecipient } : {}),
		},
	};
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
						memo: overrides.feeMemo ?? `NFTLox FEE-COL:${canonicalId}`,
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

describe("M5 multisig <-> handler payload parity", () => {
	useSingletonLock();

	beforeAll(async () => {
		await seedSyncStateForTimeWindow();
	});

	beforeEach(async () => {
		await clearDivergentFlag();
		await seedActiveSettlementNode(NODE_ACCOUNT, { registeredBlock: 1 });
		await clearCollectionForCreator();
		await clearStubCollections(CREATOR);
	});

	afterAll(async () => {
		await clearCollectionForCreator();
		await clearStubCollections(CREATOR);
	});

	test("rejects payloads whose originDna does not equal generateOriginDna(canonicalId)", async () => {
		const tamperedOriginDna = "oDEADBEEFDEADBEE"; // 16 chars, valid shape, wrong value
		const body = await buildPassingCollectionBody({ originDna: tamperedOriginDna });

		const outcome = await callCollection(body);

		expect(outcome.thrown).toBe(true);
		if (outcome.thrown) {
			expect(outcome.code).toBe("INVALID_PROTOCOL_PAYLOAD");
			expect(outcome.message).toContain("Non-canonical originDna");
			expect(outcome.message).toContain(tamperedOriginDna);
		}
	});

	test("rejects payloads with royaltyPct > 0 and no royaltyRecipient", async () => {
		const body = await buildPassingCollectionBody({ royaltyPct: 5 });

		const outcome = await callCollection(body);

		expect(outcome.thrown).toBe(true);
		if (outcome.thrown) {
			expect(outcome.code).toBe("INVALID_PROTOCOL_PAYLOAD");
			expect(outcome.message).toContain("royaltyRecipient is required when");
			expect(outcome.message).toContain("royaltyPct");
		}
	});

	test("rejects payloads whose royaltyRecipient is not a well-formed Hive username", async () => {
		const body = await buildPassingCollectionBody({
			royaltyPct: 5,
			royaltyRecipient: "Bad_User!",
		});

		const outcome = await callCollection(body);

		expect(outcome.thrown).toBe(true);
		if (outcome.thrown) {
			expect(outcome.code).toBe("INVALID_PROTOCOL_PAYLOAD");
			expect(outcome.message).toContain("royaltyRecipient");
			expect(outcome.message).toContain("Bad_User!");
		}
	});

	// B-1 — handler's `requireBoundedString` rejects "" via `requireString`
	// (utils/validation.ts:198-203). Multisig must reject the same empty values
	// before signing, or the protocol fee is paid for a tx the chain bounces.
	// Note: `id` is shape-gated (see malformed-id table below) — empty `id`
	// fails the shape check first, not the empty check.
	test.each([
		["name", { name: "" }] as const,
		["metadata.description", { description: "" }] as const,
		["metadata.image", { image: "" }] as const,
	])("rejects empty %s", async (fieldName, overrides) => {
		const body = await buildPassingCollectionBody(overrides);

		const outcome = await callCollection(body);

		expect(outcome.thrown).toBe(true);
		if (outcome.thrown) {
			expect(outcome.code).toBe("INVALID_PROTOCOL_PAYLOAD");
			expect(outcome.message).toContain(fieldName);
			expect(outcome.message).toContain("non-empty");
		}
	});

	test.each([
		["empty memo", ""],
		["wrong collection id", "NFTLox FEE-COL:col_aaaaaaaaaaaaaaaaaaaa"],
	])("rejects fee transfer with %s", async (_label, feeMemo) => {
		const body = await buildPassingCollectionBody({ feeMemo });

		const outcome = await callCollection(body);

		expect(outcome.thrown).toBe(true);
		if (outcome.thrown) {
			expect(outcome.code).toBe("INVALID_PAYMENT_SPLIT");
			expect(outcome.message).toContain("Collection fee memo");
			expect(outcome.message).toContain("NFTLox FEE-COL:");
		}
	});

	test(`rejects maxInstances above ${MAX_INSTANCES_PER_COLLECTION}`, async () => {
		const oversized = MAX_INSTANCES_PER_COLLECTION + INSTANCE_FEE_PER_N;
		const body = await buildPassingCollectionBody({ maxInstances: oversized });

		const outcome = await callCollection(body);

		expect(outcome.thrown).toBe(true);
		if (outcome.thrown) {
			expect(outcome.code).toBe("INVALID_PROTOCOL_PAYLOAD");
			expect(outcome.message).toContain("maxInstances");
			expect(outcome.message).toContain("exceeds protocol cap");
			expect(outcome.message).toContain(String(MAX_INSTANCES_PER_COLLECTION));
		}
	});

	// B-2 — handler caps a creator at `collectionsPerCreator` collections
	// (processor/handlers/core/create-collection.ts:72-73 via
	// @nftlox/protocol's `getLimit`). Multisig must reject the cap+1 request
	// or the protocol fee is paid for a tx the chain bounces. Seed-block is
	// the genesis schedule, so the value `getLimit("collectionsPerCreator", 1)`
	// resolves at module-load time matches the value the handler sees.
	test("rejects payloads when creator is at collectionsPerCreator cap", async () => {
		const cap = getLimit("collectionsPerCreator", 1);
		await seedCollectionsAtCap(CREATOR, cap);

		const body = await buildPassingCollectionBody();
		const outcome = await callCollection(body);

		expect(outcome.thrown).toBe(true);
		if (outcome.thrown) {
			expect(outcome.code).toBe("INVALID_PROTOCOL_PAYLOAD");
			expect(outcome.message).toContain("collectionsPerCreator");
			expect(outcome.message).toContain(CREATOR);
			expect(outcome.message).toContain(String(cap));
		}
	});

	// Shape-guard parity on `id`. Handler runs `requireShapedString` with
	// `isCollectionId` before the canonical-equality check; multisig must
	// reject the same malformed ids pre-broadcast or the protocol fee is
	// paid for a tx the chain bounces. Pins prefix / hex-charset / length
	// constraints derived from `generateDeterministicCollectionId`.
	test.each([
		["wrong prefix", "coll_c68ff3c9d182617bf2d0"],
		["uppercase hex", `col_${"A".repeat(20)}`],
		["too short", `col_${"a".repeat(19)}`],
		["too long", `col_${"a".repeat(21)}`],
		["non-hex char", `col_${"g".repeat(20)}`],
		["missing prefix", "c68ff3c9d182617bf2d0"],
		["empty", ""],
	])("rejects malformed id (%s)", async (_label, badId) => {
		const body = await buildPassingCollectionBody({ id: badId });

		const outcome = await callCollection(body);

		expect(outcome.thrown).toBe(true);
		if (outcome.thrown) {
			expect(outcome.code).toBe("INVALID_PROTOCOL_PAYLOAD");
			expect(outcome.message).toContain("data.id");
			expect(outcome.message).toContain("canonical shape");
		}
	});

	// Shape-guard parity on `symbol`. Handler uses `requireSymbol` (which
	// delegates to `isSymbol` from `@nftlox/protocol`). Multisig must reject
	// the same malformed symbols before signing — otherwise the protocol
	// fee is paid for a tx the chain bounces post-broadcast. Pinned cases
	// cover the regex's defining constraints: case, leading char, length.
	test.each([
		["lowercase", "card"],
		["leading digit", "1ABC"],
		["too short", "AB"],
		["too long", "ABCDEFGHIJK"],
		["special char", "AB-C"],
		["empty", ""],
	])("rejects malformed symbol (%s)", async (_label, badSymbol) => {
		const body = await buildPassingCollectionBody({ symbol: badSymbol });

		const outcome = await callCollection(body);

		expect(outcome.thrown).toBe(true);
		if (outcome.thrown) {
			expect(outcome.code).toBe("INVALID_PROTOCOL_PAYLOAD");
			expect(outcome.message).toContain("data.symbol");
			expect(outcome.message).toContain("canonical shape");
		}
	});

	// Happy-path guard. Without this test, a future refactor that wrongly
	// rejects canonical payloads would silently widen the multisig-strict
	// direction of the parity contract — a denial-of-service vector against
	// legitimate creators. The four reject-tests above only defend the
	// multisig-loose direction.
	test("accepts a canonical payload and returns a signed response", async () => {
		const body = await buildPassingCollectionBody();

		const result = await processCollectionRequest(body, buildCollectionCtx(passingSignStub));

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.signature).toBe("stub-signature");
		}
	});
});
