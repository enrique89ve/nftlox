// Runtime protocol state — initialized from the indexer API.
// Falls back to constants if not initialized (offline mode).

import { PROTOCOL_VERSION, PROTOCOL_ID } from "./constants";

interface ProtocolState {
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

interface StatusResponse {
	protocolVersion: string;
	protocolId: string;
}

/**
 * Initialize the SDK protocol state from the indexer API.
 * Must be called before creating payloads to ensure correct version.
 * Falls back to built-in constants on failure.
 */
export async function initProtocol(baseUrl?: string): Promise<ProtocolState> {
	const url = baseUrl
		? `${baseUrl.replace(/\/+$/, "")}/api/status`
		: DEFAULT_STATUS_URL;

	const res = await fetch(url);
	if (!res.ok) {
		throw new Error(`Failed to fetch protocol status: ${res.status}`);
	}

	const data = (await res.json()) as StatusResponse;
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
