import type { Queryable } from "@/db/client.ts";
import type { ParsedOperation } from "@/scanner/operation-parser.ts";
import {
	getNftForProcessingForUpdate,
	NFT_STATUS_LISTED,
	NFT_STATUS_PENDING_SALE,
} from "@/db/queries/nfts.ts";
import { requireShapedString, requireString, requireUsername } from "@/utils/validation.ts";
import { assertActionable, isListingExpired } from "@/utils/status-checks.ts";
import {
	BUY_COMMITMENT_TTL_BLOCKS,
	MAX_ACTIVE_COMMITMENTS_PER_NODE,
	isHiveTxId,
	isInstanceId,
	isListingId,
} from "@/protocol/index.ts";

/**
 * Projects a settlement node's on-chain reservation of a listed NFT. The node
 * broadcasts this custom_json BEFORE co-signing the buyer's buy transaction;
 * the ordering of commitments inside a Hive block is the network-wide consensus
 * on which node gets to settle, eliminating the cross-node race that would
 * otherwise leave a losing buyer with irreversibly executed transfers.
 *
 * State machine:
 *   listed                       → pending_sale (commitment wins)
 *   pending_sale + expired       → pending_sale (new commitment overrides)
 *   pending_sale + active        → reject (another commitment holds the slot)
 *   any other status             → reject
 */
export async function handleBuyCommitment(
	op: ParsedOperation,
	txn: Queryable,
): Promise<ReadonlyArray<string>> {
	const nftId = requireShapedString(op.data.nftId, "nftId", isInstanceId, "nft_<20 hex>_<instance>");
	const listingId = requireShapedString(op.data.listingId, "listingId", isListingId, "list_<32 hex>");
	const listTxId = requireShapedString(op.data.listTxId, "listTxId", isHiveTxId, "<40 lowercase hex>");
	const buyer = requireUsername(requireString(op.data.buyer, "buyer"), "buyer");
	// txHash lower-cased to canonicalize before shape-guarding — Hive nodes
	// emit lower-hex but some buyer-side libraries upcase before signing.
	const buyTxHash = requireShapedString(
		requireString(op.data.txHash, "txHash").toLowerCase(),
		"txHash",
		isHiveTxId,
		"<40 lowercase hex>",
	);

	// The node that emitted the commitment is the active-auth signer of the
	// custom_json. Eligibility as a settlement node (registered + active in
	// l2_nodes at op.blockNum) is enforced pre-handler by the action-router
	// gate that consumes NODE_SIGNED_ACTIONS from @nftlox/protocol — by the
	// time control reaches here, op.signer is guaranteed to be a live node.
	const settlementNode = requireUsername(op.signer, "settlementNode");

	const nft = await getNftForProcessingForUpdate(nftId, txn);
	if (!nft) throw new Error(`NFT not found: ${nftId}`);
	assertActionable(nft, nftId);

	const activeReservation = nft.status === NFT_STATUS_PENDING_SALE
		&& nft.sale_expires_block !== null
		&& nft.sale_expires_block >= op.blockNum;

	if (activeReservation) {
		throw new Error(
			`NFT ${nftId} already committed by ${nft.sale_settlement_node} (expires block ${nft.sale_expires_block})`,
		);
	}
	if (nft.status !== NFT_STATUS_LISTED && !isExpiredPendingSale(nft, op.blockNum)) {
		throw new Error(`NFT ${nftId} is not committable (status=${nft.status})`);
	}
	if (nft.listing_id !== listingId) {
		throw new Error(`listingId mismatch: expected '${nft.listing_id}', got '${listingId}'`);
	}
	if (nft.listing_tx_id !== listTxId) {
		throw new Error(`listTxId mismatch: expected '${nft.listing_tx_id}', got '${listTxId}'`);
	}
	// A commitment on an expired listing is rejected: `handleBuy` would also
	// reject (listing expired there), but without this gate a byzantine node
	// could re-commit every ~30s to keep the NFT in `pending_sale`, blocking
	// the owner from calling `unlist` (which refuses on pending_sale). Uses
	// the same block timestamp as the router, so every indexer agrees.
	if (isListingExpired(nft.listing_expires_at, op.timestamp)) {
		throw new Error(`Listing expired for NFT: ${nftId}`);
	}
	if (nft.owner === buyer) {
		throw new Error(`Cannot reserve own NFT: ${nftId}`);
	}

	const [{ count }] = await txn<[{ count: string }]>`
		SELECT COUNT(*)::text AS count
		FROM nfts
		WHERE status = ${NFT_STATUS_PENDING_SALE}
		  AND sale_settlement_node = ${settlementNode}
		  AND sale_expires_block >= ${op.blockNum}
	`;
	const activeForNode = Number(count);
	if (activeForNode >= MAX_ACTIVE_COMMITMENTS_PER_NODE) {
		throw new Error(
			`Node ${settlementNode} at commitment cap (${activeForNode}/${MAX_ACTIVE_COMMITMENTS_PER_NODE})`,
		);
	}

	const expiresBlock = op.blockNum + BUY_COMMITMENT_TTL_BLOCKS;
	await txn`
		UPDATE nfts
		SET status = ${NFT_STATUS_PENDING_SALE},
		    sale_buyer = ${buyer},
		    sale_settlement_node = ${settlementNode},
		    sale_expires_block = ${expiresBlock},
		    sale_commitment_op_tx_id = ${op.txId},
		    sale_commitment_buy_tx_hash = ${buyTxHash}
		WHERE id = ${nftId}
	`;

	return [nftId];
}

function isExpiredPendingSale(
	nft: { status: string; sale_expires_block: number | null },
	currentBlock: number,
): boolean {
	// A commitment is valid while `sale_expires_block >= currentBlock` — the
	// inverse is strictly `<`. Keeping the predicate symmetric with
	// `handleBuy`'s `currentBlock > sale_expires_block` check avoids future
	// drift between the two call sites.
	return nft.status === NFT_STATUS_PENDING_SALE
		&& nft.sale_expires_block !== null
		&& nft.sale_expires_block < currentBlock;
}
