/**
 * NFTLox sync-pipeline benchmark.
 *
 * Two benches in one run:
 *   1. Parser micro-bench — strict NFTLox parser vs permissive baseline,
 *      on a synthetic mix of custom_json operations.
 *   2. End-to-end testnet replay — genesis..head in fixed-size chunks,
 *      measuring fetch / parse / enrich / route+commit phases.
 *
 * Uses an isolated `_bench`-suffixed database so dev state is untouched.
 * Run with: bun run scripts/bench.ts
 */

import { performance } from "node:perf_hooks";
import pgClient from "postgres";

// ─── DB isolation ─────────────────────────────────────
// MUST set DATABASE_URL BEFORE importing config.ts / client.ts, because
// both read the URL at module-init time and open the pool eagerly.

const DEV_URL = process.env.DATABASE_URL
	?? "postgres://nftlox:nftlox_dev@localhost:5432/nftlox_indexer";
const BENCH_DB = `${new URL(DEV_URL).pathname.replace(/^\//, "")}_bench`;
const BENCH_URL = DEV_URL.replace(/\/[^/]+$/, `/${BENCH_DB}`);

await ensureBenchDatabase(DEV_URL, BENCH_DB);
process.env.DATABASE_URL = BENCH_URL;

// Dynamic imports: everything below sees the bench DB.
const { runMigrations } = await import("../src/db/migration-runner.ts");
const { sql, withTransaction } = await import("../src/db/client.ts");
const { getCustomJsonInRange, getTransfersInTransaction } =
	await import("../src/scanner/hive-client.ts");
const { parseHafAHOperations } = await import("../src/scanner/operation-parser.ts");
const { routeOperation } = await import("../src/processor/action-router.ts");
const { updateLastBlock, insertInvalidOperation } =
	await import("../src/db/queries/sync.ts");
const { materializePendingUnlists } =
	await import("../src/db/queries/nft-mutations.ts");
const {
	ACTION_BUY,
	ACTION_CREATE_COLLECTION,
	UNLIST_DELAY_BLOCKS,
	PROTOCOL_VERSION,
	PROTOCOL_ID,
	PROTOCOL_GENESIS_BLOCK,
} = await import("../src/protocol/index.ts");
const { config } = await import("../src/config.ts");

type HafAHOperation = Awaited<ReturnType<typeof getCustomJsonInRange>>[number];

// ─── DB setup helpers ─────────────────────────────────

async function ensureBenchDatabase(devUrl: string, dbName: string): Promise<void> {
	// Connect to the default `postgres` maintenance DB to CREATE DATABASE.
	const maintUrl = devUrl.replace(/\/[^/]+$/, "/postgres");
	const admin = pgClient(maintUrl, { max: 1, idle_timeout: 5 });
	try {
		const existing = await admin`
			SELECT 1 FROM pg_database WHERE datname = ${dbName}
		`;
		if (existing.length === 0) {
			console.log(`Creating bench DB: ${dbName}`);
			await admin.unsafe(`CREATE DATABASE "${dbName}"`);
		}
	} finally {
		await admin.end();
	}
}

async function truncateAllTables(): Promise<void> {
	// TRUNCATE ... CASCADE wipes state while preserving schema. Faster than
	// dropping + re-migrating between bench runs. `schema_migrations` and
	// `schema_versions` are NOT truncated so we don't re-run migrations.
	const rows = await sql<{ tablename: string }[]>`
		SELECT tablename FROM pg_tables
		WHERE schemaname = 'public'
		  AND tablename NOT IN ('schema_migrations', 'schema_versions')
	`;
	if (rows.length === 0) return;
	const list = rows.map((r) => `"${r.tablename}"`).join(", ");
	await sql.unsafe(`TRUNCATE ${list} RESTART IDENTITY CASCADE`);
}

// ─── Synthetic fixture generator ──────────────────────

interface OpMix {
	readonly count: number;
	readonly validPct: number;      // valid NFTLox ops
	readonly wrongIdPct: number;    // custom_json with a different id (fast-filter path)
	readonly malformedPct: number;  // matches our id but JSON.parse fails
	readonly invalidTxPct: number;  // matches our id but txId regex fails
}

// Mulberry32 — deterministic seeded RNG for reproducible fixtures.
function mulberry32(seed: number): () => number {
	let s = seed >>> 0;
	return () => {
		s = (s + 0x6d2b79f5) >>> 0;
		let t = s;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function buildValidPayload(rand: () => number): string {
	// Representative payload shape (create_collection). Content isn't checked
	// at parse time beyond being a valid object with protocol/version/action/data.
	return JSON.stringify({
		protocol: PROTOCOL_ID,
		version: PROTOCOL_VERSION,
		action: "create_collection",
		data: {
			id: `coll_${Math.floor(rand() * 1e9)}`,
			name: "bench",
			schema: { immutable: {}, mutable: {} },
			maxInstances: 1000,
		},
	});
}

function randomTxId(rand: () => number): string {
	// 40 hex chars — matches TX_ID_REGEX in the parser.
	let s = "";
	for (let i = 0; i < 40; i++) {
		s += Math.floor(rand() * 16).toString(16);
	}
	return s;
}

function buildFixture(mix: OpMix, seed = 42): HafAHOperation[] {
	const rand = mulberry32(seed);
	const ops: HafAHOperation[] = [];
	for (let i = 0; i < mix.count; i++) {
		const roll = rand();
		let id = PROTOCOL_ID;
		let json = buildValidPayload(rand);
		let txId = randomTxId(rand);

		if (roll < mix.wrongIdPct) {
			id = "some_other_app";                     // filtered by custom_json id
		} else if (roll < mix.wrongIdPct + mix.malformedPct) {
			json = "{not valid json";                   // hits JSON.parse catch
		} else if (roll < mix.wrongIdPct + mix.malformedPct + mix.invalidTxPct) {
			txId = "notahex";                           // rejected by isValidTxId
		}

		ops.push({
			op: {
				type: "custom_json_operation",
				value: {
					id,
					json,
					required_auths: [],
					required_posting_auths: ["alice"],
				},
			},
			block: PROTOCOL_GENESIS_BLOCK + i,
			trx_id: txId,
			timestamp: "2026-04-01T00:00:00",
			operation_id: String(i),
			virtual_op: false,
		});
	}
	return ops;
}

// ─── Permissive baseline parser (nft-tracker style) ───
// Only checks that the op is custom_json, matches protocol id, and the JSON
// parses to an object with an `action` string. No txId / opId / version /
// prototype-pollution / auth validation. Equivalent to a SQL `_json->>'action'`
// approach without `RAISE EXCEPTION` for missing fields.

interface PermissiveOp {
	readonly blockNum: number;
	readonly action: string;
	readonly data: Record<string, unknown>;
}

function parsePermissive(hafOps: HafAHOperation[]): PermissiveOp[] {
	const out: PermissiveOp[] = [];
	for (const h of hafOps) {
		const v = h.op?.value;
		if (!v || v.id !== PROTOCOL_ID) continue;
		let payload: unknown;
		try { payload = JSON.parse(v.json); } catch { continue; }
		if (typeof payload !== "object" || payload === null) continue;
		const p = payload as Record<string, unknown>;
		if (typeof p.action !== "string") continue;
		out.push({
			blockNum: h.block,
			action: p.action,
			data: (typeof p.data === "object" && p.data !== null)
				? (p.data as Record<string, unknown>)
				: {},
		});
	}
	return out;
}

// ─── Timing utilities ─────────────────────────────────

function percentile(sorted: number[], p: number): number {
	if (sorted.length === 0) return 0;
	const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
	return sorted[idx] ?? 0;
}

interface PhaseStats {
	readonly count: number;
	readonly totalMs: number;
	readonly p50: number;
	readonly p99: number;
	readonly meanMs: number;
}

function summarize(samples: number[]): PhaseStats {
	const sorted = [...samples].sort((a, b) => a - b);
	const total = sorted.reduce((s, n) => s + n, 0);
	return {
		count: sorted.length,
		totalMs: total,
		p50: percentile(sorted, 50),
		p99: percentile(sorted, 99),
		meanMs: sorted.length ? total / sorted.length : 0,
	};
}

function fmt(n: number, digits = 2): string {
	return n.toFixed(digits);
}

// ─── Micro-bench: parser ──────────────────────────────

async function runMicroBench(): Promise<void> {
	console.log("\n─── Parser micro-bench ───");
	const mix: OpMix = {
		count: 100_000,
		validPct: 0.70,
		wrongIdPct: 0.15,
		malformedPct: 0.10,
		invalidTxPct: 0.05,
	};
	const fixture = buildFixture(mix);
	console.log(`fixture: ${fixture.length} ops (70% valid, 15% other-id, 10% malformed, 5% bad-tx)`);

	// Warm-up to stabilize JIT.
	parseHafAHOperations(fixture.slice(0, 1000));
	parsePermissive(fixture.slice(0, 1000));

	const t1 = performance.now();
	const strict = parseHafAHOperations(fixture);
	const strictMs = performance.now() - t1;

	const t2 = performance.now();
	const permissive = parsePermissive(fixture);
	const permissiveMs = performance.now() - t2;

	const strictOps = Math.round(fixture.length / (strictMs / 1000));
	const permOps = Math.round(fixture.length / (permissiveMs / 1000));
	const overhead = ((strictMs - permissiveMs) / permissiveMs) * 100;

	console.log(`  strict     : ${fmt(strictMs)} ms  (${strictOps.toLocaleString()} ops/s) — ${strict.ops.length} accepted, ${strict.rejected.length} rejected`);
	console.log(`  permissive : ${fmt(permissiveMs)} ms  (${permOps.toLocaleString()} ops/s) — ${permissive.length} accepted`);
	console.log(`  overhead   : ${fmt(overhead, 1)}%  (cost of strict validation vs shape-only)`);
}

// ─── End-to-end replay ────────────────────────────────

interface PhaseSample {
	fetchMs: number;
	parseMs: number;
	enrichMs: number;
	routeMs: number;
	rawOps: number;
	parsedOps: number;
	rejectedOps: number;
	pages: number;
}

async function replayChunk(
	from: number,
	to: number,
	protocolId: string,
): Promise<PhaseSample> {
	const s: PhaseSample = {
		fetchMs: 0, parseMs: 0, enrichMs: 0, routeMs: 0,
		rawOps: 0, parsedOps: 0, rejectedOps: 0, pages: 0,
	};

	// Phase 1: fetch
	const t0 = performance.now();
	const hafOps = await getCustomJsonInRange(from, to, protocolId, /* behind */ 0);
	s.fetchMs = performance.now() - t0;
	s.rawOps = hafOps.length;

	// Phase 2: parse
	const t1 = performance.now();
	const { ops, rejected } = parseHafAHOperations(hafOps);
	s.parseMs = performance.now() - t1;
	s.parsedOps = ops.length;
	s.rejectedOps = rejected.length;

	// Phase 3: enrich paired transfers for BUY / CREATE_COLLECTION
	const t2 = performance.now();
	const transferBacked = ops.filter(
		(o) => o.action === ACTION_BUY || o.action === ACTION_CREATE_COLLECTION,
	);
	if (transferBacked.length > 0) {
		const uniqueTxIds = [...new Set(transferBacked.map((o) => o.txId))];
		const pools = new Map<string, {
			transfers: Awaited<ReturnType<typeof getTransfersInTransaction>>;
			consumed: Set<number>;
		}>();
		await Promise.all(uniqueTxIds.map(async (txId) => {
			const transfers = await getTransfersInTransaction(txId);
			pools.set(txId, { transfers, consumed: new Set() });
		}));
		for (const op of transferBacked) {
			const pool = pools.get(op.txId);
			if (!pool) continue;
			op.pairedTransfers = pool.transfers;
			op.transferPool = pool;
		}
	}
	s.enrichMs = performance.now() - t2;

	// Phase 4: route + commit (single transaction, same as sync-engine)
	const t3 = performance.now();
	await withTransaction(async (txn) => {
		for (const rej of rejected) {
			await insertInvalidOperation({
				blockNum: rej.blockNum,
				txId: rej.txId,
				operationId: rej.operationId,
				signer: rej.signer,
				action: null,
				reason: rej.reason,
				rawPayload: rej.rawPayload,
			}, txn);
		}
		for (const op of ops) {
			await routeOperation(op, txn);
		}
		await materializePendingUnlists(to, UNLIST_DELAY_BLOCKS, txn);
		await updateLastBlock(to, txn);
	});
	s.routeMs = performance.now() - t3;

	return s;
}

async function runEndToEnd(): Promise<void> {
	console.log("\n─── End-to-end testnet replay ───");

	// Determine the head dynamically so the bench always covers genesis..head.
	// Chunk size of 200 gives ~8 samples for a 1.5k-block range — enough for
	// meaningful p50/p99. Matches real-world HafAH cursor pagination: small
	// enough to fit in one page, big enough to amortize HTTP overhead.
	const CHUNK = 200;

	const statusRes = await fetch(
		`${config.hiveEndpoints[0]}/hafah-api/headblock`,
	).catch(() => null);
	const chainHead = statusRes?.ok ? parseInt(await statusRes.text(), 10) : 0;
	const from = PROTOCOL_GENESIS_BLOCK;
	// We want a bounded replay — use head from the NFTLox testnet API which is
	// guaranteed to have protocol data. Hive mainnet head would be fine too but
	// we'd waste fetch cycles on blocks with zero NFTLox ops.
	const apiRes = await fetch("https://api-nftlox.hivecreators.co/api/status")
		.catch(() => null);
	const apiHead = apiRes?.ok
		? (await apiRes.json() as { lastBlock: number }).lastBlock
		: 0;
	const to = Math.min(apiHead || chainHead, from + 10_000);  // cap at 10k
	if (to <= from) {
		console.log(`⚠ head=${to} <= genesis=${from}; skipping replay`);
		return;
	}
	console.log(`range: ${from}..${to} (${to - from} blocks, chunks of ${CHUNK})`);

	const samples: PhaseSample[] = [];
	let cursor = from;
	const globalStart = performance.now();

	while (cursor <= to) {
		const chunkEnd = Math.min(cursor + CHUNK - 1, to);
		const s = await replayChunk(cursor, chunkEnd, config.protocolId);
		samples.push(s);
		cursor = chunkEnd + 1;
	}

	const elapsedS = (performance.now() - globalStart) / 1000;
	const blocks = to - from + 1;
	const totalParsed = samples.reduce((n, s) => n + s.parsedOps, 0);
	const totalRejected = samples.reduce((n, s) => n + s.rejectedOps, 0);
	const totalRaw = samples.reduce((n, s) => n + s.rawOps, 0);

	const fetchStats = summarize(samples.map((s) => s.fetchMs));
	const parseStats = summarize(samples.map((s) => s.parseMs));
	const enrichStats = summarize(samples.map((s) => s.enrichMs));
	const routeStats = summarize(samples.map((s) => s.routeMs));

	const totalPhaseMs = fetchStats.totalMs + parseStats.totalMs
		+ enrichStats.totalMs + routeStats.totalMs;
	const pct = (ms: number): string =>
		totalPhaseMs > 0 ? fmt((ms / totalPhaseMs) * 100, 1) : "0.0";

	console.log(`\n  blocks:        ${blocks}`);
	console.log(`  raw custom_json ops (HafAH filter):  ${totalRaw}`);
	console.log(`  NFTLox ops accepted:                 ${totalParsed}`);
	console.log(`  NFTLox ops rejected:                 ${totalRejected}`);
	console.log(`  wall time:     ${fmt(elapsedS, 2)} s  (${fmt(blocks / elapsedS, 0)} blocks/s)`);
	console.log(`  samples:       ${samples.length} chunks of ${CHUNK} blocks`);
	console.log();
	console.log(`  phase          total ms    %        p50 ms    p99 ms`);
	console.log(`  ─────────────  ──────────  ───────  ────────  ────────`);
	console.log(`  fetch (HafAH)  ${fmt(fetchStats.totalMs).padStart(10)}  ${pct(fetchStats.totalMs).padStart(5)}%   ${fmt(fetchStats.p50).padStart(8)}  ${fmt(fetchStats.p99).padStart(8)}`);
	console.log(`  parse          ${fmt(parseStats.totalMs).padStart(10)}  ${pct(parseStats.totalMs).padStart(5)}%   ${fmt(parseStats.p50).padStart(8)}  ${fmt(parseStats.p99).padStart(8)}`);
	console.log(`  enrich (tx)    ${fmt(enrichStats.totalMs).padStart(10)}  ${pct(enrichStats.totalMs).padStart(5)}%   ${fmt(enrichStats.p50).padStart(8)}  ${fmt(enrichStats.p99).padStart(8)}`);
	console.log(`  route+commit   ${fmt(routeStats.totalMs).padStart(10)}  ${pct(routeStats.totalMs).padStart(5)}%   ${fmt(routeStats.p50).padStart(8)}  ${fmt(routeStats.p99).padStart(8)}`);
}

// ─── Main ─────────────────────────────────────────────

async function main(): Promise<void> {
	console.log(`bench DB: ${BENCH_URL}`);
	console.log(`protocol: ${config.protocolId}  genesis: ${PROTOCOL_GENESIS_BLOCK}`);

	console.log("\nRunning migrations on bench DB...");
	await runMigrations();
	console.log("Truncating bench tables...");
	await truncateAllTables();

	await runMicroBench();
	await runEndToEnd();

	await sql.end();
}

main().catch(async (err) => {
	console.error("Bench failed:", err);
	try { await sql.end(); } catch { /* already closed */ }
	process.exit(1);
});
