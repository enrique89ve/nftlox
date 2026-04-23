import { getNftForProcessing, getNftWithCollectionRules, NFT_KIND_INSTANCE, NFT_STATUS_LISTED, NFT_STATUS_PENDING_SALE } from "@/db/queries/nfts.ts";
import { assertActiveSettlementNode } from "@/db/queries/nodes.ts";
import {
	ACTION_BUY_COMMITMENT,
	BUY_API_LAG_MAX_BLOCKS,
	BUY_COMMITMENT_TTL_BLOCKS,
	createPayload,
	validateHiveUsername,
	type BuyCommitmentData,
	type BuyMultisigResponse,
} from "@/protocol/index.ts";
import { requireSupportedCurrency, verifyTransfers } from "@/utils/validation.ts";
import { createMultisigError, isMultisigError } from "@/api/services/multisig/errors.ts";
import { signWithBeekeeper } from "@/api/services/beekeeper-signer.ts";
import { createLogger } from "@/utils/logger.ts";
import { Transaction, type CustomJsonOperation, type TransactionType } from "hive-tx";
import {
	extractTransfers,
	getLastOperation,
	parseBuyPayload,
	validateBuyTransactionStructureWithBuyerSig,
	validateCustomJsonOperation,
	validateTransferBody,
	validateTransferOperations,
} from "@/api/services/multisig/transaction.ts";
import { verifyBuyerSignatureOrThrow } from "@/api/services/multisig/signature-verification.ts";
import type {
	MultisigBuyContext,
	TransactionOperationInput,
	ValidatedBuyPayload,
	ValidatedBuyTransaction,
	ValidatedTransferOp,
} from "./types.ts";

const BUY_TRANSFER_MIN_COUNT = 1;
const BUY_TRANSFER_MAX_COUNT = 3;
const HIVE_BLOCK_TIME_MS = 3000;

// Wait budget for buy_commitment inclusion. Hive blocks are ~3s; 5 blocks
// covers ~15s which is generous for a single block production + indexer sync.
const COMMITMENT_INCLUSION_TIMEOUT_MS = BUY_COMMITMENT_TTL_BLOCKS * HIVE_BLOCK_TIME_MS;
const COMMITMENT_POLL_INTERVAL_MS = 500;

const log = createLogger("multisig-buy");

export async function processBuyRequest(
	rawBody: unknown,
	ctx: MultisigBuyContext,
): Promise<BuyMultisigResponse> {
	try {
		return await executeBuyRequest(rawBody, ctx);
	} catch (err) {
		if (isMultisigError(err)) {
			return {
				ok: false,
				code: err.code,
				message: err.message,
				...(err.retryAfterMs !== undefined ? { retryAfterMs: err.retryAfterMs } : {}),
			};
		}
		log.error("Unexpected buy multisig error", {
			error: err instanceof Error ? err.message : String(err),
		});
		return {
			ok: false,
			code: "INTERNAL_ERROR",
			message: "Unexpected signing error",
		};
	}
}

async function executeBuyRequest(
	rawBody: unknown,
	ctx: MultisigBuyContext,
): Promise<BuyMultisigResponse> {
	await assertSyncHealthy(ctx);
	await assertNodeActive(ctx);

	const { transaction } = validateCommonRequestShape(rawBody);
	const { validated, buyerSignature, buyer } = await parseAndValidateBuyTx(transaction, ctx);
	const { txId: buyTxId, digestBytes } = computeUnsignedTxDigest(validated);

	// Cryptographic verification of the buyer's signature BEFORE we burn an
	// on-chain buy_commitment. Without this, any attacker can feed us a random
	// 130-hex blob and force us to project `pending_sale` for the NFT — see
	// VUL-001 in AUDITORIA-CIBERSEGURIDAD-NFTLOX.md.
	await verifyBuyerSignatureOrThrow({ buyer, buyerSignature, digestBytes });

	const acquisition = await ctx.buyLock.acquire(
		validated.customJsonOperation.payload.data.nftId,
		validated.customJsonOperation.payload.data.listingId,
		validated.customJsonOperation.payload.data.listTxId,
		buyTxId,
		ctx.buyTxTtlMs,
	);
	if (!acquisition.acquired) {
		throw createMultisigError(
			"NFT_LOCKED",
			`A buy signing for NFT '${validated.customJsonOperation.payload.data.nftId}' is already in flight. Retry after ${acquisition.retryAfterMs}ms`,
			{ retryAfterMs: acquisition.retryAfterMs },
		);
	}

	try {
		const commitmentOpTxId = await broadcastBuyCommitment({
			nftId: validated.customJsonOperation.payload.data.nftId,
			listingId: validated.customJsonOperation.payload.data.listingId,
			listTxId: validated.customJsonOperation.payload.data.listTxId,
			buyer,
			buyTxHash: buyTxId,
			nodeAccount: ctx.nodeAccount,
			protocolId: ctx.protocolId,
		});

		await waitForCommitmentVictory({
			ctx,
			nftId: validated.customJsonOperation.payload.data.nftId,
			buyTxHash: buyTxId,
		});

		const fullySignedTx = addNodeSignatureToBuy(validated, buyerSignature);
		const broadcastResult = await broadcastCompletedBuy(fullySignedTx);

		log.info("Buy multisig broadcast succeeded", {
			nftId: validated.customJsonOperation.payload.data.nftId,
			buyer,
			buyTxId: broadcastResult.txId,
			commitmentOpTxId,
		});

		return {
			ok: true,
			txId: broadcastResult.txId,
			commitmentOpTxId,
		};
	} finally {
		await ctx.buyLock.release(validated.customJsonOperation.payload.data.nftId, buyTxId);
	}
}

function validateCommonRequestShape(
	raw: unknown,
): Readonly<{ readonly transaction: Record<string, unknown> }> {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
		throw createMultisigError("INVALID_TX_STRUCTURE", "Request body must be a JSON object");
	}

	const transaction = (raw as { readonly transaction?: unknown }).transaction;
	if (transaction === null || typeof transaction !== "object" || Array.isArray(transaction)) {
		throw createMultisigError("INVALID_TX_STRUCTURE", "Field 'transaction' must be an object");
	}

	return { transaction: transaction as Record<string, unknown> };
}

type ParsedBuyTx = Readonly<{
	readonly validated: ValidatedBuyTransaction;
	readonly buyerSignature: string;
	readonly buyer: string;
}>;

async function parseAndValidateBuyTx(
	tx: Record<string, unknown>,
	ctx: MultisigBuyContext,
): Promise<ParsedBuyTx> {
	const base = validateBuyTransactionStructureWithBuyerSig(tx);
	const transferInputs = base.operations.slice(0, -1);
	if (transferInputs.length < BUY_TRANSFER_MIN_COUNT || transferInputs.length > BUY_TRANSFER_MAX_COUNT) {
		throw createMultisigError(
			"INVALID_TX_STRUCTURE",
			`buy requires ${BUY_TRANSFER_MIN_COUNT}-${BUY_TRANSFER_MAX_COUNT} transfer operations before the custom_json`,
		);
	}

	const customJsonOperation = validateCustomJsonOperation(
		getLastOperation(base.operations),
		ctx.nodeAccount,
		ctx.protocolId,
		parseBuyPayload,
	);
	const buyer = deriveBuyer(transferInputs);
	const transferOperations = validateTransferOperations(transferInputs, buyer);

	await validateBuyAgainstState(customJsonOperation.payload, transferOperations, buyer, ctx);

	const validated: ValidatedBuyTransaction = {
		ref_block_num: base.ref_block_num,
		ref_block_prefix: base.ref_block_prefix,
		expiration: base.expiration,
		extensions: base.extensions,
		signatures: [],
		transferOperations,
		customJsonOperation,
	};

	return {
		validated,
		buyerSignature: base.buyerSignature,
		buyer,
	};
}

function deriveBuyer(transferInputs: ReadonlyArray<TransactionOperationInput>): string {
	const first = transferInputs[0];
	if (!first) {
		throw createMultisigError("INVALID_TX_STRUCTURE", "buy requires at least one transfer");
	}
	if (first.name !== "transfer") {
		throw createMultisigError(
			"INVALID_TX_STRUCTURE",
			`Expected 'transfer' operation, got '${String(first.name)}'`,
		);
	}

	const { from } = validateTransferBody(first.body);
	const usernameError = validateHiveUsername(from);
	if (usernameError) {
		throw createMultisigError("MISSING_BUYER_AUTH", `Invalid buyer username: ${usernameError}`);
	}

	return from;
}

async function validateBuyAgainstState(
	payload: ValidatedBuyPayload,
	transferOperations: ReadonlyArray<ValidatedTransferOp>,
	buyer: string,
	ctx: MultisigBuyContext,
): Promise<void> {
	const nft = await getNftWithCollectionRules(payload.data.nftId, ctx.db);
	if (!nft) {
		throw createMultisigError("NFT_NOT_FOUND", `NFT '${payload.data.nftId}' not found`);
	}
	if (nft.status !== NFT_STATUS_LISTED) {
		throw createMultisigError("NFT_NOT_LISTED", `NFT '${payload.data.nftId}' is not currently listed`);
	}
	if (nft.nft_type !== NFT_KIND_INSTANCE) {
		throw createMultisigError("NFT_NOT_INSTANCE", "Only instances can be bought through the marketplace");
	}
	if (buyer === nft.owner) {
		throw createMultisigError("CANNOT_BUY_OWN", "Buyer cannot purchase their own NFT");
	}
	if (!nft.transferable) {
		throw createMultisigError("NFT_NOT_TRANSFERABLE", "NFT collection is not transferable");
	}
	if (nft.listing_id !== payload.data.listingId) {
		throw createMultisigError("INVALID_PROTOCOL_PAYLOAD", "buy payload listingId does not match the current listing");
	}
	if (nft.listing_tx_id !== payload.data.listTxId) {
		throw createMultisigError("INVALID_PROTOCOL_PAYLOAD", "buy payload listTxId does not match the current listing");
	}
	assertListingAlive(nft.listing_expires_at);
	assertPaymentSplit(nft, transferOperations, payload.data.nftId, ctx.nodeAccount);
}

function assertListingAlive(listingExpiresAt: string | null): void {
	if (!listingExpiresAt) return;
	const expiresMs = Date.parse(listingExpiresAt);
	if (Number.isNaN(expiresMs)) {
		throw createMultisigError("INTERNAL_ERROR", "NFT listing expiration is invalid");
	}
	if (Date.now() >= expiresMs) {
		throw createMultisigError("NFT_EXPIRED_LISTING", "Listing has already expired");
	}
}

function assertPaymentSplit(
	nft: Awaited<ReturnType<typeof getNftWithCollectionRules>>,
	transferOperations: ReadonlyArray<ValidatedTransferOp>,
	nftId: string,
	nodeAccount: string,
): void {
	if (!nft || !nft.listing_price || !nft.listing_currency) {
		throw createMultisigError("NFT_NOT_LISTED", "NFT has no listing price or currency");
	}

	const totalPrice = Number(nft.listing_price);
	if (!Number.isFinite(totalPrice) || totalPrice <= 0) {
		throw createMultisigError("INTERNAL_ERROR", "NFT listing price is invalid");
	}

	const royaltyPct = Number(nft.royalty_pct ?? 0);
	if (!Number.isFinite(royaltyPct) || royaltyPct < 0 || royaltyPct > 50) {
		throw createMultisigError("INTERNAL_ERROR", "Collection royalty_pct is invalid");
	}

	try {
		const { split } = verifyTransfers({
			transfers: extractTransfers(transferOperations),
			seller: nft.owner,
			totalPrice,
			currency: requireSupportedCurrency(nft.listing_currency, "listing_currency"),
			royaltyPct,
			royaltyRecipient: nft.royalty_recipient ?? null,
			feeAccount: nodeAccount,
			nftId,
		});

		let expectedTransfers = 0;
		if (split.sellerAmount > 0) expectedTransfers++;
		if (split.royaltyAmount > 0 && split.royaltyRecipient) expectedTransfers++;
		if (split.feeAmount > 0) expectedTransfers++;
		if (transferOperations.length !== expectedTransfers) {
			throw new Error(`Expected exactly ${expectedTransfers} transfers, got ${transferOperations.length}`);
		}
	} catch (cause) {
		throw createMultisigError(
			"INVALID_PAYMENT_SPLIT",
			cause instanceof Error ? cause.message : "Payment split verification failed",
			{ cause },
		);
	}
}

async function assertSyncHealthy(ctx: MultisigBuyContext): Promise<void> {
	const snapshot = await readSyncState(ctx);
	const lag = snapshot.hiveHeadBlock - snapshot.lastBlock;
	if (lag > BUY_API_LAG_MAX_BLOCKS) {
		const deficit = Math.max(1, lag - BUY_API_LAG_MAX_BLOCKS + 1);
		const retryAfterMs = deficit * HIVE_BLOCK_TIME_MS;
		throw createMultisigError(
			"INDEXER_LAGGED",
			`Indexer is ${lag} blocks behind Hive HEAD (max ${BUY_API_LAG_MAX_BLOCKS}); retry in ~${retryAfterMs}ms`,
			{ retryAfterMs },
		);
	}
}

async function assertNodeActive(ctx: MultisigBuyContext): Promise<void> {
	const snapshot = await readSyncState(ctx);
	try {
		await assertActiveSettlementNode(ctx.nodeAccount, snapshot.lastBlock, ctx.db);
	} catch (cause) {
		throw createMultisigError(
			"NODE_NOT_ACTIVE",
			cause instanceof Error ? cause.message : "Settlement node is not active",
			{ cause },
		);
	}
}

type SyncStateSnapshot = Readonly<{
	readonly lastBlock: number;
	readonly hiveHeadBlock: number;
}>;

async function readSyncState(ctx: MultisigBuyContext): Promise<SyncStateSnapshot> {
	const [row] = await ctx.db`SELECT last_block, hive_head_block FROM sync_state WHERE id = 1`;
	if (!row) {
		throw createMultisigError("INTERNAL_ERROR", "sync_state row missing — indexer not initialized");
	}

	const lastBlock = Number(row.last_block);
	const hiveHeadBlock = Number(row.hive_head_block);
	if (!Number.isFinite(lastBlock) || !Number.isFinite(hiveHeadBlock)) {
		throw createMultisigError("INTERNAL_ERROR", "sync_state row has invalid block numbers");
	}

	return { lastBlock, hiveHeadBlock };
}

// ─── Commitment broadcast ───────────────────────────────

type BroadcastCommitmentInput = Readonly<{
	readonly nftId: string;
	readonly listingId: string;
	readonly listTxId: string;
	readonly buyer: string;
	readonly buyTxHash: string;
	readonly nodeAccount: string;
	readonly protocolId: string;
}>;

async function broadcastBuyCommitment(input: BroadcastCommitmentInput): Promise<string> {
	const data: BuyCommitmentData = {
		txHash: input.buyTxHash,
		nftId: input.nftId,
		listingId: input.listingId,
		listTxId: input.listTxId,
		buyer: input.buyer,
	};
	// `createPayload` already stamps the canonical PROTOCOL_VERSION; only the
	// protocol id varies per node (testnet vs mainnet) so that is the single
	// field we override here.
	const payloadJson = JSON.stringify({
		...createPayload(ACTION_BUY_COMMITMENT, data),
		protocol: input.protocolId,
	});

	const customJson: CustomJsonOperation = {
		required_auths: [input.nodeAccount],
		required_posting_auths: [],
		id: input.protocolId,
		json: payloadJson,
	};

	const tx = new Transaction();
	await tx.addOperation("custom_json", customJson);

	const { digest, txId } = tx.digest();
	const sigDigestHex = Buffer.from(digest).toString("hex");
	tx.addSignature(signWithBeekeeper(sigDigestHex));

	try {
		await tx.broadcast();
	} catch (cause) {
		throw createMultisigError(
			"COMMITMENT_BROADCAST_FAILED",
			cause instanceof Error ? cause.message : "Failed to broadcast buy_commitment",
			{ cause },
		);
	}
	return txId;
}

// ─── Wait for commitment inclusion & victory ────────────

type WaitForVictoryInput = Readonly<{
	readonly ctx: MultisigBuyContext;
	readonly nftId: string;
	readonly buyTxHash: string;
}>;

async function waitForCommitmentVictory(input: WaitForVictoryInput): Promise<void> {
	const deadline = Date.now() + COMMITMENT_INCLUSION_TIMEOUT_MS;
	const expectedHash = input.buyTxHash.toLowerCase();
	const expectedNode = input.ctx.nodeAccount;

	while (Date.now() < deadline) {
		const nft = await getNftForProcessing(input.nftId, input.ctx.db);
		if (!nft) {
			throw createMultisigError(
				"NFT_NOT_FOUND",
				`NFT '${input.nftId}' disappeared while waiting for commitment`,
			);
		}

		if (nft.status === NFT_STATUS_PENDING_SALE
			&& nft.sale_commitment_buy_tx_hash !== null) {
			const observedHash = nft.sale_commitment_buy_tx_hash.toLowerCase();
			if (observedHash === expectedHash && nft.sale_settlement_node === expectedNode) {
				return; // victory
			}
			throw createMultisigError(
				"CROSS_NODE_RESERVATION",
				`NFT '${input.nftId}' reserved by ${nft.sale_settlement_node} (commitment ${observedHash}); retry later`,
				{ retryAfterMs: COMMITMENT_INCLUSION_TIMEOUT_MS },
			);
		}

		await sleep(COMMITMENT_POLL_INTERVAL_MS);
	}

	throw createMultisigError(
		"COMMITMENT_INCLUSION_TIMEOUT",
		`buy_commitment not observed within ${COMMITMENT_INCLUSION_TIMEOUT_MS}ms`,
		{ retryAfterMs: HIVE_BLOCK_TIME_MS },
	);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Final tx signing and broadcast ─────────────────────

type UnsignedTxDigest = Readonly<{
	readonly txId: string;
	readonly digestBytes: Uint8Array;
}>;

function computeUnsignedTxDigest(validated: ValidatedBuyTransaction): UnsignedTxDigest {
	const hiveTx = buildHiveTransactionForBuy(validated, []);
	const { digest, txId } = hiveTx.digest();
	return { txId, digestBytes: digest };
}

function addNodeSignatureToBuy(
	validated: ValidatedBuyTransaction,
	buyerSignature: string,
): Transaction {
	const hiveTx = buildHiveTransactionForBuy(validated, [buyerSignature]);
	const { digest } = hiveTx.digest();
	const sigDigestHex = Buffer.from(digest).toString("hex");
	const nodeSig = signWithBeekeeper(sigDigestHex);
	hiveTx.addSignature(nodeSig);
	return hiveTx;
}

async function broadcastCompletedBuy(hiveTx: Transaction): Promise<{ readonly txId: string }> {
	const { txId } = hiveTx.digest();
	try {
		await hiveTx.broadcast();
	} catch (cause) {
		throw createMultisigError(
			"BUY_BROADCAST_FAILED",
			cause instanceof Error ? cause.message : "Failed to broadcast completed buy transaction",
			{ cause },
		);
	}
	return { txId };
}

function buildHiveTransactionForBuy(
	validated: ValidatedBuyTransaction,
	initialSignatures: ReadonlyArray<string>,
): Transaction {
	const operations: TransactionType["operations"] = [];
	for (const t of validated.transferOperations) {
		operations.push(["transfer", {
			from: t.from,
			to: t.to,
			amount: t.amount,
			memo: t.memo,
		}]);
	}
	operations.push(["custom_json", {
		required_auths: [...validated.customJsonOperation.required_auths],
		required_posting_auths: [...validated.customJsonOperation.required_posting_auths],
		id: validated.customJsonOperation.id,
		json: validated.customJsonOperation.json,
	}]);

	const tx = new Transaction();
	tx.transaction = {
		ref_block_num: validated.ref_block_num,
		ref_block_prefix: validated.ref_block_prefix,
		expiration: validated.expiration,
		operations,
		extensions: validated.extensions.filter((e): e is unknown[] => Array.isArray(e)) as TransactionType["extensions"],
		signatures: [...initialSignatures],
	};
	return tx;
}
