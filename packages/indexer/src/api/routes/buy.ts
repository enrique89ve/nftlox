// POST /api/buy — two-phase NFT purchase. Buyer sends (nftId, listingId,
// listTxId, buyer, presignedTx2). The indexer:
//   1. Validates the payload + payment split + buyer signature structure.
//   2. Broadcasts tx1 (sale_lock, posting-signed by the node) to reserve the NFT.
//   3. Waits for tx1 to project into the indexer DB (confirmed or rejected).
//   4. Cosigns the buyer-presigned tx2 with the node's active key and broadcasts.
//
// The route layer here is deliberately thin: rate-limit, schema validation,
// error-code-to-HTTP mapping. The state machine lives in
// api/services/buy/index.ts::processBuy.
//
// CONFIDENCE: HIGH on the code->status mapping — mirrors how multisig.ts
// translates signing errors into 400/409/429/503/500. The only new code is
// TOO_MANY_ACTIVE_LOCKS which also maps to 429 since it's a soft-backoff
// retryable state.

import { Elysia, t } from "elysia";
import { sql } from "@/db/client.ts";
import { config } from "@/config.ts";
import { createLogger } from "@/utils/logger.ts";
import { resolveClientIp } from "@/api/middleware/client-ip.ts";
import { createMultisigRateLimiter } from "@/api/services/multisig-rate-limiter.ts";
import { BUY_TX_TTL_MS } from "@/protocol/index.ts";
import { processBuy, BUY_SERVICE_DEFAULTS } from "@/api/services/buy/index.ts";
import { BuyError } from "@/api/services/buy/errors.ts";
import type { BuyContext, BuyRequest, BuyResponse } from "@/api/services/buy/types.ts";

const log = createLogger("buy-route");

// Tighter than the multisig bucket because /api/buy actually submits an L1
// transaction on every call — we do NOT want a single buyer firing 10
// sale_locks in a row and hogging other buyers' reservations.
const BUY_BUYER_RATE_MAX = 5;
const BUY_BUYER_RATE_WINDOW_MS = 60_000;
const BUY_IP_RATE_MAX = 15;
const BUY_IP_RATE_WINDOW_MS = 60_000;

const buyerRateLimiter = createMultisigRateLimiter(BUY_BUYER_RATE_MAX, BUY_BUYER_RATE_WINDOW_MS);
const ipRateLimiter = createMultisigRateLimiter(BUY_IP_RATE_MAX, BUY_IP_RATE_WINDOW_MS);

function mapBuyErrorToStatus(code: string): number {
	switch (code) {
		case "NFT_NOT_FOUND":
			return 404;
		case "NFT_NOT_LISTED":
		case "NFT_NOT_INSTANCE":
		case "NFT_NOT_TRANSFERABLE":
		case "NFT_EXPIRED_LISTING":
		case "CANNOT_BUY_OWN":
		case "LISTING_MISMATCH":
			return 409;
		case "INVALID_PRESIGNED_TX2":
		case "INVALID_PAYMENT_SPLIT":
		case "INVALID_PROTOCOL_PAYLOAD":
		case "NODE_ACCOUNT_MISMATCH":
		case "MISSING_BUYER_SIGNATURE":
			return 400;
		case "RATE_LIMITED":
		case "TOO_MANY_ACTIVE_LOCKS":
			return 429;
			case "INDEXER_LAGGED":
			case "NODE_NOT_ACTIVE":
			case "POSTING_SIGNER_UNAVAILABLE":
			case "ACTIVE_SIGNER_UNAVAILABLE":
				return 503;
		case "TX1_BROADCAST_FAILED":
		case "TX1_REJECTED":
		case "TX1_INCLUSION_TIMEOUT":
		case "TX2_BROADCAST_FAILED":
			return 502;
		case "INTERNAL_ERROR":
		default:
			return 500;
	}
}

function toErrorResponse(err: BuyError): BuyResponse {
	const base = { ok: false as const, code: err.code, message: err.message };
	return err.retryAfterMs !== undefined ? { ...base, retryAfterMs: err.retryAfterMs } : base;
}

function buildContext(): BuyContext {
	return {
		db: sql,
		nodeAccount: config.hiveAccount,
		protocolId: config.protocolId,
		lagMaxBlocks: BUY_SERVICE_DEFAULTS.lagMaxBlocks,
		maxActiveLocksPerBuyer: BUY_SERVICE_DEFAULTS.maxActiveLocksPerBuyer,
		saleLockDurationBlocks: BUY_SERVICE_DEFAULTS.saleLockDurationBlocks,
		buyTxTtlMs: BUY_TX_TTL_MS,
	};
}

export const buyRoutes = new Elysia({ tags: ["Buy"] })
	.post("/api/buy", async ({ body, request, server, set }): Promise<BuyResponse> => {
		const socketIp = server?.requestIP(request)?.address;
		const clientIp = resolveClientIp(request, socketIp);

		// Per-buyer + per-IP rate limits. The buyer-scoped bucket targets
		// abuse from a single account; the IP bucket catches a single host
		// fanning out across many newly-minted buyer accounts. Both must
		// pass before the route touches the DB.
		const buyerRate = buyerRateLimiter.check(body.buyer);
		if (!buyerRate.allowed) {
			log.warn("Buy request rate-limited (buyer)", {
				buyer: body.buyer,
				nftId: body.nftId,
				clientIp,
				retryAfterMs: buyerRate.retryAfterMs,
			});
			set.status = 429;
			set.headers["Retry-After"] = String(Math.ceil(buyerRate.retryAfterMs / 1000));
			return {
				ok: false,
				code: "RATE_LIMITED",
				message: `Rate limited. Retry after ${buyerRate.retryAfterMs}ms`,
				retryAfterMs: buyerRate.retryAfterMs,
			};
		}

		const ipRate = ipRateLimiter.check(clientIp);
		if (!ipRate.allowed) {
			log.warn("Buy request rate-limited (IP)", {
				buyer: body.buyer,
				nftId: body.nftId,
				clientIp,
				retryAfterMs: ipRate.retryAfterMs,
			});
			set.status = 429;
			set.headers["Retry-After"] = String(Math.ceil(ipRate.retryAfterMs / 1000));
			return {
				ok: false,
				code: "RATE_LIMITED",
				message: `Rate limited. Retry after ${ipRate.retryAfterMs}ms`,
				retryAfterMs: ipRate.retryAfterMs,
			};
		}

		try {
			const ctx = buildContext();
			const response = await processBuy(ctx, body);
			return response;
		} catch (err) {
			if (err instanceof BuyError) {
				set.status = mapBuyErrorToStatus(err.code);
				if (err.retryAfterMs !== undefined) {
					set.headers["Retry-After"] = String(Math.ceil(err.retryAfterMs / 1000));
				}
				log.warn("Buy request rejected", {
					buyer: body.buyer,
					nftId: body.nftId,
					clientIp,
					code: err.code,
					retryAfterMs: err.retryAfterMs,
				});
				return toErrorResponse(err);
			}
			log.error("Unexpected /api/buy error", {
				buyer: body.buyer,
				nftId: body.nftId,
				clientIp,
				error: err instanceof Error ? err.message : String(err),
			});
			set.status = 500;
			return { ok: false, code: "INTERNAL_ERROR", message: "Unexpected error processing buy request" };
		}
	}, {
		body: t.Object({
			nftId: t.String({ minLength: 1, maxLength: 128, description: "ID of the NFT being purchased" }),
			listingId: t.String({ minLength: 1, maxLength: 128, description: "Deterministic listing ID from the list operation" }),
			listTxId: t.String({ minLength: 1, maxLength: 40, description: "Transaction ID of the list operation on Hive" }),
			buyer: t.String({ minLength: 3, maxLength: 16, description: "Hive username of the buyer" }),
			presignedTx2: t.String({
				minLength: 1,
				maxLength: 32_768,
					description: "Buyer-signed tx2 serialized as JSON. Contains transfers (seller/royalty/fee) and the buy custom_json whose required_auths is [nodeAccount]. The node cosigns with its active key and broadcasts.",
				}),
			}),
			detail: {
				summary: "Submit a buy request (two-phase, server-brokered sale_lock)",
				description: "Validates the buyer-presigned tx2, broadcasts sale_lock with the node's posting key, waits for inclusion, then cosigns tx2 with the node's active key and broadcasts. Response is returned after tx2 lands in an irreversible block.",
			},
		});

export { processBuy } from "@/api/services/buy/index.ts";
