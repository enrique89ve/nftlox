import { describe, test, expect, beforeAll, afterAll, beforeEach, spyOn } from "bun:test";
import { sql } from "@/db/client.ts";
import {
	findHighestDivergentCheckpointBlock,
	setDivergentAtBlock,
} from "@/db/queries/state-root.ts";
import { tickDivergenceCheck } from "@/services/heartbeat-daemon.ts";
import { config } from "@/config.ts";

// F3.B — divergence detection.
//
// The comparator is a pure read over (state_root_checkpoints JOIN
// l2_node_checkpoints) → it doesn't need the daemon's polling loop, the Hive
// signer, or the network to be wired. We exercise the query directly and the
// `tickDivergenceCheck` integration, then verify the singleton flag on
// state_meta moves monotonically. No mocks needed beyond the logger spy used
// to assert the emergency log line on a hit.

const OUR_ACCOUNT = config.hiveAccount;
const PEER_HONEST = "peer-honest";
const PEER_BYZANTINE = "peer-byzantine";
const NODE_ENDPOINT = "divergence.example.com";

// Pinned aligned boundary so tests don't rely on wall-clock or counters.
// state_root_checkpoints has no alignment CHECK, but using realistic boundaries
// makes failure messages readable.
const BLOCK_A = 100_000_000;
const BLOCK_B = 100_001_000;
const BLOCK_C = 100_002_000;

const ROOT_OURS_HEX = "a".repeat(64);
const ROOT_PEER_HEX = "b".repeat(64);
const ROOT_OURS_FORMATTED = `sha256:${ROOT_OURS_HEX}`;
const ROOT_PEER_FORMATTED = `sha256:${ROOT_PEER_HEX}`;

let txCounter = 0;
function detTxId(tag: string): string {
	const id = ++txCounter;
	return `tx_div_${tag}_${id}`;
}

async function ensurePeerNode(account: string): Promise<void> {
	await sql`
		INSERT INTO l2_nodes (account, endpoint, status, block_num, tx_id)
		VALUES (${account}, ${NODE_ENDPOINT}, 'active', 99999999, ${detTxId("reg")})
		ON CONFLICT (account) DO NOTHING
	`;
}

async function insertOurSnapshot(blockNum: number, hex: string): Promise<void> {
	const buf = Buffer.from(hex, "hex");
	await sql`
		INSERT INTO state_root_checkpoints (block_num, state_root)
		VALUES (${blockNum}, ${buf})
		ON CONFLICT (block_num) DO UPDATE SET state_root = EXCLUDED.state_root
	`;
}

async function insertPeerCheckpoint(
	account: string,
	blockNum: number,
	formattedRoot: string,
): Promise<void> {
	await ensurePeerNode(account);
	await sql`
		INSERT INTO l2_node_checkpoints (account, block_num, state_root, tx_id)
		VALUES (${account}, ${blockNum}, ${formattedRoot}, ${detTxId(`cp_${account}_${blockNum}`)})
	`;
}

async function readDivergentFlag(): Promise<number | null> {
	const [row] = await sql`SELECT divergent_at_block FROM state_meta WHERE id = 1`;
	const raw = row?.divergent_at_block;
	if (raw === null || raw === undefined) return null;
	const n = Number(raw);
	return Number.isFinite(n) ? n : null;
}

async function clearAllDivergenceState(): Promise<void> {
	await sql`DELETE FROM l2_node_checkpoints`;
	await sql`DELETE FROM l2_node_heartbeats`;
	await sql`DELETE FROM state_root_checkpoints`;
	await sql`DELETE FROM l2_nodes`;
	await sql`UPDATE state_meta SET divergent_at_block = NULL WHERE id = 1`;
}

describe("F3.B divergence detection", () => {
	beforeAll(async () => {
		// Schema is bootstrapped by handlers.test.ts in a full run, but we own
		// the suite when invoked in isolation. Re-applying schema.sql is
		// idempotent and makes sure `divergent_at_block` is present.
		const schemaFile = Bun.file(import.meta.dir + "/../db/schema.sql");
		await sql.unsafe(await schemaFile.text());
	});

	afterAll(async () => {
		await clearAllDivergenceState();
	});

	beforeEach(async () => {
		await clearAllDivergenceState();
	});

	describe("findHighestDivergentCheckpointBlock", () => {
		test("returns null when there are no checkpoints at all", async () => {
			const hit = await findHighestDivergentCheckpointBlock(OUR_ACCOUNT);
			expect(hit).toBeNull();
			expect(await readDivergentFlag()).toBeNull();
		});

		test("returns null when we have local snapshots but no peer published one", async () => {
			await insertOurSnapshot(BLOCK_A, ROOT_OURS_HEX);
			const hit = await findHighestDivergentCheckpointBlock(OUR_ACCOUNT);
			expect(hit).toBeNull();
		});

		test("returns null when peers have checkpoints but we have no local snapshot", async () => {
			await insertPeerCheckpoint(PEER_HONEST, BLOCK_A, ROOT_PEER_FORMATTED);
			const hit = await findHighestDivergentCheckpointBlock(OUR_ACCOUNT);
			expect(hit).toBeNull();
		});

		test("returns null when our root matches a peer's root at the same block", async () => {
			await insertOurSnapshot(BLOCK_A, ROOT_OURS_HEX);
			await insertPeerCheckpoint(PEER_HONEST, BLOCK_A, ROOT_OURS_FORMATTED);
			const hit = await findHighestDivergentCheckpointBlock(OUR_ACCOUNT);
			expect(hit).toBeNull();
		});

		test("detects disagreement and returns the diagnostic tuple", async () => {
			await insertOurSnapshot(BLOCK_A, ROOT_OURS_HEX);
			await insertPeerCheckpoint(PEER_BYZANTINE, BLOCK_A, ROOT_PEER_FORMATTED);

			const hit = await findHighestDivergentCheckpointBlock(OUR_ACCOUNT);
			expect(hit).not.toBeNull();
			expect(hit!.blockNum).toBe(BLOCK_A);
			expect(hit!.ourRoot).toBe(ROOT_OURS_FORMATTED);
			expect(hit!.theirAccount).toBe(PEER_BYZANTINE);
			expect(hit!.theirRoot).toBe(ROOT_PEER_FORMATTED);
		});

		test("returns the HIGHEST block when divergence exists at multiple blocks", async () => {
			await insertOurSnapshot(BLOCK_A, ROOT_OURS_HEX);
			await insertOurSnapshot(BLOCK_B, ROOT_OURS_HEX);
			await insertOurSnapshot(BLOCK_C, ROOT_OURS_HEX);
			await insertPeerCheckpoint(PEER_BYZANTINE, BLOCK_A, ROOT_PEER_FORMATTED);
			await insertPeerCheckpoint(PEER_BYZANTINE, BLOCK_B, ROOT_PEER_FORMATTED);
			await insertPeerCheckpoint(PEER_BYZANTINE, BLOCK_C, ROOT_PEER_FORMATTED);

			const hit = await findHighestDivergentCheckpointBlock(OUR_ACCOUNT);
			expect(hit).not.toBeNull();
			expect(hit!.blockNum).toBe(BLOCK_C);
		});

		test("ignores our own account in l2_node_checkpoints — no self-divergence", async () => {
			// If we ever republished our own checkpoint and it differed from the
			// local snapshot (shouldn't happen, but proves the WHERE clause is
			// guarding correctly), the comparator must not flag the node against
			// itself.
			await insertOurSnapshot(BLOCK_A, ROOT_OURS_HEX);
			await insertPeerCheckpoint(OUR_ACCOUNT, BLOCK_A, ROOT_PEER_FORMATTED);

			const hit = await findHighestDivergentCheckpointBlock(OUR_ACCOUNT);
			expect(hit).toBeNull();
		});

		test("absence of a peer checkpoint at our block is NOT divergence", async () => {
			// Local snapshot at BLOCK_B; peer only published BLOCK_A. The
			// comparator must not surface any disagreement at BLOCK_B simply
			// because nobody else has weighed in yet.
			await insertOurSnapshot(BLOCK_B, ROOT_OURS_HEX);
			await insertPeerCheckpoint(PEER_HONEST, BLOCK_A, ROOT_PEER_FORMATTED);

			const hit = await findHighestDivergentCheckpointBlock(OUR_ACCOUNT);
			expect(hit).toBeNull();
		});
	});

	describe("setDivergentAtBlock", () => {
		test("sets the flag when previously NULL", async () => {
			await setDivergentAtBlock(BLOCK_A);
			expect(await readDivergentFlag()).toBe(BLOCK_A);
		});

		test("advances the flag monotonically (later block wins)", async () => {
			await setDivergentAtBlock(BLOCK_A);
			await setDivergentAtBlock(BLOCK_C);
			expect(await readDivergentFlag()).toBe(BLOCK_C);
		});

		test("does not lower the flag (GREATEST semantics)", async () => {
			await setDivergentAtBlock(BLOCK_C);
			await setDivergentAtBlock(BLOCK_A);
			expect(await readDivergentFlag()).toBe(BLOCK_C);
		});

		test("rejects non-positive blockNum", async () => {
			await expect(setDivergentAtBlock(0)).rejects.toThrow(/blockNum/);
			await expect(setDivergentAtBlock(-1)).rejects.toThrow(/blockNum/);
		});
	});

	describe("tickDivergenceCheck", () => {
		test("no-op when there is no divergence — flag stays NULL, no error log", async () => {
			const errSpy = spyOn(console, "error").mockImplementation(() => {});
			try {
				await insertOurSnapshot(BLOCK_A, ROOT_OURS_HEX);
				await insertPeerCheckpoint(PEER_HONEST, BLOCK_A, ROOT_OURS_FORMATTED);

				await tickDivergenceCheck();

				expect(await readDivergentFlag()).toBeNull();
				expect(errSpy).not.toHaveBeenCalled();
			} finally {
				errSpy.mockRestore();
			}
		});

		test("on disagreement: sets the flag AND emits log.error with all four fields", async () => {
			const errSpy = spyOn(console, "error").mockImplementation(() => {});
			try {
				await insertOurSnapshot(BLOCK_A, ROOT_OURS_HEX);
				await insertPeerCheckpoint(PEER_BYZANTINE, BLOCK_A, ROOT_PEER_FORMATTED);

				await tickDivergenceCheck();

				expect(await readDivergentFlag()).toBe(BLOCK_A);
				expect(errSpy).toHaveBeenCalled();

				// Check the structured log carries the diagnostic payload that an
				// operator grepping the logs needs.
				const calls = errSpy.mock.calls;
				const joined = calls.map((args) => args.map((a) => String(a)).join(" ")).join("\n");
				expect(joined).toContain("STATE-ROOT DIVERGENCE DETECTED");
				expect(joined).toContain(String(BLOCK_A));
				expect(joined).toContain(ROOT_OURS_FORMATTED);
				expect(joined).toContain(PEER_BYZANTINE);
				expect(joined).toContain(ROOT_PEER_FORMATTED);
			} finally {
				errSpy.mockRestore();
			}
		});

		test("does not auto-clear: a once-divergent flag persists across ticks with no new disagreement", async () => {
			await setDivergentAtBlock(BLOCK_B);
			expect(await readDivergentFlag()).toBe(BLOCK_B);

			// No checkpoints exist now — old divergence has been "resolved" but
			// we never auto-clear. The flag stays at BLOCK_B until the operator
			// clears it manually.
			await tickDivergenceCheck();
			expect(await readDivergentFlag()).toBe(BLOCK_B);
		});

		test("a more recent divergence raises the flag past an older operator-untouched value", async () => {
			await setDivergentAtBlock(BLOCK_A);
			await insertOurSnapshot(BLOCK_C, ROOT_OURS_HEX);
			await insertPeerCheckpoint(PEER_BYZANTINE, BLOCK_C, ROOT_PEER_FORMATTED);

			const errSpy = spyOn(console, "error").mockImplementation(() => {});
			try {
				await tickDivergenceCheck();
				expect(await readDivergentFlag()).toBe(BLOCK_C);
			} finally {
				errSpy.mockRestore();
			}
		});
	});
});
