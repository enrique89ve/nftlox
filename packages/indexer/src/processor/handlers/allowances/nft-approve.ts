import type { Queryable } from "@/db/client.ts";
import type { ParsedOperation } from "@/scanner/operation-parser.ts";
import { getNftForProcessing } from "@/db/queries/nfts.ts";
import { upsertNftAllowance, deleteNftAllowance } from "@/db/queries/allowances.ts";
import { requireString, requireBoolean, requireUsername } from "@/utils/validation.ts";
import { assertNotBurned, assertNotLent, assertNotSeed } from "@/utils/status-checks.ts";

export async function handleNftApprove(op: ParsedOperation, txn: Queryable): Promise<void> {
	const spender = requireUsername(op.data.spender, "spender");
	const instanceId = requireString(op.data.instanceId, "instanceId");
	const approved = requireBoolean(op.data.approved, "approved");

	if (spender === op.signer) throw new Error("Cannot approve yourself");

	const nft = await getNftForProcessing(instanceId, txn);
	if (!nft) throw new Error(`NFT not found: ${instanceId}`);

	assertNotBurned(nft, instanceId);
	assertNotLent(nft, instanceId);
	assertNotSeed(nft, instanceId);

	if (nft.owner !== op.signer) throw new Error(`Signer ${op.signer} is not owner of ${instanceId}`);

	if (approved) {
		await upsertNftAllowance(instanceId, op.signer, spender, op.blockNum, op.txId, txn);
	} else {
		await deleteNftAllowance(instanceId, txn);
	}
}
