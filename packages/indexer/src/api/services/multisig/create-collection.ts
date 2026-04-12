import { symbolTakenByCreator } from "@/db/queries/collections.ts";
import { createMultisigError } from "@/api/services/multisig/errors.ts";
import {
	getLastOperation,
	isRecord,
	parseCollectionPayload,
	parseHiveAmount,
	validateBoundedPayloadString,
	validateCommonTransactionStructure,
	validateCustomJsonOperation,
	validateNonEmptyString,
	validatePayloadDataString,
	validateRecord,
	validateTransferBody,
} from "@/api/services/multisig/transaction.ts";
import { formatSchemaErrors } from "@/utils/data-transforms.ts";
import { feeOracle } from "@/utils/fee-oracle.ts";
import { optionalCollectionSchema } from "@/utils/validation.ts";
import {
	MAX_DESCRIPTION_LENGTH,
	MAX_ID_LENGTH,
	MAX_IMAGE_URL_LENGTH,
	MAX_NAME_LENGTH,
	MAX_ROYALTY_PCT,
	MAX_URL_LENGTH,
	PROTOCOL_COLLECTION_FEE_HBD,
	generateDeterministicCollectionId,
	validateHiveUsername,
	validateSchemaDefinition,
} from "@/protocol/index.ts";
import type {
	CollectionRequestShape,
	MultisigProcessContext,
	TransactionOperationInput,
	ValidatedCollectionPayload,
	ValidatedCollectionTransaction,
	ValidatedTransferOp,
} from "./types.ts";

const CREATE_COLLECTION_OPERATION_COUNT = 2;
const SYMBOL_REGEX = /^[A-Z][A-Z0-9]{2,9}$/;

export async function processCollectionRequest(
	rawBody: unknown,
	ctx: MultisigProcessContext,
) {
	const requestShape = validateCollectionRequestShape(rawBody);
	const transaction = await validateCollectionTransactionStructure(
		requestShape.transaction,
		requestShape.creator,
		ctx,
	);

	return ctx.sign(transaction);
}

function validateCollectionRequestShape(raw: unknown): CollectionRequestShape {
	if (!isRecord(raw)) {
		throw createMultisigError("INVALID_TX_STRUCTURE", "Request body must be a JSON object");
	}

	const creator = raw.creator === undefined
		? null
		: validateNonEmptyString(raw.creator, "Field 'creator' must be a non-empty string");

	if (creator) {
		const usernameError = validateHiveUsername(creator);
		if (usernameError) {
			throw createMultisigError("INVALID_TX_STRUCTURE", `Invalid creator username: ${usernameError}`);
		}
	}

	return {
		creator,
		transaction: validateRecord(raw.transaction, "INVALID_TX_STRUCTURE", "Field 'transaction' must be an object"),
	};
}

async function validateCollectionTransactionStructure(
	tx: Record<string, unknown>,
	expectedCreator: string | null,
	ctx: MultisigProcessContext,
): Promise<ValidatedCollectionTransaction> {
	const validated = validateCommonTransactionStructure(tx);
	if (validated.operations.length !== CREATE_COLLECTION_OPERATION_COUNT) {
		throw createMultisigError(
			"INVALID_TX_STRUCTURE",
			`create_collection requires exactly ${CREATE_COLLECTION_OPERATION_COUNT} operations: fee transfer + custom_json`,
		);
	}

	const transferOperations = await validateCollectionFeeTransfer(
		validated.operations.slice(0, -1),
		expectedCreator,
		ctx.nodeAccount,
	);
	const customJsonOperation = validateCustomJsonOperation(
		getLastOperation(validated.operations),
		ctx.nodeAccount,
		ctx.protocolId,
		parseCollectionPayload,
	);

	await validateCollectionPayloadData(customJsonOperation.payload, transferOperations[0].from, ctx);

	return {
		...validated,
		transferOperations,
		customJsonOperation,
	};
}

async function validateCollectionFeeTransfer(
	ops: ReadonlyArray<TransactionOperationInput>,
	expectedCreator: string | null,
	nodeAccount: string,
): Promise<readonly [ValidatedTransferOp]> {
	if (ops.length !== 1) {
		throw createMultisigError("INVALID_TX_STRUCTURE", "create_collection requires exactly one fee transfer");
	}

	const op = ops[0];
	if (!op || op.name !== "transfer") {
		throw createMultisigError(
			"INVALID_TX_STRUCTURE",
			`Expected 'transfer' operation, got '${String(op?.name)}'`,
		);
	}

	const { from, to, amount, memo } = validateTransferBody(op.body);
	const usernameError = validateHiveUsername(from);
	if (usernameError) {
		throw createMultisigError("INVALID_TX_STRUCTURE", `Invalid creator username: ${usernameError}`);
	}

	if (expectedCreator !== null && from !== expectedCreator) {
		throw createMultisigError(
			"MISSING_BUYER_AUTH",
			`Fee transfer 'from' must match creator ('${expectedCreator}'), got '${from}'`,
		);
	}

	if (to !== nodeAccount) {
		throw createMultisigError(
			"INVALID_PAYMENT_SPLIT",
			`Collection fee must be paid to node account '${nodeAccount}', got '${to}'`,
		);
	}

	const parsedAmount = parseHiveAmount(amount);
	const feeValid = await feeOracle.validateFee(
		PROTOCOL_COLLECTION_FEE_HBD,
		parsedAmount.amount,
		parsedAmount.currency,
	);
	if (!feeValid) {
		throw createMultisigError(
			"INVALID_PAYMENT_SPLIT",
			`Insufficient collection fee: expected ${PROTOCOL_COLLECTION_FEE_HBD} HBD or HIVE equivalent`,
		);
	}

	return [{ from, to, amount, memo, parsedAmount }];
}

async function validateCollectionPayloadData(
	payload: ValidatedCollectionPayload,
	creator: string,
	ctx: MultisigProcessContext,
): Promise<void> {
	const data = payload.data;
	const id = validateBoundedPayloadString(data.id, "id", MAX_ID_LENGTH);
	const name = validateBoundedPayloadString(data.name, "name", MAX_NAME_LENGTH);
	const symbol = validateCollectionSymbol(data.symbol);
	validateOptionalPayloadCreator(data.creator, creator);

	const canonicalId = await generateDeterministicCollectionId(creator, name, symbol);
	if (id !== canonicalId) {
		throw createMultisigError(
			"INVALID_PROTOCOL_PAYLOAD",
			`Non-canonical collectionId: expected ${canonicalId}, got ${id}`,
		);
	}

	if (await symbolTakenByCreator(creator, symbol, ctx.db)) {
		throw createMultisigError("INVALID_PROTOCOL_PAYLOAD", `Symbol ${symbol} already used by @${creator}`);
	}

	validateCollectionMetadata(data.metadata);
	validateCollectionRules(data.rules);
	validateTotalPotential(data.totalPotential);
	validateCollectionSchema(data.schema);
}

function validateOptionalPayloadCreator(value: unknown, creator: string): void {
	if (value === undefined || value === null) return;
	if (value !== creator) {
		throw createMultisigError(
			"INVALID_PROTOCOL_PAYLOAD",
			`Payload creator mismatch: expected '${creator}', got '${String(value)}'`,
		);
	}
}

function validateCollectionMetadata(value: unknown): void {
	if (!isRecord(value)) {
		throw createMultisigError("INVALID_PROTOCOL_PAYLOAD", "Payload data.metadata must be an object");
	}

	validateBoundedPayloadString(value.description, "metadata.description", MAX_DESCRIPTION_LENGTH);
	validateBoundedPayloadString(value.image, "metadata.image", MAX_IMAGE_URL_LENGTH);
	if (value.externalUrl !== undefined && value.externalUrl !== null) {
		validateBoundedPayloadString(value.externalUrl, "metadata.externalUrl", MAX_URL_LENGTH);
	}
}

function validateCollectionRules(value: unknown): void {
	if (!isRecord(value)) {
		throw createMultisigError("INVALID_PROTOCOL_PAYLOAD", "Payload data.rules must be an object");
	}

	if (typeof value.transferable !== "boolean") {
		throw createMultisigError("INVALID_PROTOCOL_PAYLOAD", "Payload data.rules.transferable must be a boolean");
	}
	if (typeof value.burnable !== "boolean") {
		throw createMultisigError("INVALID_PROTOCOL_PAYLOAD", "Payload data.rules.burnable must be a boolean");
	}
	if (typeof value.royaltyPct !== "number" || !Number.isFinite(value.royaltyPct)) {
		throw createMultisigError("INVALID_PROTOCOL_PAYLOAD", "Payload data.rules.royaltyPct must be a finite number");
	}
	if (value.royaltyPct < 0 || value.royaltyPct > MAX_ROYALTY_PCT) {
		throw createMultisigError(
			"INVALID_PROTOCOL_PAYLOAD",
			`Payload data.rules.royaltyPct must be between 0 and ${MAX_ROYALTY_PCT}`,
		);
	}
	if (
		value.royaltyRecipient !== undefined &&
		value.royaltyRecipient !== null &&
		typeof value.royaltyRecipient !== "string"
	) {
		throw createMultisigError("INVALID_PROTOCOL_PAYLOAD", "Payload data.rules.royaltyRecipient must be a string");
	}
}

function validateTotalPotential(value: unknown): void {
	if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
		throw createMultisigError(
			"INVALID_PROTOCOL_PAYLOAD",
			"Payload data.totalPotential must be a non-negative integer",
		);
	}
}

function validateCollectionSchema(value: unknown): void {
	try {
		const schema = optionalCollectionSchema(value);
		if (!schema) return;

		const schemaErrors = validateSchemaDefinition(schema);
		if (schemaErrors.length > 0) {
			throw new Error(formatSchemaErrors(schemaErrors));
		}
	} catch (cause) {
		throw createMultisigError(
			"INVALID_PROTOCOL_PAYLOAD",
			`Invalid schema: ${cause instanceof Error ? cause.message : String(cause)}`,
			cause,
		);
	}
}

function validateCollectionSymbol(value: unknown): string {
	const symbol = validatePayloadDataString(value, "symbol");
	if (!SYMBOL_REGEX.test(symbol)) {
		throw createMultisigError(
			"INVALID_PROTOCOL_PAYLOAD",
			"Payload data.symbol must be 3-10 uppercase characters and start with a letter",
		);
	}

	return symbol;
}
