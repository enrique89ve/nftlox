// F3.C — Multisig API gate.
//
// When the heartbeat daemon flags `state_meta.divergent_at_block`, this node
// must refuse to co-sign new buy or collection-creation requests. Reads stay
// open (a divergent node serves potentially-stale data, but signing locks in
// new state and is the catastrophic action).
//
// The gate must be the FIRST DB read in each entry function — even garbage
// input should be rejected with NODE_DIVERGENT instead of a parsing error.
// This is the strongest property test that the gate is positioned correctly.

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { sql } from "@/db/client.ts";
import { processBuyRequest } from "@/api/services/multisig/buy.ts";
import { processCollectionRequest } from "@/api/services/multisig/create-collection.ts";
import { isMultisigError } from "@/api/services/multisig/errors.ts";
import { setDivergentAtBlock } from "@/db/queries/state-root.ts";
import type {
	BuyLockHandle,
	CollectionLockHandle,
	MultisigBuyContext,
	MultisigCollectionContext,
	MultisigSign,
} from "@/api/services/multisig/types.ts";
import type { MultisigErrorCode } from "@/protocol/index.ts";
import { config } from "@/config.ts";

const NODE_ACCOUNT = config.hiveAccount;
const PROTOCOL_ID = config.protocolId;
const DIVERGENT_BLOCK = 100_000;

// Lock stubs that always grant the slot. The gate fires before locks are
// touched, so these never actually run during the divergent-state tests; they
// only need to compile and return success in case a clean-state test reaches
// further into the flow.
const buyLockStub: BuyLockHandle = {
	acquire: async () => ({ acquired: true }),
	release: async () => {},
};

const collectionLockStub: CollectionLockHandle = {
	acquire: async () => ({ acquired: true }),
	release: async () => {},
};

const signStub: MultisigSign = async () => {
	throw new Error("sign should not be reached when the gate fires");
};

function buildBuyCtx(): MultisigBuyContext {
	return {
		db: sql,
		nodeAccount: NODE_ACCOUNT,
		protocolId: PROTOCOL_ID,
		buyLock: buyLockStub,
		buyTxTtlMs: 60_000,
	};
}

function buildCollectionCtx(): MultisigCollectionContext {
	return {
		db: sql,
		nodeAccount: NODE_ACCOUNT,
		protocolId: PROTOCOL_ID,
		sign: signStub,
		collectionLock: collectionLockStub,
	};
}

async function clearDivergentFlag(): Promise<void> {
	await sql`UPDATE state_meta SET divergent_at_block = NULL WHERE id = 1`;
}

describe("F3.C multisig divergence gate", () => {
	beforeEach(async () => {
		// Bootstrap-level safety net: the schema is owned by other suites, so we
		// only reset the one column we mutate here. This keeps the test isolated
		// from any residual flag a prior test (or a prior run) left behind.
		await clearDivergentFlag();
	});

	afterAll(async () => {
		await clearDivergentFlag();
	});

	describe("processBuyRequest", () => {
		test("clean state: gate does not fire — failure (if any) comes from downstream validation, not NODE_DIVERGENT", async () => {
			// Garbage body. If the gate were the failure, we'd see NODE_DIVERGENT.
			// With the flag clear, the request should fall through to structure
			// validation and return INVALID_TX_STRUCTURE (or any other code that
			// is NOT NODE_DIVERGENT). The point: clean state never produces
			// NODE_DIVERGENT.
			const result = await processBuyRequest({}, buildBuyCtx());

			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.code).not.toBe("NODE_DIVERGENT");
			}
		});

		test("divergent state: returns NODE_DIVERGENT with the block number in the message", async () => {
			await setDivergentAtBlock(DIVERGENT_BLOCK);

			const result = await processBuyRequest({}, buildBuyCtx());

			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.code).toBe("NODE_DIVERGENT");
				expect(result.message).toContain(String(DIVERGENT_BLOCK));
			}
		});

		test("divergent state: garbage body returns NODE_DIVERGENT (gate runs BEFORE validation)", async () => {
			// Strong positional test: with the flag set, even a body the
			// validator would normally reject (here, an explicit non-object) must
			// be turned away by the gate. If we ever see INVALID_TX_STRUCTURE
			// here, the gate has been moved past the validator and the safety
			// invariant is broken.
			await setDivergentAtBlock(DIVERGENT_BLOCK);

			const result = await processBuyRequest("not-a-json-object", buildBuyCtx());

			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.code).toBe("NODE_DIVERGENT");
			}
		});
	});

	// processCollectionRequest does not wrap its own errors — the surrounding
	// processMultisigRequest in multisig-service.ts is what maps thrown
	// MultisigDomainError instances onto the response shape. Calling the entry
	// function directly therefore yields a thrown error, which we narrow with
	// isMultisigError to read the code without depending on the route layer.
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

	describe("processCollectionRequest", () => {
		test("clean state: gate does not fire — failure (if any) is NOT NODE_DIVERGENT", async () => {
			const outcome = await callCollection({});

			if (outcome.thrown) {
				expect(outcome.code).not.toBe("NODE_DIVERGENT");
			} else {
				expect(outcome.code).not.toBe("NODE_DIVERGENT");
			}
		});

		test("divergent state: throws MultisigError with code NODE_DIVERGENT and the block number in the message", async () => {
			await setDivergentAtBlock(DIVERGENT_BLOCK);

			const outcome = await callCollection({});

			expect(outcome.thrown).toBe(true);
			if (outcome.thrown) {
				expect(outcome.code).toBe("NODE_DIVERGENT");
				expect(outcome.message).toContain(String(DIVERGENT_BLOCK));
			}
		});

		test("divergent state: garbage body produces NODE_DIVERGENT (gate runs BEFORE validation)", async () => {
			await setDivergentAtBlock(DIVERGENT_BLOCK);

			const outcome = await callCollection("not-a-json-object");

			expect(outcome.thrown).toBe(true);
			if (outcome.thrown) {
				expect(outcome.code).toBe("NODE_DIVERGENT");
			}
		});
	});
});
