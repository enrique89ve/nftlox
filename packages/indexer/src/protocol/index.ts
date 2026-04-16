// Re-export canonical protocol contract from the shared package.
export * from "@nftlox/protocol";

// Indexer-only extensions (not part of the cross-package contract).
export {
	PROTOCOL_GENESIS_BLOCK,
	PROTOCOL_GENESIS_BLOCK_ID,
	validateGenesisBlockSelection,
	type GenesisBlockValidationInput,
} from "./genesis-guard.ts";
