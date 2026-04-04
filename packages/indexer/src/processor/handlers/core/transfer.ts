import type { Queryable } from "@/db/client.ts";
import type { ParsedOperation } from "@/scanner/operation-parser.ts";
import { getNftForProcessing, updateNftOwner, updateNftBurned } from "@/db/queries/nfts.ts";
import { getCollectionRules } from "@/db/queries/collections.ts";
import { deleteNftAllowance, cleanupCollectionAllowancesIfEmpty } from "@/db/queries/allowances.ts";
import { requireString, requireUsername } from "@/utils/validation.ts";
import { assertOwnershipChangeable, assertActionable, assertNotListed, assertSeedNotDistributed, assertSeedNotReserved } from "@/utils/status-checks.ts";
import { createLogger } from "@/utils/logger.ts";
import { MAX_TRANSFER_BATCH_SIZE } from "nftlox-sdk";

const HIVE_NULL_ACCOUNT = "null";
const log = createLogger("handler:transfer");

function resolveNftIds(data: Record<string, unknown>): string[] {
	if (Array.isArray(data.nftIds)) {
		const ids = data.nftIds;
		if (ids.length === 0) throw new Error("nftIds array is empty");
		if (ids.length > MAX_TRANSFER_BATCH_SIZE) {
			throw new Error(`Too many NFTs: ${ids.length} exceeds max ${MAX_TRANSFER_BATCH_SIZE}`);
		}
		return ids.map((id, i) => requireString(id, `nftIds[${i}]`));
	}
	return [requireString(data.nftId, "nftId")];
}

export async function handleTransfer(op: ParsedOperation, txn: Queryable): Promise<void> {
	const toRaw = requireString(op.data.to, "to");
	const nftIds = resolveNftIds(op.data);
	const isBurn = toRaw === HIVE_NULL_ACCOUNT;

	if (isBurn) {
		for (const nftId of nftIds) {
			await processBurn(op, nftId, txn);
		}
		return;
	}

	const to = requireUsername(toRaw, "to");
	if (to === op.signer) throw new Error("Cannot transfer NFT to yourself");

	for (const nftId of nftIds) {
		await processSingleTransfer(op, nftId, to, txn);
	}
}

async function processSingleTransfer(op: ParsedOperation, nftId: string, to: string, txn: Queryable): Promise<void> {
	const nft = await getNftForProcessing(nftId, txn);
	if (!nft) throw new Error(`NFT not found: ${nftId}`);

	const { hadExpiredListing } = assertOwnershipChangeable(nft, nftId, op.timestamp);
	if (hadExpiredListing) {
		log.info("Transfer auto-cleared expired listing", { nftId, block: op.blockNum });
	}

	if (nft.owner !== op.signer) throw new Error(`Signer ${op.signer} is not owner of ${nftId}`);

	const rules = await getCollectionRules(nft.collection_id, txn);
	if (rules && !rules.transferable) {
		throw new Error(`Collection ${nft.collection_id} is not transferable`);
	}

	await updateNftOwner(nftId, to, op.txId, txn);
	await deleteNftAllowance(nftId, txn);
	await cleanupCollectionAllowancesIfEmpty(op.signer, nft.collection_id, txn);
}

async function processBurn(op: ParsedOperation, nftId: string, txn: Queryable): Promise<void> {
	const nft = await getNftForProcessing(nftId, txn);
	if (!nft) throw new Error(`NFT not found: ${nftId}`);

	assertActionable(nft, nftId);
	assertNotListed(nft, nftId);
	assertSeedNotDistributed(nft, nftId);
	assertSeedNotReserved(nft, nftId);

	if (nft.owner !== op.signer) throw new Error(`Signer ${op.signer} is not owner of ${nftId}`);

	const rules = await getCollectionRules(nft.collection_id, txn);
	if (rules && !rules.burnable) {
		throw new Error(`Collection ${nft.collection_id} does not allow burning`);
	}

	log.info("Burn via transfer to null", { nftId, block: op.blockNum });
	await updateNftBurned(nftId, op.signer, op.blockNum, txn);
	await deleteNftAllowance(nftId, txn);
	await cleanupCollectionAllowancesIfEmpty(op.signer, nft.collection_id, txn);
}
