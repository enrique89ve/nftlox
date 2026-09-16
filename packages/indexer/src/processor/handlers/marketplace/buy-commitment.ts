import type { Queryable } from "@/db/client.ts";
import type { ParsedOperation } from "@/scanner/operation-parser.ts";
import {
	getAssetForProcessingForUpdate,
	ASSET_STATUS_LISTED,
	ASSET_STATUS_PENDING_SALE,
} from "@/db/queries/assets.ts";
import { requireShapedString, requireString, requireUsername } from "@/utils/validation.ts";
import { assertActionable, isListingExpired } from "@/utils/status-checks.ts";
import {
	BUY_COMMITMENT_TTL_BLOCKS,
	MAX_ACTIVE_COMMITMENTS_PER_NODE,
	isHiveTxId,
	isInstanceId,
	isListingId,
} from "@/protocol/index.ts";
import { protocolReject } from "@/processor/protocol-rejection.ts";

/**
 * Projects a settlement node's on-chain reservation of a listed Asset. The node
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
	const assetId = requireShapedString(op.data.assetId, "assetId", isInstanceId, "asset_<20 hex>_<instance>");
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

	const asset = await getAssetForProcessingForUpdate(assetId, txn);
	if (!asset) throw protocolReject(`Asset not found: ${assetId}`);
	assertActionable(asset, assetId);

	const activeReservation = asset.status === ASSET_STATUS_PENDING_SALE
		&& asset.sale_expires_block !== null
		&& asset.sale_expires_block >= op.blockNum;

	if (activeReservation) {
		throw protocolReject(
			`Asset ${assetId} already committed by ${asset.sale_settlement_node} (expires block ${asset.sale_expires_block})`,
		);
	}
	if (asset.status !== ASSET_STATUS_LISTED && !isExpiredPendingSale(asset, op.blockNum)) {
		throw protocolReject(`Asset ${assetId} is not committable (status=${asset.status})`);
	}
	if (asset.listing_id !== listingId) {
		throw protocolReject(`listingId mismatch: expected '${asset.listing_id}', got '${listingId}'`);
	}
	if (asset.listing_tx_id !== listTxId) {
		throw protocolReject(`listTxId mismatch: expected '${asset.listing_tx_id}', got '${listTxId}'`);
	}
	// A commitment on an expired listing is rejected: `handleBuy` would also
	// reject (listing expired there), but without this gate a byzantine node
	// could re-commit every ~30s to keep the Asset in `pending_sale`, blocking
	// the owner from calling `unlist` (which refuses on pending_sale). Uses
	// the same block timestamp as the router, so every indexer agrees.
	if (isListingExpired(asset.listing_expires_at, op.timestamp)) {
		throw protocolReject(`Listing expired for Asset: ${assetId}`);
	}
	if (asset.owner === buyer) {
		throw protocolReject(`Cannot reserve own Asset: ${assetId}`);
	}

	const [{ count }] = await txn<[{ count: string }]>`
		SELECT COUNT(*)::text AS count
		FROM assets
		WHERE status = ${ASSET_STATUS_PENDING_SALE}
		  AND sale_settlement_node = ${settlementNode}
		  AND sale_expires_block >= ${op.blockNum}
	`;
	const activeForNode = Number(count);
	if (activeForNode >= MAX_ACTIVE_COMMITMENTS_PER_NODE) {
		throw protocolReject(
			`Node ${settlementNode} at commitment cap (${activeForNode}/${MAX_ACTIVE_COMMITMENTS_PER_NODE})`,
		);
	}

	const expiresBlock = op.blockNum + BUY_COMMITMENT_TTL_BLOCKS;
	await txn`
		UPDATE assets
		SET status = ${ASSET_STATUS_PENDING_SALE},
		    sale_buyer = ${buyer},
		    sale_settlement_node = ${settlementNode},
		    sale_expires_block = ${expiresBlock},
		    sale_commitment_op_tx_id = ${op.txId},
		    sale_commitment_buy_tx_hash = ${buyTxHash}
		WHERE id = ${assetId}
	`;

	return [assetId];
}

function isExpiredPendingSale(
	asset: { status: string; sale_expires_block: number | null },
	currentBlock: number,
): boolean {
	// A commitment is valid while `sale_expires_block >= currentBlock` — the
	// inverse is strictly `<`. Keeping the predicate symmetric with
	// `handleBuy`'s `currentBlock > sale_expires_block` check avoids future
	// drift between the two call sites.
	return asset.status === ASSET_STATUS_PENDING_SALE
		&& asset.sale_expires_block !== null
		&& asset.sale_expires_block < currentBlock;
}
