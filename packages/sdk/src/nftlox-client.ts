// Unified NFTLox client — the recommended entry point for apps and games.
//
// Bundles the four conceptually-separate surfaces (builders, indexer client,
// SPV verifiers, protocol metadata) behind one configured object so the
// integrator does not have to wire baseUrl / l1Config into every call.
//
// Tree-shaking is preserved: the underlying primitives stay in their own
// modules and are still exported at the package root for callers who prefer
// the lower-level API.

import {
	buildArchiveCollection,
	buildCollection,
	buildCollectionWithSeeds,
	buildBulkDistribute,
	buildBurn,
	buildBuy,
	buildDataOperatorApprove,
	buildList,
	buildAssetApprove,
	buildAssetApproveAll,
	buildAssetLend,
	buildAssetReturn,
	buildAssetTransferFrom,
	buildNodeHeartbeat,
	buildNodeRegister,
	buildSeed,
	buildSeedBatch,
	buildSetData,
	buildSetDataFrom,
	buildTransfer,
	buildUnlist,
} from "./builders";
import { buildExtendSchema } from "./builders/collection";
import { createIndexerClient, type IndexerClient } from "./client";
import type { HttpOptions } from "./http";
import {
	createDefaultL1Config,
	verifyDeterministicDerivation,
	verifyListingPrice,
	verifyAssetOwnership,
	verifyOperationOnChain,
	resolveMutableDataFromOperation,
	resolveOperationById,
	type DeterministicDerivationParams,
	type DeterministicDerivationResult,
	type HiveL1Config,
	type ListingPriceVerifyParams,
	type ListingPriceVerificationResult,
	type OnChainVerifyParams,
	type OnChainVerificationResult,
	type OwnershipVerificationResult,
	type ResolveMutableDataParams,
	type ResolveOperationByIdParams,
	type ResolvedMutableData,
	type ResolvedOperationById,
} from "./spv";
import { initProtocol } from "./protocol-state";
import {
	MIN_PROTOCOL_VERSION,
	PROTOCOL_ID,
	PROTOCOL_VERSION,
} from "@nftlox/protocol";

// ─── public types ────────────────────────────────────────────────────────────

export type NftloxClientOptions = {
	/** Indexer base URL — required for `indexer.*` calls and SPV ownership checks. */
	readonly indexerUrl: string;
	/** Hive RPC config for SPV verifiers. Defaults to `createDefaultL1Config()`. */
	readonly hiveL1?: HiveL1Config;
	/** Custom HTTP options (timeout, headers, fetch impl) forwarded to the indexer client. */
	readonly http?: HttpOptions;
};

export type NftloxClient = {
	/** REST client for the NFTLox indexer (collections, Assets, marketplace, multisig). */
	readonly indexer: IndexerClient;
	/** Payload builders — preconfigured with no extra plumbing required. */
	readonly builders: NftloxBuilders;
	/** SPV verifiers — `indexerBaseUrl` and `l1Config` are auto-injected. */
	readonly spv: NftloxSpv;
	/** Protocol metadata (read-only snapshot of constants the SDK ships with). */
	readonly protocol: {
		readonly id: string;
		readonly version: string;
		readonly minVersion: string;
	};
	/**
	 * Fetches `/api/status` from the indexer and verifies that it serves the
	 * exact protocol contract bundled by this SDK before enabling live state.
	 *
	 * Optional: skip it if you trust the bundled constants (offline mode). A
	 * different protocol id or version is rejected instead of producing a
	 * payload the target indexer cannot accept.
	 */
	connect(): Promise<{ readonly version: string; readonly protocolId: string }>;
};

export type NftloxBuilders = {
	collection: typeof buildCollection;
	collectionWithSeeds: typeof buildCollectionWithSeeds;
	archiveCollection: typeof buildArchiveCollection;
	extendSchema: typeof buildExtendSchema;
	seed: typeof buildSeed;
	seedBatch: typeof buildSeedBatch;
	bulkDistribute: typeof buildBulkDistribute;
	transfer: typeof buildTransfer;
	burn: typeof buildBurn;
	list: typeof buildList;
	unlist: typeof buildUnlist;
	buy: typeof buildBuy;
	setData: typeof buildSetData;
	setDataFrom: typeof buildSetDataFrom;
	dataOperatorApprove: typeof buildDataOperatorApprove;
	assetApprove: typeof buildAssetApprove;
	assetApproveAll: typeof buildAssetApproveAll;
	assetTransferFrom: typeof buildAssetTransferFrom;
	assetLend: typeof buildAssetLend;
	assetReturn: typeof buildAssetReturn;
	nodeRegister: typeof buildNodeRegister;
	nodeHeartbeat: typeof buildNodeHeartbeat;
};

export type NftloxSpv = {
	verifyAssetOwnership(params: { readonly assetId: string; readonly expectedOwner: string }): Promise<OwnershipVerificationResult>;
	verifyOperationOnChain(params: Omit<OnChainVerifyParams, "l1Config">): Promise<OnChainVerificationResult>;
	verifyListingPrice(params: Omit<ListingPriceVerifyParams, "l1Config">): Promise<ListingPriceVerificationResult>;
	verifyDeterministicDerivation(params: DeterministicDerivationParams): Promise<DeterministicDerivationResult>;
	resolveOperationById(params: Omit<ResolveOperationByIdParams, "l1Config">): Promise<ResolvedOperationById>;
	resolveMutableData(params: Omit<ResolveMutableDataParams, "l1Config">): Promise<ResolvedMutableData>;
};

// ─── factory ─────────────────────────────────────────────────────────────────

/**
 * Creates the unified NFTLox client.
 *
 * Example:
 *   const client = createNftloxClient({ indexerUrl: "https://indexer.example" });
 *   await client.connect();
 *
 *   const tx = await client.builders.list({
 *     assetId, owner, price: { amount: "10.000", currency: "HIVE" },
 *     expiresAt: expireIn({ days: 30 }),
 *   });
 *
 *   const assets = await client.indexer.getUserAssets("alice");
 *   const proof = await client.spv.verifyAssetOwnership({ assetId, expectedOwner: "alice" });
 *
 * SECURITY: When used server-side, `indexerUrl` must point to a trusted host.
 * Do not pass user-controlled URLs (SSRF risk).
 */
export function createNftloxClient(options: NftloxClientOptions): NftloxClient {
	const indexerUrl = options.indexerUrl.replace(/\/+$/, "");
	const hiveL1 = options.hiveL1 ?? createDefaultL1Config();
	const indexer = createIndexerClient(indexerUrl, options.http);

	const builders: NftloxBuilders = {
		collection: buildCollection,
		collectionWithSeeds: buildCollectionWithSeeds,
		archiveCollection: buildArchiveCollection,
		extendSchema: buildExtendSchema,
		seed: buildSeed,
		seedBatch: buildSeedBatch,
		bulkDistribute: buildBulkDistribute,
		transfer: buildTransfer,
		burn: buildBurn,
		list: buildList,
		unlist: buildUnlist,
		buy: buildBuy,
		setData: buildSetData,
		setDataFrom: buildSetDataFrom,
		dataOperatorApprove: buildDataOperatorApprove,
		assetApprove: buildAssetApprove,
		assetApproveAll: buildAssetApproveAll,
		assetTransferFrom: buildAssetTransferFrom,
		assetLend: buildAssetLend,
		assetReturn: buildAssetReturn,
		nodeRegister: buildNodeRegister,
		nodeHeartbeat: buildNodeHeartbeat,
	};

	const spv: NftloxSpv = {
		verifyAssetOwnership: ({ assetId, expectedOwner }) =>
			verifyAssetOwnership({ assetId, expectedOwner, indexerBaseUrl: indexerUrl, l1Config: hiveL1 }),
		verifyOperationOnChain: (params) =>
			verifyOperationOnChain({ ...params, l1Config: hiveL1 }),
		verifyListingPrice: (params) =>
			verifyListingPrice({ ...params, l1Config: hiveL1 }),
		verifyDeterministicDerivation,
		resolveOperationById: (params) =>
			resolveOperationById({ ...params, l1Config: hiveL1 }),
		resolveMutableData: (params) =>
			resolveMutableDataFromOperation({ ...params, l1Config: hiveL1 }),
	};

	const connect = async () => {
		const state = await initProtocol(indexerUrl, options.http);
		return { version: state.version, protocolId: state.protocolId };
	};

	return {
		indexer,
		builders,
		spv,
		protocol: {
			id: PROTOCOL_ID,
			version: PROTOCOL_VERSION,
			minVersion: MIN_PROTOCOL_VERSION,
		},
		connect,
	};
}
