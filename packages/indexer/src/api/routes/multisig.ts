import { Elysia, t } from "elysia";
import { sql } from "@/db/client.ts";
import { config } from "@/config.ts";
import { processMultisigRequest } from "@/api/services/multisig-service.ts";
import { createMultisigRateLimiter } from "@/api/services/multisig-rate-limiter.ts";
import { createMultisigNftLock } from "@/api/services/multisig-nft-lock.ts";
import { getNftWithCollectionRules, NFT_STATUS_LISTED } from "@/db/queries/nfts.ts";
import { calculatePaymentSplit, MULTISIG_EXPIRATION_MS } from "nftlox-sdk";

const rateLimiter = createMultisigRateLimiter(
	config.multisigRateLimitMax,
	config.multisigRateLimitWindowMs,
);

const nftLock = createMultisigNftLock();

export const multisigRoutes = new Elysia({ tags: ["Multisig"] })

	// GET /api/payment-info/:nftId — returns payment split for building tx
	.get("/api/payment-info/:nftId", async ({ params, set }) => {
		const nft = await getNftWithCollectionRules(params.nftId);
		if (!nft) {
			set.status = 404;
			return { error: "NFT not found" };
		}
		if (nft.status !== NFT_STATUS_LISTED) {
			set.status = 400;
			return { error: "NFT not listed" };
		}

		const totalPrice = Number(nft.listing_price);
		if (!totalPrice || !nft.listing_currency) {
			set.status = 400;
			return { error: "NFT has no valid listing price" };
		}

		const royaltyPct = Number(nft.royalty_pct ?? 0);
		const royaltyRecipient = nft.royalty_recipient ?? null;
		const currency = nft.listing_currency;

		const split = calculatePaymentSplit(totalPrice, currency, royaltyPct, royaltyRecipient, nft.owner, config.hiveAccount);

		return {
			nftId: params.nftId,
			listingId: nft.listing_id ?? "",
			listTxId: nft.listing_tx_id ?? "",
			seller: nft.owner,
			totalPrice,
			currency,
			sellerAmount: split.sellerAmount,
			royaltyAmount: split.royaltyAmount,
			royaltyRecipient: split.royaltyRecipient,
			feeAmount: split.feeAmount,
			feeAccount: split.feeAccount,
			nodeAccount: config.hiveAccount,
			birthTx: nft.birth_tx ?? "",
		};
	}, {
		params: t.Object({ nftId: t.String() }),
		detail: {
			summary: "Get payment info for buying an NFT",
			description: "Returns the payment split needed to build a buy transaction",
		},
	})

	// POST /api/multisig — validate and multisig-sign a buy transaction
	.post("/api/multisig", async ({ body, set }) => {
		if (!config.activeKey) {
			set.status = 503;
			return { ok: false, code: "MULTISIG_DISABLED", message: "Multisig signing is not enabled on this node" };
		}

		// Rate limit by buyer account
		const buyer = extractBuyerFromBody(body);
		if (buyer) {
			const rateResult = rateLimiter.check(buyer);
			if (!rateResult.allowed) {
				set.status = 429;
				return { ok: false, code: "RATE_LIMITED", message: `Rate limited. Retry after ${rateResult.retryAfterMs}ms` };
			}
		}

		// Acquire per-NFT lock to prevent two buyers co-signing the same NFT
		const nftId = extractNftIdFromBody(body);
		if (nftId && buyer) {
			const lockResult = nftLock.acquire(nftId, buyer, MULTISIG_EXPIRATION_MS);
			if (!lockResult.acquired) {
				set.status = 409;
				return {
					ok: false,
					code: "NFT_LOCKED",
					message: `NFT is being purchased by another buyer. Retry after ${lockResult.retryAfterMs}ms`,
				};
			}
		}

		const result = await processMultisigRequest(body, sql, config.hiveAccount, config.protocolId, config.activeKey);

		// Release lock on validation failure so the NFT is available again
		if (!result.ok && nftId) {
			nftLock.release(nftId);
		}

		if (!result.ok) {
			set.status = 400;
			return result;
		}
		return result;
	}, {
		body: t.Object({
			buyer: t.String({ description: "Hive username of the buyer" }),
			nftId: t.String({ description: "ID of the NFT being purchased" }),
			listingId: t.String({ description: "Deterministic listing ID from the list operation" }),
			listTxId: t.String({ description: "Transaction ID of the list operation on Hive" }),
			transaction: t.Object({
				ref_block_num: t.Number(),
				ref_block_prefix: t.Number(),
				expiration: t.String(),
				operations: t.Array(t.Any()),
				extensions: t.Optional(t.Array(t.Any())),
				signatures: t.Array(t.String()),
			}, { description: "Unsigned Hive transaction object" }),
		}),
		detail: {
			summary: "Multisig-sign a buy transaction",
			description: "Validates NFT state, payment split, and signs the transaction with the node's active key",
		},
	});

/** Safely extract `buyer` string from an unvalidated request body. */
function extractBuyerFromBody(body: unknown): string {
	if (!body || typeof body !== "object" || Array.isArray(body)) return "";
	const record = body as Record<string, unknown>;
	return typeof record.buyer === "string" ? record.buyer : "";
}

/** Safely extract `nftId` string from an unvalidated request body. */
function extractNftIdFromBody(body: unknown): string {
	if (!body || typeof body !== "object" || Array.isArray(body)) return "";
	const record = body as Record<string, unknown>;
	return typeof record.nftId === "string" ? record.nftId : "";
}
