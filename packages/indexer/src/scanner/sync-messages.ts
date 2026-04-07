// Message types for communication between main thread and sync worker.
// Uses simple objects for Bun's postMessage fast path (2-241x faster).

import type { SyncProgressSnapshot } from "./sync-state.ts";

export type SyncProgressMessage = {
	readonly type: "progress";
	readonly progress: SyncProgressSnapshot;
};

export type SyncStatusMessage = {
	readonly type: "synced";
	readonly synced: boolean;
};

export type SyncLogMessage = {
	readonly type: "log";
	readonly level: "info" | "warn" | "error";
	readonly message: string;
	readonly data?: Record<string, unknown>;
};

export type SyncReadyMessage = {
	readonly type: "ready";
};

export type SyncErrorMessage = {
	readonly type: "fatal";
	readonly error: string;
};

export type WorkerMessage =
	| SyncProgressMessage
	| SyncStatusMessage
	| SyncLogMessage
	| SyncReadyMessage
	| SyncErrorMessage;

export type MainToWorkerMessage = {
	readonly type: "stop";
};
