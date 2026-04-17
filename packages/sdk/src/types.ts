// SDK-only types. Protocol wire types live in `@nftlox/protocol`.
// Zod input schemas that map 1:1 to protocol data live in `./schemas`.

/**
 * Seed NFT with mandatory artId for deterministic seedId generation.
 * Used by UIs that pre-collect user-provided artIds before broadcasting.
 */
export type SeedNFTWithArtId = {
	readonly artId: string;
	readonly name: string;
	readonly brief?: string | undefined;
	readonly imageUrl: string;
	readonly maxSupply: number;
};

/**
 * Minting session persisted to localStorage / indexedDB by the client UI.
 * Tracks progressive broadcast of a collection + its seeds across restarts.
 */
export type MintingSession = {
	readonly id: string;
	readonly status: "validating" | "validated" | "collection_pending" | "seeds_partial" | "complete";
	readonly creator: string;
	readonly collectionName: string;
	readonly collectionSymbol: string;
	readonly nfts: readonly SeedNFTWithArtId[];
	readonly collectionId: string;
	readonly seedMapping: ReadonlyArray<{
		readonly artId: string;
		readonly seedId: string;
		readonly status: "new" | "exists" | "error";
	}>;
	readonly collectionBroadcast: {
		readonly status: "pending" | "broadcast" | "confirmed";
		readonly txId?: string | undefined;
	};
	readonly seedBatches: ReadonlyArray<{
		readonly batchNumber: number;
		readonly status: "pending" | "broadcast" | "confirmed";
		readonly seedIds: readonly string[];
		readonly txId?: string | undefined;
	}>;
	readonly createdAt: number;
	readonly validatedAt?: number | undefined;
	readonly completedAt?: number | undefined;
};
