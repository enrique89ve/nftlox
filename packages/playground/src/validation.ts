// NFTLox Protocol - Playground Validation Functions

import { PROTOCOL_ID, PROTOCOL_VERSION, type HiveOperation } from "nftlox-sdk";
import {
	type OperationValidationError,
	createVersionMismatchError,
	createProtocolMismatchError,
	createInvalidJsonError,
} from "./constants";
import { getArrayElement } from "./utils";

// ============ TYPES ============

export interface OperationValidationResult {
	valid: boolean;
	errors: OperationValidationError[];
	summary: {
		total: number;
		valid: number;
		invalid: number;
	};
}

interface ParsedOperationPayload {
	version?: string;
	protocol?: string;
}

// ============ VALIDATION FUNCTIONS ============

/**
 * Parses operation JSON safely with error context.
 */
function parseOperationPayload(
	operation: HiveOperation,
	operationIndex: number,
): { success: true; payload: ParsedOperationPayload } | { success: false; error: OperationValidationError } {
	try {
		const payload = JSON.parse(operation[1].json) as ParsedOperationPayload;
		return { success: true, payload };
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		return {
			success: false,
			error: createInvalidJsonError(operationIndex, errorMessage),
		};
	}
}

/**
 * Validates a single operation's version and protocol.
 */
function validateSingleOperation(
	operation: HiveOperation,
	operationIndex: number,
	expectedVersion: string,
	expectedProtocol: string,
): OperationValidationError[] {
	const errors: OperationValidationError[] = [];

	const parseResult = parseOperationPayload(operation, operationIndex);

	if (!parseResult.success) {
		errors.push(parseResult.error);
		return errors;
	}

	const { payload } = parseResult;

	if (payload.version && payload.version !== expectedVersion) {
		errors.push(createVersionMismatchError(operationIndex, payload.version, expectedVersion));
	}

	if (payload.protocol && payload.protocol !== expectedProtocol) {
		errors.push(createProtocolMismatchError(operationIndex, payload.protocol, expectedProtocol));
	}

	return errors;
}

/**
 * Validates operations for correct protocol version and ID.
 * Returns detailed validation results with typed errors.
 */
export function validateOperationsVersion(
	operations: HiveOperation[],
	expectedVersion: string = PROTOCOL_VERSION,
	expectedProtocol: string = PROTOCOL_ID,
): OperationValidationResult {
	const errors: OperationValidationError[] = [];

	for (let i = 0; i < operations.length; i++) {
		const operation = getArrayElement(operations, i, "validateOperationsVersion");
		const operationErrors = validateSingleOperation(operation, i, expectedVersion, expectedProtocol);
		errors.push(...operationErrors);
	}

	const validCount = operations.length - errors.length;

	return {
		valid: errors.length === 0,
		errors,
		summary: {
			total: operations.length,
			valid: validCount,
			invalid: errors.length,
		},
	};
}

/**
 * Calculates the size in bytes of an operation.
 */
export function getOperationSize(operation: HiveOperation): number {
	return JSON.stringify(operation).length;
}

/**
 * Calculates total size of all operations in bytes.
 */
export function getTotalOperationsSize(operations: HiveOperation[]): number {
	return operations.reduce((total, op) => total + getOperationSize(op), 0);
}
