#!/usr/bin/env bun
/**
 * sync-auth-levels.ts
 *
 * Syncs ACTION_AUTH_LEVEL_MAP in sdk/src/constants.ts from the indexer
 * (source of truth: indexer/src/protocol/auth.ts).
 *
 * Usage:
 *   bun run scripts/sync-auth-levels.ts          # write if out of sync
 *   bun run scripts/sync-auth-levels.ts --check  # exit 1 if out of sync (CI)
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ── Constants ────────────────────────────────────────────────────────────────

const ROOT = join(import.meta.dir, "..");
const INDEXER_AUTH = join(ROOT, "packages/indexer/src/protocol/auth.ts");
const SDK_CONSTANTS = join(ROOT, "packages/sdk/src/constants.ts");

// Marker lines that bracket the map block in sdk/src/constants.ts
const MAP_OPEN_MARKER = "const ACTION_AUTH_LEVEL_MAP = {";
const MAP_CLOSE_MARKER = "} as const satisfies Record<ProtocolAction, AuthLevel>;";

// ── Types ────────────────────────────────────────────────────────────────────

type AuthLevel = "active" | "posting";
type AuthEntry = readonly [constantName: string, level: AuthLevel];

// ── Parsing ──────────────────────────────────────────────────────────────────

function parseAuthMapFromIndexer(source: string): readonly AuthEntry[] {
	const entries: AuthEntry[] = [];
	const pattern = /\[(\w+)\]:\s*"(active|posting)"/g;
	let match: RegExpExecArray | null;

	while ((match = pattern.exec(source)) !== null) {
		const constantName = match[1];
		const level = match[2] as AuthLevel;

		if (constantName === undefined || level === undefined) {
			throw new Error(`Malformed auth entry at index ${match.index}`);
		}

		entries.push([constantName, level]);
	}

	if (entries.length === 0) {
		throw new Error(
			"No auth entries found in indexer auth.ts — file format may have changed.",
		);
	}

	return entries;
}

// ── Replacement ──────────────────────────────────────────────────────────────

function detectIndent(mapBlock: string): string {
	const firstLine = mapBlock.split("\n").find((l) => l.trim().length > 0);
	return firstLine?.match(/^(\s+)/)?.[1] ?? "  ";
}

function buildMapLines(entries: readonly AuthEntry[], indent: string): string {
	return entries.map(([name, level]) => `${indent}[${name}]: "${level}",`).join("\n");
}

function replaceMapBlock(sdkSource: string, entries: readonly AuthEntry[]): string {
	const openIdx = sdkSource.indexOf(MAP_OPEN_MARKER);
	const closeIdx = sdkSource.indexOf(MAP_CLOSE_MARKER);

	if (openIdx === -1) {
		throw new Error(`Marker not found in SDK constants.ts: "${MAP_OPEN_MARKER}"`);
	}
	if (closeIdx === -1) {
		throw new Error(`Marker not found in SDK constants.ts: "${MAP_CLOSE_MARKER}"`);
	}
	if (closeIdx <= openIdx) {
		throw new Error("MAP_CLOSE_MARKER appears before MAP_OPEN_MARKER — unexpected file structure.");
	}

	const beforeBlock = sdkSource.slice(0, openIdx + MAP_OPEN_MARKER.length);
	const afterBlock = sdkSource.slice(closeIdx);
	const existingBlock = sdkSource.slice(openIdx + MAP_OPEN_MARKER.length, closeIdx);

	const indent = detectIndent(existingBlock);
	const newEntries = buildMapLines(entries, indent);

	return `${beforeBlock}\n${newEntries}\n${afterBlock}`;
}

// ── Reporting ────────────────────────────────────────────────────────────────

function printEntries(entries: readonly AuthEntry[]): void {
	const active = entries.filter(([, l]) => l === "active").map(([n]) => n);
	const posting = entries.filter(([, l]) => l === "posting").map(([n]) => n);
	console.log(`  active  (${active.length}): ${active.join(", ")}`);
	console.log(`  posting (${posting.length}): ${posting.length} actions`);
}

// ── Main ─────────────────────────────────────────────────────────────────────

function main(): void {
	const isCheckMode = process.argv.includes("--check");

	const indexerSource = readFileSync(INDEXER_AUTH, "utf8");
	const entries = parseAuthMapFromIndexer(indexerSource);

	console.log(`Parsed ${entries.length} auth entries from indexer:`);
	printEntries(entries);

	const sdkSource = readFileSync(SDK_CONSTANTS, "utf8");
	const updated = replaceMapBlock(sdkSource, entries);

	if (updated === sdkSource) {
		console.log("\nSDK already in sync with indexer. Nothing to do.");
		return;
	}

	if (isCheckMode) {
		console.error("\nSDK auth map is OUT OF SYNC with indexer.");
		console.error("Run `bun run sync:auth` to fix.");
		process.exit(1);
	}

	writeFileSync(SDK_CONSTANTS, updated, "utf8");
	console.log("\nSDK constants.ts updated.");
	console.log("Run `bun test packages/sdk/tests/auth-coherence.test.ts` to verify.");
}

main();
