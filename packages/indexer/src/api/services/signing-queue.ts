/**
 * Signing Queue — serializes Beekeeper signing operations to prevent
 * Hive nonce conflicts when multiple multisig requests arrive concurrently.
 *
 * Hive requires sequential broadcasting per account. If a buy and a
 * create_collection arrive simultaneously, signing both concurrently would
 * cause the second TX to be rejected by the blockchain (duplicate/nonce error).
 *
 * This queue ensures all signing operations execute one at a time via a
 * Promise chain.
 */

import { createLogger } from "@/utils/logger.ts";

const log = createLogger("signing-queue");

const DEFAULT_MAX_QUEUE_LENGTH = 50;
const DEFAULT_TIMEOUT_MS = 10_000;

export type SigningQueueOptions = Readonly<{
	readonly maxQueueLength?: number;
	readonly timeoutMs?: number;
}>;

export type SigningQueueMetrics = Readonly<{
	readonly pending: number;
	readonly queued: number;
	readonly inFlight: number;
	readonly completed: number;
	readonly failed: number;
	readonly averageLatencyMs: number;
}>;

export type SigningQueue = Readonly<{
	/** Enqueue a signing task. Resolves when the task completes. */
	readonly enqueue: <T>(fn: () => T | Promise<T>) => Promise<T>;
	/** Current number of queued + in-flight tasks. */
	readonly pending: number;
	readonly getMetrics: () => SigningQueueMetrics;
}>;

type SigningQueueErrorCode = "SIGNING_QUEUE_FULL" | "SIGNING_TIMEOUT";

export type SigningQueueError = Error & Readonly<{
	readonly code: SigningQueueErrorCode;
}>;

function createSigningQueueError(code: SigningQueueErrorCode, message: string): SigningQueueError {
	const error = new Error(message) as SigningQueueError;
	return Object.assign(error, {
		name: "SigningQueueError",
		code,
	});
}

function isSigningQueueError(value: unknown, code: SigningQueueErrorCode): value is SigningQueueError {
	return (
		value instanceof Error &&
		"code" in value &&
		(value as { readonly code?: unknown }).code === code
	);
}

export function isSigningQueueFullError(value: unknown): value is SigningQueueError {
	return isSigningQueueError(value, "SIGNING_QUEUE_FULL");
}

export function isSigningQueueTimeoutError(value: unknown): value is SigningQueueError {
	return isSigningQueueError(value, "SIGNING_TIMEOUT");
}

export function createSigningQueue(options?: SigningQueueOptions): SigningQueue {
	const maxLength = options?.maxQueueLength ?? DEFAULT_MAX_QUEUE_LENGTH;
	const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	let tail: Promise<void> = Promise.resolve();
	let queued = 0;
	let inFlight = 0;
	let completed = 0;
	let failed = 0;
	let totalLatencyMs = 0;

	function getPending(): number {
		return queued + inFlight;
	}

	function getMetrics(): SigningQueueMetrics {
		const finished = completed + failed;
		return {
			pending: getPending(),
			queued,
			inFlight,
			completed,
			failed,
			averageLatencyMs: finished === 0 ? 0 : totalLatencyMs / finished,
		};
	}

	function runWithTimeout<T>(fn: () => T | Promise<T>): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			let settled = false;
			const timer = setTimeout(() => {
				if (settled) return;
				settled = true;
				reject(createSigningQueueError("SIGNING_TIMEOUT", `Signing task timed out after ${timeoutMs}ms`));
			}, timeoutMs);

			Promise.resolve()
				.then(fn)
				.then(
					(result) => {
						if (settled) return;
						settled = true;
						clearTimeout(timer);
						resolve(result);
					},
					(err: unknown) => {
						if (settled) return;
						settled = true;
						clearTimeout(timer);
						reject(err);
					},
				);
		});
	}

	async function enqueue<T>(fn: () => T | Promise<T>): Promise<T> {
		const pending = getPending();
		if (pending >= maxLength) {
			log.warn("Signing queue full", { ...getMetrics(), maxLength });
			throw createSigningQueueError(
				"SIGNING_QUEUE_FULL",
				`Signing queue full (${pending}/${maxLength}). Try again later.`,
			);
		}

		queued++;
		const enqueuedAt = Date.now();

		const task = tail.then(async () => {
			queued--;
			inFlight++;
			try {
				const result = await runWithTimeout(fn);
				completed++;
				return result;
			} catch (err) {
				failed++;
				throw err;
			} finally {
				inFlight--;
				totalLatencyMs += Date.now() - enqueuedAt;
			}
		});

		tail = task.then(
			() => undefined,
			() => undefined,
		);

		return task;
	}

	return {
		enqueue,
		get pending() {
			return getPending();
		},
		getMetrics,
	};
}
