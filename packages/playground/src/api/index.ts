// NFTLox API Module
// Exports HafSQL client for querying blockchain data

export {
	// Types
	type HafSQLOperation,
	type ParsedOperation,
	type NFTMintData,
	type CollectionData,
	type TransferData,
	type BurnData,
	type ListingData,
	type ProtocolAction,
	type FetchOperationsOptions,
	type NFTState,
	type CollectionState,
	type DuplicateEntry,
	type BuildStateResult,
	type ProtocolStats,
	type FilteringStats,
	type HistoryEventType,
	type HistoryEvent,
	type TransferValidation,
	type OwnershipRecord,
	// Constants
	MIN_PROTOCOL_VERSION,
	// Fetch functions
	fetchOperations,
	parseOperation,
	fetchAllOperations,
	fetchMintOperations,
	fetchCollectionOperations,
	fetchTransferOperations,
	fetchByAction,
	// State builders
	buildNFTState,
	buildFullState,
	getNFTsByOwner,
	getNFTsByCollection,
	getListedNFTs,
	// NFT by ID & History (Procedencia)
	getNFTById,
	getNFTHistory,
	getOwnershipHistory,
	validateTransfer,
	// Stats
	getProtocolStats,
	getFilteringStats,
	// Existence checks (Anti-Duplication)
	collectionExists,
	seedExists,
	nftExists,
	checkSeedsExistence,
	getCollectionById,
	getDetectedDuplicates,
} from "./hafsql-client";
