import index from "../public/index.html";
import {
	PROTOCOL_VERSION,
	MIN_PROTOCOL_VERSION,
	HASH_VERSION,
} from "nftlox-sdk";
import { queryRoutes } from "./routes/query";
import { buildRoutes } from "./routes/build";
import { batchRoutes } from "./routes/batch";
import { nftTrackerRoutes } from "./routes/nft-tracker";
import { validationRoutes } from "./routes/validation";
import { spvRoutes } from "./routes/spv";
import { debugRoutes } from "./routes/debug";

const json = (data: unknown, status = 200) =>
	new Response(JSON.stringify(data, null, 2), {
		status,
		headers: { "Content-Type": "application/json" },
	});

const ALLOWED_SAMPLE_FILES = new Set([
	"sample-bulls.json",
	"sample-seeds.json",
	"sample-nfts.json",
	"sample-nfts-200.json",
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

		// ============ DEBUG ROUTES ============
		...debugRoutes,

		// ============ PROTOCOL INFO ============

		"/api/protocol/version": async () => {
			return json({
				protocolVersion: PROTOCOL_VERSION,
				minProtocolVersion: MIN_PROTOCOL_VERSION,
			});
		},

		"/api/protocol/info": async () => {
			return json({
				protocolVersion: PROTOCOL_VERSION,
				hashVersion: HASH_VERSION,
				minProtocolVersion: MIN_PROTOCOL_VERSION,
			});
		},
	},
	development: { hmr: true, console: true },
});

console.log(`
NFTLox Test Console - http://localhost:${server.port}

Query API (via Indexer):
  GET  /api/user/:username
  GET  /api/user/:username/collections
  GET  /api/user/:username/packs
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
  GET  /api/packs
  GET  /api/pack/:id
  GET  /api/stats
  GET  /api/status
  GET  /api/health

Build API (24 endpoints):
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

Protocol Info:
  GET  /api/protocol/version
  GET  /api/protocol/info
`);
