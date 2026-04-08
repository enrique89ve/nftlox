import index from "../public/index.html";
import {
	PROTOCOL_VERSION,
	MIN_PROTOCOL_VERSION,
	HASH_VERSION,
} from "nftlox-sdk";
import { playgroundConfig } from "./config";
import { queryRoutes } from "./routes/query";
import { buildRoutes } from "./routes/build";
import { batchRoutes } from "./routes/batch";
import { nftTrackerRoutes } from "./routes/nft-tracker";
import { validationRoutes } from "./routes/validation";
import { spvRoutes } from "./routes/spv";
import { debugRoutes } from "./routes/debug";
import { marketplaceRoutes } from "./routes/marketplace";
import { scenarioRoutes } from "./routes/scenarios";

const json = (data: unknown, status = 200) =>
	new Response(JSON.stringify(data, null, 2), {
		status,
		headers: { "Content-Type": "application/json" },
	});

const MIME_TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".md": "text/plain; charset=utf-8",
	".json": "application/json",
	".css": "text/css",
	".js": "application/javascript",
};

const ALLOWED_SAMPLE_FILES = new Set([
	"sample-bulls.json",
	"sample-seeds.json",
	"sample-nfts.json",
	"sample-game-cards.json",
	"template-seeds.json",
]);

const server = Bun.serve({
	port: 3040,
	routes: {
		"/": index,

		// Serve sample JSON files
		"/playground/:filename": async (req) => {
			const filename = req.params.filename;
			if (!filename.endsWith(".json") || !ALLOWED_SAMPLE_FILES.has(filename)) {
				return new Response("Not Found", { status: 404 });
			}
			const file = Bun.file(`./data/${filename}`);
			if (!await file.exists()) {
				return new Response("File not found", { status: 404 });
			}
			return new Response(file, {
				headers: { "Content-Type": "application/json" },
			});
		},

		// ============ DOCUMENTATION (docsify) ============
		"/docs": () => Response.redirect("/docs/", 301),
		"/docs/": async () => {
			const file = Bun.file("./docs/index.html");
			if (!await file.exists()) return new Response("Not Found", { status: 404 });
			return new Response(file, { headers: { "Content-Type": "text/html; charset=utf-8" } });
		},
		"/docs/*": async (req) => {
			const path = new URL(req.url).pathname.slice("/docs/".length);
			if (!path || path.includes("..")) return new Response("Not Found", { status: 404 });
			const file = Bun.file(`./docs/${path}`);
			if (!await file.exists()) return new Response("Not Found", { status: 404 });
			const ext = `.${path.split(".").pop()}`;
			const contentType = MIME_TYPES[ext] ?? "application/octet-stream";
			return new Response(file, { headers: { "Content-Type": contentType } });
		},

		// ============ QUERY ROUTES (Indexer API proxy) ============
		...queryRoutes,

		// ============ BUILD ROUTES (SDK builders) ============
		...buildRoutes,

		// ============ BATCH MINTING ROUTES (Legacy) ============
		...batchRoutes,

		// ============ VALIDATION ROUTES ============
		...validationRoutes,

		// ============ NFT TRACKER ROUTES (BlockTrades Standard) ============
		...nftTrackerRoutes,

		// ============ SPV VERIFICATION ROUTES ============
		...spvRoutes,

		// ============ MARKETPLACE ROUTES (multisig buy) ============
		...marketplaceRoutes,

		// ============ DEBUG ROUTES ============
		...(playgroundConfig.debugRoutesEnabled ? debugRoutes : {}),

		// ============ GAME SCENARIO ROUTES ============
		...scenarioRoutes,

		// ============ PROTOCOL INFO ============

		"/api/protocol/version": async () => {
			return json({
				protocolVersion: PROTOCOL_VERSION,
				minProtocolVersion: MIN_PROTOCOL_VERSION,
				debugRoutesEnabled: playgroundConfig.debugRoutesEnabled,
			});
		},

		"/api/protocol/info": async () => {
			return json({
				protocolVersion: PROTOCOL_VERSION,
				hashVersion: HASH_VERSION,
				minProtocolVersion: MIN_PROTOCOL_VERSION,
				debugRoutesEnabled: playgroundConfig.debugRoutesEnabled,
			});
		},
	},
	development: process.env.NODE_ENV !== "production" ? { hmr: true, console: true } : false,
});

console.log(`
NFTLox Test Console - http://localhost:${server.port}
Debug Routes: ${playgroundConfig.debugRoutesEnabled ? "enabled" : "disabled"}

Query API (via Indexer):
  GET  /api/user/:username
  GET  /api/user/:username/collections
  GET  /api/nft/:nftId
  GET  /api/nft/:nftId/details
  GET  /api/collections
  GET  /api/collection/:id
  GET  /api/collection/:id/nfts
  GET  /api/collection/:id/stats
  GET  /api/collection/:id/exists
  GET  /api/seed/:seedId/instances
  GET  /api/seed/:id/exists
  GET  /api/marketplace/listings
  GET  /api/stats
  GET  /api/status
  GET  /api/health

Build API (26 endpoints):
  POST /api/build/collection       POST /api/build/seeds
  POST /api/build/bulk-distribute  POST /api/build/transfer
  POST /api/build/list             POST /api/build/unlist
  POST /api/build/burn             POST /api/build/buy
  POST /api/build/preview-ids
  POST /api/build/replicate
  POST /api/build/set-data         POST /api/build/pack-create
  POST /api/build/pack-buy         POST /api/build/pack-open
  POST /api/build/pack-transfer    POST /api/build/nft-approve
  POST /api/build/nft-approve-all  POST /api/build/nft-transfer-from
  POST /api/build/pack-approve     POST /api/build/pack-transfer-from
  POST /api/build/nft-lend         POST /api/build/nft-return
  POST /api/build/data-operator-approve
  POST /api/build/set-data-from
  POST /api/build/archive-collection
  POST /api/build/extend-schema

SPV Verification:
  POST /api/spv/verify-ownership
  POST /api/spv/verify-on-chain
  POST /api/spv/verify-pack-open

Validation:
  POST /api/validate/pre-mint

NFT Tracker (BlockTrades Standard):
  POST /api/nft-tracker/register
  POST /api/nft-tracker/issue
  POST /api/nft-tracker/transfer
  POST /api/nft-tracker/set-data
  POST /api/nft-tracker/soulbind
  POST /api/nft-tracker/modify

Legacy Batch:
  POST /api/batch/preview
  POST /api/batch/collection
  POST /api/batch/mint-seeds
  POST /api/batch/collection-deterministic
  POST /api/batch/mint-seeds-deterministic

Game Scenarios (custodial examples):
  GET  /api/scenarios                    (index)
  GET  /api/scenarios/setup              (create collection + mint + distribute)
  GET  /api/scenarios/assign-cards       (assign cards to players via mutableData)
  GET  /api/scenarios/lend-cards         (lend starter cards to trial players)
  GET  /api/scenarios/in-game-trade      (players trade cards)
  GET  /api/scenarios/level-up           (update stats after matches)
  GET  /api/scenarios/graduation         (player gets real Web3 ownership)

Sample Collections (unified format):
  GET  /playground/sample-bulls.json
  GET  /playground/sample-seeds.json
  GET  /playground/sample-nfts.json
  GET  /playground/sample-game-cards.json

Protocol Info:
  GET  /api/protocol/version
  GET  /api/protocol/info
`);
