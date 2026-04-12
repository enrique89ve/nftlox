/**
 * Multisig service — dispatches validated protocol actions to focused handlers.
 *
 * Beekeeper signing is serialized through a process-local FIFO queue so Hive
 * transactions from the node account are never signed concurrently.
 */

import { createSigningQueue } from "@/api/services/signing-queue.ts";
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
import { ACTION_CREATE_COLLECTION, type MultisigResponse } from "@/protocol/index.ts";
import type { MultisigProcessContext, ValidatedTransaction } from "@/api/services/multisig/types.ts";

const log = createLogger("multisig-service");
const signingQueue = createSigningQueue();

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
		const ctx: MultisigProcessContext = {
			db,
			nodeAccount,
			protocolId,
			sign: signValidatedTransaction,
		};

		if (action === ACTION_CREATE_COLLECTION) {
			return await processCollectionRequest(rawBody, ctx);
		}

		return await processBuyRequest(rawBody, ctx);
	} catch (err) {
		return mapErrorToMultisigResponse(err, log);
	}
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
