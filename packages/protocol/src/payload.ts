import {
	SAFE_PAYLOAD_MAX_BYTES,
	PROTOCOL_ID,
	PROTOCOL_VERSION,
	isProtocolAction,
	type ProtocolAction,
} from "./constants";
import { ACTION_AUTH_LEVEL } from "./auth";
import type { ProtocolPayload, HiveOperation } from "./types";

export type CreatePayloadOptions = {
	readonly protocol?: string | undefined;
	readonly version?: string | undefined;
};

export function createPayload<T>(
	action: ProtocolAction,
	data: T,
	options?: CreatePayloadOptions,
): ProtocolPayload<T> {
	if (!isProtocolAction(action)) {
		throw new Error(`Unsupported protocol action: ${String(action)}`);
	}
	return {
		protocol: options?.protocol ?? PROTOCOL_ID,
		version: options?.version ?? PROTOCOL_VERSION,
		action,
		data,
	};
}

export class PayloadTooLargeError extends Error {
	readonly payloadBytes: number;
	readonly maxBytes: number;
	readonly suggestedMaxItems: number;

	constructor(payloadBytes: number, maxBytes: number, itemCount: number) {
		const ratio = maxBytes / payloadBytes;
		const suggestedMaxItems = Math.max(1, Math.floor(itemCount * ratio));
		super(
			`Payload too large: ${payloadBytes} bytes (limit: ${maxBytes}). ` +
				`Try reducing to ~${suggestedMaxItems} items per batch.`,
		);
		this.name = "PayloadTooLargeError";
		this.payloadBytes = payloadBytes;
		this.maxBytes = maxBytes;
		this.suggestedMaxItems = suggestedMaxItems;
	}
}

function safeStringify(payload: unknown, itemCount = 0): string {
	const json = JSON.stringify(payload);
	if (json.length > SAFE_PAYLOAD_MAX_BYTES) {
		throw new PayloadTooLargeError(json.length, SAFE_PAYLOAD_MAX_BYTES, itemCount);
	}
	return json;
}

export function createHiveOperation(
	payload: ProtocolPayload<unknown>,
	signer: string,
): HiveOperation {
	const action = payload.action;
	if (!isProtocolAction(action)) {
		throw new Error(`Unsupported protocol action: ${String(action)}`);
	}
	const level = ACTION_AUTH_LEVEL[action];
	const json = safeStringify(payload);
	return [
		"custom_json",
		level === "active"
			? { required_auths: [signer], required_posting_auths: [], id: payload.protocol, json }
			: { required_auths: [], required_posting_auths: [signer], id: payload.protocol, json },
	];
}
