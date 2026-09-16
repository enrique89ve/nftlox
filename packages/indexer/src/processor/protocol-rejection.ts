/**
 * Deterministic protocol failures are part of the replay result. They may be
 * recorded in `invalid_operations` and the sync cursor may continue. Anything
 * else is an execution failure and must abort the batch.
 */
export type ProtocolRejectionCode =
	| "PROTOCOL_REJECTION"
	| "BURN_RECIPIENT_DELEGATION_FORBIDDEN";

export type ProtocolRejectionError = Error & Readonly<{
	readonly kind: "protocol-rejection";
	readonly code: ProtocolRejectionCode;
}>;

export const DELEGATED_BURN_REJECTION_REASON =
	"Delegated Asset transfers cannot target the burn account";

export function protocolReject(
	message: string,
	code: ProtocolRejectionCode = "PROTOCOL_REJECTION",
): ProtocolRejectionError {
	return Object.assign(new Error(message), {
		kind: "protocol-rejection" as const,
		code,
	});
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

export function isProtocolRejection(error: unknown): error is ProtocolRejectionError {
	return (
		isRecord(error) &&
		error.kind === "protocol-rejection" &&
		typeof error.code === "string" &&
		error instanceof Error
	);
}

const TRANSIENT_SQLSTATES = new Set([
	"40001", // serialization_failure
	"40P01", // deadlock_detected
	"55P03", // lock_not_available
	"57014", // query_canceled, including statement_timeout
	"53300", // too_many_connections
	"57P01", // admin_shutdown
]);

function readErrorCode(error: unknown): string | null {
	if (!isRecord(error) || typeof error.code !== "string") return null;
	return error.code;
}

export function isTransientExecutionError(error: unknown): boolean {
	const code = readErrorCode(error);
	if (code && (TRANSIENT_SQLSTATES.has(code) || code.startsWith("08"))) return true;
	if (code === "ECONNRESET" || code === "ETIMEDOUT" || code === "EPIPE") return true;
	if (isRecord(error) && "cause" in error) return isTransientExecutionError(error.cause);
	return false;
}

export type ExecutionClassification =
	| Readonly<{
			readonly kind: "rejected";
			readonly code: ProtocolRejectionCode;
			readonly message: string;
		}>
	| Readonly<{
			readonly kind: "fatal";
			readonly transient: boolean;
			readonly message: string;
		}>;

export function classifyExecutionError(error: unknown): ExecutionClassification {
	if (isProtocolRejection(error)) {
		return { kind: "rejected", code: error.code, message: error.message };
	}

	return {
		kind: "fatal",
		transient: isTransientExecutionError(error),
		message: error instanceof Error ? error.message : String(error),
	};
}
