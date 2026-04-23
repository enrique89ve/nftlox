import { describe, expect, test } from "bun:test";

type EnvSnapshot = Record<string, string | undefined>;

const CONFIG_MODULE_URL = new URL("../config.ts", import.meta.url);

function snapshotEnv(keys: readonly string[]): EnvSnapshot {
	const snapshot: EnvSnapshot = {};
	for (const key of keys) {
		snapshot[key] = process.env[key];
	}
	return snapshot;
}

function restoreEnv(snapshot: EnvSnapshot): void {
	for (const [key, value] of Object.entries(snapshot)) {
		if (value === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = value;
		}
	}
}

async function loadResolver() {
	const keys = ["INDEXER_ROLE", "NODE_ENV", "POSTGRES_PASSWORD", "ACTIVE_KEY"] as const;
	const snapshot = snapshotEnv(keys);
	process.env.INDEXER_ROLE = "sync";
	process.env.NODE_ENV = "test";
	process.env.POSTGRES_PASSWORD = "nftlox_dev";
	delete process.env.ACTIVE_KEY;

	try {
		const mod = await import(`${CONFIG_MODULE_URL.href}?case=${Math.random()}`) as typeof import("../config.ts");
		return mod.resolveDatabaseConfig;
	} finally {
		restoreEnv(snapshot);
	}
}

describe("resolveDatabaseConfig", () => {
	test("prefers explicit external DATABASE_URL in auto mode", async () => {
		const resolveDatabaseConfig = await loadResolver();
		const resolved = resolveDatabaseConfig({
			NODE_ENV: "production",
			DATABASE_MODE: "auto",
			DATABASE_URL: "postgres://reader:secret@db.example.com:6432/nftlox_prod",
		});

		expect(resolved.mode).toBe("external");
		expect(resolved.source).toBe("url");
		expect(resolved.host).toBe("db.example.com");
		expect(resolved.port).toBe(6432);
		expect(resolved.database).toBe("nftlox_prod");
		expect(resolved.shouldAutoStartLocalPostgres).toBe(false);
	});

	test("builds an internal connection from parts", async () => {
		const resolveDatabaseConfig = await loadResolver();
		const resolved = resolveDatabaseConfig({
			NODE_ENV: "production",
			DATABASE_MODE: "internal",
			POSTGRES_HOST: "postgres",
			POSTGRES_PORT: "5432",
			POSTGRES_DB: "nftlox_indexer",
			POSTGRES_USER: "nftlox",
			POSTGRES_PASSWORD: "secret",
			DATABASE_URL: "postgres://wrong:wrong@external.example.com:5432/other_db",
		});

		expect(resolved.mode).toBe("internal");
		expect(resolved.source).toBe("parts");
		expect(resolved.host).toBe("postgres");
		expect(resolved.port).toBe(5432);
		expect(resolved.database).toBe("nftlox_indexer");
		expect(resolved.url).toContain("@postgres:5432/nftlox_indexer");
		expect(resolved.shouldAutoStartLocalPostgres).toBe(false);
	});

	test("uses host-run development defaults when no DB env is set", async () => {
		const resolveDatabaseConfig = await loadResolver();
		const resolved = resolveDatabaseConfig({
			NODE_ENV: "development",
		});

		expect(resolved.mode).toBe("internal");
		expect(resolved.source).toBe("dev-default");
		expect(resolved.host).toBe("localhost");
		expect(resolved.port).toBe(5432);
		expect(resolved.database).toBe("nftlox_indexer");
		expect(resolved.shouldAutoStartLocalPostgres).toBe(true);
	});

	test("rejects external mode without DATABASE_URL", async () => {
		const resolveDatabaseConfig = await loadResolver();
		expect(() =>
			resolveDatabaseConfig({
				NODE_ENV: "production",
				DATABASE_MODE: "external",
			})).toThrow("DATABASE_MODE=external requires DATABASE_URL to be set");
	});
});
