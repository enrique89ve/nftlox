import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { sql } from "@/db/client.ts";
import { processCollectionRequest } from "@/api/services/multisig/create-collection.ts";
import { createMultisigCollectionLock } from "@/api/services/multisig-collection-lock.ts";
import { isMultisigError } from "@/api/services/multisig/errors.ts";
import { seedActiveSettlementNode } from "./helpers/settlement-node.ts";
import {
	ACTION_CREATE_COLLECTION,
	BUY_API_LAG_MAX_BLOCKS,
	MEMO_PREFIX_FEE_COL,
	MULTISIG_TX_MAX_EXPIRATION_MS,
	MIN_PROTOCOL_VERSION,
	PROTOCOL_COLLECTION_FEE_HBD,
	generateDeterministicCollectionId,
	generateOriginDna,
} from "@/protocol/index.ts";
import type {
	CollectionLockHandle,
	MultisigCollectionContext,
	MultisigSign,
} from "@/api/services/multisig/types.ts";
import { config } from "@/config.ts";

const NODE_ACCOUNT = config.hiveAccount;
const PROTOCOL_ID = config.protocolId;
const CREATOR = "safe.creator";
const LOCK_TTL_MS = 120_000;

const collectionLock = createMultisigCollectionLock();

const passingSignStub: MultisigSign = async () => ({
	ok: true,
	signature: "stub-signature",
	digest: "stub-digest",
	expiration: "2030-01-01T00:00:00",
});

const openLockStub: CollectionLockHandle = {
	acquire: async () => ({ acquired: true }),
	release: async () => {},
};

function buildCollectionLockHandle(holder: string): CollectionLockHandle {
	return {
		acquire: (creator) => collectionLock.acquire(creator, holder, LOCK_TTL_MS),
		release: (creator) => collectionLock.release(creator, holder),
	};
}

function buildCtx(
	sign: MultisigSign,
	collectionLockHandle: CollectionLockHandle = openLockStub,
): MultisigCollectionContext {
	return {
		db: sql,
		nodeAccount: NODE_ACCOUNT,
		protocolId: PROTOCOL_ID,
		sign,
		collectionLock: collectionLockHandle,
	};
}

function expirationFromNow(offsetMs: number): string {
	return new Date(Date.now() + offsetMs).toISOString().replace(/\.\d{3}Z$/, "");
}

async function buildCollectionBody(params: Readonly<{
	name: string;
	symbol: string;
}>): Promise<Record<string, unknown>> {
	const canonicalId = await generateDeterministicCollectionId(CREATOR, params.name, params.symbol);
	const originDna = await generateOriginDna(canonicalId);
	const data = {
		id: canonicalId,
		name: params.name,
		symbol: params.symbol,
		originDna,
		totalPotential: 5,
		maxInstances: 0,
		metadata: {
			description: "safety gate test collection",
			image: "https://example.com/safety.png",
		},
		rules: {
			transferable: true,
			burnable: false,
			royaltyPct: 0,
		},
	};

	return {
		transaction: {
			ref_block_num: 1,
			ref_block_prefix: 1,
			// Sized inside the HEAD-based multisig expiration window while leaving
			// a small margin for test execution time.
			expiration: expirationFromNow(MULTISIG_TX_MAX_EXPIRATION_MS - 5_000),
			extensions: [],
			signatures: [],
			operations: [
				[
					"transfer",
					{
						from: CREATOR,
						to: NODE_ACCOUNT,
						amount: `${PROTOCOL_COLLECTION_FEE_HBD} HBD`,
						memo: `${MEMO_PREFIX_FEE_COL}${canonicalId}`,
					},
				],
				[
					"custom_json",
					{
						id: PROTOCOL_ID,
						required_auths: [NODE_ACCOUNT],
						required_posting_auths: [],
						json: JSON.stringify({
							protocol: PROTOCOL_ID,
							version: MIN_PROTOCOL_VERSION,
							action: ACTION_CREATE_COLLECTION,
							data,
						}),
					},
				],
			],
		},
	};
}

// ~15-block finality delta between Hive HEAD and the irreversible cursor that
// the sync engine writes to last_block. Tests mirror this so the health gate
// sees realistic production state.
const HIVE_FINALITY_DELTA = 15;

async function setSyncBlocks(
	lastBlock: number,
	options: { hiveIrreversibleBlock?: number } = {},
): Promise<void> {
	const hiveIrreversibleBlock = options.hiveIrreversibleBlock ?? lastBlock;
	const hiveHeadBlock = hiveIrreversibleBlock + HIVE_FINALITY_DELTA;
	await sql`
		UPDATE sync_state
		SET last_block = ${lastBlock},
		    hive_head_block = ${hiveHeadBlock},
		    hive_irreversible_block = ${hiveIrreversibleBlock},
		    hive_head_time = NOW()
		WHERE id = 1
	`;
}

async function resetRows(): Promise<void> {
	await sql`UPDATE state_meta SET divergent_at_block = NULL WHERE id = 1`;
	await sql`DELETE FROM multisig_collection_locks WHERE creator = ${CREATOR}`;
	await sql`DELETE FROM collections WHERE creator = ${CREATOR}`;
	await sql`DELETE FROM l2_nodes WHERE account = ${NODE_ACCOUNT}`;
}

async function captureCollectionError(
	body: unknown,
	ctx: MultisigCollectionContext,
): Promise<Readonly<{ code: string; message: string }>> {
	try {
		await processCollectionRequest(body, ctx);
		throw new Error("expected processCollectionRequest to reject");
	} catch (err) {
		if (!isMultisigError(err)) throw err;
		return { code: err.code, message: err.message };
	}
}

describe("create_collection multisig safety gates", () => {
	beforeEach(async () => {
		await resetRows();
		await setSyncBlocks(100);
	});

	afterAll(async () => {
		await resetRows();
		collectionLock.destroy();
	});

	test("rejects before signing when the settlement node is not active", async () => {
		let signCalls = 0;
		const sign: MultisigSign = async () => {
			signCalls += 1;
			return {
				ok: true,
				signature: "unused",
				digest: "unused",
				expiration: "2030-01-01T00:00:00",
			};
		};
		const body = await buildCollectionBody({ name: "No Node", symbol: "NON" });

		const err = await captureCollectionError(body, buildCtx(sign));

		expect(err.code).toBe("NODE_NOT_ACTIVE");
		expect(signCalls).toBe(0);
	});

	test("rejects before signing when the indexer is lagged", async () => {
		await seedActiveSettlementNode(NODE_ACCOUNT, { registeredBlock: 100 });
		// Force a real processing backlog: chain says irreversible has advanced
		// past the indexer's cursor by more than the cap.
		await setSyncBlocks(100, { hiveIrreversibleBlock: 100 + BUY_API_LAG_MAX_BLOCKS + 1 });
		let signCalls = 0;
		const sign: MultisigSign = async () => {
			signCalls += 1;
			return {
				ok: true,
				signature: "unused",
				digest: "unused",
				expiration: "2030-01-01T00:00:00",
			};
		};
		const body = await buildCollectionBody({ name: "Lagged", symbol: "LAG" });

		const err = await captureCollectionError(body, buildCtx(sign));

		expect(err.code).toBe("INDEXER_LAGGED");
		expect(signCalls).toBe(0);
	});

	test("serializes concurrent requests by creator even when symbols differ", async () => {
		await seedActiveSettlementNode(NODE_ACCOUNT, { registeredBlock: 100 });
		const firstBody = await buildCollectionBody({ name: "Race One", symbol: "RAO" });
		const secondBody = await buildCollectionBody({ name: "Race Two", symbol: "RAT" });

		const releaseFirstSign: { current: (() => void) | null } = { current: null };
		let firstSignStartedResolve: (() => void) | null = null;
		const firstSignStarted = new Promise<void>((resolve) => {
			firstSignStartedResolve = resolve;
		});
		const firstSign: MultisigSign = async () => {
			firstSignStartedResolve?.();
			await new Promise<void>((release) => {
				releaseFirstSign.current = release;
			});
			return {
				ok: true,
				signature: "first-signature",
				digest: "first-digest",
				expiration: "2030-01-01T00:00:00",
			};
		};
		const firstPromise = processCollectionRequest(
			firstBody,
			buildCtx(firstSign, buildCollectionLockHandle("first-holder")),
		);

		await firstSignStarted;

		const secondErr = await captureCollectionError(
			secondBody,
			buildCtx(passingSignStub, buildCollectionLockHandle("second-holder")),
		);

		expect(secondErr.code).toBe("COLLECTION_LOCKED");
		const release = releaseFirstSign.current;
		if (!release) {
			throw new Error("first signing promise did not expose its release callback");
		}
		release();
		const firstResult = await firstPromise;
		expect(firstResult.ok).toBe(true);
	});
});
