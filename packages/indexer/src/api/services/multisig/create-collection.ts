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
	validatePayloadDataString,
	validateRecord,
	validateTransferBody,
} from "@/api/services/multisig/transaction.ts";
import { formatSchemaErrors } from "@/utils/data-transforms.ts";
import { feeValidator } from "@/utils/fee-validator.ts";
import { optionalCollectionSchema } from "@/utils/validation.ts";
import {
	INSTANCE_FEE_PER_N,
	MAX_DESCRIPTION_LENGTH,
	MAX_ID_LENGTH,
	MAX_IMAGE_URL_LENGTH,
	MAX_NAME_LENGTH,
	MAX_ROYALTY_PCT,
	MAX_URL_LENGTH,
	PROTOCOL_COLLECTION_FEE_HBD,
	SYMBOL_REGEX,
	generateDeterministicCollectionId,
	validateHiveUsername,
	validateSchemaDefinition,
} from "@/protocol/index.ts";
import type {
	CollectionRequestShape,
	MultisigCollectionContext,
	TransactionOperationInput,
	ValidatedCollectionPayload,
	ValidatedCollectionTransaction,
	ValidatedTransferOp,
} from "./types.ts";

const CREATE_COLLECTION_OPERATION_COUNT = 2;

export async function processCollectionRequest(
	rawBody: unknown,
	ctx: MultisigCollectionContext,
) {
	const requestShape = validateCollectionRequestShape(rawBody);
	const transaction = await validateCollectionTransactionStructure(
		requestShape.transaction,
		ctx,
	);

	// After validation the creator + symbol are known; acquire the per-
	// (creator, symbol) lock BEFORE signing so two concurrent requests for the
	// same collection can't both get co-signed (only one wins on-chain and the
	// loser forfeits the fee). Holder is a per-request UUID, so a same-creator
	// same-symbol parallel request gets rejected instead of refreshing the slot.
	const transferOp = transaction.transferOperations[0];
	if (!transferOp) {
		throw createMultisigError("INVALID_TX_STRUCTURE", "Missing fee transfer after validation");
	}
	const creator = transferOp.from;
	const symbol = String(transaction.customJsonOperation.payload.data.symbol);
	const acquisition = await ctx.collectionLock.acquire(creator, symbol);
	if (!acquisition.acquired) {
		throw createMultisigError(
			"COLLECTION_LOCKED",
			`A collection signing for ${creator}/${symbol} is already in flight. Retry after ${acquisition.retryAfterMs}ms`,
			{ retryAfterMs: acquisition.retryAfterMs },
		);
	}

	let signingSucceeded = false;
	try {
		const response = await ctx.sign(transaction);
		if (response.ok) {
			signingSucceeded = true;
		}
		return response;
	} finally {
		// On success, leave the lock to expire naturally so a second request can't
		// be signed while the first tx is still within its broadcast window.
		if (!signingSucceeded) {
			await ctx.collectionLock.release(creator, symbol);
		}
	}
}

function validateCollectionRequestShape(raw: unknown): CollectionRequestShape {
	if (!isRecord(raw)) {
		throw createMultisigError("INVALID_TX_STRUCTURE", "Request body must be a JSON object");
	}

	return {
		transaction: validateRecord(raw.transaction, "INVALID_TX_STRUCTURE", "Field 'transaction' must be an object"),
	};
}

async function validateCollectionTransactionStructure(
	tx: Record<string, unknown>,
	ctx: MultisigCollectionContext,
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

	if (to !== nodeAccount) {
		throw createMultisigError(
			"INVALID_PAYMENT_SPLIT",
			`Collection fee must be paid to node account '${nodeAccount}', got '${to}'`,
		);
	}

	const parsedAmount = parseHiveAmount(amount);
	// Early currency gate so the multisig returns a clearer error than the
	// generic "insufficient fee" one when someone builds a HIVE payment. The
	// consensus-path `validateFixedFee` would reject the same op post-broadcast
	// anyway, but refusing to sign up-front saves the user a wasted broadcast.
	if (parsedAmount.currency !== "HBD") {
		throw createMultisigError(
			"INVALID_PAYMENT_SPLIT",
			`Collection fee must be paid in HBD, got ${parsedAmount.currency}`,
		);
	}
	const feeValid = await feeValidator.validateFee(
		PROTOCOL_COLLECTION_FEE_HBD,
		parsedAmount.amount,
		parsedAmount.currency,
	);
	if (!feeValid) {
		throw createMultisigError(
			"INVALID_PAYMENT_SPLIT",
			`Insufficient collection fee: expected exactly ${PROTOCOL_COLLECTION_FEE_HBD} HBD, got ${parsedAmount.amount.toFixed(3)} HBD`,
		);
	}

	return [{ from, to, amount, memo, parsedAmount }];
}

async function validateCollectionPayloadData(
	payload: ValidatedCollectionPayload,
	creator: string,
	ctx: MultisigCollectionContext,
): Promise<void> {
	const data = payload.data;
	const id = validateBoundedPayloadString(data.id, "id", MAX_ID_LENGTH);
	const name = validateBoundedPayloadString(data.name, "name", MAX_NAME_LENGTH);
	const symbol = validateCollectionSymbol(data.symbol);

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
	validateMaxInstances(data.maxInstances);
	validateCollectionSchema(data.schema);
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

function validateMaxInstances(value: unknown): void {
	if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
		throw createMultisigError(
			"INVALID_PROTOCOL_PAYLOAD",
			"Payload data.maxInstances must be a non-negative integer",
		);
	}
	if (value > 0 && value % INSTANCE_FEE_PER_N !== 0) {
		throw createMultisigError(
			"INVALID_PROTOCOL_PAYLOAD",
			`Payload data.maxInstances must be 0 (unlimited) or a positive multiple of ${INSTANCE_FEE_PER_N}`,
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
			{ cause },
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
