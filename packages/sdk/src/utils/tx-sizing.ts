import { MAX_JSON_SIZE } from "../constants";
import type { HiveOperation } from "../types";

export interface TxValidationResult {
	valid: boolean;
	error?: string;
}

export function estimateOperationSize(operation: HiveOperation): number {
	return new TextEncoder().encode(JSON.stringify(operation)).length;
}

export function validateOperationSize(operation: HiveOperation): TxValidationResult {
	const size = estimateOperationSize(operation);
	if (size > MAX_JSON_SIZE) {
		return {
			valid: false,
			error: `Operation size (${size} bytes) exceeds maximum (${MAX_JSON_SIZE} bytes)`,
		};
	}
	return { valid: true };
}

export function splitIntoBatches<T>(items: T[], maxBatchSize: number): T[][] {
	const batches: T[][] = [];
	for (let i = 0; i < items.length; i += maxBatchSize) {
		batches.push(items.slice(i, i + maxBatchSize));
	}
	return batches;
}

export function calculateMaxOperationsPerTx(
	sampleOperation: HiveOperation,
): number {
	const operationSize = estimateOperationSize(sampleOperation);
	const maxTxSize = 65000;
	const overhead = 500;
	return Math.floor((maxTxSize - overhead) / operationSize);
}
