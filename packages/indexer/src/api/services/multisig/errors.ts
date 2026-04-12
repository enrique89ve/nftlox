import {
	isSigningQueueFullError,
	isSigningQueueTimeoutError,
} from "@/api/services/signing-queue.ts";
import type { MultisigErrorCode, MultisigResponse } from "@/protocol/index.ts";

export type MultisigDomainError = Error & Readonly<{
	readonly code: MultisigErrorCode;
}>;

type ErrorLogger = Readonly<{
	readonly error: (message: string, data?: unknown) => void;
}>;

export function createMultisigError(
	code: MultisigErrorCode,
	message: string,
	cause?: unknown,
): MultisigDomainError {
	const error = new Error(message, cause === undefined ? undefined : { cause }) as MultisigDomainError;
	return Object.assign(error, {
		name: "MultisigError",
		code,
	});
}

export function isMultisigError(value: unknown): value is MultisigDomainError {
	return (
		value instanceof Error &&
		"code" in value &&
		typeof (value as { readonly code?: unknown }).code === "string"
	);
}

export function mapErrorToMultisigResponse(err: unknown, log: ErrorLogger): MultisigResponse {
	if (isMultisigError(err)) {
		return { ok: false, code: err.code, message: err.message };
	}

	if (isSigningQueueFullError(err)) {
		return { ok: false, code: "SIGNING_QUEUE_FULL", message: err.message };
	}

	if (isSigningQueueTimeoutError(err)) {
		return { ok: false, code: "SIGNING_TIMEOUT", message: err.message };
	}

	log.error("Unexpected multisig error", { error: err instanceof Error ? err.message : String(err) });
	return { ok: false, code: "INTERNAL_ERROR", message: "An unexpected error occurred" };
}
