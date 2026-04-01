// Sync Worker — runs syncLoop on a dedicated thread.
// Communicates progress to the main thread via postMessage.
// The main thread's event loop stays free for API requests.

declare var self: Worker;

import { connectWithRetry } from "@/bootstrap.ts";
import { startSync, stopSync } from "./sync-engine.ts";
import { setSyncReporter } from "./sync-state.ts";
import type { WorkerMessage, MainToWorkerMessage } from "./sync-messages.ts";

function send(msg: WorkerMessage): void {
	postMessage(msg);
}

// Wire sync-state reporters to postMessage so the main thread stays updated
setSyncReporter({
	onProgress(lastBlock: number, headBlock: number) {
		send({ type: "progress", lastBlock, headBlock });
	},
	onSyncedChange(synced: boolean) {
		send({ type: "synced", synced });
	},
});

// Listen for stop command from main thread
self.onmessage = async (event: MessageEvent<MainToWorkerMessage>) => {
	if (event.data.type === "stop") {
		await stopSync();
	}
};

// Bootstrap and start
async function main(): Promise<void> {
	await connectWithRetry();
	send({ type: "ready" });
	startSync();
}

main().catch((err) => {
	send({ type: "fatal", error: err instanceof Error ? err.message : String(err) });
	process.exit(1);
});
