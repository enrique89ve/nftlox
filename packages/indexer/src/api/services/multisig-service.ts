/**
 * Multisig service — dispatches validated protocol actions to focused handlers.
 *
 * Beekeeper signing is serialized through a process-local FIFO queue so Hive
 * transactions from the node account are never signed concurrently.
 */

import { createSigningQueue } from "@/api/services/signing-queue.ts";
import { createMultisigCollectionLock } from "@/api/services/multisig-collection-lock.ts";
import { createMultisigNftLock, type MultisigNftLock } from "@/api/services/multisig-nft-lock.ts";
import { processBuyRequest } from "@/api/services/multisig/buy.ts";
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
	MULTISIG_EXPIRATION_MS,
	MULTISIG_LAG_MAX_BLOCKS,
	type MultisigResponse,
} from "@/protocol/index.ts";
import type {
	CollectionLockHandle,
	MultisigBaseContext,
	MultisigBuyContext,
	MultisigCollectionContext,
	NftLockHandle,
	ValidatedTransaction,
} from "@/api/services/multisig/types.ts";

const log = createLogger("multisig-service");
const signingQueue = createSigningQueue();
const collectionLock = createMultisigCollectionLock();
const nftLock: MultisigNftLock = createMultisigNftLock();

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

		const baseCtx: MultisigBaseContext = {
			db,
			nodeAccount,
			protocolId,
			sign: signValidatedTransaction,
		};

		if (action === ACTION_CREATE_COLLECTION) {
			// Per-request holder lets two concurrent signings of the same (creator,
			// symbol) fight for the lock: only the first wins, second gets
			// COLLECTION_LOCKED with retryAfterMs propagated back.
			const collectionCtx: MultisigCollectionContext = {
				...baseCtx,
				collectionLock: buildCollectionLockHandle(crypto.randomUUID()),
			};
			return await processCollectionRequest(rawBody, collectionCtx);
		}

		const buyCtx: MultisigBuyContext = {
			...baseCtx,
			nftLock: buildNftLockHandle(),
			lockExpirationMs: MULTISIG_EXPIRATION_MS,
			lagMaxBlocks: MULTISIG_LAG_MAX_BLOCKS,
		};
		return await processBuyRequest(rawBody, buyCtx);
	} catch (err) {
		return mapErrorToMultisigResponse(err, log);
	}
}

function buildCollectionLockHandle(holder: string): CollectionLockHandle {
	return {
		acquire: (creator, symbol) =>
			collectionLock.acquire(creator, symbol, holder, MULTISIG_EXPIRATION_MS),
		release: (creator, symbol) => collectionLock.release(creator, symbol, holder),
	};
}

function buildNftLockHandle(): NftLockHandle {
	return {
		acquire: (input) => nftLock.acquire(input),
		release: (nftId, buyer) => nftLock.release(nftId, buyer),
	};
}

async function signValidatedTransaction(transaction: ValidatedTransaction): Promise<MultisigResponse> {
	const signResult = await signingQueue.enqueue(() => signTransaction(transaction));
	return {
		ok: true,
		signature: signResult.signature,
		digest: signResult.digest,
		expiration: transaction.expiration,
	};
}
