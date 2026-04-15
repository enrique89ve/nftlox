import type { Queryable } from "@/db/client.ts";
import type { ParsedOperation } from "@/scanner/operation-parser.ts";
import { getNftForProcessing } from "@/db/queries/nfts.ts";
import { upsertNftAllowance, deleteNftAllowance } from "@/db/queries/allowances.ts";
import { requireString, requireBoolean, requireUsername } from "@/utils/validation.ts";
import { assertActionable, assertNotSeed, assertNotListed } from "@/utils/status-checks.ts";

export async function handleNftApprove(op: ParsedOperation, txn: Queryable): Promise<ReadonlyArray<string>> {
	const spender = requireUsername(op.data.spender, "spender");
	const instanceId = requireString(op.data.instanceId, "instanceId");
	const approved = requireBoolean(op.data.approved, "approved");

	if (spender === op.signer) throw new Error("Cannot approve yourself");

	const nft = await getNftForProcessing(instanceId, txn);
	if (!nft) throw new Error(`NFT not found: ${instanceId}`);

	assertActionable(nft, instanceId);
	assertNotSeed(nft, instanceId);
	// An NFT in `listed` status is committed to the marketplace buy flow. Granting
	// (or revoking) a separate spender allowance at the same time creates two races
	// that contend for the same NFT: the marketplace `buy` and a potential
	// `nft_transfer_from`. The transfer-from handler also blocks listed NFTs, but
	// rejecting at approve time is the hygienic fix — the owner must unlist first
	// before delegating, making the authorization chain linear instead of ambiguous.
	assertNotListed(nft, instanceId);

	if (nft.owner !== op.signer) throw new Error(`Signer ${op.signer} is not owner of ${instanceId}`);

	if (approved) {
		await upsertNftAllowance(instanceId, op.signer, spender, op.blockNum, op.txId, txn);
	} else {
		await deleteNftAllowance(instanceId, txn);
	}

	return [instanceId];
}
