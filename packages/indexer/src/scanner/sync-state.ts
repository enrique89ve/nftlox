// Shared sync state between sync-engine and API server.
// In monolith mode, updated via postMessage from the sync worker.
// In sync-only mode, updated directly by the sync engine.

let synced = false;
let lastBlock = 0;
let headBlock = 0;
let startupTime = 0;

// Optional reporter for forwarding state changes to the main thread (worker mode)
export interface SyncReporter {
	onProgress(lastBlock: number, headBlock: number): void;
	onSyncedChange(synced: boolean): void;
}

let reporter: SyncReporter | null = null;

export function setSyncReporter(r: SyncReporter): void {
	reporter = r;
}

export function setStartupTime(): void {
	startupTime = Date.now();
}

export function getStartupTime(): number {
	return startupTime;
}

export function isSynced(): boolean {
	return synced;
}

export function setSynced(value: boolean): void {
	synced = value;
	reporter?.onSyncedChange(value);
}

export function getSyncProgress(): { lastBlock: number; headBlock: number; behind: number } {
	return {
		lastBlock,
		headBlock,
		behind: Math.max(0, headBlock - lastBlock),
	};
}

export function updateSyncProgress(last: number, head: number): void {
	lastBlock = last;
	headBlock = head;
	reporter?.onProgress(last, head);
}
