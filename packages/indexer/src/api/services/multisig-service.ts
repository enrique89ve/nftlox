/**
 * Collection multisig service.
 *
 * Buy signing now lives in api/services/multisig/buy.ts, but both flows share
 * the same process-local beekeeper queue so Hive transactions from the node
 * account are never signed concurrently.
 */

import { createSigningQueue } from "@/api/services/signing-queue.ts";
import { createMultisigCollectionLock } from "@/api/services/multisig-collection-lock.ts";
import { processCollectionRequest } from "@/api/services/multisig/create-collection.ts";
import { mapErrorToMultisigResponse } from "@/api/services/multisig/errors.ts";
import {
	detectMultisigAction,
	signTransaction,
	validateBaseRequestShape,
} from "@/api/services/multisig/transaction.ts";
import { createLogger } from "@/utils/logger.ts";
import type { Queryable } from "@/db/client.ts";
import {
	ACTION_CREATE_COLLECTION,
	type MultisigResponse,
} from "@/protocol/index.ts";
import type {
	CollectionLockHandle,
	MultisigBaseContext,
	MultisigCollectionContext,
	ValidatedTransaction,
} from "@/api/services/multisig/types.ts";

const log = createLogger("multisig-service");
const signingQueue = createSigningQueue();
const collectionLock = createMultisigCollectionLock();

const COLLECTION_LOCK_TTL_MS = 120_000;

export function getSigningQueueMetrics() {
	return signingQueue.getMetrics();
}

export async function processMultisigRequest(
	rawBody: unknown,
	db: Queryable,
	nodeAccount: string,
	protocolId: string,
): Promise<MultisigResponse> {
	try {
		const { transaction } = validateBaseRequestShape(rawBody);
		const action = detectMultisigAction(transaction, protocolId);

		if (action !== ACTION_CREATE_COLLECTION) {
			return {
				ok: false,
				code: "INVALID_TX_STRUCTURE",
				message: `Action '${action}' is not supported by /api/multisig — only create_collection remains post-0.7.0`,
			};
		}

		const baseCtx: MultisigBaseContext = {
			db,
			nodeAccount,
			protocolId,
		};
		const collectionCtx: MultisigCollectionContext = {
			...baseCtx,
			sign: signValidatedTransaction,
			collectionLock: buildCollectionLockHandle(crypto.randomUUID()),
		};
		return await processCollectionRequest(rawBody, collectionCtx);
	} catch (err) {
		return mapErrorToMultisigResponse(err, log);
	}
}

function buildCollectionLockHandle(holder: string): CollectionLockHandle {
	return {
		acquire: (creator, symbol) =>
			collectionLock.acquire(creator, symbol, holder, COLLECTION_LOCK_TTL_MS),
		release: (creator, symbol) => collectionLock.release(creator, symbol, holder),
	};
}

export async function signValidatedTransaction(transaction: ValidatedTransaction): Promise<MultisigResponse> {
	const signResult = await signingQueue.enqueue(() => signTransaction(transaction));
	return {
		ok: true,
		signature: signResult.signature,
		digest: signResult.digest,
		expiration: transaction.expiration,
	};
}
