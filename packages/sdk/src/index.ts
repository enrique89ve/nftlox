// nftlox-sdk — NFTLox Protocol SDK
// Public API: re-exports the wire protocol from @nftlox/protocol and adds
// the SDK-only builders, clients, SPV verifiers, and persistence helpers.

import * as artid from "./artid";
import * as protocolState from "./protocol-state";
import * as nftOperationValidation from "./validate";
import * as schemaTemplates from "./schema-templates";
import * as multisigClient from "./multisig";
import * as pow from "./pow";
import * as inheritance from "./inheritance";
import * as indexerClient from "./client";

// ============ PROTOCOL (re-exported from @nftlox/protocol) ============
export * from "./protocol-exports";

// ============ SDK-ONLY: ART ID ============
export const sanitizeArtId = artid.sanitizeArtId;
export const generateArtIdFromName = artid.generateArtIdFromName;
export const validateArtId = artid.validateArtId;
export const validateArtIdArray = artid.validateArtIdArray;
export type { ArtIdValidationResult, ArtIdArrayValidation } from "./artid";

// ============ SDK-ONLY: SESSION TYPES ============
export type { SeedNFTWithArtId, MintingSession } from "./types";

// ============ SDK-ONLY: ZOD SCHEMAS ============
export * from "./schemas";

// ============ SDK-ONLY: BUILDERS ============
export * from "./builders";

// ============ SDK-ONLY: PROTOCOL STATE ============
export const initProtocol = protocolState.initProtocol;
export const getProtocolVersion = protocolState.getProtocolVersion;
export const getProtocolId = protocolState.getProtocolId;
export const isInitialized = protocolState.isInitialized;

// ============ SDK-ONLY: NFT OPERATION PRE-VALIDATION ============
export const validateNftOperation = nftOperationValidation.validateNftOperation;
export type { NftState, PreValidationResult } from "./validate";

// ============ SDK-ONLY: SCHEMA TEMPLATES ============
export const GAMING_SCHEMA = schemaTemplates.GAMING_SCHEMA;
export const ART_SCHEMA = schemaTemplates.ART_SCHEMA;
export const COLLECTIBLE_SCHEMA = schemaTemplates.COLLECTIBLE_SCHEMA;
export const MUSIC_SCHEMA = schemaTemplates.MUSIC_SCHEMA;
export const RAGNAROK_MINION_SCHEMA = schemaTemplates.RAGNAROK_MINION_SCHEMA;
export const RAGNAROK_SPELL_SCHEMA = schemaTemplates.RAGNAROK_SPELL_SCHEMA;
export const RAGNAROK_WEAPON_SCHEMA = schemaTemplates.RAGNAROK_WEAPON_SCHEMA;
export const RAGNAROK_PET_SCHEMA = schemaTemplates.RAGNAROK_PET_SCHEMA;
export const RAGNAROK_ARMOR_SCHEMA = schemaTemplates.RAGNAROK_ARMOR_SCHEMA;
export const RAGNAROK_HERO_SCHEMA = schemaTemplates.RAGNAROK_HERO_SCHEMA;
export const createSchemaBuilder = schemaTemplates.createSchemaBuilder;

// ============ SDK-ONLY: MULTISIG CLIENT ============
export const fetchNodeAccount = multisigClient.fetchNodeAccount;
export const fetchMultisigNodeAccount = multisigClient.fetchMultisigNodeAccount;
export const fetchPaymentInfo = multisigClient.fetchPaymentInfo;
export const resolveNodeAccountFromStatus = multisigClient.resolveNodeAccountFromStatus;
export const submitBuy = multisigClient.submitBuy;
export const requestCreateCollectionMultisig = multisigClient.requestCreateCollectionMultisig;
export type { ResolveNodeAccountOptions, RequestMultisigOptions } from "./multisig";

export const DEFAULT_MULTISIG_POW_BITS = pow.DEFAULT_MULTISIG_POW_BITS;
export const MAX_MULTISIG_POW_BITS = pow.MAX_MULTISIG_POW_BITS;
export const MULTISIG_POW_VERSION = pow.MULTISIG_POW_VERSION;
export const NFTLOX_POW_HEADER = pow.NFTLOX_POW_HEADER;
export const canonicalPowJson = pow.canonicalPowJson;
export const hashJsonPayload = pow.hashJsonPayload;
export const hashMultisigPowToken = pow.hashMultisigPowToken;
export const hasLeadingZeroBits = pow.hasLeadingZeroBits;
export const solveMultisigPow = pow.solveMultisigPow;

// ============ SDK-ONLY: SPV VERIFICATION ============
export * from "./spv";

// ============ SDK-ONLY: INHERITANCE ============
export const resolveInstance = inheritance.resolveInstance;

// ============ SDK-ONLY: INDEXER CLIENT ============
export const createIndexerClient = indexerClient.createIndexerClient;
export { NftloxError, IndexerError, MultisigError } from "./errors";
export type { IndexerErrorInit, MultisigErrorInit } from "./errors";
export type { HttpOptions, FetchFunction } from "./http";
export type {
	IndexerClient,
	SyncStatus,
	HealthStatus,
	ProtocolStats,
	NodeRegistryStatus,
	IndexerNodeHeartbeat,
	IndexerNodeProfile,
	IndexedNodeOperation,
	IndexedNodeOperationsPage,
	HiveNodeOperation,
	HiveNodeOperationsPage,
	IndexerCollection,
	CollectionStats,
	IndexerNft,
	IndexerNftOwner,
	IndexerNftProof,
	IndexerNftLoan,
	IndexerNftLoanStatus,
	IndexerNftSummary,
	IndexerOwnershipAction,
	LoanRole,
	ListingSort,
	NodeOperationsQueryParams,
	NodeHiveOperationsQueryParams,
	UserAssetsOverview,
	UserAssetsQueryParams,
	UserLoansPage,
	UserLoansQueryParams,
	UserNftCounts,
	UserNftsPage,
	UserNftsQueryParams,
} from "./client";

// ============ SDK-ONLY: UTILS ============
export * from "./utils/tx-sizing";
