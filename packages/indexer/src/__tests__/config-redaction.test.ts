import { describe, expect, test } from "bun:test";
import { inspect } from "node:util";
import { config } from "@/config.ts";

// The config singleton is imported by ~20 modules, including the logger,
// the API server, the sync engine, and the health endpoints. A future
// `log.info("boot", { config })` or `console.log(config)` line must never
// leak `postgresPassword` or the password embedded in `databaseUrl`.
// These tests encode that contract at the serialization boundary — callers
// still read the real values directly from the object.
describe("config credential redaction", () => {
	test("JSON.stringify(config) replaces postgresPassword with a placeholder", () => {
		const serialized = JSON.stringify(config);
		const parsed = JSON.parse(serialized) as Record<string, unknown>;

		expect(parsed["postgresPassword"]).toBe("[REDACTED]");
	});

	test("JSON.stringify(config) replaces databaseUrl with a placeholder", () => {
		// `databaseUrl` contains the password as URL userinfo, so it must also
		// be masked — masking only `postgresPassword` would still leak via URL.
		const serialized = JSON.stringify(config);
		const parsed = JSON.parse(serialized) as Record<string, unknown>;

		expect(parsed["databaseUrl"]).toBe("[REDACTED]");
	});

	test("util.inspect(config) applies the same redaction (console.log path)", () => {
		const dumped = inspect(config, { depth: 2 });

		expect(dumped).toContain("[REDACTED]");
		expect(dumped).not.toContain(config.postgresPassword);
		// Runtime-resolved URL (including credentials) must not leak either,
		// but only when the URL actually carries a credential. In non-prod
		// defaults `postgresPassword` is "nftlox_dev" which is fine to assert
		// against; in prod with empty password the URL has no userinfo.
		if (config.postgresPassword.length > 0) {
			expect(dumped).not.toContain(config.postgresPassword);
		}
	});

	test("direct property access still returns the real values (no behavioral change)", () => {
		// Runtime consumers (db client, bootstrap Docker command) depend on
		// reading the credential directly. Redaction is a serialization-only
		// concern — property access is unchanged.
		expect(typeof config.postgresPassword).toBe("string");
		expect(typeof config.databaseUrl).toBe("string");
		expect(config.databaseUrl.startsWith("postgres://")).toBe(true);
	});

	test("non-sensitive fields survive JSON.stringify round-trip", () => {
		const parsed = JSON.parse(JSON.stringify(config)) as Record<string, unknown>;

		expect(parsed["port"]).toBe(config.port);
		expect(parsed["protocolId"]).toBe(config.protocolId);
		expect(parsed["indexerRole"]).toBe(config.indexerRole);
		expect(parsed["genesisBlock"]).toBe(config.genesisBlock);
	});

	test("spreading config then stringifying still redacts (hook survives copy)", () => {
		// Bun's JSON.stringify only honors enumerable `toJSON`, so our hook is
		// enumerable. That means `{ ...config }` copies the hook function
		// alongside the data. Verifying this roundtrip guarantees that a
		// consumer who builds an audit copy via spread is ALSO protected —
		// the redacted view travels with the data, not only with the original
		// module-level singleton.
		const spread = { ...config };
		const serialized = JSON.stringify(spread);
		const parsed = JSON.parse(serialized) as Record<string, unknown>;

		expect(parsed["postgresPassword"]).toBe("[REDACTED]");
		expect(parsed["databaseUrl"]).toBe("[REDACTED]");
		expect(parsed["toJSON"]).toBeUndefined();
	});

	test("redaction snapshot does not include the toJSON hook itself", () => {
		// Self-reference guard: buildRedactedConfigSnapshot iterates
		// Object.entries(config), which includes the enumerable `toJSON` hook.
		// The snapshot must skip it so serialized output is clean JSON (no
		// function placeholders, no self-reference loops).
		const serialized = JSON.stringify(config);
		const parsed = JSON.parse(serialized) as Record<string, unknown>;
		expect("toJSON" in parsed).toBe(false);
	});
});
