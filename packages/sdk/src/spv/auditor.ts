// SPV "Boleto Suizo" - Auditor
// Coordinator that randomly samples pack_open events and verifies them

import {
	DEFAULT_HIVE_ENDPOINTS,
	DEFAULT_HIVE_TIMEOUT_MS,
	DEFAULT_AUDIT_SAMPLE_SIZE,
	selectRandomSample,
} from "./constants.ts";
import { ACTION_PACK_OPEN } from "../constants.ts";
import { createDefaultL1Config } from "./hive-l1-client.ts";
import { verifyPackOpen } from "./verifiers.ts";
import type {
	AuditorConfig,
	AuditReport,
	PackOpenVerificationResult,
} from "./types.ts";

// ============ CONFIG ============

export function createAuditorConfig(
	overrides?: Partial<AuditorConfig>,
): AuditorConfig {
	return {
		indexerBaseUrl: overrides?.indexerBaseUrl ?? "",
		hiveEndpoints: overrides?.hiveEndpoints ?? [...DEFAULT_HIVE_ENDPOINTS],
		hiveTimeoutMs: overrides?.hiveTimeoutMs ?? DEFAULT_HIVE_TIMEOUT_MS,
		sampleSize: overrides?.sampleSize ?? DEFAULT_AUDIT_SAMPLE_SIZE,
	};
}

// ============ PACK OPEN EVENT DISCOVERY ============

interface PackOpenEvent {
	txId: string;
	blockNum: number;
	packId: string;
	fromAccount: string;
}

/**
 * Fetches recent pack_open events from the indexer.
 */
export async function fetchRecentPackOpenEvents(
	config: AuditorConfig,
	limit: number = 20,
): Promise<PackOpenEvent[]> {
	const packsResponse = await fetch(
		`${config.indexerBaseUrl}/api/packs?limit=${limit}`,
	);
	if (!packsResponse.ok) {
		throw new Error(`Failed to fetch packs: HTTP ${packsResponse.status}`);
	}

	const packsRaw = await packsResponse.json() as unknown;
	if (!Array.isArray(packsRaw)) {
		throw new Error("Indexer /api/packs did not return an array");
	}

	const packs = packsRaw as Array<Record<string, unknown>>;
	const events: PackOpenEvent[] = [];

	for (const pack of packs) {
		const packId = pack.id;
		if (typeof packId !== "string") {
			console.warn(`SPV audit: skipping pack with non-string id: ${String(packId)}`);
			continue;
		}

		const historyResponse = await fetch(
			`${config.indexerBaseUrl}/api/packs/${packId}/history?limit=50`,
		);
		if (!historyResponse.ok) {
			console.warn(`SPV audit: failed to fetch history for pack ${packId} (HTTP ${historyResponse.status})`);
			continue;
		}

		const historyRaw = await historyResponse.json() as unknown;
		if (!Array.isArray(historyRaw)) {
			console.warn(`SPV audit: unexpected non-array history response for pack ${packId}`);
			continue;
		}

		const history = historyRaw as Array<{
			event_type: string;
			tx_id: string;
			block_num: number;
			from_account: string;
		}>;

		for (const entry of history) {
			if (entry.event_type === ACTION_PACK_OPEN) {
				events.push({
					txId: entry.tx_id,
					blockNum: entry.block_num,
					packId,
					fromAccount: entry.from_account,
				});
			}
		}
	}

	return events;
}

// ============ AUDIT ============

/**
 * Runs a "Boleto Suizo" audit: randomly samples pack_open events
 * and verifies each one against Hive L1.
 */
export async function runAudit(
	config: AuditorConfig,
): Promise<AuditReport> {
	const startedAt = Date.now();
	const results: PackOpenVerificationResult[] = [];

	const events = await fetchRecentPackOpenEvents(config);
	if (events.length === 0) {
		return {
			startedAt,
			completedAt: Date.now(),
			durationMs: Date.now() - startedAt,
			samplesChecked: 0,
			verified: 0,
			mismatches: 0,
			errors: 0,
			results: [],
		};
	}

	// Random sample selection (true randomness, not deterministic)
	const sampleCount = Math.min(config.sampleSize, events.length);
	const sampled = selectRandomSample(events, sampleCount);

	const l1Config = createDefaultL1Config();
	l1Config.endpoints = config.hiveEndpoints;
	l1Config.timeoutMs = config.hiveTimeoutMs;

	for (const event of sampled) {
		const result = await verifyPackOpen({
			txId: event.txId,
			blockNum: event.blockNum,
			indexerBaseUrl: config.indexerBaseUrl,
			l1Config,
		});
		results.push(result);
	}

	const completedAt = Date.now();

	return {
		startedAt,
		completedAt,
		durationMs: completedAt - startedAt,
		samplesChecked: results.length,
		verified: results.filter((r) => r.status === "verified").length,
		mismatches: results.filter((r) => r.status === "mismatch").length,
		errors: results.filter((r) => r.status === "error" || r.status === "not_found").length,
		results,
	};
}

/**
 * Verifies a single specific pack_open transaction (user-initiated).
 */
export async function runSingleVerification(
	config: AuditorConfig,
	txId: string,
	blockNum: number,
): Promise<PackOpenVerificationResult> {
	const l1Config = createDefaultL1Config();
	l1Config.endpoints = config.hiveEndpoints;
	l1Config.timeoutMs = config.hiveTimeoutMs;

	return verifyPackOpen({
		txId,
		blockNum,
		indexerBaseUrl: config.indexerBaseUrl,
		l1Config,
	});
}

