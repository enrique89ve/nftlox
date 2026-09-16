// Runtime protocol state — initialized from the indexer API when requested.
// Bundled constants remain active until a compatible indexer is verified.

import { PROTOCOL_VERSION, PROTOCOL_ID, isValidProtocolVersion } from "@nftlox/protocol";
import { resolveFetch, type HttpOptions } from "./http";

type ProtocolState = {
	version: string;
	protocolId: string;
	initialized: boolean;
}

const state: ProtocolState = {
	version: PROTOCOL_VERSION,
	protocolId: PROTOCOL_ID,
	initialized: false,
};

const DEFAULT_STATUS_URL = "https://api-nftlox.hivecreators.co/api/status";

type StatusResponse = {
	protocolVersion: string;
	protocolId: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/**
 * Initialize the SDK protocol state from the indexer API.
 * Must be called before creating payloads to ensure the configured indexer
 * serves the exact wire contract bundled by this SDK. A different protocol
 * id or version is rejected because the indexer validates both fields and
 * emitting a negotiated mismatch would create an operation it cannot accept.
 */
export async function initProtocol(baseUrl?: string, http?: HttpOptions): Promise<ProtocolState> {
	const url = baseUrl
		? `${baseUrl.replace(/\/+$/, "")}/api/status`
		: DEFAULT_STATUS_URL;

	const res = await resolveFetch(http)(url, { headers: http?.headers, signal: http?.signal });
	if (!res.ok) {
		throw new Error(`Failed to fetch protocol status: ${res.status}`);
	}

	const raw: unknown = await res.json();
	if (!isRecord(raw) || typeof raw.protocolVersion !== "string" || typeof raw.protocolId !== "string") {
		throw new Error("Protocol status response malformed");
	}
	const data: StatusResponse = {
		protocolVersion: raw.protocolVersion,
		protocolId: raw.protocolId,
	};
	if (!isValidProtocolVersion(data.protocolVersion)) {
		throw new Error(`Protocol status incompatible: invalid protocol version '${data.protocolVersion}'`);
	}
	if (data.protocolId !== PROTOCOL_ID) {
		throw new Error(`Protocol status incompatible: expected protocol '${PROTOCOL_ID}', got '${data.protocolId}'`);
	}
	if (data.protocolVersion !== PROTOCOL_VERSION) {
		throw new Error(`Protocol status incompatible: expected version '${PROTOCOL_VERSION}', got '${data.protocolVersion}'`);
	}
	state.version = data.protocolVersion;
	state.protocolId = data.protocolId;
	state.initialized = true;

	return { ...state };
}

/** Current protocol version (from API if initialized, otherwise from constants). */
export function getProtocolVersion(): string {
	return state.version;
}

/** Current protocol ID (from API if initialized, otherwise from constants). */
export function getProtocolId(): string {
	return state.protocolId;
}

/** Whether initProtocol() has been called successfully. */
export function isInitialized(): boolean {
	return state.initialized;
}

/** Restore the bundled contract after an explicit live initialization. */
export function resetProtocolState(): void {
	state.version = PROTOCOL_VERSION;
	state.protocolId = PROTOCOL_ID;
	state.initialized = false;
}
