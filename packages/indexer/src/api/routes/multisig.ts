import { Elysia, t } from "elysia";
import { sql } from "@/db/client.ts";
import { config } from "@/config.ts";
import { createLogger } from "@/utils/logger.ts";
import { processMultisigRequest } from "@/api/services/multisig-service.ts";
import { createMultisigRateLimiter } from "@/api/services/multisig-rate-limiter.ts";
import { createMultisigNftLock } from "@/api/services/multisig-nft-lock.ts";
import { getMultisigHealth } from "@/api/services/multisig-health.ts";
import { resolveClientIp } from "@/api/middleware/client-ip.ts";
import { getNftWithCollectionRules, NFT_STATUS_LISTED } from "@/db/queries/nfts.ts";
import { calculatePaymentSplit, MULTISIG_EXPIRATION_MS } from "@/protocol/index.ts";

const log = createLogger("multisig-route");

const buyerRateLimiter = createMultisigRateLimiter(
	config.multisigRateLimitMax,
	config.multisigRateLimitWindowMs,
);

const ipRateLimiter = createMultisigRateLimiter(
	config.multisigIpRateLimitMax,
	config.multisigIpRateLimitWindowMs,
);

const nftLock = createMultisigNftLock();

type RejectionCode =
	| "MULTISIG_DISABLED"
	| "RATE_LIMITED"
	| "NFT_LOCKED"
	| "INTERNAL_ERROR"
	| string;

function logRejection(params: {
	buyer: string;
	nftId: string;
	clientIp: string;
	code: RejectionCode;
	retryAfterMs?: number;
}): void {
	const { buyer, nftId, clientIp, code, retryAfterMs } = params;
	log.warn("Multisig request rejected", {
		buyer,
		nftId,
		clientIp,
		code,
		retryAfterMs,
	});
}

function getDisabledMessage(): string {
	const health = getMultisigHealth();
	return health.disabledReason === "clock_drift"
		? "Multisig signing is temporarily disabled due to clock drift"
		: "Multisig signing is not enabled on this node";
}

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
		if (nft.listing_expires_at) {
			const expiresMs = new Date(nft.listing_expires_at).getTime();
			if (Date.now() > expiresMs) {
				set.status = 410;
				return { error: "Listing has expired" };
			}
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
			txId: nft.created_tx_id,
			seedTxId: nft.seed_created_tx_id ?? null,
		};
	}, {
		params: t.Object({ nftId: t.String({ minLength: 1, maxLength: 128 }) }),
		detail: {
			summary: "Get payment info for buying an NFT",
			description: "Returns the payment split needed to build a buy transaction. totalPrice, sellerAmount, royaltyAmount, and feeAmount are decimal Hive asset values rounded to 3 decimals. currency is HIVE or HBD. Royalties are derived from the collection royalty_pct field, which remains a whole percent value.",
		},
	})

	// POST /api/multisig — validate and multisig-sign a buy transaction
	.post("/api/multisig", async ({ body, request, server, set }) => {
		const socketIp = server?.requestIP(request)?.address;
		const clientIp = resolveClientIp(request, socketIp);
		const health = getMultisigHealth();

		if (!health.multisigEnabled) {
			set.status = 503;
			const message = getDisabledMessage();
			logRejection({
				buyer: body.buyer,
				nftId: body.nftId,
				clientIp,
				code: "MULTISIG_DISABLED",
			});
			return { ok: false, code: "MULTISIG_DISABLED", message };
		}

		// Elysia validates body schema, so buyer and nftId are typed strings.
		// Always apply rate limiting — no silent skip on empty values.
		const buyerRateResult = buyerRateLimiter.check(body.buyer);
		if (!buyerRateResult.allowed) {
			logRejection({
				buyer: body.buyer,
				nftId: body.nftId,
				clientIp,
				code: "RATE_LIMITED",
				retryAfterMs: buyerRateResult.retryAfterMs,
			});
			set.status = 429;
			return { ok: false, code: "RATE_LIMITED", message: `Rate limited. Retry after ${buyerRateResult.retryAfterMs}ms` };
		}

		const ipRateResult = ipRateLimiter.check(clientIp);
		if (!ipRateResult.allowed) {
			logRejection({
				buyer: body.buyer,
				nftId: body.nftId,
				clientIp,
				code: "RATE_LIMITED",
				retryAfterMs: ipRateResult.retryAfterMs,
			});
			set.status = 429;
			return { ok: false, code: "RATE_LIMITED", message: `Rate limited. Retry after ${ipRateResult.retryAfterMs}ms` };
		}

		// Acquire per-NFT lock to prevent two buyers co-signing the same NFT
		const lockResult = await nftLock.acquire(body.nftId, body.buyer, MULTISIG_EXPIRATION_MS);
		if (!lockResult.acquired) {
			logRejection({
				buyer: body.buyer,
				nftId: body.nftId,
				clientIp,
				code: "NFT_LOCKED",
				retryAfterMs: lockResult.retryAfterMs,
			});
			set.status = 409;
			return {
				ok: false,
				code: "NFT_LOCKED",
				message: `NFT is being purchased by another buyer. Retry after ${lockResult.retryAfterMs}ms`,
			};
		}

		try {
			const result = await processMultisigRequest(body, sql, config.hiveAccount, config.protocolId);
			if (!result.ok) {
				logRejection({
					buyer: body.buyer,
					nftId: body.nftId,
					clientIp,
					code: result.code,
				});
				set.status = 400;
			}
			return result;
		} catch (err) {
			log.error("Unexpected multisig route error", {
				buyer: body.buyer,
				nftId: body.nftId,
				clientIp,
				error: err instanceof Error ? err.message : String(err),
			});
			set.status = 500;
			return { ok: false, code: "INTERNAL_ERROR" as const, message: "Unexpected signing error" };
		} finally {
			// Always release lock — on success it expires naturally via MULTISIG_EXPIRATION_MS,
			// but on any failure (validation or unexpected) we free the NFT immediately.
			await nftLock.release(body.nftId);
		}
	}, {
		body: t.Object({
			buyer: t.String({ minLength: 3, maxLength: 16, description: "Hive username of the buyer" }),
			nftId: t.String({ minLength: 1, maxLength: 128, description: "ID of the NFT being purchased" }),
			listingId: t.String({ minLength: 1, maxLength: 128, description: "Deterministic listing ID from the list operation" }),
			listTxId: t.String({ minLength: 1, maxLength: 40, description: "Transaction ID of the list operation on Hive" }),
			transaction: t.Object({
				ref_block_num: t.Number(),
				ref_block_prefix: t.Number(),
				expiration: t.String(),
				operations: t.Array(t.Tuple([t.String(), t.Record(t.String(), t.Unknown())])),
				extensions: t.Optional(t.Array(t.Unknown())),
				signatures: t.Array(t.String()),
			}, { description: "Unsigned Hive transaction object" }),
		}),
		detail: {
			summary: "Multisig-sign a buy transaction",
			description: "Validates NFT state, payment split, and signs the transaction with the node's active key",
		},
	});
