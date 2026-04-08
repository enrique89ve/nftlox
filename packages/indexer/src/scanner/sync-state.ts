// Shared sync state between sync-engine and API server.
// In monolith mode, updated via postMessage from the sync worker.
// In sync-only mode, updated directly by the sync engine.

let synced = false;
let lastBlock = 0;
let headBlock = 0;
let irreversibleBlock = 0;
let startupTime = 0;
let lastActivityTime = 0;

// Optional reporter for forwarding state changes to the main thread (worker mode)
export type SyncProgressSnapshot = Readonly<{
	lastBlock: number;
	headBlock: number;
	irreversibleBlock: number;
}>;

export type SyncProgress = SyncProgressSnapshot & Readonly<{
	behind: number;
}>;

export type SyncReporter = {
	onProgress(progress: SyncProgressSnapshot): void;
	onSyncedChange(synced: boolean): void;
};

let reporter: SyncReporter | null = null;

export function setSyncReporter(r: SyncReporter | null): void {
	reporter = r;
}

export function setStartupTime(): void {
	startupTime = Date.now();
}

export function getStartupTime(): number {
	return startupTime;
}

export function getLastActivityTime(): number {
	return lastActivityTime;
}

export function isSynced(): boolean {
	return synced;
}

export function setSynced(value: boolean): void {
	synced = value;
	reporter?.onSyncedChange(value);
}

export function getSyncProgress(): SyncProgress {
	return {
		lastBlock,
		headBlock,
		irreversibleBlock,
		behind: Math.max(0, irreversibleBlock - lastBlock),
	};
}

export function updateSyncProgress(progress: SyncProgressSnapshot): void {
	lastBlock = progress.lastBlock;
	headBlock = progress.headBlock;
	irreversibleBlock = progress.irreversibleBlock;
	reporter?.onProgress(progress);
}

export function markSyncActivity(): void {
	lastActivityTime = Date.now();
}
