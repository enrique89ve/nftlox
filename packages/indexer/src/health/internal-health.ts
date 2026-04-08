import { getLastActivityTime, getStartupTime, getSyncProgress } from "@/scanner/sync-state.ts";
import { SYNC_TOLERANCE_BLOCKS } from "@/scanner/sync-engine.ts";
import {
	evaluateSyncHealth,
	isHealthyForMode,
	type SyncHealthMode,
} from "./sync-health.ts";

type InternalHealthBody = Readonly<{
	mode: SyncHealthMode;
	status: "healthy" | "unhealthy";
	sync: "starting" | "catching-up" | "ready" | "stale" | "unreachable";
	syncActive: boolean;
	inSync: boolean;
	lastBlock: number;
	headBlock: number;
	irreversibleBlock: number;
	blocksBehind: number;
	secondsSinceUpdate: number | null;
}>;

function getModeFromPath(pathname: string): SyncHealthMode | null {
	if (pathname === "/" || pathname === "/live") return "liveness";
	if (pathname === "/ready") return "readiness";
	return null;
}

function buildInternalHealthBody(mode: SyncHealthMode): InternalHealthBody {
	const progress = getSyncProgress();
	const health = evaluateSyncHealth({
		nowMs: Date.now(),
		startupTimeMs: getStartupTime(),
		lastUpdateTimeMs: getLastActivityTime(),
		lastBlock: progress.lastBlock,
		headBlock: progress.headBlock,
		irreversibleBlock: progress.irreversibleBlock,
		toleranceBlocks: SYNC_TOLERANCE_BLOCKS,
	});
	const healthy = isHealthyForMode(mode, health);
	return {
		mode,
		status: healthy ? "healthy" : "unhealthy",
		sync: health.syncState,
		syncActive: health.syncActive,
		inSync: health.inSync,
		lastBlock: health.lastBlock,
		headBlock: health.headBlock,
		irreversibleBlock: health.irreversibleBlock,
		blocksBehind: health.blocksBehind,
		secondsSinceUpdate: health.secondsSinceUpdate,
	};
}

export function buildInternalHealthResponse(request: Request): Response {
	const pathname = new URL(request.url).pathname;
	const mode = getModeFromPath(pathname);

	if (mode === null) {
		return Response.json({ error: "Not found" }, { status: 404 });
	}

	const body = buildInternalHealthBody(mode);
	return Response.json(body, {
		status: body.status === "healthy" ? 200 : 503,
	});
}
