// Shared sync state between sync-engine and API server

let synced = false;
let lastBlock = 0;
let headBlock = 0;

export function isSynced(): boolean {
	return synced;
}

export function setSynced(value: boolean): void {
	synced = value;
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
}
