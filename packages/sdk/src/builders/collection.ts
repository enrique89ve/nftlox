import { z } from "zod";
import { createCollectionInputSchema, archiveCollectionInputSchema, extendSchemaInputSchema, usernameSchema, type CreateCollectionInput } from "../schemas";
import { formatZodError } from "./helpers";
import type { KeychainResult, ValidationError } from "./types";
import {
	generateDeterministicCollectionId,
	generateOriginDna,
	createPayload,
	createHiveOperation,
	getKeyType,
	MAX_NAME_LENGTH,
	PROTOCOL_COLLECTION_FEE_HBD,
	PROTOCOL_ID,
	PROTOCOL_VERSION,
	ACTION_CREATE_COLLECTION,
	SUPPORTED_CURRENCIES,
	validateHiveUsername,
	type CollectionData,
	type ArchiveCollectionData,
	type ExtendSchemaData,
	type HiveOperation,
	type HiveTransferOperation,
	type SupportedCurrency,
} from "@nftlox/protocol";
import { fetchNodeAccount } from "../multisig";

export type BuildCollectionBaseOptions = Readonly<{
	readonly feeAmount?: string | undefined;
	readonly feeCurrency?: SupportedCurrency | undefined;
}>;

export type BuildCollectionOptions = BuildCollectionBaseOptions & (
	| Readonly<{
			readonly nodeAccount: string;
			readonly indexerBaseUrl?: never;
			readonly requireMultisigReady?: never;
	  }>
	| Readonly<{
			readonly indexerBaseUrl: string;
			readonly nodeAccount?: never;
			readonly requireMultisigReady?: boolean | undefined;
	  }>
);

async function resolveCollectionNodeAccount(options: BuildCollectionOptions): Promise<string | ValidationError> {
	if (typeof options.nodeAccount === "string") {
		const nodeAccountError = validateHiveUsername(options.nodeAccount);
		if (nodeAccountError) {
			return { field: "nodeAccount", message: nodeAccountError, code: "invalid_username" };
		}
		return options.nodeAccount;
	}

	if (typeof options.indexerBaseUrl !== "string") {
		return {
			field: "nodeAccount",
			message: "Either nodeAccount or indexerBaseUrl is required",
			code: "node_account_required",
		};
	}

	try {
		return await fetchNodeAccount(options.indexerBaseUrl, {
			requireMultisigReady: options.requireMultisigReady ?? true,
		});
	} catch (error) {
		return {
			field: "indexerBaseUrl",
			message: error instanceof Error ? error.message : String(error),
			code: "node_account_resolution_failed",
		};
	}
}

function isValidationError(value: string | ValidationError): value is ValidationError {
	return typeof value !== "string";
}

/**
 * Build the 2-operation transaction required by the NFTLox `create_collection`
 * flow: op[0] is a fee transfer from the creator to the node account; op[1] is
 * the protocol payload whose active-auth signer is the node account (co-signed
 * via the multisig endpoint).
 *
 * Both operations MUST be broadcast in the same Hive transaction. The indexer
 * pairs transfers to protocol ops by txId only — splitting them into separate
 * transactions drops the payload and leaves the fee unclaimed.
 *
 * The caller wraps these operations with the Hive lib of their choice
 * (hive-tx, @hiveio/wax, dhive, …), adds TaPoS/expiration, POSTs the unsigned
 * tx to the node's `/api/multisig/collection` endpoint for co-signature, then
 * attaches the creator's own active-key signature and broadcasts.
 */
export async function buildCollection(
	input: CreateCollectionInput,
	options: BuildCollectionOptions,
): Promise<KeychainResult<CollectionData>> {
	const parsed = createCollectionInputSchema.safeParse(input);
	if (!parsed.success) {
		return { success: false, errors: formatZodError(parsed.error) };
	}

	const nodeAccountResult = await resolveCollectionNodeAccount(options);
	if (isValidationError(nodeAccountResult)) {
		return { success: false, errors: [nodeAccountResult] };
	}
	const nodeAccount = nodeAccountResult;

	const feeCurrency: SupportedCurrency = options.feeCurrency ?? "HBD";
	if (!(SUPPORTED_CURRENCIES as readonly string[]).includes(feeCurrency)) {
		return {
			success: false,
			errors: [{ field: "feeCurrency", message: `Unsupported currency: ${feeCurrency}`, code: "invalid_currency" }],
		};
	}

	const feeAmount = options.feeAmount ?? PROTOCOL_COLLECTION_FEE_HBD;
	const parsedFee = Number.parseFloat(feeAmount);
	if (!Number.isFinite(parsedFee) || parsedFee <= 0) {
		return {
			success: false,
			errors: [{ field: "feeAmount", message: `Fee amount must be a positive number, got '${feeAmount}'`, code: "invalid_amount" }],
		};
	}

	const data = parsed.data;
	const warnings: string[] = [];

	if (data.name.length > MAX_NAME_LENGTH * 0.9) {
		warnings.push("Name is close to maximum length, consider shortening");
	}
	if (data.rules.royaltyPct > 25) {
		warnings.push("Royalty percentage is high (>25%), consider reducing");
	}

	const collectionId = await generateDeterministicCollectionId(
		data.creator,
		data.name,
		data.symbol,
	);
	const originDna = await generateOriginDna(collectionId);

	const collectionData: CollectionData = {
		id: collectionId,
		name: data.name,
		symbol: data.symbol.toUpperCase(),
		totalPotential: data.totalPotential,
		originDna,
		metadata: data.metadata,
		rules: data.rules,
		...(data.schema && { schema: data.schema }),
	};

	const payload = createPayload("create_collection", collectionData);
	// The protocol op is co-signed by the node; pass nodeAccount as the signer
	// so createHiveOperation emits auth fields bound to the node account.
	const customJsonOp = createHiveOperation(payload, nodeAccount);

	const transferOp: HiveTransferOperation = [
		"transfer",
		{
			from: data.creator,
			to: nodeAccount,
			amount: `${parsedFee.toFixed(3)} ${feeCurrency}`,
			memo: `NFTLox collection fee:${collectionId}`,
		},
	];

	return {
		success: true,
		operations: [transferOp, customJsonOp],
		// Creator signs op[0] (the transfer) directly with their active key.
		// The node co-signs op[1] (the custom_json) via /multisig/collection —
		// the caller obtains that signature separately and attaches it before
		// broadcast. Modeling both signers explicitly avoids hiding the dual-
		// signer reality behind a single `signer` field.
		keyType: getKeyType(ACTION_CREATE_COLLECTION),
		signer: data.creator,
		coSigners: [{
			op: 1,
			account: nodeAccount,
			keyType: getKeyType(ACTION_CREATE_COLLECTION),
			via: "multisig",
		}],
		payload,
		generatedIds: { collectionId, originDna },
		...(warnings.length > 0 && { warnings }),
	};
}

export const archiveCollectionBuilderSchema = archiveCollectionInputSchema.extend({
	creator: usernameSchema,
});
export type ArchiveCollectionBuilderInput = z.infer<typeof archiveCollectionBuilderSchema>;

export function buildArchiveCollection(
	input: ArchiveCollectionBuilderInput,
): KeychainResult<ArchiveCollectionData> {
	const parsed = archiveCollectionBuilderSchema.safeParse(input);
	if (!parsed.success) {
		return { success: false, errors: formatZodError(parsed.error) };
	}

	const data = parsed.data;
	const payload = createPayload("archive_collection", {
		collectionId: data.collectionId,
	} satisfies ArchiveCollectionData);
	const operation = createHiveOperation(payload, data.creator);

	return {
		success: true,
		operations: [operation],
		keyType: getKeyType("archive_collection"),
		signer: data.creator,
		payload,
	};
}

export const extendSchemaBuilderSchema = extendSchemaInputSchema.extend({
	creator: usernameSchema,
});
export type ExtendSchemaBuilderInput = z.infer<typeof extendSchemaBuilderSchema>;

export function buildExtendSchema(
	input: ExtendSchemaBuilderInput,
): KeychainResult<ExtendSchemaData> {
	const parsed = extendSchemaBuilderSchema.safeParse(input);
	if (!parsed.success) {
		return { success: false, errors: formatZodError(parsed.error) };
	}

	const data = parsed.data;
	const extendData: ExtendSchemaData = {
		collectionId: data.collectionId,
		...(data.newImmutableFields && { newImmutableFields: data.newImmutableFields }),
		...(data.newMutableFields && { newMutableFields: data.newMutableFields }),
	};

	const payload = createPayload("extend_schema", extendData);
	const operation = createHiveOperation(payload, data.creator);

	return {
		success: true,
		operations: [operation],
		keyType: getKeyType("extend_schema"),
		signer: data.creator,
		payload,
	};
}
