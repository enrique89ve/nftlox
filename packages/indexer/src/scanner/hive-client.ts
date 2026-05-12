// Hive L1 Client — HafAH REST API + JSON-RPC failover
// Uses circuit breaker + health-aware selection via endpoint-health.ts

import { config } from "@/config.ts";
import { createLogger } from "@/utils/logger.ts";
import { selectConsensusSample } from "./head-consensus.ts";
import {
	classifyError,
	createEndpointHealthPool,
	getBackoffMs,
	type ErrorCategory,
} from "./endpoint-health.ts";

const log = createLogger("hive-client");

// Keep transport health independent by capability. A healthy JSON-RPC probe
// should not reset HafAH failures for the same host.
const rpcHealth = createEndpointHealthPool(config.hiveEndpoints);
const hafahHealth = createEndpointHealthPool(config.hiveEndpoints);

// ============ FETCH ERROR ============

class FetchError extends Error {
	constructor(
		readonly status: number,
		readonly endpoint: string,
		statusText: string,
		readonly retryAfterMs?: number,
	) {
		super(`HTTP ${status}: ${statusText}`);
		this.name = "FetchError";
	}
}

function parseRetryAfterHeader(response: Response): number | undefined {
	const header = response.headers.get("Retry-After");
	if (!header) return undefined;
	const seconds = Number(header);
	if (!Number.isNaN(seconds) && seconds > 0) return seconds * 1000;
	return undefined;
}

function logRetryFailure(
	message: string,
	endpoint: string,
	attempt: number,
	maxAttempts: number,
	err: unknown,
	category: ErrorCategory,
	context: Record<string, unknown> = {},
): void {
	const data = {
		...context,
		endpoint,
		attempt: attempt + 1,
		maxAttempts,
		error: err instanceof Error ? err.message : String(err),
		category,
	};

	if (attempt === maxAttempts - 1 || category !== "transient") {
		log.warn(message, data);
		return;
	}

	log.debug(message, data);
}

// ============ JSON-RPC (for head block only) ============

async function rpcCall<T>(endpoint: string, method: string, params: Record<string, unknown> | unknown[]): Promise<T> {
	const response = await fetch(endpoint, {
		method: "POST",
		signal: AbortSignal.timeout(15_000),
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ jsonrpc: "2.0", method, params, id: 1 }),
	});

	if (!response.ok) {
		const retryAfterMs = parseRetryAfterHeader(response);
		await response.text().catch(() => {}); // drain body to release connection
		throw new FetchError(response.status, endpoint, response.statusText, retryAfterMs);
	}

	const json = await response.json() as Record<string, unknown>;

	if (json.error != null && typeof json.error === "object") {
		const errObj = json.error as Record<string, unknown>;
		throw new Error(`RPC error: ${typeof errObj.message === "string" ? errObj.message : "unknown"}`);
	}

	if (json.result === undefined || json.result === null) {
		throw new Error(`RPC returned empty result for ${method}`);
	}

	return json.result as T;
}

async function callWithFailover<T>(method: string, params: Record<string, unknown> | unknown[]): Promise<T> {
	const maxAttempts = config.hiveEndpoints.length * 2;

	for (let attempt = 0; attempt < maxAttempts; attempt++) {
		const endpoint = rpcHealth.selectEndpoint();
		const start = performance.now();
		try {
			const result = await rpcCall<T>(endpoint, method, params);
			rpcHealth.recordSuccess(endpoint, performance.now() - start);
			return result;
		} catch (err) {
			const category = classifyError(err);
			const retryAfterMs = err instanceof FetchError ? err.retryAfterMs : undefined;
			rpcHealth.recordFailure(endpoint, category, retryAfterMs);
			logRetryFailure("RPC failed", endpoint, attempt, maxAttempts, err, category, { method });
			if (attempt === maxAttempts - 1) throw err;
			await new Promise(r => setTimeout(r, getBackoffMs(attempt, category)));
		}
	}

	throw new Error("All Hive endpoints exhausted");
}

// ============ HAFAH REST API ============

export interface HafAHOperation {
	op: {
		type: string;
		value: {
			id: string;
			json: string;
			required_auths: string[];
			required_posting_auths: string[];
		};
	};
	block: number;
	trx_id: string;
	timestamp: string;
	operation_id: string;
	virtual_op: boolean;
}

interface HafAHResponse {
	ops: HafAHOperation[];
	next_block_range_begin: number | null;
	next_operation_begin: string | null;
}

// HafAH page-size limits: server allows up to 150,000 ops per page.
// Three tiers based on how far behind we are:
//   MASSIVE: deep catch-up — bounded response size, 2000-block ranges
//   NORMAL:  moderate catch-up — balanced latency/throughput
//   LIVE:    near head — tiny pages, fast round-trips (few ops expected)
const HAFAH_PAGE_SIZE_LIVE = 100;
const HAFAH_PAGE_SIZE_NORMAL = 1000;
const HAFAH_PAGE_SIZE_MASSIVE = 1000;
const MASSIVE_SYNC_THRESHOLD = 100;
// <= this many blocks behind = live mode (small pages, no extra sleep)
const LIVE_SYNC_THRESHOLD = 20;

// HafAH enforces a hard limit of 2000 blocks per request (server-side assert)
const HAFAH_BLOCK_RANGE = 2000;
// Hive protocol operation type ID for custom_json (immutable blockchain constant)
const CUSTOM_JSON_OP_TYPE = 18;

async function hafahFetch(endpoint: string, fromBlock: number, toBlock: number, operationBegin: string, pageSize: number): Promise<HafAHResponse> {
	// Adaptive timeout: larger pages need more time but 10-15s is plenty
	// (benchmarks show 2-4s for 2000 blocks with pageSize 5000)
	const timeoutMs = pageSize > HAFAH_PAGE_SIZE_NORMAL ? 15_000 : 10_000;

	const url = `${endpoint}/hafah-api/operations?from-block=${fromBlock}&to-block=${toBlock}&operation-types=${CUSTOM_JSON_OP_TYPE}&page-size=${pageSize}&operation-begin=${operationBegin}`;

	const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });

	if (!response.ok) {
		const retryAfterMs = parseRetryAfterHeader(response);
		await response.text().catch(() => {}); // drain body to release connection
		throw new FetchError(response.status, endpoint, response.statusText, retryAfterMs);
	}

	const data = await response.json() as Record<string, unknown>;

	// Validate response structure
	if (!Array.isArray(data.ops)) {
		return { ops: [], next_block_range_begin: null, next_operation_begin: null };
	}

	return {
		ops: data.ops as HafAHOperation[],
		next_block_range_begin: typeof data.next_block_range_begin === "number" ? data.next_block_range_begin : null,
		next_operation_begin: typeof data.next_operation_begin === "string" ? data.next_operation_begin : null,
	};
}

async function hafahWithFailover(fromBlock: number, toBlock: number, operationBegin: string, pageSize: number): Promise<HafAHResponse> {
	const maxAttempts = config.hiveEndpoints.length * 2;

	for (let attempt = 0; attempt < maxAttempts; attempt++) {
		const endpoint = hafahHealth.selectEndpoint();
		const start = performance.now();
		try {
			const result = await hafahFetch(endpoint, fromBlock, toBlock, operationBegin, pageSize);
			hafahHealth.recordSuccess(endpoint, performance.now() - start);
			return result;
		} catch (err) {
			const category = classifyError(err);
			const retryAfterMs = err instanceof FetchError ? err.retryAfterMs : undefined;
			hafahHealth.recordFailure(endpoint, category, retryAfterMs);
			logRetryFailure("HafAH failed", endpoint, attempt, maxAttempts, err, category, {
				fromBlock,
				toBlock,
				operationBegin,
				pageSize,
			});
			if (attempt === maxAttempts - 1) throw err;
			await new Promise(r => setTimeout(r, getBackoffMs(attempt, category)));
		}
	}

	throw new Error("All HafAH endpoints exhausted");
}

// ============ PUBLIC API ============

export interface BlockchainHead {
	readonly headBlock: number;
	readonly irreversibleBlock: number;
	readonly headTime?: string | null;
}

export type EndpointHeadSample = Readonly<{
	endpoint: string;
	head: BlockchainHead;
}>;

function parseBlockchainHead(result: Record<string, unknown>): BlockchainHead {
	const headBlock = Number(result.head_block_number);
	const irreversibleBlock = Number(result.last_irreversible_block_num);
	const rawHeadTime = typeof result.time === "string" ? result.time : null;
	const headTime = rawHeadTime
		? new Date(`${rawHeadTime}Z`).toISOString()
		: null;

	if (Number.isNaN(headBlock) || Number.isNaN(irreversibleBlock)) {
		throw new Error("Invalid blockchain head response", {
			cause: { head_block_number: result.head_block_number, last_irreversible_block_num: result.last_irreversible_block_num },
		});
	}

	return { headBlock, irreversibleBlock, headTime };
}

/** @internal — exported for unit tests only */
export function selectConsensusHead(samples: readonly EndpointHeadSample[]): BlockchainHead {
	if (samples.length === 0) {
		throw new Error("Cannot select blockchain head from an empty sample set");
	}

	const selected = selectConsensusSample(samples, sample => sample.head);

	let minIrreversible = Infinity;
	let maxIrreversible = -Infinity;
	for (const s of samples) {
		if (s.head.irreversibleBlock < minIrreversible) minIrreversible = s.head.irreversibleBlock;
		if (s.head.irreversibleBlock > maxIrreversible) maxIrreversible = s.head.irreversibleBlock;
	}

	if (maxIrreversible !== minIrreversible) {
		log.warn("Hive irreversible block mismatch across endpoints", {
			samples: samples.map(({ endpoint, head }) => ({
				endpoint,
				headBlock: head.headBlock,
				irreversibleBlock: head.irreversibleBlock,
			})),
			selectedEndpoint: selected.endpoint,
			selectedHeadBlock: selected.head.headBlock,
			selectedIrreversibleBlock: selected.head.irreversibleBlock,
			minIrreversible,
			maxIrreversible,
			spread: maxIrreversible - minIrreversible,
			strategy: samples.length === 2 ? "lower-of-two" : "lower-median",
		});
	}

	return selected.head;
}

// Maximum acceptable drift between server clock and blockchain time.
// Beyond this threshold, listing expiration checks in the multisig service
// could diverge from the blockchain, causing incorrect accept/reject decisions.
const MAX_CLOCK_DRIFT_MS = 15_000;

export async function getBlockchainHead(consistency: "fast" | "strict" = "strict"): Promise<BlockchainHead> {
	if (consistency === "fast" || config.hiveEndpoints.length === 1) {
		const result = await callWithFailover<Record<string, unknown>>(
			"condenser_api.get_dynamic_global_properties", [],
		);
		return parseBlockchainHead(result);
	}

	const results = await Promise.allSettled(
		config.hiveEndpoints.map(async (endpoint) => {
			const start = performance.now();
			const result = await rpcCall<Record<string, unknown>>(
				endpoint,
				"condenser_api.get_dynamic_global_properties",
				[],
			);
			rpcHealth.recordSuccess(endpoint, performance.now() - start);
			return { endpoint, head: parseBlockchainHead(result) };
		}),
	);

	const successes = results.flatMap((result, idx) => {
		if (result.status === "fulfilled") {
			return [result.value];
		}
		const endpoint = config.hiveEndpoints[idx] ?? "";
		const category = classifyError(result.reason);
		const retryAfterMs = result.reason instanceof FetchError ? result.reason.retryAfterMs : undefined;
		rpcHealth.recordFailure(endpoint, category, retryAfterMs);
		log.warn("RPC head probe failed", {
			endpoint,
			error: result.reason instanceof Error ? result.reason.message : String(result.reason),
			category,
		});
		return [];
	});

	if (successes.length === 0) {
		throw new Error("All Hive endpoints exhausted");
	}

	return selectConsensusHead(successes);
}

/**
 * Checks server clock against Hive blockchain time.
 * Returns whether the drift is within acceptable limits.
 * The caller should disable the multisig service if drift is excessive.
 */
export async function checkClockDrift(): Promise<{ ok: boolean; driftMs: number }> {
	try {
		const result = await callWithFailover<Record<string, unknown>>(
			"condenser_api.get_dynamic_global_properties", [],
		);
		const blockTime = new Date(result.time + "Z").getTime();
		const serverTime = Date.now();
		const driftMs = Math.abs(serverTime - blockTime);

		if (driftMs > MAX_CLOCK_DRIFT_MS) {
			log.error("CLOCK DRIFT DETECTED — multisig should be disabled", {
				serverTime: new Date(serverTime).toISOString(),
				blockchainTime: new Date(blockTime).toISOString(),
				driftMs,
				driftSec: Math.round(driftMs / 1000),
				recommendation: "Verify NTP is running: timedatectl status",
			});
			return { ok: false, driftMs };
		}

		log.info("Clock sync OK", { driftMs });
		return { ok: true, driftMs };
	} catch (err) {
		log.warn("Could not verify clock drift — assuming OK", {
			error: err instanceof Error ? err.message : String(err),
		});
		return { ok: true, driftMs: -1 };
	}
}

export async function getHeadBlockNum(): Promise<number> {
	const maxAttempts = config.hiveEndpoints.length * 2;
	for (let attempt = 0; attempt < maxAttempts; attempt++) {
		const endpoint = hafahHealth.selectEndpoint();
		const start = performance.now();
		try {
			const response = await fetch(`${endpoint}/hafah-api/headblock`, { signal: AbortSignal.timeout(10_000) });
			if (!response.ok) {
				const retryAfterMs = parseRetryAfterHeader(response);
				await response.text().catch(() => {});
				throw new FetchError(response.status, endpoint, response.statusText, retryAfterMs);
			}
			const text = await response.text();
			const blockNum = parseInt(text, 10);
			if (Number.isNaN(blockNum)) throw new Error(`Invalid headblock: ${text}`);
			hafahHealth.recordSuccess(endpoint, performance.now() - start);
			return blockNum;
		} catch (err) {
			const category = classifyError(err);
			const retryAfterMs = err instanceof FetchError ? err.retryAfterMs : undefined;
			hafahHealth.recordFailure(endpoint, category, retryAfterMs);
			logRetryFailure("HafAH headblock failed", endpoint, attempt, maxAttempts, err, category);
			if (attempt === maxAttempts - 1) throw err;
			await new Promise(r => setTimeout(r, getBackoffMs(attempt, category)));
		}
	}
	throw new Error("All endpoints exhausted for headblock");
}

/**
 * Fetch ALL custom_json operations in a block range using HafAH.
 * Handles cursor pagination automatically.
 * Returns operations grouped by block for compatibility with existing parser.
 */
export async function getCustomJsonInRange(fromBlock: number, toBlock: number, protocolId: string, behind = 0): Promise<HafAHOperation[]> {
	const pageSize = behind > MASSIVE_SYNC_THRESHOLD
		? HAFAH_PAGE_SIZE_MASSIVE
		: behind > LIVE_SYNC_THRESHOLD
			? HAFAH_PAGE_SIZE_NORMAL
			: HAFAH_PAGE_SIZE_LIVE;

	const allOps: HafAHOperation[] = [];
	let operationBegin = "-1";
	let pages = 0;
	const maxPages = 100;

	while (pages < maxPages) {
		const result = await hafahWithFailover(fromBlock, toBlock, operationBegin, pageSize);
		const ops = result.ops;

		// Filter to only our protocol operations
		const ours = ops.filter(op => op.op.value.id === protocolId);
		allOps.push(...ours);
		pages++;

		// Trust ONLY the cursor for termination. Using `ops.length < pageSize` as an
		// early-exit heuristic is unsafe: some HAF nodes return fewer ops than requested
		// while still offering `next_operation_begin`, which would silently drop the
		// remaining pages.
		// End-of-stream signals from HafAH: `null` OR the string sentinel "0".
		// The non-advancing-cursor guard is a defensive backstop against future server
		// quirks — without it a stuck cursor would re-read the same page until maxPages.
		if (
			result.next_operation_begin === null ||
			result.next_operation_begin === "0" ||
			result.next_operation_begin === operationBegin
		) break;
		operationBegin = result.next_operation_begin;
	}

	if (pages >= maxPages) {
		// MUST throw — returning a partial set would let the sync engine commit those ops
		// and advance `last_block` past blocks whose ops were silently dropped, breaking
		// the completeness invariant for ownership data. The sync loop will retry; if the
		// overflow is real, the operator must reduce HAFAH_BLOCK_RANGE.
		throw new Error(
			`HafAH pagination overflow: range ${fromBlock}-${toBlock} exceeded ${maxPages} pages ` +
			`× ${pageSize} ops/page. Reduce HAFAH_BLOCK_RANGE or investigate custom_json density.`,
		);
	}
	if (allOps.length > 0) {
		log.debug("HafAH found", { fromBlock, toBlock, pages, protocolOps: allOps.length });
	}

	return allOps;
}

/** Optimal block range for HafAH queries */
export function getHafAHBlockRange(): number {
	return HAFAH_BLOCK_RANGE;
}

// ============ BLOCK HEADERS ============

function parseBlockId(result: unknown): string | null {
	if (typeof result !== "object" || result === null) return null;
	const root = result as Record<string, unknown>;
	const headerContainer = root.block_id ? root : (root.block as Record<string, unknown> | undefined);
	if (!headerContainer) return null;
	const blockId = headerContainer.block_id;
	if (typeof blockId !== "string" || blockId.length === 0) return null;
	return blockId;
}

export type BlockIdObservation = Readonly<{
	readonly endpoint: string;
	readonly blockId: string;
}>;

/**
 * Fans out `block_api.get_block` to every configured Hive endpoint in parallel
 * and returns only the successful observations. Callers decide how many they
 * need for a quorum; startup cross-check requires ≥2.
 */
export async function getBlockIdFromAllEndpoints(blockNum: number): Promise<ReadonlyArray<BlockIdObservation>> {
	const results = await Promise.allSettled(
		config.hiveEndpoints.map(async (endpoint) => {
			const start = performance.now();
			const response = await rpcCall<Record<string, unknown>>(
				endpoint,
				"block_api.get_block",
				{ block_num: blockNum },
			);
			rpcHealth.recordSuccess(endpoint, performance.now() - start);
			const blockId = parseBlockId(response);
			if (!blockId) {
				throw new Error(`block_api.get_block returned no block_id for block ${blockNum}`);
			}
			return { endpoint, blockId };
		}),
	);

	const successes: BlockIdObservation[] = [];
	for (let i = 0; i < results.length; i++) {
		const result = results[i];
		const endpoint = config.hiveEndpoints[i] ?? "";
		if (!result) continue;
		if (result.status === "fulfilled") {
			successes.push(result.value);
			continue;
		}
		const category = classifyError(result.reason);
		const retryAfterMs = result.reason instanceof FetchError ? result.reason.retryAfterMs : undefined;
		rpcHealth.recordFailure(endpoint, category, retryAfterMs);
		log.warn("Block header probe failed", {
			endpoint,
			blockNum,
			error: result.reason instanceof Error ? result.reason.message : String(result.reason),
			category,
		});
	}
	return successes;
}

// ============ TRANSFER VERIFICATION (for buy payment checks) ============

const NAI_TO_CURRENCY: Record<string, string> = {
	"@@000000021": "HIVE",
	"@@000000013": "HBD",
};

export interface TransferDetail {
	from: string;
	to: string;
	amount: number;
	currency: string;
	memo: string;
}

/**
 * Parses a Hive-formatted asset value in either NAI form
 * (`{ amount, precision, nai }`) or legacy string form (`"1.000 HIVE"`).
 * Used both for transfer amounts inside operations and for account balance
 * fields returned by `condenser_api.get_accounts`.
 */
export function parseHiveAsset(raw: unknown): { amount: number; currency: string } | null {
	if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
		const nai = raw as { amount?: string; precision?: number; nai?: string };
		if (typeof nai.amount === "string" && typeof nai.precision === "number" && typeof nai.nai === "string") {
			const currency = NAI_TO_CURRENCY[nai.nai];
			if (!currency) return null;
			return { amount: parseInt(nai.amount, 10) / Math.pow(10, nai.precision), currency };
		}
	}
	if (typeof raw === "string") {
		const parts = raw.split(" ");
		// Hive consensus emits HIVE/HBD assets with exactly 3 decimals.
		// Rejecting non-canonical formats blocks malformed RPC payloads
		// before they reach fee-validator's epsilon comparison.
		if (parts.length === 2 && parts[0] && parts[1] && /^\d+\.\d{3}$/.test(parts[0])) {
			const amount = parseFloat(parts[0]);
			if (Number.isNaN(amount)) return null;
			return { amount, currency: parts[1] };
		}
	}
	return null;
}

/**
 * Fetch all operations in a specific transaction by txId via JSON-RPC,
 * then extract transfer operations. Direct lookup — no block scan needed.
 */
export async function getTransfersInTransaction(txId: string): Promise<TransferDetail[]> {
	const result = await callWithFailover<Record<string, unknown>>(
		"account_history_api.get_transaction", { id: txId, include_reversible: false },
	);

	const operations = Array.isArray(result.operations) ? result.operations : [];

	const transfers: TransferDetail[] = [];
	for (const raw of operations) {
		if (typeof raw !== "object" || raw === null) continue;
		const op = raw as Record<string, unknown>;
		if (op.type !== "transfer_operation") continue;
		if (typeof op.value !== "object" || op.value === null) continue;
		const val = op.value as Record<string, unknown>;
		if (typeof val.from !== "string" || typeof val.to !== "string") continue;

		const parsed = parseHiveAsset(val.amount);
		if (!parsed) continue;

		transfers.push({
			from: val.from,
			to: val.to,
			amount: parsed.amount,
			currency: parsed.currency,
			memo: typeof val.memo === "string" ? val.memo : "",
		});
	}

	return transfers;
}

// ============ ACCOUNT BALANCE (for solvency pre-check at /api/multisig/buy) ============

export interface AccountLiquidBalance {
	readonly hive: number;
	readonly hbd: number;
}

interface HiveAccountRow {
	readonly balance: unknown;
	readonly hbd_balance: unknown;
}

/**
 * Returns the account's LIQUID balances for HIVE and HBD. Savings and vesting
 * are intentionally excluded — only liquid funds can settle a transfer_operation
 * in the same block, which is the case the buy multisig flow needs to verify.
 *
 * Used as an anti-grief gate: the multisig API rejects buy requests whose buyer
 * cannot cover the transfers BEFORE broadcasting `buy_commitment`, preventing
 * an attacker with empty accounts from locking listings repeatedly via the
 * pending_sale slot.
 *
 * Failover via `callWithFailover` (multi-endpoint, backoff, retry-after). A
 * lying endpoint understating balance produces a false negative (legitimate
 * buyer rejected, retries) — annoying but never unsafe. A lying endpoint
 * overstating balance regresses to today's behavior (Hive consensus rejects
 * the transfer at block production), so the worst case is the slot we already
 * accept hoy.
 *
 * Throws if the account is not found OR if Hive returns an asset format that
 * we cannot parse — the caller maps this to a multisig error.
 */
export async function getAccountLiquidBalance(account: string): Promise<AccountLiquidBalance> {
	const rows = await callWithFailover<ReadonlyArray<HiveAccountRow>>(
		"condenser_api.get_accounts",
		[[account]],
	);
	const row = rows[0];
	if (!row) throw new Error(`Hive account not found: ${account}`);

	const hive = parseHiveAsset(row.balance);
	const hbd = parseHiveAsset(row.hbd_balance);
	if (!hive || hive.currency !== "HIVE") {
		throw new Error(`Unparseable HIVE balance for ${account}: ${JSON.stringify(row.balance)}`);
	}
	if (!hbd || hbd.currency !== "HBD") {
		throw new Error(`Unparseable HBD balance for ${account}: ${JSON.stringify(row.hbd_balance)}`);
	}
	return { hive: hive.amount, hbd: hbd.amount };
}
