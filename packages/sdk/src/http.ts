// NFTLox SDK — Shared HTTP helpers.
// Keeps the client portable across Node 18+, Bun, and the browser by allowing
// consumers to inject their own fetch implementation, headers, and AbortSignal.

import { IndexerError } from "./errors";

export type FetchFunction = typeof fetch;

const FETCH_FAILED_MESSAGES = ["fetch failed", "failed to fetch"];

const BUN_NETWORK_ERROR_CODES = [
	"ConnectionRefused",
	"ConnectionClosed",
	"FailedToOpenSocket",
	"ECONNRESET",
	"ECONNREFUSED",
	"ETIMEDOUT",
	"EPIPE",
];

function isAbortError(error: unknown): boolean {
	return (
		error instanceof Error
		&& (error.name === "AbortError" || error.name === "TimeoutError")
	);
}

function isBunNetworkError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	const code = (error as { code?: unknown }).code;
	return typeof code === "string" && BUN_NETWORK_ERROR_CODES.includes(code);
}

/**
 * Wrap low-level fetch failures (DNS, connection refused, aborts) into
 * a typed `IndexerError` with `isRetryable` set appropriately.
 * Abort errors are returned as-is so callers can distinguish cancellation
 * from network failure.
 */
export function handleFetchError({
	error,
	url,
	requestBodyValues,
}: {
	error: unknown;
	url: string;
	requestBodyValues?: unknown;
}): unknown {
	if (isAbortError(error)) return error;

	if (
		error instanceof TypeError
		&& FETCH_FAILED_MESSAGES.includes(error.message.toLowerCase())
	) {
		const cause = (error as { cause?: Error }).cause;
		if (cause != null) {
			return new IndexerError({
				message: `Cannot connect to indexer: ${cause.message}`,
				cause,
				url,
				requestBodyValues,
				isRetryable: true,
			});
		}
	}

	if (isBunNetworkError(error)) {
		return new IndexerError({
			message: `Cannot connect to indexer: ${(error as Error).message}`,
			cause: error,
			url,
			requestBodyValues,
			isRetryable: true,
		});
	}

	return error;
}

/** Convert a Headers object to a plain, serializable record. */
export function headersToRecord(headers: Headers): Record<string, string> {
	const result: Record<string, string> = {};
	headers.forEach((value, key) => {
		result[key] = value;
	});
	return result;
}

export interface HttpOptions {
	/** Custom fetch implementation (testing, proxies, retry middleware, edge runtimes). */
	readonly fetch?: FetchFunction;
	/** Extra headers merged into every request (e.g. Authorization, telemetry). */
	readonly headers?: Readonly<Record<string, string>>;
	/** AbortSignal propagated to every fetch call. */
	readonly signal?: AbortSignal;
}

/** Resolve the fetch function to use: caller-provided → global. */
export function resolveFetch(options?: HttpOptions): FetchFunction {
	return options?.fetch ?? globalThis.fetch;
}

/** Merge extra headers into a base set without mutating inputs. */
export function mergeHeaders(
	base: Readonly<Record<string, string>> | undefined,
	extra: Readonly<Record<string, string>> | undefined,
): Record<string, string> | undefined {
	if (!base && !extra) return undefined;
	return { ...base, ...extra };
}
