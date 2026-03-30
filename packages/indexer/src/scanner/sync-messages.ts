// Message types for communication between main thread and sync worker.
// Uses simple objects for Bun's postMessage fast path (2-241x faster).

export interface SyncProgressMessage {
	readonly type: "progress";
	readonly lastBlock: number;
	readonly headBlock: number;
}

export interface SyncStatusMessage {
	readonly type: "synced";
	readonly synced: boolean;
}

export interface SyncLogMessage {
	readonly type: "log";
	readonly level: "info" | "warn" | "error";
	readonly message: string;
	readonly data?: Record<string, unknown>;
}

export interface SyncReadyMessage {
	readonly type: "ready";
}

export interface SyncErrorMessage {
	readonly type: "fatal";
	readonly error: string;
}

export type WorkerMessage =
	| SyncProgressMessage
	| SyncStatusMessage
	| SyncLogMessage
	| SyncReadyMessage
	| SyncErrorMessage;

export interface MainToWorkerMessage {
	readonly type: "stop";
}
