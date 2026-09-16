import type { Queryable } from "@/db/client.ts";
import type { ParsedOperation } from "@/scanner/operation-parser.ts";
import {
  getAssetForProcessingForUpdate,
  updateAssetOwner,
  hardDeleteAsset,
} from "@/db/queries/assets.ts";
import type { OwnerChangeCtx, BurnCtx } from "@/db/queries/assets.ts";
import { getCollectionRules } from "@/db/queries/collections.ts";
import {
  deleteAssetAllowance,
  cleanupCollectionAllowancesIfEmpty,
} from "@/db/queries/allowances.ts";
import { requireString, requireUsername } from "@/utils/validation.ts";
import {
  assertOwnershipChangeable,
  assertActionable,
  assertNotListed,
  assertNotPendingSale,
  assertSeedNotDistributed,
} from "@/utils/status-checks.ts";
import { validateSeedProvenance } from "@/utils/seed-provenance.ts";
import { createLogger } from "@/utils/logger.ts";
import {
  ACTION_TRANSFER,
  BURN_RECIPIENT,
  MAX_TRANSFER_BATCH_SIZE,
} from "@/protocol/index.ts";
import { protocolReject } from "@/processor/protocol-rejection.ts";

const log = createLogger("handler:transfer");

function resolveAssetIds(data: Record<string, unknown>): string[] {
  if (Array.isArray(data.assetIds)) {
    const ids = data.assetIds;
    if (ids.length === 0) throw protocolReject("assetIds array is empty");
    if (ids.length > MAX_TRANSFER_BATCH_SIZE) {
      throw protocolReject(
        `Too many Assets: ${ids.length} exceeds max ${MAX_TRANSFER_BATCH_SIZE}`,
      );
    }
    return ids.map((id, i) => requireString(id, `assetIds[${i}]`));
  }
  return [requireString(data.assetId, "assetId")];
}

function assertNoFromInPayload(data: Record<string, unknown>): void {
  if (Object.prototype.hasOwnProperty.call(data, "from")) {
    throw protocolReject("Transfer payload must not include from; owner is derived from Hive signer");
  }
}

export async function handleTransfer(
  op: ParsedOperation,
  txn: Queryable,
): Promise<ReadonlyArray<string>> {
  assertNoFromInPayload(op.data);
  const toRaw = requireString(op.data.to, "to");
  const assetIds = resolveAssetIds(op.data);
  const isBurn = toRaw === BURN_RECIPIENT;

  if (isBurn) {
    for (const assetId of assetIds) {
      await processBurn(op, assetId, txn);
    }
    return assetIds;
  }

  const to = requireUsername(toRaw, "to");
  if (to === op.signer) throw protocolReject("Cannot transfer Asset to yourself");
  for (const assetId of assetIds) {
    await processSingleTransfer(op, assetId, to, txn);
  }

  return assetIds;
}

async function processSingleTransfer(
  op: ParsedOperation,
  assetId: string,
  to: string,
  txn: Queryable,
): Promise<void> {
  const asset = await getAssetForProcessingForUpdate(assetId, txn);
  if (!asset) throw protocolReject(`Asset not found: ${assetId}`);

  await validateSeedProvenance(op, asset, txn);

  // A `pending_sale` row is reserved by an active buy_commitment for another
  // buyer. Block the transfer before any state mutation so the savepoint
  // reverts cleanly.
  assertNotPendingSale(asset, assetId);

  const { hadExpiredListing } = assertOwnershipChangeable(
    asset,
    assetId,
    op.timestamp,
  );
  if (hadExpiredListing) {
    log.info("Transfer auto-cleared expired listing", {
      assetId,
      block: op.blockNum,
    });
  }

  if (asset.owner !== op.signer)
    throw protocolReject(`Signer ${op.signer} is not owner of ${assetId}`);

  const rules = await getCollectionRules(asset.collection_id, txn);
  if (rules && !rules.transferable) {
    throw protocolReject(`Collection ${asset.collection_id} is not transferable`);
  }

  const ctx: OwnerChangeCtx = {
    oldOwner: asset.owner,
    assetType: asset.asset_type,
    collectionId: asset.collection_id,
    ownerAction: ACTION_TRANSFER,
    ownerBlockNum: op.blockNum,
    wasListed: hadExpiredListing,
  };
  await updateAssetOwner(assetId, to, op.operationId, ctx, txn);
  await deleteAssetAllowance(assetId, txn);
  await cleanupCollectionAllowancesIfEmpty(op.signer, asset.collection_id, txn);
}

async function processBurn(
  op: ParsedOperation,
  assetId: string,
  txn: Queryable,
): Promise<void> {
  const asset = await getAssetForProcessingForUpdate(assetId, txn);
  if (!asset) throw protocolReject(`Asset not found: ${assetId}`);

  await validateSeedProvenance(op, asset, txn);

  // Burn destroys the Asset — incompatible with an in-flight buy reserved by a
  // buy_commitment. Reject before any state mutation so the savepoint reverts
  // cleanly.
  assertNotPendingSale(asset, assetId);

  assertActionable(asset, assetId);
  assertNotListed(asset, assetId);

  // Seeds can only be burned if no instances reference them
  if (asset.asset_type === "seed") {
    assertSeedNotDistributed(asset, assetId);
    const [row] =
      await txn`SELECT COUNT(*)::int AS count FROM assets WHERE seed_id = ${assetId}`;
    if ((row?.count ?? 0) > 0) {
      throw protocolReject(
        `Seed ${assetId} still has ${row!.count} instance(s) — burn them first`,
      );
    }
  }

  if (asset.owner !== op.signer)
    throw protocolReject(`Signer ${op.signer} is not owner of ${assetId}`);

  const rules = await getCollectionRules(asset.collection_id, txn);
  if (rules && !rules.burnable) {
    throw protocolReject(`Collection ${asset.collection_id} does not allow burning`);
  }

  log.info("Hard delete via transfer to null", { assetId, block: op.blockNum });
  const ctx: BurnCtx = {
    owner: asset.owner,
    assetType: asset.asset_type,
    collectionId: asset.collection_id,
    blockNum: op.blockNum,
    createdAt: op.timestamp,
  };
  await hardDeleteAsset(assetId, op.signer, op.txId, op.operationId, ctx, txn);
  // Ordering: cleanup queries `assets` to decide whether the owner's count in
  // this collection is zero — the burned row must already be gone or the
  // check short-circuits on its own stale presence and leaks the approval.
  await cleanupCollectionAllowancesIfEmpty(op.signer, asset.collection_id, txn);
}
