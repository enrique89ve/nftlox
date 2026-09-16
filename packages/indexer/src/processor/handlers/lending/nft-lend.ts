import type { Queryable } from "@/db/client.ts";
import type { ParsedOperation } from "@/scanner/operation-parser.ts";
import { getNftForProcessingForUpdate, updateNftStatus, NFT_STATUS_ACTIVE, NFT_STATUS_LENT } from "@/db/queries/nfts.ts";
import { getCollectionRules } from "@/db/queries/collections.ts";
import { insertLoan, getLoan } from "@/db/queries/loans.ts";
import { deleteNftAllowance } from "@/db/queries/allowances.ts";
import { requireString, requireUsername } from "@/utils/validation.ts";
import { assertNotSeed } from "@/utils/status-checks.ts";
import { validateSeedProvenance } from "@/utils/seed-provenance.ts";
import { protocolReject } from "@/processor/protocol-rejection.ts";

export async function handleNftLend(op: ParsedOperation, txn: Queryable): Promise<ReadonlyArray<string>> {
	const instanceId = requireString(op.data.instanceId, "instanceId");
	const borrower = requireUsername(op.data.borrower, "borrower");

	if (borrower === op.signer) throw protocolReject("Cannot lend to yourself");

	const nft = await getNftForProcessingForUpdate(instanceId, txn);
	if (!nft) throw protocolReject(`NFT not found: ${instanceId}`);

	await validateSeedProvenance(op, nft, txn);

	if (nft.status !== NFT_STATUS_ACTIVE) throw protocolReject(`NFT must be active to lend, current status: ${nft.status}`);
	assertNotSeed(nft, instanceId);
	if (nft.owner !== op.signer) throw protocolReject(`Signer ${op.signer} is not owner of ${instanceId}`);

	const rules = await getCollectionRules(nft.collection_id, txn);
	if (rules && !rules.transferable) {
		throw protocolReject(`Collection ${nft.collection_id} is not transferable — lending not allowed`);
	}

	const existingLoan = await getLoan(instanceId, txn);
	if (existingLoan) throw protocolReject(`NFT already lent: ${instanceId}`);

	await updateNftStatus(instanceId, NFT_STATUS_LENT, txn);
	await insertLoan({
		nftId: instanceId,
		lender: op.signer,
		borrower,
		operationId: op.operationId,
		blockNum: op.blockNum,
		txId: op.txId,
	}, txn);

	// Clear any existing approvals — lent NFTs cannot be transferred
	await deleteNftAllowance(instanceId, txn);

	return [instanceId];
}
