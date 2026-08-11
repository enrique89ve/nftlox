// Hive account observation client — batch JSON-RPC with bounded failover.
// This module deliberately does not decide how an indexer handles missing
// accounts; it returns current existence plus the immutable creation timestamp
// needed for deterministic historical replay.

import { normalizeHiveTimestampToUtc } from "@/utils/hive-timestamp.ts";

// Keep the normal path below one second. A fast connection failure immediately
// releases the remaining budget to the next endpoint; a slow/dead endpoint is
// bounded by the per-attempt timeout and the global deadline.
const DEFAULT_TIMEOUT_MS = 850;
const DEFAULT_DEADLINE_MS = 1_500;
const DEFAULT_BATCH_SIZE = 1_000;

type JsonRecord = Record<string, unknown>;

export type HiveAccountLookupResult = Readonly<{
	readonly requested: readonly string[];
	readonly accounts: ReadonlyMap<string, HiveAccountObservation>;
	readonly missing: ReadonlySet<string>;
	readonly attemptedEndpoints: readonly string[];
}>;

export type HiveAccountObservation = Readonly<{
	readonly name: string;
	readonly createdAt: string;
}>;

export type HiveAccountClientOptions = Readonly<{
	readonly endpoints: readonly string[];
	readonly timeoutMs?: number;
	readonly deadlineMs?: number;
	readonly batchSize?: number;
	readonly fetchImpl?: typeof fetch;
}>;

export type HiveAccountClient = Readonly<{
	readonly lookup: (accounts: readonly string[]) => Promise<HiveAccountLookupResult>;
}>;

export type HiveAccountLookupUnavailableError = Error & Readonly<{
	readonly code: "HIVE_ACCOUNT_LOOKUP_UNAVAILABLE";
	readonly attemptedEndpoints: readonly string[];
}>;

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeAccounts(accounts: readonly string[]): string[] {
	const unique = new Set<string>();
	for (const account of accounts) {
		if (typeof account !== "string" || account.length === 0) {
			throw new Error("Hive account lookup requires non-empty account names");
		}
		unique.add(account);
	}
	return [...unique];
}

function normalizeEndpoints(endpoints: readonly string[]): string[] {
	const unique = new Set<string>();
	for (const endpoint of endpoints) {
		const normalized = endpoint.trim().replace(/\/+$/, "");
		if (normalized.length > 0) unique.add(normalized);
	}
	if (unique.size === 0) throw new Error("Hive account lookup requires at least one endpoint");
	return [...unique];
}

function readAccounts(raw: unknown, endpoint: string): HiveAccountObservation[] {
	if (!isRecord(raw)) {
		throw new Error(`Invalid account response from ${endpoint}: expected JSON-RPC envelope`);
	}
	if (raw.error !== undefined && raw.error !== null) {
		const error = isRecord(raw.error) && typeof raw.error.message === "string"
			? raw.error.message
			: "unknown RPC error";
		throw new Error(`Hive account RPC error from ${endpoint}: ${error}`);
	}
	if (!Array.isArray(raw.result)) {
		throw new Error(`Invalid account response from ${endpoint}: result must be an array`);
	}

	return raw.result.map((row, index) => {
		if (!isRecord(row) || typeof row.name !== "string") {
			throw new Error(`Invalid account response from ${endpoint}: result[${index}].name missing`);
		}
		if (typeof row.created !== "string") {
			throw new Error(`Invalid account response from ${endpoint}: result[${index}].created missing`);
		}
		return {
			name: row.name,
			createdAt: normalizeHiveTimestampToUtc(
				row.created,
				`Hive account ${row.name} created timestamp`,
			),
		};
	});
}

function createUnavailableError(
	attemptedEndpoints: readonly string[],
	lastError: unknown,
): HiveAccountLookupUnavailableError {
	const message = `Hive account lookup unavailable after ${attemptedEndpoints.length} endpoint attempt(s)`;
	const error = Object.assign(
		new Error(message, { cause: lastError }),
		{
			name: "HiveAccountLookupUnavailableError" as const,
			code: "HIVE_ACCOUNT_LOOKUP_UNAVAILABLE" as const,
			attemptedEndpoints: [...attemptedEndpoints],
		},
	);
	return error;
}

function chunk<T>(items: readonly T[], size: number): T[][] {
	const chunks: T[][] = [];
	for (let index = 0; index < items.length; index += size) {
		chunks.push(items.slice(index, index + size));
	}
	return chunks;
}

function validatePositiveInteger(value: number | undefined, fallback: number, label: string): number {
	if (value === undefined) return fallback;
	if (!Number.isSafeInteger(value) || value < 1) {
		throw new Error(`${label} must be a positive safe integer`);
	}
	return value;
}

export function createHiveAccountClient(options: HiveAccountClientOptions): HiveAccountClient {
	const endpoints = normalizeEndpoints(options.endpoints);
	const timeoutMs = validatePositiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS, "timeoutMs");
	const deadlineMs = validatePositiveInteger(options.deadlineMs, DEFAULT_DEADLINE_MS, "deadlineMs");
	const batchSize = validatePositiveInteger(options.batchSize, DEFAULT_BATCH_SIZE, "batchSize");

	async function fetchBatch(
		accounts: readonly string[],
		endpoint: string,
		attemptedEndpoints: string[],
		deadlineAt: number,
	): Promise<ReadonlyMap<string, HiveAccountObservation>> {
		const fetchImpl = options.fetchImpl ?? globalThis.fetch;
		const remainingMs = deadlineAt - performance.now();
		if (remainingMs <= 0) {
			throw new Error("Hive account lookup deadline exceeded");
		}

		attemptedEndpoints.push(endpoint);
		const response = await fetchImpl(endpoint, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				jsonrpc: "2.0",
				method: "condenser_api.get_accounts",
				params: [accounts, false],
				id: 1,
			}),
			signal: AbortSignal.timeout(Math.min(timeoutMs, Math.max(1, Math.ceil(remainingMs)))),
		});
		if (!response.ok) {
			await response.text().catch(() => {});
			throw new Error(`HTTP ${response.status}: ${response.statusText}`);
		}

		const returnedAccounts = readAccounts(await response.json(), endpoint);
		const requested = new Set(accounts);
		return new Map(
			returnedAccounts
				.filter((account) => requested.has(account.name))
				.map((account) => [account.name, account]),
		);
	}

	async function lookup(accounts: readonly string[]): Promise<HiveAccountLookupResult> {
		const requested = normalizeAccounts(accounts);
		if (requested.length === 0) {
			return {
				requested,
				accounts: new Map(),
				missing: new Set(),
				attemptedEndpoints: [],
			};
		}

		const attemptedEndpoints: string[] = [];
		const deadlineAt = performance.now() + deadlineMs;
		let lastError: unknown = new Error("No endpoint attempt was made");
		let foundAccounts: Map<string, HiveAccountObservation> | undefined;

		for (const endpoint of endpoints) {
			const endpointAccounts = new Map<string, HiveAccountObservation>();
			try {
				for (const accountsBatch of chunk(requested, batchSize)) {
					const batchAccounts = await fetchBatch(
						accountsBatch,
						endpoint,
						attemptedEndpoints,
						deadlineAt,
					);
					for (const [name, account] of batchAccounts) endpointAccounts.set(name, account);
				}
				foundAccounts = endpointAccounts;
				break;
			} catch (error) {
				lastError = error;
			}
		}
		if (!foundAccounts) throw createUnavailableError(attemptedEndpoints, lastError);

		const missing = new Set(requested.filter((account) => !foundAccounts.has(account)));
		return { requested, accounts: foundAccounts, missing, attemptedEndpoints };
	}

	return { lookup };
}
