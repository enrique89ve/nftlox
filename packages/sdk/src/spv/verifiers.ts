// SPV "Boleto Suizo" - Verification Logic
// Reuses SDK deterministic functions — zero duplication

import {
	resolveDropTable,
	generateDeterministicInstanceId,
	generateDeterministicInstanceDna,
	generateDeterministicAccessKey,
	extractInstanceNumber,
} from "../dna.ts";
import {
	ACTION_PACK_OPEN,
	ACTION_TRANSFER,
	ACTION_LIST,
	ACTION_UNLIST,
	ACTION_BURN,
	ACTION_REPLICATE,
	ACTION_NFT_TRANSFER_FROM,
	ACTION_SET_DATA,
	SUPPORTED_CURRENCIES,
	type SupportedCurrency,
} from "../constants.ts";
import { buildRngSeed, selectRandomSample } from "./constants.ts";
import {
	fetchTransaction,
	parseNftloxOperation,
} from "./hive-l1-client.ts";
import type {
	HiveL1Config,
	PackOpenVerificationResult,
	OnChainVerificationResult,
	OwnershipVerifyParams,
	OwnershipVerificationResult,
	OwnershipCheckResult,
	ReportedMintedNft,
	SpvMismatch,
	ListingPriceVerifyParams,
	ListingPriceVerificationResult,
	OnChainPrice,
} from "./types.ts";

// ============ PURE VERIFIERS (no network) ============

export interface DropTableReplayParams {
	txId: string;
	blockNum: number;
	signer: string;
	packId: string;
	packIndex: number;
	dropTable: Array<{ seedId: string; weight: number }>;
	itemsPerPack: number;
}

/**
 * Replays the drop table resolution using the same deterministic RNG.
 * Pure function — no network calls.
 */
export function replayDropTableResolution(
	params: DropTableReplayParams,
): string[] {
	const rngSeed = buildRngSeed(
		params.txId,
		params.blockNum,
		params.signer,
		params.packId,
		params.packIndex,
	);
	return resolveDropTable(params.dropTable, params.itemsPerPack, rngSeed);
}

export interface DeterministicDerivationParams {
	seedId: string;
	instanceNumber: number;
	txId: string;
	blockNum: number;
	signer: string;
}

export interface DeterministicDerivationResult {
	instanceId: string;
	instanceDna: string;
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
	const instanceDna = await generateDeterministicInstanceDna(
		params.seedId,
		params.instanceNumber,
		params.txId,
		params.blockNum,
	);
	const accessKey = await generateDeterministicAccessKey(
		instanceDna,
		params.signer,
		params.txId,
	);
	return { instanceId, instanceDna, accessKey };
}

// ============ NETWORK VERIFIERS ============

export interface PackOpenVerifyParams {
	txId: string;
	blockNum: number;
	indexerBaseUrl: string;
	l1Config: HiveL1Config;
}

/**
 * Full pack_open verification:
 * 1. Fetches tx from Hive L1
 * 2. Parses NFTLox operation
 * 3. Fetches pack info + history from indexer
 * 4. Replays RNG and compares results
 */
export async function verifyPackOpen(
	params: PackOpenVerifyParams,
): Promise<PackOpenVerificationResult> {
	const startTime = Date.now();
	const mismatches: SpvMismatch[] = [];
	const allExpectedSeedIds: string[] = [];
	const allReportedNfts: ReportedMintedNft[] = [];

	try {
		// Step 1: Fetch tx from Hive L1
		const tx = await fetchTransaction(params.l1Config, params.txId);

		// Step 2: Parse NFTLox operation
		const l1Op = parseNftloxOperation(tx);
		if (!l1Op) {
			return buildResult("not_found", startTime, {
				txId: params.txId,
				blockNum: params.blockNum,
				message: "No NFTLox operation found in transaction",
			});
		}

		if (l1Op.action !== ACTION_PACK_OPEN) {
			return buildResult("mismatch", startTime, {
				txId: params.txId,
				blockNum: params.blockNum,
				signer: l1Op.signer,
				message: `Expected pack_open, found ${l1Op.action}`,
			});
		}

		const packId = l1Op.data.packId;
		const quantity = l1Op.data.quantity;

		if (typeof packId !== "string" || typeof quantity !== "number") {
			return buildResult("error", startTime, {
				txId: params.txId,
				blockNum: params.blockNum,
				signer: l1Op.signer,
				message: "pack_open payload missing packId or quantity",
			});
		}

		// Step 3: Fetch pack info from indexer
		const packResponse = await fetch(
			`${params.indexerBaseUrl}/api/packs/${packId}`,
		);
		if (!packResponse.ok) {
			return buildResult("error", startTime, {
				txId: params.txId,
				blockNum: params.blockNum,
				signer: l1Op.signer,
				packId,
				message: `Indexer returned ${packResponse.status} for pack ${packId}`,
			});
		}

		const packData = await packResponse.json() as Record<string, unknown>;
		const dropTable = packData.drop_table;
		const itemsPerPack = packData.items_per_pack;

		if (!Array.isArray(dropTable) || typeof itemsPerPack !== "number") {
			return buildResult("error", startTime, {
				txId: params.txId,
				blockNum: params.blockNum,
				signer: l1Op.signer,
				packId,
				message: "Indexer pack data missing drop_table or items_per_pack",
			});
		}

		// Step 4: Fetch pack history to find minted NFTs
		const historyResponse = await fetch(
			`${params.indexerBaseUrl}/api/packs/${packId}/history`,
		);
		if (!historyResponse.ok) {
			return buildResult("error", startTime, {
				txId: params.txId,
				blockNum: params.blockNum,
				signer: l1Op.signer,
				packId,
				message: `Indexer returned ${historyResponse.status} for pack history`,
			});
		}

		const historyRaw = await historyResponse.json() as unknown;

		if (!Array.isArray(historyRaw)) {
			return buildResult("error", startTime, {
				txId: params.txId,
				blockNum: params.blockNum,
				signer: l1Op.signer,
				packId,
				message: "Indexer pack history is not an array",
			});
		}

		const historyData = historyRaw as Array<{
			event_type: string;
			tx_id: string;
			payload?: { mintedNfts?: ReportedMintedNft[] };
		}>;

		const packOpenEvent = historyData.find(
			(e) => e.event_type === ACTION_PACK_OPEN && e.tx_id === params.txId,
		);

		const reportedNfts = packOpenEvent?.payload?.mintedNfts ?? [];
		allReportedNfts.push(...reportedNfts);

		// Step 5: Replay RNG for each pack index
		for (let packIndex = 0; packIndex < quantity; packIndex++) {
			const expectedSeeds = replayDropTableResolution({
				txId: params.txId,
				blockNum: params.blockNum,
				signer: l1Op.signer,
				packId,
				packIndex,
				dropTable: dropTable as Array<{ seedId: string; weight: number }>,
				itemsPerPack: itemsPerPack,
			});
			allExpectedSeedIds.push(...expectedSeeds);

			// Compare expected seeds with reported NFTs for this packIndex
			const reportedForIndex = reportedNfts.filter(
				(n) => n.packIndex === packIndex,
			);

			for (let itemIndex = 0; itemIndex < expectedSeeds.length; itemIndex++) {
				const expectedSeedId = expectedSeeds[itemIndex]!;
				const reported = reportedForIndex[itemIndex];

				if (!reported) {
					mismatches.push({
						packIndex,
						itemIndex,
						field: "seedId",
						expected: expectedSeedId,
						actual: "(missing)",
						severity: "critical",
					});
					continue;
				}

				if (reported.seedId !== expectedSeedId) {
					mismatches.push({
						packIndex,
						itemIndex,
						field: "seedId",
						expected: expectedSeedId,
						actual: reported.seedId,
						severity: "critical",
					});
				}
			}
		}

		// Step 6: Verify deterministic derivations for each reported NFT
		for (const nft of reportedNfts) {
			const instanceNumber = extractInstanceNumber(nft.instanceId);
			if (instanceNumber === null) continue;

			const derived = await verifyDeterministicDerivation({
				seedId: nft.seedId,
				instanceNumber,
				txId: params.txId,
				blockNum: params.blockNum,
				signer: l1Op.signer,
			});

			if (derived.instanceId !== nft.instanceId) {
				mismatches.push({
					packIndex: nft.packIndex,
					itemIndex: 0,
					field: "instanceId",
					expected: derived.instanceId,
					actual: nft.instanceId,
					severity: "critical",
				});
			}
		}

		const status = mismatches.length === 0 ? "verified" : "mismatch";
		const message = mismatches.length === 0
			? `Verified: ${reportedNfts.length} NFTs from ${quantity} pack(s)`
			: `Found ${mismatches.length} mismatch(es)`;

		return {
			status,
			txId: params.txId,
			blockNum: params.blockNum,
			signer: l1Op.signer,
			packId,
			expectedSeedIds: allExpectedSeedIds,
			reportedMintedNfts: allReportedNfts,
			mismatches,
			verifiedAt: Date.now(),
			durationMs: Date.now() - startTime,
			message,
		};
	} catch (err) {
		return buildResult("error", startTime, {
			txId: params.txId,
			blockNum: params.blockNum,
			message: err instanceof Error ? err.message : String(err),
		});
	}
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

// Actions where the signer is the "from" (sender/actor)
const SIGNER_IS_FROM_ACTIONS = new Set([
	ACTION_TRANSFER, ACTION_LIST, ACTION_UNLIST, ACTION_BURN, ACTION_REPLICATE,
	ACTION_NFT_TRANSFER_FROM, ACTION_SET_DATA,
]);

/**
 * Verifies NFT ownership by sampling random operations from the NFT's history
 * and checking each one exists on Hive L1 with the correct signer.
 * Max 3 operations checked (Boleto Suizo principle).
 */
export async function verifyNftOwnership(
	params: OwnershipVerifyParams,
): Promise<OwnershipVerificationResult> {
	const startTime = Date.now();
	const maxSamples = Math.min(params.sampleSize, 3);

	try {
		// Step 1: Fetch NFT info from indexer
		const nftResponse = await fetch(
			`${params.indexerBaseUrl}/api/nfts/${params.nftId}`,
		);
		if (!nftResponse.ok) {
			return buildOwnershipResult("error", startTime, {
				nftId: params.nftId,
				expectedOwner: params.expectedOwner,
				message: `Indexer returned ${nftResponse.status} for NFT ${params.nftId}`,
			});
		}

		const nftData = await nftResponse.json() as Record<string, unknown>;
		const reportedOwner = nftData.owner;

		if (typeof reportedOwner !== "string") {
			return buildOwnershipResult("error", startTime, {
				nftId: params.nftId,
				expectedOwner: params.expectedOwner,
				message: "Indexer NFT data missing owner field",
			});
		}

		// Step 2: Fetch NFT history from indexer
		const historyResponse = await fetch(
			`${params.indexerBaseUrl}/api/nfts/${params.nftId}/history`,
		);
		if (!historyResponse.ok) {
			return buildOwnershipResult("error", startTime, {
				nftId: params.nftId,
				expectedOwner: params.expectedOwner,
				reportedOwner,
				message: `Indexer returned ${historyResponse.status} for NFT history`,
			});
		}

		const historyRaw = await historyResponse.json() as unknown;
		if (!Array.isArray(historyRaw)) {
			return buildOwnershipResult("error", startTime, {
				nftId: params.nftId,
				expectedOwner: params.expectedOwner,
				reportedOwner,
				message: "Indexer NFT history is not an array",
			});
		}

		const history = historyRaw as Array<{
			event_type: string;
			tx_id: string;
			block_num: number;
			from_account?: string;
			to_account?: string;
		}>;

		// Step 3: Sample up to maxSamples random events
		const sampled = selectRandomSample(history, maxSamples);
		const checks: OwnershipCheckResult[] = [];

		for (const event of sampled) {
			// Determine expected signer based on action type
			const expectedSigner = SIGNER_IS_FROM_ACTIONS.has(event.event_type)
				? event.from_account
				: event.from_account; // mint/distribute: signer is also from_account

			if (typeof expectedSigner !== "string" || typeof event.tx_id !== "string") {
				checks.push({
					txId: event.tx_id ?? "",
					blockNum: event.block_num ?? 0,
					eventType: event.event_type,
					expectedSigner: expectedSigner ?? "",
					l1Status: "error",
					message: "Missing tx_id or from_account in history event",
				});
				continue;
			}

			const l1Result = await verifyOperationOnChain({
				txId: event.tx_id,
				blockNum: event.block_num,
				expectedAction: event.event_type,
				expectedSigner,
				l1Config: params.l1Config,
			});

			checks.push({
				txId: event.tx_id,
				blockNum: event.block_num,
				eventType: event.event_type,
				expectedSigner,
				l1Status: l1Result.status,
				message: l1Result.message,
			});
		}

		// Step 4: Determine overall result
		const ownerMatch = reportedOwner === params.expectedOwner;
		const allChecksVerified = checks.every((c) => c.l1Status === "verified");
		const hasMismatch = checks.some((c) => c.l1Status === "mismatch");

		let status: OwnershipVerificationResult["status"];
		let message: string;

		if (!ownerMatch) {
			status = "mismatch";
			message = `Owner mismatch: indexer reports ${reportedOwner}, expected ${params.expectedOwner}`;
		} else if (hasMismatch) {
			status = "mismatch";
			message = `Owner matches but ${checks.filter((c) => c.l1Status === "mismatch").length} history event(s) failed L1 verification`;
		} else if (allChecksVerified) {
			status = "verified";
			message = `Ownership verified: ${checks.length}/${history.length} events checked on L1`;
		} else {
			status = "error";
			message = `Some checks could not complete: ${checks.filter((c) => c.l1Status === "error").length} error(s)`;
		}

		return {
			status,
			nftId: params.nftId,
			reportedOwner,
			expectedOwner: params.expectedOwner,
			totalEvents: history.length,
			sampledEvents: checks.length,
			checks,
			verifiedAt: Date.now(),
			durationMs: Date.now() - startTime,
			message,
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
		totalEvents: 0,
		sampledEvents: 0,
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

// ============ HELPERS ============

interface BuildResultPartial {
	txId: string;
	blockNum: number;
	signer?: string;
	packId?: string;
	message: string;
}

function buildResult(
	status: PackOpenVerificationResult["status"],
	startTime: number,
	partial: BuildResultPartial,
): PackOpenVerificationResult {
	return {
		status,
		txId: partial.txId,
		blockNum: partial.blockNum,
		signer: partial.signer ?? "",
		packId: partial.packId ?? "",
		expectedSeedIds: [],
		reportedMintedNfts: [],
		mismatches: [],
		verifiedAt: Date.now(),
		durationMs: Date.now() - startTime,
		message: partial.message,
	};
}
