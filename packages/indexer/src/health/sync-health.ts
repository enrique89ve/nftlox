export const STALE_THRESHOLD_MS = 60_000;

export type SyncHealthMode = "liveness" | "readiness";

export type SyncState = "starting" | "catching-up" | "ready" | "stale" | "unreachable";

export type SyncHealthInput = Readonly<{
	nowMs: number;
	startupTimeMs: number;
	lastUpdateTimeMs: number;
	lastBlock: number;
	headBlock: number;
	irreversibleBlock: number;
	toleranceBlocks: number;
}>;

export type SyncHealthSnapshot = Readonly<{
	lastBlock: number;
	headBlock: number;
	irreversibleBlock: number;
	blocksBehind: number;
	secondsSinceUpdate: number | null;
	hiveReachable: boolean;
	syncActive: boolean;
	inSync: boolean;
	live: boolean;
	ready: boolean;
	syncState: SyncState;
}>;

export function evaluateSyncHealth(input: SyncHealthInput): SyncHealthSnapshot {
	const hiveReachable = input.irreversibleBlock > 0;
	const blocksBehind = Math.max(0, input.irreversibleBlock - input.lastBlock);
	const secondsSinceUpdate = input.lastUpdateTimeMs > 0
		? Math.max(0, Math.floor((input.nowMs - input.lastUpdateTimeMs) / 1000))
		: null;
	const updatedAfterStartup = input.startupTimeMs > 0 && input.lastUpdateTimeMs > input.startupTimeMs;
	const recentUpdate = input.lastUpdateTimeMs > 0 && (input.nowMs - input.lastUpdateTimeMs) < STALE_THRESHOLD_MS;
	const syncActive = updatedAfterStartup && recentUpdate;
	const inSync = hiveReachable && blocksBehind <= input.toleranceBlocks;
	const live = inSync || syncActive;
	const ready = inSync;

	if (inSync) {
		return {
			lastBlock: input.lastBlock,
			headBlock: input.headBlock,
			irreversibleBlock: input.irreversibleBlock,
			blocksBehind,
			secondsSinceUpdate,
			hiveReachable,
			syncActive,
			inSync,
			live,
			ready,
			syncState: "ready",
		};
	}

	if (syncActive) {
		return {
			lastBlock: input.lastBlock,
			headBlock: input.headBlock,
			irreversibleBlock: input.irreversibleBlock,
			blocksBehind,
			secondsSinceUpdate,
			hiveReachable,
			syncActive,
			inSync,
			live,
			ready,
			syncState: "catching-up",
		};
	}

	if (!hiveReachable) {
		return {
			lastBlock: input.lastBlock,
			headBlock: input.headBlock,
			irreversibleBlock: input.irreversibleBlock,
			blocksBehind,
			secondsSinceUpdate,
			hiveReachable,
			syncActive,
			inSync,
			live,
			ready,
			syncState: "unreachable",
		};
	}

	if (!updatedAfterStartup) {
		return {
			lastBlock: input.lastBlock,
			headBlock: input.headBlock,
			irreversibleBlock: input.irreversibleBlock,
			blocksBehind,
			secondsSinceUpdate,
			hiveReachable,
			syncActive,
			inSync,
			live,
			ready,
			syncState: "starting",
		};
	}

	return {
		lastBlock: input.lastBlock,
		headBlock: input.headBlock,
		irreversibleBlock: input.irreversibleBlock,
		blocksBehind,
		secondsSinceUpdate,
		hiveReachable,
		syncActive,
		inSync,
		live,
		ready,
		syncState: "stale",
	};
}

export function isHealthyForMode(mode: SyncHealthMode, health: SyncHealthSnapshot): boolean {
	return mode === "liveness" ? health.live : health.ready;
}
