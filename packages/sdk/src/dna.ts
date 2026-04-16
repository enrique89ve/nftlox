// Re-exports protocol DNA helpers + SDK-only artId utilities so existing
// callers can import both from a single module.

export {
	generateHash,
	generateOriginDna,
	generateInstanceDna,
	generateImageHash,
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
	generateDeterministicInstanceDna,
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
