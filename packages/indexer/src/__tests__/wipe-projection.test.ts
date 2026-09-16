import { describe, it, expect } from "bun:test";
import { STATE_SINGLETONS, buildProjectionTruncateStmt } from "@/bootstrap.ts";

describe("STATE_SINGLETONS", () => {
	it("includes the two known singleton tables", () => {
		expect(STATE_SINGLETONS.has("state_meta")).toBe(true);
		expect(STATE_SINGLETONS.has("sync_state")).toBe(true);
	});

	it("does not include any projected tables", () => {
		expect(STATE_SINGLETONS.has("assets")).toBe(false);
		expect(STATE_SINGLETONS.has("collections")).toBe(false);
		expect(STATE_SINGLETONS.has("burned_assets")).toBe(false);
	});
});

describe("buildProjectionTruncateStmt", () => {
	it("excludes singletons from the TRUNCATE list", () => {
		const stmt = buildProjectionTruncateStmt([
			"state_meta",
			"sync_state",
			"assets",
			"collections",
		]);
		expect(stmt).toBe(`TRUNCATE TABLE "assets", "collections" CASCADE`);
	});

	it("preserves input order of non-singleton tables", () => {
		const stmt = buildProjectionTruncateStmt([
			"assets",
			"state_meta",
			"collections",
			"sync_state",
			"burned_assets",
		]);
		expect(stmt).toBe(`TRUNCATE TABLE "assets", "collections", "burned_assets" CASCADE`);
	});

	it("returns null when only singletons are present (empty install)", () => {
		expect(buildProjectionTruncateStmt(["state_meta", "sync_state"])).toBeNull();
	});

	it("returns null when no tables at all are present", () => {
		expect(buildProjectionTruncateStmt([])).toBeNull();
	});

	it("quotes identifiers with embedded double-quotes", () => {
		const stmt = buildProjectionTruncateStmt([`weird"name`]);
		expect(stmt).toBe(`TRUNCATE TABLE "weird""name" CASCADE`);
	});

	it("quotes identifiers that look like SQL keywords", () => {
		const stmt = buildProjectionTruncateStmt(["select", "table"]);
		expect(stmt).toBe(`TRUNCATE TABLE "select", "table" CASCADE`);
	});

	it("handles a realistic full schema (snapshot over current tables)", () => {
		const stmt = buildProjectionTruncateStmt([
			"state_meta", "sync_state",
			"collections", "assets",
			"asset_loans", "asset_allowances", "collection_allowances", "schema_versions",
			"data_operators",
			"orphaned_buys", "invalid_operations", "confirmed_operations",
			"owner_asset_counts", "collection_stats",
			"sales", "burned_assets", "archived_collections",
			"multisig_buy_locks",
			"multisig_collection_locks",
			"l2_node_heartbeats", "l2_nodes",
		]);
		// Must include every non-singleton and exclude both singletons.
		expect(stmt).not.toBeNull();
		expect(stmt).not.toContain(`"state_meta"`);
		expect(stmt).not.toContain(`"sync_state"`);
		expect(stmt).toContain(`"assets"`);
		expect(stmt).toContain(`"collections"`);
		expect(stmt).toContain(`"burned_assets"`);
		expect(stmt).toContain(`"schema_versions"`);
		expect(stmt).toContain(`"multisig_buy_locks"`);
		expect(stmt).toContain(`"multisig_collection_locks"`);
		expect(stmt?.endsWith(" CASCADE")).toBe(true);
	});
});
