// NFTLox SDK — Data Operations Builders
// Pure functional builders for set_data, set_data_from, data_operator_approve
//
// Data flow:
//   buildSetData()             → blockchain → indexer → nfts.custom_data   (owner-controlled)
//   buildSetDataFrom()         → blockchain → indexer → nfts.operator_data (operator-controlled)
//   buildDataOperatorApprove() → blockchain → indexer → data_operators     (creator grants access)

import type { BuildResult, ValidationError } from "../payload-builder";
import type {
	SetDataData,
	SetDataInput,
	SetDataFromData,
	SetDataFromInput,
	DataOperatorApproveData,
	DataOperatorApproveInput,
} from "../types";
import {
	createSetDataPayload,
	createSetDataOperation,
	createSetDataFromPayload,
	createSetDataFromOperation,
	createDataOperatorApprovePayload,
	createDataOperatorApproveOperation,
} from "../payloads";
import {
	validateSetDataInput,
	validateSetDataFromInput,
	validateDataOperatorApproveInput,
} from "../validation";
import { MAX_TAGS, MAX_TAG_LENGTH } from "../constants";

// ============ SHARED PREDICATES ============

const HIVE_USERNAME_RE = /^[a-z][a-z0-9\-\.]{2,15}$/;
const NFT_ID_RE = /^(nft_[a-z0-9_]+|seed_[a-z0-9]+)$/;

function pushUsernameError(errors: ValidationError[], field: string, value: string): void {
	if (!HIVE_USERNAME_RE.test(value)) {
		errors.push({
			field,
			message: "Invalid Hive username format (3-16 chars, lowercase, a-z 0-9 - .)",
			code: "INVALID_USERNAME",
		});
	}
}

function pushNftIdError(errors: ValidationError[], value: string): void {
	if (!NFT_ID_RE.test(value)) {
		errors.push({
			field: "nftId",
			message: "Invalid NFT ID format (must start with nft_ or seed_)",
			code: "INVALID_NFT_ID",
		});
	}
}

function pushTagErrors(errors: ValidationError[], tags: string[]): void {
	if (tags.length > MAX_TAGS) {
		errors.push({
			field: "tags",
			message: `Maximum ${MAX_TAGS} tags allowed`,
			code: "TOO_MANY_TAGS",
		});
	}
	for (let i = 0; i < tags.length; i++) {
		if (tags[i]!.length > MAX_TAG_LENGTH) {
			errors.push({
				field: `tags[${i}]`,
				message: `Tag must be at most ${MAX_TAG_LENGTH} characters`,
				code: "TAG_TOO_LONG",
			});
		}
	}
}

function pushValidationError(errors: ValidationError[], result: { valid: boolean; error?: string }): void {
	if (!result.valid) {
		errors.push({
			field: "input",
			message: result.error ?? "Validation failed",
			code: "VALIDATION_FAILED",
		});
	}
}

// ============ BUILD SET DATA (owner → custom_data) ============

export type BuildSetDataInput = {
	nftId: string;
	instanceDna: string;
	data: Record<string, unknown>;
	tags?: string[];
	signer: string;
};

export function buildSetData(input: BuildSetDataInput): BuildResult<SetDataData> {
	const errors: ValidationError[] = [];

	pushUsernameError(errors, "signer", input.signer);
	pushNftIdError(errors, input.nftId);

	const payload: SetDataInput = {
		nftId: input.nftId,
		instanceDna: input.instanceDna,
		data: input.data,
		tags: input.tags,
	};

	pushValidationError(errors, validateSetDataInput(payload));
	if (input.tags) pushTagErrors(errors, input.tags);
	if (errors.length > 0) return { success: false, errors };

	return {
		success: true,
		payload: createSetDataPayload(payload),
		operation: createSetDataOperation(payload, input.signer),
	};
}

// ============ BUILD SET DATA FROM (operator → operator_data) ============

export type BuildSetDataFromInput = {
	nftId: string;
	instanceDna: string;
	data: Record<string, unknown>;
	tags?: string[];
	operator: string;
};

export function buildSetDataFrom(input: BuildSetDataFromInput): BuildResult<SetDataFromData> {
	const errors: ValidationError[] = [];

	pushUsernameError(errors, "operator", input.operator);
	pushNftIdError(errors, input.nftId);

	const payload: SetDataFromInput = {
		nftId: input.nftId,
		instanceDna: input.instanceDna,
		data: input.data,
		tags: input.tags,
	};

	pushValidationError(errors, validateSetDataFromInput(payload));
	if (input.tags) pushTagErrors(errors, input.tags);
	if (errors.length > 0) return { success: false, errors };

	return {
		success: true,
		payload: createSetDataFromPayload(payload),
		operation: createSetDataFromOperation(payload, input.operator),
	};
}

// ============ BUILD DATA OPERATOR APPROVE (creator → data_operators table) ============

export type BuildDataOperatorApproveInput = {
	collectionId: string;
	operator: string;
	approved: boolean;
	creator: string;
};

export function buildDataOperatorApprove(
	input: BuildDataOperatorApproveInput,
): BuildResult<DataOperatorApproveData> {
	const errors: ValidationError[] = [];

	pushUsernameError(errors, "creator", input.creator);

	const payload: DataOperatorApproveInput = {
		collectionId: input.collectionId,
		operator: input.operator,
		approved: input.approved,
	};

	pushValidationError(errors, validateDataOperatorApproveInput(payload));

	if (input.creator === input.operator) {
		errors.push({
			field: "operator",
			message: "Cannot approve yourself as data operator",
			code: "SELF_APPROVE",
		});
	}

	if (errors.length > 0) return { success: false, errors };

	return {
		success: true,
		payload: createDataOperatorApprovePayload(payload),
		operation: createDataOperatorApproveOperation(payload, input.creator),
	};
}
