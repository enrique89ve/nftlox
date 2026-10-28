// Re-exports protocol DNA helpers + SDK-only artId utilities so existing
// callers can import both from a single module.

export {
	generateHash,
	generateOriginDna,
	generateSeedDna,
	generateInstanceId,
	extractSeedId,
	extractInstanceNumber,
	isSeedId,
	isInstanceId,
	generateDeterministicCollectionId,
	generateDeterministicSeedId,
	generateDeterministicInstanceId,
	generateListingNonce,
	generateListingId,
	generateInstanceDna,
	generateDeterministicAccessKey,
} from "@nftlox/protocol";

export {
	sanitizeArtId,
	generateArtIdFromName,
	validateArtId,
	validateArtIdArray,
	type ArtIdValidationResult,
	type ArtIdArrayValidation,
} from "./artid";
