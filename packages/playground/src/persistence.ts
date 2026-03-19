// NFTLox Protocol - Persistence Module
// Manages minting sessions in localStorage for recovery and deduplication

import {
	deterministicHash,
	generateDeterministicCollectionId,
	generateDeterministicSeedId,
	type SeedNFTWithArtId,
	type MintingSession,
} from "nftlox-sdk";

// Re-export MintingSession type for consumers
export type { MintingSession } from "nftlox-sdk";

const STORAGE_KEY = "nftlox_minting_sessions";
const MAX_SESSIONS = 10;

// ============ SESSION ID GENERATION ============

/**
 * Generates a unique session ID from the minting parameters.
 * Same parameters always produce the same sessionId.
 */
export function generateSessionId(
	creator: string,
	collectionName: string,
	artIds: string[],
): string {
	const input = `session:${creator.toLowerCase()}:${collectionName}:${artIds.sort().join(",")}`;
	return `session_${deterministicHash(input).slice(0, 12)}`;
}

// ============ SESSION STORAGE ============

/**
 * Gets all stored sessions from localStorage.
 */
export function getAllSessions(): MintingSession[] {
	if (typeof localStorage === "undefined") return [];

	try {
		const data = localStorage.getItem(STORAGE_KEY);
		return data ? JSON.parse(data) : [];
	} catch {
		return [];
	}
}

/**
 * Gets a specific session by ID.
 */
export function getSession(sessionId: string): MintingSession | null {
	const sessions = getAllSessions();
	return sessions.find(s => s.id === sessionId) || null;
}

/**
 * Saves a session to localStorage.
 * Updates existing session or adds new one.
 */
export function saveSession(session: MintingSession): void {
	if (typeof localStorage === "undefined") return;

	const sessions = getAllSessions();
	const existingIndex = sessions.findIndex(s => s.id === session.id);

	if (existingIndex >= 0) {
		sessions[existingIndex] = session;
	} else {
		sessions.unshift(session);
		// Keep only the most recent sessions
		if (sessions.length > MAX_SESSIONS) {
			sessions.pop();
		}
	}

	localStorage.setItem(STORAGE_KEY, JSON.stringify(sessions));
}

/**
 * Deletes a session from localStorage.
 */
export function deleteSession(sessionId: string): void {
	if (typeof localStorage === "undefined") return;

	const sessions = getAllSessions();
	const filtered = sessions.filter(s => s.id !== sessionId);
	localStorage.setItem(STORAGE_KEY, JSON.stringify(filtered));
}

/**
 * Clears all sessions from localStorage.
 */
export function clearAllSessions(): void {
	if (typeof localStorage === "undefined") return;
	localStorage.removeItem(STORAGE_KEY);
}

// ============ SESSION CREATION ============

/**
 * Creates a new minting session.
 */
export function createSession(
	creator: string,
	collectionName: string,
	collectionSymbol: string,
	nfts: SeedNFTWithArtId[],
): MintingSession {
	const artIds = nfts.map(n => n.artId);
	const sessionId = generateSessionId(creator, collectionName, artIds);

	const collectionId = generateDeterministicCollectionId(
		creator,
		collectionName,
		collectionSymbol,
	);

	const seedMapping = nfts.map(nft => ({
		artId: nft.artId,
		seedId: generateDeterministicSeedId(collectionId, nft.artId),
		status: "new" as const,
	}));

	const session: MintingSession = {
		id: sessionId,
		status: "validating",
		creator,
		collectionName,
		collectionSymbol,
		nfts,
		collectionId,
		seedMapping,
		collectionBroadcast: { status: "pending" },
		seedBatches: [],
		createdAt: Date.now(),
	};

	return session;
}

// ============ SESSION UPDATES ============

/**
 * Updates the session status.
 */
export function updateSessionStatus(
	sessionId: string,
	status: MintingSession["status"],
): MintingSession | null {
	const session = getSession(sessionId);
	if (!session) return null;

	session.status = status;

	if (status === "validated") {
		session.validatedAt = Date.now();
	} else if (status === "complete") {
		session.completedAt = Date.now();
	}

	saveSession(session);
	return session;
}

/**
 * Updates the collection broadcast status.
 */
export function updateCollectionBroadcast(
	sessionId: string,
	status: MintingSession["collectionBroadcast"]["status"],
	txId?: string,
): MintingSession | null {
	const session = getSession(sessionId);
	if (!session) return null;

	session.collectionBroadcast = { status, txId };
	if (status === "confirmed") {
		session.status = "seeds_partial";
	}

	saveSession(session);
	return session;
}

/**
 * Updates a seed batch status.
 */
export function updateSeedBatch(
	sessionId: string,
	batchNumber: number,
	status: "pending" | "broadcast" | "confirmed",
	txId?: string,
): MintingSession | null {
	const session = getSession(sessionId);
	if (!session) return null;

	const batchIndex = session.seedBatches.findIndex(b => b.batchNumber === batchNumber);
	if (batchIndex >= 0) {
		session.seedBatches[batchIndex]!.status = status;
		if (txId) {
			session.seedBatches[batchIndex]!.txId = txId;
		}
	}

	// Check if all batches are confirmed
	const allConfirmed = session.seedBatches.every(b => b.status === "confirmed");
	if (allConfirmed && session.seedBatches.length > 0) {
		session.status = "complete";
		session.completedAt = Date.now();
	}

	saveSession(session);
	return session;
}

/**
 * Initializes seed batches in the session.
 */
export function initializeSeedBatches(
	sessionId: string,
	batches: Array<{ batchNumber: number; seedIds: string[] }>,
): MintingSession | null {
	const session = getSession(sessionId);
	if (!session) return null;

	session.seedBatches = batches.map(b => ({
		batchNumber: b.batchNumber,
		status: "pending",
		seedIds: b.seedIds,
	}));

	saveSession(session);
	return session;
}

// ============ SESSION RECOVERY ============

/**
 * Finds an existing session that matches the given parameters.
 * Used to recover from tab close/refresh.
 */
export function findExistingSession(
	creator: string,
	collectionName: string,
	artIds: string[],
): MintingSession | null {
	const sessionId = generateSessionId(creator, collectionName, artIds);
	return getSession(sessionId);
}

/**
 * Gets the next pending action for a session.
 * Returns what needs to be done next to continue the minting process.
 */
export function getNextAction(session: MintingSession): {
	type: "broadcast_collection" | "broadcast_batch" | "complete" | "error";
	batchNumber?: number;
	message: string;
} {
	if (session.collectionBroadcast.status !== "confirmed") {
		return {
			type: "broadcast_collection",
			message: "Collection needs to be broadcast",
		};
	}

	const pendingBatch = session.seedBatches.find(b => b.status === "pending");
	if (pendingBatch) {
		return {
			type: "broadcast_batch",
			batchNumber: pendingBatch.batchNumber,
			message: `Batch ${pendingBatch.batchNumber} needs to be broadcast`,
		};
	}

	const allConfirmed = session.seedBatches.every(b => b.status === "confirmed");
	if (allConfirmed && session.seedBatches.length > 0) {
		return {
			type: "complete",
			message: "All operations complete",
		};
	}

	return {
		type: "error",
		message: "Session in unknown state",
	};
}

// ============ SESSION INFO ============

/**
 * Gets a summary of session progress.
 */
export function getSessionProgress(session: MintingSession): {
	collectionDone: boolean;
	batchesTotal: number;
	batchesComplete: number;
	percentComplete: number;
} {
	const collectionDone = session.collectionBroadcast.status === "confirmed";
	const batchesTotal = session.seedBatches.length;
	const batchesComplete = session.seedBatches.filter(b => b.status === "confirmed").length;

	const totalSteps = 1 + batchesTotal; // 1 for collection + batches
	const completedSteps = (collectionDone ? 1 : 0) + batchesComplete;
	const percentComplete = totalSteps > 0 ? Math.round((completedSteps / totalSteps) * 100) : 0;

	return {
		collectionDone,
		batchesTotal,
		batchesComplete,
		percentComplete,
	};
}
