// NFTLox SDK — Structured errors.
// Uses a marker-symbol pattern (Symbol.for(...) + static isInstance()) so that
// identity checks survive multiple copies of the package in hoisted monorepos
// where plain `instanceof` would fail (e.g. pnpm hoisting, dual-install).

const BASE_MARKER = "nftlox.error";
const baseSymbol = Symbol.for(BASE_MARKER);

/** Base class for all nftlox-sdk errors. */
export class NftloxError extends Error {
	private readonly [baseSymbol] = true;
	override readonly cause?: unknown;

	constructor({
		name,
		message,
		cause,
	}: {
		name: string;
		message: string;
		cause?: unknown;
	}) {
		super(message);
		this.name = name;
		this.cause = cause;
	}

	static isInstance(error: unknown): error is NftloxError {
		return NftloxError.hasMarker(error, BASE_MARKER);
	}

	protected static hasMarker(error: unknown, marker: string): boolean {
		const markerSymbol = Symbol.for(marker);
		return (
			error != null
			&& typeof error === "object"
			&& markerSymbol in error
			&& (error as Record<symbol, unknown>)[markerSymbol] === true
		);
	}
}

// ============ IndexerError ============

const INDEXER_ERROR_NAME = "IndexerError";
const INDEXER_MARKER = `${BASE_MARKER}.${INDEXER_ERROR_NAME}`;
const indexerSymbol = Symbol.for(INDEXER_MARKER);

/** True when an HTTP status code should be considered retryable. */
function isRetryableStatus(statusCode: number | undefined): boolean {
	if (statusCode == null) return false;
	return (
		statusCode === 408 // Request Timeout
		|| statusCode === 409 // Conflict
		|| statusCode === 429 // Too Many Requests
		|| statusCode >= 500 // Server errors
	);
}

export interface IndexerErrorInit {
	readonly message: string;
	readonly url: string;
	readonly requestBodyValues?: unknown;
	readonly statusCode?: number;
	readonly responseHeaders?: Readonly<Record<string, string>>;
	readonly responseBody?: string;
	readonly cause?: unknown;
	readonly isRetryable?: boolean;
	readonly data?: unknown;
}

/**
 * Error thrown by all indexer HTTP calls. Carries full request/response context
 * and an `isRetryable` flag auto-derived from the HTTP status code.
 * Consumers should prefer `IndexerError.isInstance(err)` over `instanceof` to
 * survive hoisted/duplicated copies of the SDK.
 */
export class IndexerError extends NftloxError {
	private readonly [indexerSymbol] = true;

	readonly url: string;
	readonly requestBodyValues: unknown;
	readonly statusCode?: number;
	readonly responseHeaders?: Readonly<Record<string, string>>;
	readonly responseBody?: string;
	readonly isRetryable: boolean;
	readonly data?: unknown;

	constructor(init: IndexerErrorInit) {
		super({
			name: INDEXER_ERROR_NAME,
			message: init.message,
			cause: init.cause,
		});
		this.url = init.url;
		this.requestBodyValues = init.requestBodyValues;
		this.statusCode = init.statusCode;
		this.responseHeaders = init.responseHeaders;
		this.responseBody = init.responseBody;
		this.isRetryable = init.isRetryable ?? isRetryableStatus(init.statusCode);
		this.data = init.data;
	}

	/** @deprecated Use `statusCode`. Kept for backwards compatibility. */
	get status(): number {
		return this.statusCode ?? 0;
	}

	/** @deprecated Use `responseBody`. Kept for backwards compatibility. */
	get body(): string {
		return this.responseBody ?? "";
	}

	static override isInstance(error: unknown): error is IndexerError {
		return NftloxError.hasMarker(error, INDEXER_MARKER);
	}
}

// ============ MultisigError ============

const MULTISIG_ERROR_NAME = "MultisigError";
const MULTISIG_MARKER = `${BASE_MARKER}.${MULTISIG_ERROR_NAME}`;
const multisigSymbol = Symbol.for(MULTISIG_MARKER);

export interface MultisigErrorInit extends IndexerErrorInit {
	readonly code?: string | null;
}

/** Thrown specifically by the multisig endpoints. Exposes the server-provided error `code`. */
export class MultisigError extends IndexerError {
	private readonly [multisigSymbol] = true;
	readonly code: string | null;

	constructor(init: MultisigErrorInit) {
		super(init);
		// Overwrite `name` set by IndexerError's super() call.
		this.name = MULTISIG_ERROR_NAME;
		this.code = init.code ?? null;
	}

	static override isInstance(error: unknown): error is MultisigError {
		return NftloxError.hasMarker(error, MULTISIG_MARKER);
	}
}
