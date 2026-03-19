// NFTLox Protocol - Playground Constants

// ============ COLLECTION DEFAULTS ============

export const DEFAULT_COLLECTION_IMAGE = "https://ipfs.io/ipfs/QmDefaultCollection/cover.png";
export const TEST_COLLECTION_SUFFIX = "- NFTLox Protocol Test Collection";
export const PRODUCTION_COLLECTION_SUFFIX = "- NFTLox Protocol Collection";

// ============ SYMBOL PROCESSING ============

export const SYMBOL_MAX_LENGTH = 8;
export const SYMBOL_MIN_LENGTH = 3;
export const SYMBOL_PAD_CHARACTER = "X";
export const SYMBOL_CLEANUP_REGEX = /[^A-Z0-9]/g;

// ============ BATCH PROCESSING ============

export const DEFAULT_MAX_OPERATIONS_PER_BATCH = 5;
export const DEFAULT_STARTING_INSTANCE_NUMBER = 1;

// ============ ROYALTY DEFAULTS ============

export const DEFAULT_ROYALTY_PCT = 5;
export const DEFAULT_TRANSFERABLE = true;
export const DEFAULT_BURNABLE = true;

// ============ ERROR MESSAGES ============

export enum ValidationErrorType {
	INVALID_JSON = "INVALID_JSON",
	VERSION_MISMATCH = "VERSION_MISMATCH",
	PROTOCOL_MISMATCH = "PROTOCOL_MISMATCH",
}

export interface OperationValidationError {
	type: ValidationErrorType;
	operationIndex: number;
	message: string;
	context?: {
		expected?: string;
		actual?: string;
		rawError?: string;
	};
}

export const createVersionMismatchError = (
	index: number,
	actual: string,
	expected: string,
): OperationValidationError => ({
	type: ValidationErrorType.VERSION_MISMATCH,
	operationIndex: index,
	message: `Operation ${index}: version ${actual} !== ${expected}`,
	context: { expected, actual },
});

export const createProtocolMismatchError = (
	index: number,
	actual: string,
	expected: string,
): OperationValidationError => ({
	type: ValidationErrorType.PROTOCOL_MISMATCH,
	operationIndex: index,
	message: `Operation ${index}: protocol ${actual} !== ${expected}`,
	context: { expected, actual },
});

export const createInvalidJsonError = (
	index: number,
	rawError?: string,
): OperationValidationError => ({
	type: ValidationErrorType.INVALID_JSON,
	operationIndex: index,
	message: `Operation ${index}: invalid JSON`,
	context: { rawError },
});

// ============ COLLECTION TYPES ============

export enum CollectionType {
	TEST = "test",
	PRODUCTION = "production",
}

export interface PlaygroundConfig {
	collectionType: CollectionType;
	maxOperationsPerBatch: number;
	defaultRoyaltyPct: number;
	defaultTransferable: boolean;
	defaultBurnable: boolean;
}

export const DEFAULT_PLAYGROUND_CONFIG: PlaygroundConfig = {
	collectionType: CollectionType.TEST,
	maxOperationsPerBatch: DEFAULT_MAX_OPERATIONS_PER_BATCH,
	defaultRoyaltyPct: DEFAULT_ROYALTY_PCT,
	defaultTransferable: DEFAULT_TRANSFERABLE,
	defaultBurnable: DEFAULT_BURNABLE,
} as const;
