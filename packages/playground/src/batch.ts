// NFTLox Protocol - Playground Batch Processing

import type { HiveOperation } from "nftlox-sdk";
import { DEFAULT_MAX_OPERATIONS_PER_BATCH } from "./constants";

// ============ TYPES ============

export interface BatchInfo {
	batchNumber: number;
	operations: HiveOperation[];
	size: number;
}

export interface BatchSplitResult {
	batches: BatchInfo[];
	summary: {
		totalOperations: number;
		totalBatches: number;
		averageOperationsPerBatch: number;
	};
}

// ============ BATCH PROCESSING ============

/**
 * Calculates the size in bytes of an operation.
 */
function getOperationSize(operation: HiveOperation): number {
	return JSON.stringify(operation).length;
}

/**
 * Calculates total size of operations batch in bytes.
 */
function calculateBatchSize(operations: HiveOperation[]): number {
	return operations.reduce((total, op) => total + getOperationSize(op), 0);
}

/**
 * Splits operations into batches to avoid transaction limits.
 * Each batch respects the maximum operations per transaction constraint.
 */
export function splitOperationsIntoBatches(
	operations: HiveOperation[],
	maxPerBatch: number = DEFAULT_MAX_OPERATIONS_PER_BATCH,
): BatchSplitResult {
	const batches: BatchInfo[] = [];

	for (let i = 0; i < operations.length; i += maxPerBatch) {
		const endIndex = Math.min(i + maxPerBatch, operations.length);
		const batchOperations = operations.slice(i, endIndex);

		batches.push({
			batchNumber: batches.length + 1,
			operations: batchOperations,
			size: calculateBatchSize(batchOperations),
		});
	}

	const averageOperationsPerBatch =
		batches.length > 0 ? operations.length / batches.length : 0;

	return {
		batches,
		summary: {
			totalOperations: operations.length,
			totalBatches: batches.length,
			averageOperationsPerBatch: Math.round(averageOperationsPerBatch * 100) / 100,
		},
	};
}

/**
 * Gets information about a specific batch without creating all batches.
 * Useful for previewing or processing batches one at a time.
 */
export function getBatchAtIndex(
	operations: HiveOperation[],
	batchIndex: number,
	maxPerBatch: number = DEFAULT_MAX_OPERATIONS_PER_BATCH,
): BatchInfo | null {
	const startIndex = batchIndex * maxPerBatch;

	if (startIndex >= operations.length) {
		return null;
	}

	const endIndex = Math.min(startIndex + maxPerBatch, operations.length);
	const batchOperations = operations.slice(startIndex, endIndex);

	return {
		batchNumber: batchIndex + 1,
		operations: batchOperations,
		size: calculateBatchSize(batchOperations),
	};
}

/**
 * Calculates the total number of batches needed for operations.
 */
export function calculateTotalBatches(
	operationsCount: number,
	maxPerBatch: number = DEFAULT_MAX_OPERATIONS_PER_BATCH,
): number {
	return Math.ceil(operationsCount / maxPerBatch);
}
