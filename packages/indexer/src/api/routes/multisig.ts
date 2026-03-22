import { Elysia, t } from "elysia";
import { sql } from "@/db/client.ts";
import { config } from "@/config.ts";
import { processMultisigRequest } from "@/api/services/multisig-service.ts";
import { createMultisigRateLimiter } from "@/api/services/multisig-rate-limiter.ts";
import { getNftWithCollectionRules, NFT_STATUS_LISTED } from "@/db/queries/nfts.ts";
import { calculatePaymentSplit } from "nftlox-sdk";

const rateLimiter = createMultisigRateLimiter(
	config.multisigRateLimitMax,
	config.multisigRateLimitWindowMs,
);

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
		const feeAccount = nft.listing_marketplace || config.hiveAccount;
		const currency = nft.listing_currency;

		const split = calculatePaymentSplit(totalPrice, currency, royaltyPct, royaltyRecipient, nft.owner, feeAccount);

		return {
			nftId: params.nftId,
			seller: nft.owner,
			totalPrice,
			currency,
			sellerAmount: split.sellerAmount,
			royaltyAmount: split.royaltyAmount,
			royaltyRecipient: split.royaltyRecipient,
			feeAmount: split.feeAmount,
			feeAccount: split.feeAccount,
			nodeAccount: config.hiveAccount,
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

		const result = await processMultisigRequest(body, sql, config.hiveAccount, config.protocolId, config.activeKey);

		if (!result.ok) {
			set.status = 400;
			return result;
		}
		return result;
	}, {
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
