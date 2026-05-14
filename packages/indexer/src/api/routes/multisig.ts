import { Elysia, t } from "elysia";
import { sql } from "@/db/client.ts";
import { config } from "@/config.ts";
import { createLogger } from "@/utils/logger.ts";
import { processMultisigRequest, signValidatedTransaction } from "@/api/services/multisig-service.ts";
import { processBuyRequest } from "@/api/services/multisig/buy.ts";
import { createMultisigRateLimiter } from "@/api/services/multisig-rate-limiter.ts";
import { createMultisigBuyLock } from "@/api/services/multisig-buy-lock.ts";
import { getMultisigHealth } from "@/api/services/multisig-health.ts";
import { resolveClientIp } from "@/api/middleware/client-ip.ts";
import { NFTLOX_POW_HEADER, validateMultisigPow } from "@/api/middleware/pow-validator.ts";
import { getNftWithCollectionRules, NFT_KIND_INSTANCE, NFT_STATUS_LISTED } from "@/db/queries/nfts.ts";
import { getChainTimeSnapshot } from "@/db/queries/sync.ts";
import {
	BUY_TX_TTL_MS,
	calculatePaymentSplit,
	type MultisigErrorCode,
} from "@/protocol/index.ts";
import { CHAIN_TIME_RETRY_AFTER_MS, resolveHiveHeadTimeMs } from "@/utils/chain-time.ts";
import { requireSupportedCurrency } from "@/utils/validation.ts";
import {
	IDEMPOTENCY_HEADER,
	IDEMPOTENCY_REPLAY_HEADER,
	createIdempotencyCache,
	hashIdempotencyBody,
	isValidIdempotencyKey,
} from "@/api/services/idempotency-cache.ts";

// TTL for collection-signing idempotency entries. Matches tx expiration so
// cached signatures drop with the underlying tx.
const COLLECTION_IDEMPOTENCY_TTL_MS = 120_000;

const log = createLogger("multisig-route");

const collectionRateLimiter = createMultisigRateLimiter(
	config.multisigRateLimitMax,
	config.multisigRateLimitWindowMs,
);

const ipRateLimiter = createMultisigRateLimiter(
	config.multisigIpRateLimitMax,
	config.multisigIpRateLimitWindowMs,
);

const COLLECTION_IDEMPOTENCY_MAX_ENTRIES = 10_000;
const collectionIdempotency = createIdempotencyCache({
	ttlMs: COLLECTION_IDEMPOTENCY_TTL_MS,
	maxEntries: COLLECTION_IDEMPOTENCY_MAX_ENTRIES,
});
const buyLock = createMultisigBuyLock();
const buyBuyerRateLimiter = createMultisigRateLimiter(5, 60_000);
const buyIpRateLimiter = createMultisigRateLimiter(15, 60_000);

// Only terminal responses are cached. Transient states (rate limit, lock
// contention, signer outage) must re-evaluate on retry — caching them would
// bind the client to a stale failure past its natural resolution window.
const CACHEABLE_STATUSES: ReadonlySet<number> = new Set([200, 400, 422]);

// Exhaustive HTTP status dispatch for every MultisigErrorCode. TypeScript
// enforces coverage via `Record<MultisigErrorCode, number>` so any new code
// added upstream is a compile error here until it gets a mapping.
const BUY_MULTISIG_STATUS: Record<MultisigErrorCode, number> = {
	// contention / concurrency
	NFT_LOCKED: 409,
	COLLECTION_LOCKED: 409,
	CROSS_NODE_RESERVATION: 409,
	// resource state conflicts (buy-time invariants the caller can recover)
	NFT_NOT_LISTED: 409,
	NFT_NOT_INSTANCE: 409,
	NFT_NOT_TRANSFERABLE: 409,
	NFT_EXPIRED_LISTING: 409,
	CANNOT_BUY_OWN: 409,
	SEED_HAS_INSTANCES: 409,
	// Buyer's liquid balance cannot cover the buy transfers. 409 (not 4xx-cached
	// 400/422) so a top-up + retry is re-evaluated against fresh state instead
	// of returning the cached pre-top-up failure.
	INSUFFICIENT_BALANCE: 409,
	// not found
	NFT_NOT_FOUND: 404,
	// client-shape errors
	INVALID_TX_STRUCTURE: 400,
	INVALID_PROTOCOL_PAYLOAD: 400,
	INVALID_PAYMENT_SPLIT: 400,
	NODE_ACCOUNT_MISMATCH: 400,
	MISSING_BUYER_AUTH: 400,
	BUYER_SIGNATURE_MISSING: 400,
	INVALID_BUYER_SIGNATURE: 400,
	POW_REQUIRED: 400,
	INVALID_POW: 400,
	POW_EXPIRED: 400,
	POW_REPLAYED: 400,
	// feature flag
	MULTISIG_DISABLED: 503,
	// rate limiting
	RATE_LIMITED: 429,
	// upstream / temporal unavailability
	NODE_NOT_ACTIVE: 503,
	INDEXER_LAGGED: 503,
	// F3.C — node refuses to sign while a state-root divergence with peers is
	// outstanding; clears manually after operator audit.
	NODE_DIVERGENT: 503,
	COMMITMENT_INCLUSION_TIMEOUT: 503,
	COMMITMENT_BROADCAST_FAILED: 503,
	BUY_BROADCAST_FAILED: 503,
	SIGNING_QUEUE_FULL: 503,
	SIGNING_TIMEOUT: 503,
	// fallback for unexpected internal failure
	INTERNAL_ERROR: 500,
};

type RejectionCode =
	| "MULTISIG_DISABLED"
	| "RATE_LIMITED"
	| "INTERNAL_ERROR"
	| string;

const multisigTransactionSchema = t.Object({
	ref_block_num: t.Number(),
	ref_block_prefix: t.Number(),
	expiration: t.String(),
	operations: t.Array(t.Tuple([t.String(), t.Record(t.String(), t.Unknown())])),
	extensions: t.Optional(t.Array(t.Unknown())),
	signatures: t.Array(t.String()),
}, { description: "Unsigned Hive transaction object" });

function logCollectionRejection(params: {
	creator: string | null;
	clientIp: string;
	code: RejectionCode;
	retryAfterMs?: number;
}): void {
	const { creator, clientIp, code, retryAfterMs } = params;
	log.warn("Collection multisig request rejected", {
		creator,
		clientIp,
		code,
		retryAfterMs,
	});
}

/**
 * Peeks at the unvalidated request body to extract the fee transfer sender
 * (the collection creator). Used for rate-limiting and logging BEFORE the
 * full transaction validator runs. Returns null for any malformed shape —
 * callers must treat that as "unknown creator" and fall back to IP-only
 * rate limiting. The downstream validator is the source of truth; this is
 * best-effort metadata only.
 */
function peekCollectionCreator(body: unknown): string | null {
	if (body === null || typeof body !== "object") return null;
	const tx = (body as { transaction?: unknown }).transaction;
	if (tx === null || typeof tx !== "object") return null;
	const ops = (tx as { operations?: unknown }).operations;
	if (!Array.isArray(ops) || ops.length === 0) return null;
	const first = ops[0];
	if (!Array.isArray(first) || first.length < 2) return null;
	if (first[0] !== "transfer") return null;
	const from = (first[1] as { from?: unknown })?.from;
	return typeof from === "string" && from.length > 0 ? from : null;
}

function getDisabledMessage(): string {
	const health = getMultisigHealth();
	return health.disabledReason === "clock_drift"
		? "Multisig signing is temporarily disabled due to clock drift"
		: "Multisig signing is not enabled on this node";
}

function peekBuyBuyer(body: unknown): string | null {
	if (body === null || typeof body !== "object") return null;
	const tx = (body as { transaction?: unknown }).transaction;
	if (tx === null || typeof tx !== "object") return null;
	const ops = (tx as { operations?: unknown }).operations;
	if (!Array.isArray(ops) || ops.length < 2) return null;
	const first = ops[0];
	if (!Array.isArray(first) || first.length < 2) return null;
	if (first[0] !== "transfer") return null;
	const from = (first[1] as { from?: unknown })?.from;
	return typeof from === "string" && from.length > 0 ? from : null;
}

function buildBuyContext() {
	return {
		db: sql,
		nodeAccount: config.hiveAccount,
		protocolId: config.protocolId,
		buyLock,
		buyTxTtlMs: BUY_TX_TTL_MS,
	} as const;
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
		if (nft.nft_type !== NFT_KIND_INSTANCE) {
			set.status = 400;
			return { error: "Only instances can be bought" };
		}
		if (nft.listing_expires_at) {
			const chainTimeSnapshot = await getChainTimeSnapshot();
				const chainTime = resolveHiveHeadTimeMs(chainTimeSnapshot);
			if (!chainTime.ok) {
				set.status = 503;
				set.headers["Retry-After"] = String(Math.ceil(CHAIN_TIME_RETRY_AFTER_MS / 1000));
				return { error: "Indexer chain time unavailable; retry shortly" };
			}
			const expiresMs = new Date(nft.listing_expires_at).getTime();
			if (chainTime.referenceTimeMs >= expiresMs) {
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
		const currency = requireSupportedCurrency(nft.listing_currency, "listing_currency");

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

	// POST /api/multisig/collection — validate and multisig-sign a collection creation transaction
	.post("/api/multisig/collection", async ({ body, request, server, set }) => {
		const socketIp = server?.requestIP(request)?.address;
		const clientIp = resolveClientIp(request, socketIp);
		const health = getMultisigHealth();

		// The creator is the canonical sender of the fee transfer embedded in
		// the request's transaction. We peek it at route-entry for rate-limiting
		// and log correlation; the full validator downstream is the source of
		// truth and will reject any malformed shape. When the peek fails we fall
		// back to IP-only rate limiting — a malformed request still gets a 400
		// from the validator, just without per-account throttling on this call.
		const creator = peekCollectionCreator(body);

		// Idempotency check runs before PoW so retries cost O(1) on a hit.
		// Malformed keys fall through as if absent — we don't hard-fail a
		// client that set the header with an unexpected format. Likewise, a
		// body that can't be canonicalized (shouldn't happen past Elysia's
		// schema, but defensive) degrades to "no cache" rather than 500.
		const rawIdempotencyKey = request.headers.get(IDEMPOTENCY_HEADER);
		const idempotencyKey = isValidIdempotencyKey(rawIdempotencyKey) ? rawIdempotencyKey : null;
		let bodyHash: string | null = null;
		if (idempotencyKey) {
			try {
				bodyHash = await hashIdempotencyBody(body);
			} catch (err) {
				log.warn("Idempotency body hash failed; proceeding without cache", {
					creator,
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}
		if (idempotencyKey && bodyHash) {
			const cached = collectionIdempotency.lookup(idempotencyKey, bodyHash);
			if (cached.type === "hit") {
				set.status = cached.status;
				set.headers[IDEMPOTENCY_REPLAY_HEADER] = "true";
				return cached.body;
			}
			if (cached.type === "mismatch") {
				set.status = 422;
				return {
					ok: false,
					code: "IDEMPOTENCY_MISMATCH",
					message: "Idempotency-Key reused with a different request body",
				};
			}
		}

		const storeResponse = (status: number, responseBody: unknown): void => {
			if (!idempotencyKey || !bodyHash) return;
			if (!CACHEABLE_STATUSES.has(status)) return;
			collectionIdempotency.store(idempotencyKey, bodyHash, status, responseBody);
		};

		if (!health.multisigEnabled) {
			set.status = 503;
			const message = getDisabledMessage();
			logCollectionRejection({
				creator,
				clientIp,
				code: "MULTISIG_DISABLED",
			});
			return { ok: false, code: "MULTISIG_DISABLED", message };
		}

		const powResult = await validateMultisigPow({
			body,
			header: request.headers.get(NFTLOX_POW_HEADER),
			requiredBits: config.multisigPowBits,
			ttlMs: config.multisigPowTtlMs,
			maxFutureSkewMs: config.multisigPowMaxFutureSkewMs,
			replayCacheMax: config.multisigPowReplayCacheMax,
		});
		if (!powResult.ok) {
			logCollectionRejection({
				creator,
				clientIp,
				code: powResult.code,
			});
			set.status = 429;
			return { ok: false, code: powResult.code, message: powResult.message };
		}

		// Skip per-creator rate limiting when the peek failed — the validator
		// will reject the malformed tx with a 400, and the IP limiter below
		// still throttles abusive traffic from a single source.
		if (creator !== null) {
			const creatorRateResult = collectionRateLimiter.check(creator);
			if (!creatorRateResult.allowed) {
				logCollectionRejection({
					creator,
					clientIp,
					code: "RATE_LIMITED",
					retryAfterMs: creatorRateResult.retryAfterMs,
				});
				set.status = 429;
				return { ok: false, code: "RATE_LIMITED", message: `Rate limited. Retry after ${creatorRateResult.retryAfterMs}ms` };
			}
		}

		const ipRateResult = ipRateLimiter.check(clientIp);
		if (!ipRateResult.allowed) {
			logCollectionRejection({
				creator,
				clientIp,
				code: "RATE_LIMITED",
				retryAfterMs: ipRateResult.retryAfterMs,
			});
			set.status = 429;
			return { ok: false, code: "RATE_LIMITED", message: `Rate limited. Retry after ${ipRateResult.retryAfterMs}ms` };
		}

			try {
				const result = await processMultisigRequest(body, sql, config.hiveAccount, config.protocolId);
				if (!result.ok) {
					logCollectionRejection({
						creator,
						clientIp,
						code: result.code,
						retryAfterMs: result.retryAfterMs,
					});
					if (result.code === "COLLECTION_LOCKED") {
						set.status = 409;
						if (result.retryAfterMs !== undefined) {
							// Retry-After is expressed in seconds per RFC 7231; round up so
							// clients never retry a millisecond before the lock frees.
							set.headers["Retry-After"] = String(Math.ceil(result.retryAfterMs / 1000));
						}
					} else if (
						result.code === "INDEXER_LAGGED"
						|| result.code === "NODE_NOT_ACTIVE"
						|| result.code === "NODE_DIVERGENT"
					) {
						set.status = 503;
						if (result.retryAfterMs !== undefined) {
							set.headers["Retry-After"] = String(Math.ceil(result.retryAfterMs / 1000));
						}
					} else {
						set.status = 400;
					}
				}
				storeResponse(typeof set.status === "number" ? set.status : 200, result);
				return result;
			} catch (err) {
			log.error("Unexpected collection multisig route error", {
				creator,
				clientIp,
				error: err instanceof Error ? err.message : String(err),
			});
			set.status = 500;
			return { ok: false, code: "INTERNAL_ERROR" as const, message: "Unexpected signing error" };
		}
	}, {
		body: t.Object({
			transaction: multisigTransactionSchema,
		}),
		detail: {
			summary: "Multisig-sign a collection creation transaction",
			description: "Validates the collection fee transfer and payload, then signs the create_collection custom_json with the node active key. The creator is derived from the transaction's fee transfer sender.",
		},
	})

	.post("/api/multisig/buy", async ({ body, request, server, set }) => {
		const socketIp = server?.requestIP(request)?.address;
		const clientIp = resolveClientIp(request, socketIp);
		const health = getMultisigHealth();
		const buyer = peekBuyBuyer(body);

		if (!health.multisigEnabled) {
			set.status = 503;
			const message = getDisabledMessage();
			log.warn("Buy multisig request rejected", {
				buyer,
				clientIp,
				code: "MULTISIG_DISABLED",
			});
			return { ok: false as const, code: "MULTISIG_DISABLED", message };
		}

		const powResult = await validateMultisigPow({
			body,
			header: request.headers.get(NFTLOX_POW_HEADER),
			requiredBits: config.multisigPowBits,
			ttlMs: config.multisigPowTtlMs,
			maxFutureSkewMs: config.multisigPowMaxFutureSkewMs,
			replayCacheMax: config.multisigPowReplayCacheMax,
		});
		if (!powResult.ok) {
			set.status = 429;
			log.warn("Buy multisig request rejected", {
				buyer,
				clientIp,
				code: powResult.code,
			});
			return { ok: false as const, code: powResult.code, message: powResult.message };
		}

		if (buyer !== null) {
			const buyerRate = buyBuyerRateLimiter.check(buyer);
			if (!buyerRate.allowed) {
				set.status = 429;
				log.warn("Buy multisig request rejected", {
					buyer,
					clientIp,
					code: "RATE_LIMITED",
					retryAfterMs: buyerRate.retryAfterMs,
				});
				return {
					ok: false as const,
					code: "RATE_LIMITED",
					message: `Rate limited. Retry after ${buyerRate.retryAfterMs}ms`,
					retryAfterMs: buyerRate.retryAfterMs,
				};
			}
		}

		const ipRate = buyIpRateLimiter.check(clientIp);
		if (!ipRate.allowed) {
			set.status = 429;
			log.warn("Buy multisig request rejected", {
				buyer,
				clientIp,
				code: "RATE_LIMITED",
				retryAfterMs: ipRate.retryAfterMs,
			});
			return {
				ok: false as const,
				code: "RATE_LIMITED",
				message: `Rate limited. Retry after ${ipRate.retryAfterMs}ms`,
				retryAfterMs: ipRate.retryAfterMs,
			};
		}

		try {
			const result = await processBuyRequest(body, buildBuyContext());
			if (!result.ok) {
				set.status = BUY_MULTISIG_STATUS[result.code];
				if (result.retryAfterMs !== undefined) {
					set.headers["Retry-After"] = String(Math.ceil(result.retryAfterMs / 1000));
				}
				log.warn("Buy multisig request rejected", {
					buyer,
					clientIp,
					code: result.code,
					retryAfterMs: result.retryAfterMs,
				});
			}
			return result;
		} catch (err) {
			log.error("Unexpected buy multisig route error", {
				buyer,
				clientIp,
				error: err instanceof Error ? err.message : String(err),
			});
			set.status = 500;
			return { ok: false as const, code: "INTERNAL_ERROR", message: "Unexpected signing error" };
		}
	}, {
		body: t.Object({
			transaction: multisigTransactionSchema,
		}),
		detail: {
			summary: "Multisig-sign a buy transaction",
			description: "Validates a single buy transaction (transfers plus trailing buy custom_json), then signs the custom_json with the node active key. The buyer is derived from the transfer sender.",
		},
	})
