// SPV "Boleto Suizo" - Verification Logic
// Reuses SDK deterministic functions — zero duplication

import {
	generateDeterministicInstanceId,
	generateInstanceDna,
	generateDeterministicAccessKey,
} from "../dna";
import {
	ACTION_MINT,
	ACTION_BULK_DISTRIBUTE,
	ACTION_TRANSFER,
	ACTION_LIST,
	ACTION_BUY,
	ACTION_BUY_COMMITMENT,
	ACTION_CREATE_COLLECTION,
	ACTION_NFT_TRANSFER_FROM,
	BUY_COMMITMENT_TTL_BLOCKS,
	INSTANCE_FEE_ENABLED,
	INSTANCE_FEE_PER_N,
	INSTANCE_FEE_UNIT_HBD,
	MAX_ROYALTY_PCT,
	MEMO_PREFIX_BUY,
	MEMO_PREFIX_ROYALTY,
	MEMO_PREFIX_FEE,
	MEMO_PREFIX_FEE_COL,
	PROTOCOL_COLLECTION_FEE_HBD,
	SUPPORTED_CURRENCIES,
	calculatePaymentSplitFromUnits,
	generateDeterministicCollectionId,
	generateListingId,
	type SupportedCurrency,
} from "@nftlox/protocol";
import {
	fetchCustomJsonOperationsInRange,
	fetchTransaction,
	parseAllNftloxOperations,
	parseNftloxOperation,
	resolveOperationById,
} from "./hive-l1-client";
import type {
	HiveL1Config,
	OnChainVerificationResult,
	OwnershipVerifyParams,
	OwnershipVerificationResult,
	OwnershipCheckResult,
	ResolvedOperationById,
	ListingPriceVerifyParams,
	ListingPriceVerificationResult,
	OnChainPrice,
} from "./types";

// ============ PURE VERIFIERS (no network) ============

export interface DeterministicDerivationParams {
	seedId: string;
	instanceNumber: number;
	txId: string;
	blockNum: number;
	signer: string;
}

export interface DeterministicDerivationResult {
	instanceId: string;
	nftDna: string;
	accessKey: string;
}

/**
 * Verifies deterministic derivation of instanceId, DNA, and accessKey.
 * Async due to SHA-256 hash — no network calls.
 */
export async function verifyDeterministicDerivation(
	params: DeterministicDerivationParams,
): Promise<DeterministicDerivationResult> {
	const instanceId = await generateDeterministicInstanceId(
		params.seedId,
		params.instanceNumber,
	);
	const nftDna = await generateInstanceDna(
		params.seedId,
		params.instanceNumber,
		params.txId,
		params.blockNum,
	);
	const accessKey = await generateDeterministicAccessKey(
		nftDna,
		params.signer,
		params.txId,
	);
	return { instanceId, nftDna, accessKey };
}

// ============ GENERIC ON-CHAIN VERIFICATION ============

export interface OnChainVerifyParams {
	txId: string;
	blockNum: number;
	expectedAction: string;
	expectedSigner: string;
	l1Config: HiveL1Config;
}

/**
 * Verifies that a transaction exists on-chain with the expected action and signer.
 */
export async function verifyOperationOnChain(
	params: OnChainVerifyParams,
): Promise<OnChainVerificationResult> {
	try {
		const tx = await fetchTransaction(params.l1Config, params.txId);
		const l1Op = parseNftloxOperation(tx);

		if (!l1Op) {
			return {
				status: "not_found",
				txId: params.txId,
				blockNum: params.blockNum,
				foundOnChain: false,
				actionMatch: false,
				signerMatch: false,
				message: "No NFTLox operation found in transaction",
			};
		}

		const actionMatch = l1Op.action === params.expectedAction;
		const signerMatch = l1Op.signer === params.expectedSigner;
		const status = actionMatch && signerMatch ? "verified" : "mismatch";

		const issues: string[] = [];
		if (!actionMatch) issues.push(`action: expected ${params.expectedAction}, got ${l1Op.action}`);
		if (!signerMatch) issues.push(`signer: expected ${params.expectedSigner}, got ${l1Op.signer}`);

		return {
			status,
			txId: params.txId,
			blockNum: params.blockNum,
			foundOnChain: true,
			actionMatch,
			signerMatch,
			rawPayload: l1Op.data,
			message: status === "verified"
				? "Operation verified on-chain"
				: `Mismatch: ${issues.join(", ")}`,
		};
	} catch (err) {
		return {
			status: "error",
			txId: params.txId,
			blockNum: params.blockNum,
			foundOnChain: false,
			actionMatch: false,
			signerMatch: false,
			message: err instanceof Error ? err.message : String(err),
		};
	}
}

// ============ NFT OWNERSHIP VERIFICATION ============

type IndexerOwnershipSnapshot = Readonly<{
	owner: string;
	previousOwner: string | null;
	ownerOperationId: string;
	createdTxId: string;
	seedId: string | null;
	instanceNumber: number | null;
	nftDna: string | null;
	collectionId: string;
	collectionCreatedBlockNum: number;
	collectionCreatedTxId: string;
}>;

type DerivedOwnershipProof = Readonly<{
	txId: string;
	blockNum: number;
	operationId: string;
	eventType: string;
	expectedSigner: string;
	derivedOwner: string;
	previousOwner: string | null;
	message: string;
}>;

class OwnershipMismatchError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "OwnershipMismatchError";
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseRequiredString(value: unknown, fieldName: string): string {
	if (typeof value !== "string" || value.length === 0) {
		throw new Error(`Indexer NFT data missing ${fieldName}`);
	}
	return value;
}

function parseRequiredBoolean(value: unknown, fieldName: string): boolean {
	if (typeof value !== "boolean") {
		throw new Error(`Indexer NFT data missing ${fieldName}`);
	}
	return value;
}

function parseRequiredRecord(value: unknown, fieldName: string): Record<string, unknown> {
	if (!isRecord(value)) {
		throw new Error(`Indexer NFT data missing ${fieldName}`);
	}
	return value;
}

function parseOptionalString(value: unknown, fieldName: string): string | null {
	if (value === undefined || value === null) return null;
	if (typeof value !== "string" || value.length === 0) {
		throw new Error(`Indexer NFT data has invalid ${fieldName}`);
	}
	return value;
}

function parseNullableString(value: unknown, fieldName: string): string | null {
	if (value === null) return null;
	if (typeof value !== "string") {
		throw new Error(`Indexer NFT data has invalid ${fieldName}`);
	}
	return value;
}

function parseNullableInteger(value: unknown, fieldName: string): number | null {
	if (value === null) return null;
	if (typeof value !== "number" || !Number.isInteger(value)) {
		throw new Error(`Indexer NFT data has invalid ${fieldName}`);
	}
	return value;
}

function parseIndexerOwnershipSnapshot(raw: unknown): IndexerOwnershipSnapshot {
	if (!isRecord(raw)) {
		throw new Error("Indexer NFT data is not an object");
	}

	return {
		owner: parseRequiredString(raw.owner, "owner"),
		previousOwner: parseNullableString(raw.previous_owner, "previous_owner"),
		ownerOperationId: parseRequiredString(raw.owner_operation_id, "owner_operation_id"),
		createdTxId: parseRequiredString(
			typeof raw.created_tx_id === "string" ? raw.created_tx_id : raw.tx_id,
			"created_tx_id",
		),
		seedId: parseNullableString(raw.seed_id, "seed_id"),
		instanceNumber: parseNullableInteger(raw.instance_number, "instance_number"),
		nftDna: parseNullableString(raw.nft_dna, "nft_dna"),
		collectionId: parseRequiredString(raw.collection_id, "collection_id"),
		collectionCreatedBlockNum: parseRequiredNumber(raw.collection_created_block_num, "collection_created_block_num"),
		collectionCreatedTxId: parseRequiredString(raw.collection_created_tx_id, "collection_created_tx_id"),
	};
}

function requireNftIdInTransferPayload(data: Record<string, unknown>, nftId: string): void {
	if (typeof data.nftId === "string") {
		if (data.nftId !== nftId) {
			throw new OwnershipMismatchError(
				`Ownership operation targets NFT ${data.nftId}, expected ${nftId}`,
			);
		}
		return;
	}

	if (!Array.isArray(data.nftIds)) {
		throw new Error("Transfer payload missing nftId or nftIds");
	}

	const nftIds = data.nftIds.filter((value): value is string => typeof value === "string");
	if (!nftIds.includes(nftId)) {
		throw new OwnershipMismatchError(
			`Ownership operation does not include NFT ${nftId}`,
		);
	}
}

type BuyTransferEdge = Readonly<{
	from: string;
	to: string;
	amountUnits: number;
	currency: SupportedCurrency;
	memo: string;
}>;

type BuyListingProof = Readonly<{
	seller: string;
	price: OnChainPrice;
}>;

type CollectionBuyRules = Readonly<{
	royaltyPct: number;
	royaltyRecipient: string | null;
}>;

function parseBuyTransferEdge(raw: unknown): BuyTransferEdge | null {
	if (!isRecord(raw)) return null;
	if (raw.type !== "transfer_operation" || !isRecord(raw.value)) return null;
	const value = raw.value;
	if (
		typeof value.from !== "string" ||
		typeof value.to !== "string" ||
		typeof value.memo !== "string" ||
		typeof value.amount !== "string"
	) {
		return null;
	}
	const parsedAmount = parseTransferAmount(value.amount);
	if (!parsedAmount) return null;
	return {
		from: value.from,
		to: value.to,
		amountUnits: parsedAmount.amountUnits,
		currency: parsedAmount.currency,
		memo: value.memo,
	};
}

function extractTransferEdges(tx: { readonly operations: ReadonlyArray<unknown> }): ReadonlyArray<BuyTransferEdge> {
	return tx.operations
		.map(parseBuyTransferEdge)
		.filter((edge): edge is BuyTransferEdge => edge !== null);
}

function extractBuyTransfersForNft(
	tx: { operations: ReadonlyArray<unknown> },
	nftId: string,
): ReadonlyArray<BuyTransferEdge> {
	const expectedMemos = new Set([
		`${MEMO_PREFIX_BUY}${nftId}`,
		`${MEMO_PREFIX_ROYALTY}${nftId}`,
		`${MEMO_PREFIX_FEE}${nftId}`,
	]);

	return extractTransferEdges(tx)
		.filter((edge) => expectedMemos.has(edge.memo));
}

function parseRequiredNumber(value: unknown, fieldName: string): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new Error(`Indexer NFT data missing ${fieldName}`);
	}
	return value;
}

// Exact integer-units parser for canonical Hive amount strings ("X.XXX CUR").
// Avoids `parseFloat` so the rounding behaviour stays deterministic across
// every consumer of the buy verifier (sister to protocol's `toExactHiveUnits`).
// Returns null when the string does not match the canonical wire format.
function hiveAmountStringToUnits(rawNumeric: string): number | null {
	const match = /^(\d+)(?:\.(\d{1,3}))?$/.exec(rawNumeric);
	if (!match) return null;
	const intPart = match[1];
	const decPart = (match[2] ?? "").padEnd(3, "0");
	if (intPart === undefined) return null;
	const intNum = Number.parseInt(intPart, 10);
	const decNum = Number.parseInt(decPart, 10);
	if (!Number.isInteger(intNum) || !Number.isInteger(decNum)) return null;
	const units = intNum * 1000 + decNum;
	if (!Number.isSafeInteger(units) || units < 0) return null;
	return units;
}

function parseTransferAmount(rawAmount: string): { readonly amountUnits: number; readonly currency: SupportedCurrency } | null {
	const match = /^(\d+(?:\.\d{1,3})?)\s+([A-Z]{3,5})$/.exec(rawAmount);
	if (!match) return null;
	const currency = match[2];
	if (!currency || !isSupportedCurrency(currency)) return null;
	const amountUnits = hiveAmountStringToUnits(match[1] ?? "");
	if (amountUnits === null) return null;
	return { amountUnits, currency };
}

function unitsToCanonicalString(units: number): string {
	if (!Number.isSafeInteger(units) || units < 0) return String(units);
	const intPart = Math.floor(units / 1000);
	const decPart = units % 1000;
	return `${intPart}.${decPart.toString().padStart(3, "0")}`;
}

function computeExpectedCollectionFeeUnits(maxInstances: number): number {
	const baseUnits = hiveAmountStringToUnits(PROTOCOL_COLLECTION_FEE_HBD);
	if (baseUnits === null) {
		throw new Error(`PROTOCOL_COLLECTION_FEE_HBD is not a canonical Hive amount: ${PROTOCOL_COLLECTION_FEE_HBD}`);
	}
	if (!INSTANCE_FEE_ENABLED || maxInstances <= 0) return baseUnits;
	const unitUnits = hiveAmountStringToUnits(INSTANCE_FEE_UNIT_HBD);
	if (unitUnits === null) {
		throw new Error(`INSTANCE_FEE_UNIT_HBD is not a canonical Hive amount: ${INSTANCE_FEE_UNIT_HBD}`);
	}
	return baseUnits + unitUnits * Math.ceil(maxInstances / INSTANCE_FEE_PER_N);
}

function findExactTransfer(params: {
	readonly transfers: ReadonlyArray<BuyTransferEdge>;
	readonly from: string;
	readonly to: string;
	readonly amountUnits: number;
	readonly currency: SupportedCurrency;
	readonly memo: string;
	readonly label: string;
}): BuyTransferEdge {
	const matches = params.transfers.filter((transfer) =>
		transfer.from === params.from &&
		transfer.to === params.to &&
		transfer.currency === params.currency &&
		transfer.memo === params.memo &&
		transfer.amountUnits === params.amountUnits
	);
	if (matches.length !== 1) {
		throw new OwnershipMismatchError(
			`Buy transaction expected exactly one ${params.label}: ${unitsToCanonicalString(params.amountUnits)} ${params.currency} from ${params.from} to ${params.to} with memo ${params.memo}; found ${matches.length}`,
		);
	}
	return matches[0]!;
}

function findCollectionFeeTransfer(params: {
	readonly tx: { readonly operations: ReadonlyArray<unknown> };
	readonly collectionId: string;
	readonly nodeAccount: string;
	readonly expectedFeeUnits: number;
}): BuyTransferEdge {
	const expectedMemo = `${MEMO_PREFIX_FEE_COL}${params.collectionId}`;
	const matches = extractTransferEdges(params.tx).filter((transfer) =>
		transfer.to === params.nodeAccount &&
		transfer.currency === "HBD" &&
		transfer.memo === expectedMemo &&
		transfer.amountUnits === params.expectedFeeUnits
	);
	if (matches.length !== 1) {
		throw new OwnershipMismatchError(
			`Collection creation transaction expected exactly one fee transfer ${unitsToCanonicalString(params.expectedFeeUnits)} HBD to ${params.nodeAccount} with memo ${expectedMemo}; found ${matches.length}`,
		);
	}
	return matches[0]!;
}

async function resolveBuyListingProof(params: {
	readonly l1Config: HiveL1Config;
	readonly nftId: string;
	readonly listingId: string;
	readonly listTxId: string;
	readonly seller: string;
}): Promise<BuyListingProof> {
	const tx = await fetchTransaction(params.l1Config, params.listTxId);
	const matchingListOps = parseAllNftloxOperations(tx).filter((op) =>
		op.action === ACTION_LIST &&
		op.signer === params.seller &&
		op.data.nftId === params.nftId &&
		op.data.listingId === params.listingId
	);
	if (matchingListOps.length !== 1) {
		throw new OwnershipMismatchError(
			`Listing transaction ${params.listTxId} expected exactly one list op for NFT ${params.nftId}, listing ${params.listingId}, seller ${params.seller}; found ${matchingListOps.length}`,
		);
	}
	const listOp = matchingListOps[0]!;
	if (listOp.signer !== params.seller) {
		throw new OwnershipMismatchError(
			`Buy seller ${params.seller} does not match listing signer ${listOp.signer}`,
		);
	}

	const listedNftId = parseRequiredString(listOp.data.nftId, "list.data.nftId");
	if (listedNftId !== params.nftId) {
		throw new OwnershipMismatchError(`Listing targets NFT ${listedNftId}, expected ${params.nftId}`);
	}

	const listedListingId = parseRequiredString(listOp.data.listingId, "list.data.listingId");
	if (listedListingId !== params.listingId) {
		throw new OwnershipMismatchError(
			`Buy listingId ${params.listingId} does not match listing payload ${listedListingId}`,
		);
	}

	const listingNonce = parseRequiredString(listOp.data.listingNonce, "list.data.listingNonce");
	const expiresAt = parseRequiredNumber(listOp.data.expiresAt, "list.data.expiresAt");
	const price = parseOnChainPrice(listOp.data.price);
	if (!price) {
		throw new Error(`Listing transaction ${params.listTxId} missing valid price`);
	}
	const marketplace = typeof listOp.data.marketplace === "string" ? listOp.data.marketplace : "";
	const expectedListingId = await generateListingId({
		nftId: params.nftId,
		owner: listOp.signer,
		marketplace,
		priceAmount: price.amount,
		priceCurrency: price.currency,
		expiresAt,
		nonce: listingNonce,
	});
	if (expectedListingId !== params.listingId) {
		throw new OwnershipMismatchError(
			`listingId ${params.listingId} does not match L1 listing fields (${expectedListingId})`,
		);
	}

	return { seller: listOp.signer, price };
}

async function resolveCollectionBuyRules(params: {
	readonly l1Config: HiveL1Config;
	readonly collectionId: string;
	readonly collectionCreatedTxId: string;
	readonly collectionCreatedBlockNum: number;
}): Promise<CollectionBuyRules> {
	const tx = await fetchTransaction(params.l1Config, params.collectionCreatedTxId);
	if (tx.block_num !== params.collectionCreatedBlockNum) {
		throw new OwnershipMismatchError(
			`Collection tx ${params.collectionCreatedTxId} is in block ${tx.block_num}, proof expected ${params.collectionCreatedBlockNum}`,
		);
	}

	const matchingCollectionOps = parseAllNftloxOperations(tx).filter((op) =>
		op.action === ACTION_CREATE_COLLECTION &&
		op.data.id === params.collectionId
	);
	if (matchingCollectionOps.length !== 1) {
		throw new OwnershipMismatchError(
			`Collection transaction ${params.collectionCreatedTxId} expected exactly one create_collection for ${params.collectionId}; found ${matchingCollectionOps.length}`,
		);
	}
	const collectionOp = matchingCollectionOps[0]!;
	const name = parseRequiredString(collectionOp.data.name, "create_collection.data.name");
	const symbol = parseRequiredString(collectionOp.data.symbol, "create_collection.data.symbol");
	const maxInstances = parseRequiredNumber(collectionOp.data.maxInstances, "create_collection.data.maxInstances");
	if (!Number.isInteger(maxInstances) || maxInstances < 0) {
		throw new OwnershipMismatchError(`Collection ${params.collectionId} maxInstances is invalid: ${maxInstances}`);
	}
	const rules = parseRequiredRecord(collectionOp.data.rules, "create_collection.data.rules");
	const transferable = parseRequiredBoolean(rules.transferable, "create_collection.data.rules.transferable");
	if (!transferable) {
		throw new OwnershipMismatchError(`Collection ${params.collectionId} is not transferable`);
	}
	const royaltyPct = parseRequiredNumber(rules.royaltyPct, "create_collection.data.rules.royaltyPct");
	const royaltyRecipient = parseOptionalString(
		rules.royaltyRecipient,
		"create_collection.data.rules.royaltyRecipient",
	);
	if (royaltyPct < 0 || royaltyPct > MAX_ROYALTY_PCT) {
		throw new OwnershipMismatchError(`Collection ${params.collectionId} royaltyPct is out of range: ${royaltyPct}`);
	}
	if (royaltyPct > 0 && !royaltyRecipient) {
		throw new OwnershipMismatchError(`Collection ${params.collectionId} has royaltyPct > 0 without royaltyRecipient`);
	}

	const feeTransfer = findCollectionFeeTransfer({
		tx,
		collectionId: params.collectionId,
		nodeAccount: collectionOp.signer,
		expectedFeeUnits: computeExpectedCollectionFeeUnits(maxInstances),
	});
	const expectedCollectionId = await generateDeterministicCollectionId(feeTransfer.from, name, symbol);
	if (expectedCollectionId !== params.collectionId) {
		throw new OwnershipMismatchError(
			`Collection id ${params.collectionId} does not match L1 creator/name/symbol (${expectedCollectionId})`,
		);
	}

	return { royaltyPct, royaltyRecipient };
}

function assertBuyTransfersMatchListing(params: {
	readonly transfers: ReadonlyArray<BuyTransferEdge>;
	readonly buyTransfer: BuyTransferEdge;
	readonly buyer: string;
	readonly settlementNode: string;
	readonly nftId: string;
	readonly listing: BuyListingProof;
	readonly collectionRules: CollectionBuyRules;
}): void {
	const listingUnits = hiveAmountStringToUnits(params.listing.price.amount);
	if (listingUnits === null) {
		throw new OwnershipMismatchError(
			`Listing price is not a canonical Hive amount: ${params.listing.price.amount}`,
		);
	}
	let split: ReturnType<typeof calculatePaymentSplitFromUnits>;
	try {
		split = calculatePaymentSplitFromUnits(
			listingUnits,
			params.collectionRules.royaltyPct,
			params.collectionRules.royaltyRecipient,
			params.listing.seller,
			params.settlementNode,
		);
	} catch (cause) {
		throw new OwnershipMismatchError(
			`Unable to calculate protocol payment split: ${cause instanceof Error ? cause.message : String(cause)}`,
		);
	}

	// Presence of optional legs is decided strictly by `units > 0`, mirroring
	// the protocol primitive's contract. The royalty leg also requires a
	// non-null `effectiveRoyaltyRecipient` — `computeRoyalty` collapses
	// self-royalty (recipient === seller) to (units=0, recipient=null) so the
	// two checks are redundant in practice but kept explicit for readability.
	const hasRoyaltyLeg = split.royaltyUnits > 0 && split.effectiveRoyaltyRecipient !== null;
	const hasFeeLeg = split.feeUnits > 0;
	const expectedTransferCount = 1 + (hasRoyaltyLeg ? 1 : 0) + (hasFeeLeg ? 1 : 0);
	if (params.transfers.length !== expectedTransferCount) {
		throw new OwnershipMismatchError(
			`Buy transaction has ${params.transfers.length} payment transfers for NFT, expected ${expectedTransferCount}`,
		);
	}
	findExactTransfer({
		transfers: params.transfers,
		from: params.buyer,
		to: params.listing.seller,
		amountUnits: split.sellerUnits,
		currency: params.listing.price.currency,
		memo: `${MEMO_PREFIX_BUY}${params.nftId}`,
		label: "seller payment",
	});
	if (hasRoyaltyLeg) {
		findExactTransfer({
			transfers: params.transfers,
			from: params.buyer,
			to: split.effectiveRoyaltyRecipient!,
			amountUnits: split.royaltyUnits,
			currency: params.listing.price.currency,
			memo: `${MEMO_PREFIX_ROYALTY}${params.nftId}`,
			label: "royalty payment",
		});
	}
	if (hasFeeLeg) {
		findExactTransfer({
			transfers: params.transfers,
			from: params.buyer,
			to: params.settlementNode,
			amountUnits: split.feeUnits,
			currency: params.listing.price.currency,
			memo: `${MEMO_PREFIX_FEE}${params.nftId}`,
			label: "protocol fee",
		});
	}
}

function compareOperationIds(left: string, right: string): number | null {
	try {
		const leftId = BigInt(left);
		const rightId = BigInt(right);
		if (leftId < rightId) return -1;
		if (leftId > rightId) return 1;
		return 0;
	} catch {
		return null;
	}
}

function parseCommitmentPayload(rawJson: string, protocolId: string): Record<string, unknown> | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(rawJson);
	} catch {
		return null;
	}
	if (
		!isRecord(parsed) ||
		parsed.protocol !== protocolId ||
		parsed.action !== ACTION_BUY_COMMITMENT ||
		!isRecord(parsed.data)
	) {
		return null;
	}
	return parsed.data;
}

async function assertMatchingBuyCommitment(params: {
	readonly l1Config: HiveL1Config;
	readonly protocolId: string;
	readonly buyOperationId: string;
	readonly buyTxId: string;
	readonly buyBlockNum: number;
	readonly settlementNode: string;
	readonly nftId: string;
	readonly listingId: string;
	readonly listTxId: string;
	readonly buyer: string;
}): Promise<void> {
	const fromBlock = Math.max(0, params.buyBlockNum - BUY_COMMITMENT_TTL_BLOCKS);
	const operations = await fetchCustomJsonOperationsInRange(params.l1Config, fromBlock, params.buyBlockNum);

	for (const operation of operations) {
		if (operation.op.value.id !== params.protocolId) continue;
		if (operation.op.value.required_auths.length !== 1 || operation.op.value.required_posting_auths.length !== 0) continue;
		if (operation.op.value.required_auths[0] !== params.settlementNode) continue;
		if (operation.block > params.buyBlockNum) continue;
		const order = compareOperationIds(operation.operation_id, params.buyOperationId);
		// Non-comparable operation_id (BigInt parse failed) means HAFAH changed
		// its operation_id format. Without ordering we cannot enforce
		// commitment-precedes-buy — fail hard rather than silently accept the
		// rest of the loop, which would mask a real protocol-vs-indexer drift.
		if (order === null) {
			throw new OwnershipMismatchError(
				`HAFAH operation_id ${operation.operation_id} is not a parseable BigInt — cannot enforce commitment-before-buy ordering`,
			);
		}
		if (order >= 0) continue;

		const data = parseCommitmentPayload(operation.op.value.json, params.protocolId);
		if (!data) continue;
		const txHash = typeof data.txHash === "string" ? data.txHash.toLowerCase() : null;
		if (
			txHash === params.buyTxId.toLowerCase() &&
			data.nftId === params.nftId &&
			data.listingId === params.listingId &&
			data.listTxId === params.listTxId &&
			data.buyer === params.buyer
		) {
			return;
		}
	}

	throw new OwnershipMismatchError(
		`Buy operation ${params.buyOperationId} has no matching buy_commitment for tx ${params.buyTxId}`,
	);
}

async function deriveOwnershipProof(
	nftId: string,
	snapshot: IndexerOwnershipSnapshot,
	resolved: ResolvedOperationById,
	l1Config: HiveL1Config,
): Promise<DerivedOwnershipProof> {
	switch (resolved.action) {
		case ACTION_MINT: {
			const mintedId = parseRequiredString(resolved.data.id, "mint.data.id");
			if (mintedId !== nftId) {
				throw new OwnershipMismatchError(`Mint operation targets NFT ${mintedId}, expected ${nftId}`);
			}
			const owner = typeof resolved.data.owner === "string" ? resolved.data.owner : resolved.signer;
			if (snapshot.createdTxId !== resolved.txId) {
				throw new OwnershipMismatchError(
					`Indexer creation tx ${snapshot.createdTxId} does not match mint tx ${resolved.txId}`,
				);
			}
			return {
				txId: resolved.txId,
				blockNum: resolved.blockNum,
				operationId: resolved.operationId,
				eventType: resolved.action,
				expectedSigner: resolved.signer,
				derivedOwner: owner,
				previousOwner: null,
				message: "Verified current owner from mint operation",
			};
		}
		case ACTION_TRANSFER: {
			requireNftIdInTransferPayload(resolved.data, nftId);
			const to = parseRequiredString(resolved.data.to, "transfer.data.to");
			const from = resolved.signer;
			return {
				txId: resolved.txId,
				blockNum: resolved.blockNum,
				operationId: resolved.operationId,
				eventType: resolved.action,
				expectedSigner: from,
				derivedOwner: to,
				previousOwner: from,
				message: "Verified current owner from transfer operation",
			};
		}
		case ACTION_NFT_TRANSFER_FROM: {
			const instanceId = parseRequiredString(resolved.data.instanceId, "nft_transfer_from.data.instanceId");
			if (instanceId !== nftId) {
				throw new OwnershipMismatchError(
					`TransferFrom operation targets NFT ${instanceId}, expected ${nftId}`,
				);
			}
			const from = parseRequiredString(resolved.data.from, "nft_transfer_from.data.from");
			const to = parseRequiredString(resolved.data.to, "nft_transfer_from.data.to");
			return {
				txId: resolved.txId,
				blockNum: resolved.blockNum,
				operationId: resolved.operationId,
				eventType: resolved.action,
				expectedSigner: resolved.signer,
				derivedOwner: to,
				previousOwner: from,
				message: "Verified current owner from transfer_from operation",
			};
		}
		case ACTION_BUY: {
			const payloadNftId = parseRequiredString(resolved.data.nftId, "buy.data.nftId");
			if (payloadNftId !== nftId) {
				throw new OwnershipMismatchError(`Buy operation targets NFT ${payloadNftId}, expected ${nftId}`);
			}
			const listingId = parseRequiredString(resolved.data.listingId, "buy.data.listingId");
			const listTxId = parseRequiredString(resolved.data.listTxId, "buy.data.listTxId");

			const tx = await fetchTransaction(l1Config, resolved.txId);
			const transfers = extractBuyTransfersForNft(tx, nftId);
			if (transfers.length === 0) {
				throw new Error(`Buy transaction ${resolved.txId} does not contain payment transfers for NFT ${nftId}`);
			}

			const buyers = new Set(transfers.map(transfer => transfer.from));
			if (buyers.size !== 1) {
				throw new OwnershipMismatchError(
					`Buy transaction ${resolved.txId} has multiple buyer accounts for NFT ${nftId}`,
				);
			}

			const buyTransfer = transfers.find(transfer => transfer.memo === `${MEMO_PREFIX_BUY}${nftId}`);
			if (!buyTransfer) {
				throw new Error(`Buy transaction ${resolved.txId} is missing seller transfer for NFT ${nftId}`);
			}
			const buyer = buyTransfer.from;
			const listing = await resolveBuyListingProof({
				l1Config,
				nftId,
				listingId,
				listTxId,
				seller: buyTransfer.to,
			});
			const collectionRules = await resolveCollectionBuyRules({
				l1Config,
				collectionId: snapshot.collectionId,
				collectionCreatedTxId: snapshot.collectionCreatedTxId,
				collectionCreatedBlockNum: snapshot.collectionCreatedBlockNum,
			});
			assertBuyTransfersMatchListing({
				transfers,
				buyTransfer,
				buyer,
				settlementNode: resolved.signer,
				nftId,
				listing,
				collectionRules,
			});
			await assertMatchingBuyCommitment({
				l1Config,
				protocolId: resolved.protocolId,
				buyOperationId: resolved.operationId,
				buyTxId: resolved.txId,
				buyBlockNum: resolved.blockNum,
				settlementNode: resolved.signer,
				nftId,
				listingId,
				listTxId,
				buyer,
			});

			return {
				txId: resolved.txId,
				blockNum: resolved.blockNum,
				operationId: resolved.operationId,
				eventType: resolved.action,
				expectedSigner: resolved.signer,
				derivedOwner: buyer,
				previousOwner: listing.seller,
				message: "Verified current owner from buy operation, collection rules, listing, payment transfers, and commitment",
			};
		}
		case ACTION_BULK_DISTRIBUTE: {
			if (!snapshot.seedId || snapshot.instanceNumber === null || !snapshot.nftDna) {
				throw new Error(
					"Indexer NFT data missing seed_id, instance_number, or nft_dna required for bulk_distribute verification",
				);
			}

			const itemsRaw = resolved.data.items;
			if (!Array.isArray(itemsRaw)) {
				throw new Error("bulk_distribute payload missing items array");
			}

			const seedReferenced = itemsRaw.some((item) =>
				isRecord(item)
				&& item.seedId === snapshot.seedId
				&& typeof item.quantity === "number"
				&& item.quantity > 0,
			);
			if (!seedReferenced) {
				throw new OwnershipMismatchError(
					`bulk_distribute operation does not reference seed ${snapshot.seedId}`,
				);
			}

			const derivedInstanceId = await generateDeterministicInstanceId(
				snapshot.seedId,
				snapshot.instanceNumber,
			);
			if (derivedInstanceId !== nftId) {
				throw new OwnershipMismatchError(
					`Deterministic instanceId ${derivedInstanceId} does not match NFT ${nftId}`,
				);
			}

			const derivedNftDna = await generateInstanceDna(
				snapshot.seedId,
				snapshot.instanceNumber,
				resolved.txId,
				resolved.blockNum,
			);
			if (derivedNftDna !== snapshot.nftDna) {
				throw new OwnershipMismatchError(
					"NFT DNA does not match deterministic bulk_distribute derivation",
				);
			}

			if (snapshot.createdTxId !== resolved.txId) {
				throw new OwnershipMismatchError(
					`Indexer creation tx ${snapshot.createdTxId} does not match bulk_distribute tx ${resolved.txId}`,
				);
			}

			const owner = typeof resolved.data.to === "string" ? resolved.data.to : resolved.signer;
			return {
				txId: resolved.txId,
				blockNum: resolved.blockNum,
				operationId: resolved.operationId,
				eventType: resolved.action,
				expectedSigner: resolved.signer,
				derivedOwner: owner,
				previousOwner: null,
				message: "Verified current owner from bulk_distribute edge and deterministic instance fields",
			};
		}
		default:
			throw new OwnershipMismatchError(
				`owner_operation_id points to non-ownership action ${resolved.action}`,
			);
	}
}

/**
 * Verifies the current ownership edge using owner_operation_id and the
 * dedicated proof endpoint. This checks the exact operation that made the
 * reported owner become the current owner.
 */
export async function verifyNftOwnership(
	params: OwnershipVerifyParams,
): Promise<OwnershipVerificationResult> {
	const startTime = Date.now();

	try {
		// Step 1: Fetch minimal proof data from indexer
		const nftResponse = await fetch(
			`${params.indexerBaseUrl}/api/nfts/${params.nftId}/proof`,
		);
		if (!nftResponse.ok) {
			return buildOwnershipResult("error", startTime, {
				nftId: params.nftId,
				expectedOwner: params.expectedOwner,
				message: `Indexer returned ${nftResponse.status} for NFT proof ${params.nftId}`,
			});
		}

		const snapshot = parseIndexerOwnershipSnapshot(await nftResponse.json());
		const resolved = await resolveOperationById({
			l1Config: params.l1Config,
			operationId: snapshot.ownerOperationId,
		});

		let proof: DerivedOwnershipProof;
		try {
			proof = await deriveOwnershipProof(params.nftId, snapshot, resolved, params.l1Config);
		} catch (err) {
			if (err instanceof OwnershipMismatchError) {
				return {
					status: "mismatch",
					nftId: params.nftId,
					reportedOwner: snapshot.owner,
					expectedOwner: params.expectedOwner,
					proofsChecked: 1,
					checks: [{
						txId: resolved.txId,
						blockNum: resolved.blockNum,
						eventType: resolved.action,
						expectedSigner: resolved.signer,
						l1Status: "mismatch",
						message: err.message,
						operationId: resolved.operationId,
					}],
					verifiedAt: Date.now(),
					durationMs: Date.now() - startTime,
					message: err.message,
				};
			}
			throw err;
		}

		const ownerMatchesExpected = proof.derivedOwner === params.expectedOwner;
		const indexerOwnerMatchesL1 = snapshot.owner === proof.derivedOwner;
		const previousOwnerMatches = snapshot.previousOwner === proof.previousOwner;
		const verified = ownerMatchesExpected && indexerOwnerMatchesL1 && previousOwnerMatches;

		const issues: string[] = [];
		if (!ownerMatchesExpected) {
			issues.push(`L1 owner is ${proof.derivedOwner}, expected ${params.expectedOwner}`);
		}
		if (!indexerOwnerMatchesL1) {
			issues.push(`indexer reports ${snapshot.owner}, L1 derives ${proof.derivedOwner}`);
		}
		if (!previousOwnerMatches) {
			issues.push(
				`indexer previous_owner is ${snapshot.previousOwner ?? "null"}, L1 derives ${proof.previousOwner ?? "null"}`,
			);
		}

		const check: OwnershipCheckResult = {
			txId: proof.txId,
			blockNum: proof.blockNum,
			eventType: proof.eventType,
			expectedSigner: proof.expectedSigner,
			l1Status: verified ? "verified" : "mismatch",
			message: verified ? proof.message : issues.join("; "),
			operationId: proof.operationId,
			previousOwner: proof.previousOwner,
			derivedOwner: proof.derivedOwner,
		};

		return {
			status: verified ? "verified" : "mismatch",
			nftId: params.nftId,
			reportedOwner: snapshot.owner,
			expectedOwner: params.expectedOwner,
			proofsChecked: 1,
			checks: [check],
			verifiedAt: Date.now(),
			durationMs: Date.now() - startTime,
			message: verified
				? `Ownership verified via ${proof.eventType} operation ${proof.operationId}`
				: issues.join("; "),
		};
	} catch (err) {
		return buildOwnershipResult("error", startTime, {
			nftId: params.nftId,
			expectedOwner: params.expectedOwner,
			message: err instanceof Error ? err.message : String(err),
		});
	}
}

interface BuildOwnershipPartial {
	nftId: string;
	expectedOwner: string;
	reportedOwner?: string;
	message: string;
}

function buildOwnershipResult(
	status: OwnershipVerificationResult["status"],
	startTime: number,
	partial: BuildOwnershipPartial,
): OwnershipVerificationResult {
	return {
		status,
		nftId: partial.nftId,
		reportedOwner: partial.reportedOwner ?? "",
		expectedOwner: partial.expectedOwner,
		proofsChecked: 0,
		checks: [],
		verifiedAt: Date.now(),
		durationMs: Date.now() - startTime,
		message: partial.message,
	};
}

// ============ LISTING PRICE VERIFICATION ============

/** Hive amounts use 3 decimal places — tolerance for floating-point comparison */
const HIVE_AMOUNT_TOLERANCE = 0.0005;

const SUPPORTED_CURRENCIES_SET = new Set<string>(SUPPORTED_CURRENCIES);

function isSupportedCurrency(value: string): value is SupportedCurrency {
	return SUPPORTED_CURRENCIES_SET.has(value.toUpperCase());
}

/**
 * Runtime-validates the on-chain price object from a list payload.
 * Returns null if the data is missing or malformed.
 */
function parseOnChainPrice(raw: unknown): OnChainPrice | null {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
	const obj = raw as Record<string, unknown>;
	if (typeof obj.amount !== "string" || typeof obj.currency !== "string") return null;
	if (!isSupportedCurrency(obj.currency)) return null;
	const parsed = parseFloat(obj.amount);
	if (Number.isNaN(parsed) || parsed < 0) return null;
	return { amount: obj.amount, currency: obj.currency.toUpperCase() as SupportedCurrency };
}

type BuildListingPartial = {
	readonly blockNum: number;
	readonly onChainPrice?: OnChainPrice | null;
	readonly onChainSeller?: string | null;
	readonly onChainNftId?: string | null;
	readonly message: string;
};

function buildListingResult(
	status: ListingPriceVerificationResult["status"],
	listTxId: string,
	partial: BuildListingPartial,
): ListingPriceVerificationResult {
	return {
		status,
		listTxId,
		blockNum: partial.blockNum,
		onChainPrice: partial.onChainPrice ?? null,
		onChainSeller: partial.onChainSeller ?? null,
		onChainNftId: partial.onChainNftId ?? null,
		message: partial.message,
	};
}

/**
 * Verifies that the listing price reported by a node matches the on-chain listing tx.
 * Protects the buyer against a malicious node inflating the price.
 *
 * Flow: reads the list tx directly from Hive L1 (public RPC, not the node),
 * extracts price/seller/nftId from the custom_json payload, and compares.
 */
export async function verifyListingPrice(
	params: ListingPriceVerifyParams,
): Promise<ListingPriceVerificationResult> {
	try {
		const tx = await fetchTransaction(params.l1Config, params.listTxId);
		const l1Op = parseNftloxOperation(tx);

		if (!l1Op) {
			return buildListingResult("not_found", params.listTxId, {
				blockNum: tx.block_num,
				message: "No NFTLox operation found in listing transaction",
			});
		}

		if (l1Op.action !== ACTION_LIST) {
			return buildListingResult("mismatch", params.listTxId, {
				blockNum: tx.block_num,
				onChainSeller: l1Op.signer,
				message: `Expected 'list' action, found '${l1Op.action}'`,
			});
		}

		const onChainPrice = parseOnChainPrice(l1Op.data.price);
		const onChainNftId = typeof l1Op.data.nftId === "string" ? l1Op.data.nftId : null;
		const onChainSeller = l1Op.signer;

		if (!onChainPrice || !onChainNftId) {
			return buildListingResult("error", params.listTxId, {
				blockNum: tx.block_num,
				onChainSeller,
				onChainNftId,
				message: "On-chain listing payload missing price or nftId",
			});
		}

		const mismatches: string[] = [];

		const onChainAmount = parseFloat(onChainPrice.amount);
		if (Math.abs(onChainAmount - params.expectedPrice.amount) > HIVE_AMOUNT_TOLERANCE) {
			mismatches.push(
				`price: on-chain ${onChainPrice.amount} ${onChainPrice.currency}, expected ${params.expectedPrice.amount} ${params.expectedPrice.currency}`,
			);
		}

		if (onChainPrice.currency !== params.expectedPrice.currency.toUpperCase()) {
			mismatches.push(
				`currency: on-chain ${onChainPrice.currency}, expected ${params.expectedPrice.currency}`,
			);
		}

		if (onChainSeller !== params.expectedSeller) {
			mismatches.push(
				`seller: on-chain ${onChainSeller}, expected ${params.expectedSeller}`,
			);
		}

		if (onChainNftId !== params.expectedNftId) {
			mismatches.push(
				`nftId: on-chain ${onChainNftId}, expected ${params.expectedNftId}`,
			);
		}

		if (mismatches.length > 0) {
			return buildListingResult("mismatch", params.listTxId, {
				blockNum: tx.block_num,
				onChainPrice,
				onChainSeller,
				onChainNftId,
				message: `Listing mismatch: ${mismatches.join("; ")}`,
			});
		}

		return buildListingResult("verified", params.listTxId, {
			blockNum: tx.block_num,
			onChainPrice,
			onChainSeller,
			onChainNftId,
			message: "Listing price verified against L1",
		});
	} catch (err) {
		return buildListingResult("error", params.listTxId, {
			blockNum: 0,
			message: err instanceof Error ? err.message : String(err),
		});
	}
}
