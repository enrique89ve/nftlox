import { describe, expect, test } from "bun:test";

import {
	applyDelta,
	computeStateRootFullScan,
	emptyStateRoot,
	formatStateRoot,
	hashRow,
	parseStateRoot,
	rootsEqual,
	xorInto,
	type NftStateRow,
	type StateRootDelta,
} from "@/utils/state-root-hash.ts";

// These tests prove the mathematical properties the incremental state-root
// algorithm depends on. If any of these break, the production implementation
// cannot be trusted — the XOR approach would no longer converge between
// indexers or remain consistent under replay.

function makeRow(override: Partial<NftStateRow> = {}): NftStateRow {
	return {
		id: "nft_0001",
		owner: "alice",
		previous_owner: null,
		owner_action: "mint",
		owner_operation_id: "3448858700000",
		owner_block_num: 105_530_500,
		...override,
	};
}

describe("xorInto", () => {
	test("XOR with empty buffer is identity", () => {
		const a = new Uint8Array(32).fill(0xab);
		const empty = emptyStateRoot();
		expect(rootsEqual(xorInto(a, empty), a)).toBe(true);
	});

	test("XOR with self yields zero", () => {
		const a = new Uint8Array(32).fill(0x5a);
		expect(rootsEqual(xorInto(a, a), emptyStateRoot())).toBe(true);
	});

	test("XOR is commutative byte-for-byte", () => {
		const a = new Uint8Array(32).fill(0xaa);
		const b = new Uint8Array(32).fill(0x55);
		expect(rootsEqual(xorInto(a, b), xorInto(b, a))).toBe(true);
	});

	test("throws on wrong-length input", () => {
		expect(() => xorInto(new Uint8Array(16), new Uint8Array(32))).toThrow();
		expect(() => xorInto(new Uint8Array(32), new Uint8Array(16))).toThrow();
	});
});

describe("hashRow", () => {
	test("is deterministic for identical input", async () => {
		const row = makeRow();
		const h1 = await hashRow(row);
		const h2 = await hashRow(row);
		expect(rootsEqual(h1, h2)).toBe(true);
	});

	test("is insensitive to object key order (canonical JSON)", async () => {
		const rowA: NftStateRow = {
			id: "nft_1", owner: "alice", previous_owner: "bob",
			owner_action: "transfer", owner_operation_id: "op1", owner_block_num: 100,
		};
		const rowB: NftStateRow = {
			owner_block_num: 100, owner_operation_id: "op1", owner_action: "transfer",
			previous_owner: "bob", owner: "alice", id: "nft_1",
		};
		expect(rootsEqual(await hashRow(rowA), await hashRow(rowB))).toBe(true);
	});

	test("changes when any field changes", async () => {
		const base = makeRow();
		const h0 = await hashRow(base);
		for (const override of [
			{ owner: "bob" } as const,
			{ previous_owner: "carol" } as const,
			{ owner_action: "transfer" } as const,
			{ owner_operation_id: "other" } as const,
			{ owner_block_num: 999 } as const,
			{ id: "nft_other" } as const,
		]) {
			const mutated = await hashRow(makeRow(override));
			expect(rootsEqual(h0, mutated)).toBe(false);
		}
	});

	test("produces 32-byte output", async () => {
		const h = await hashRow(makeRow());
		expect(h.length).toBe(32);
	});
});

describe("applyDelta ↔ computeStateRootFullScan equivalence", () => {
	test("inserts are equivalent to full-scan", async () => {
		const rows = [
			makeRow({ id: "nft_1" }),
			makeRow({ id: "nft_2", owner: "bob" }),
			makeRow({ id: "nft_3", owner: "carol" }),
		];

		let incremental = emptyStateRoot();
		for (const row of rows) {
			incremental = await applyDelta(incremental, { type: "insert", newRow: row });
		}

		const fullScan = await computeStateRootFullScan(rows);
		expect(rootsEqual(incremental, fullScan)).toBe(true);
	});

	test("updates converge to the post-update full-scan", async () => {
		const initial = [
			makeRow({ id: "nft_1", owner: "alice" }),
			makeRow({ id: "nft_2", owner: "bob" }),
		];
		// Bootstrap.
		let root = emptyStateRoot();
		for (const row of initial) {
			root = await applyDelta(root, { type: "insert", newRow: row });
		}

		// Apply: nft_1 transfers from alice → dave.
		const oldRow = initial[0]!;
		const newRow: NftStateRow = {
			...oldRow,
			owner: "dave",
			previous_owner: "alice",
			owner_action: "transfer",
			owner_operation_id: "op_transfer_1",
			owner_block_num: oldRow.owner_block_num + 100,
		};
		root = await applyDelta(root, { type: "update", oldRow, newRow });

		const finalState = [newRow, initial[1]!];
		const fullScan = await computeStateRootFullScan(finalState);
		expect(rootsEqual(root, fullScan)).toBe(true);
	});

	test("deletes remove rows cleanly (burn)", async () => {
		const rows = [
			makeRow({ id: "nft_1" }),
			makeRow({ id: "nft_2", owner: "bob" }),
		];
		let root = emptyStateRoot();
		for (const row of rows) {
			root = await applyDelta(root, { type: "insert", newRow: row });
		}

		// Burn nft_2.
		root = await applyDelta(root, { type: "delete", oldRow: rows[1]! });

		const fullScan = await computeStateRootFullScan([rows[0]!]);
		expect(rootsEqual(root, fullScan)).toBe(true);
	});
});

describe("commutativity — order independence (multi-node parity)", () => {
	test("two indexers applying the same ops in different orders converge", async () => {
		const ops: StateRootDelta[] = [
			{ type: "insert", newRow: makeRow({ id: "nft_1" }) },
			{ type: "insert", newRow: makeRow({ id: "nft_2", owner: "bob" }) },
			{ type: "update",
				oldRow: makeRow({ id: "nft_1" }),
				newRow: makeRow({ id: "nft_1", owner: "dave", previous_owner: "alice", owner_action: "transfer", owner_operation_id: "op_t1", owner_block_num: 105_530_600 }),
			},
			{ type: "insert", newRow: makeRow({ id: "nft_3", owner: "carol" }) },
			{ type: "delete", oldRow: makeRow({ id: "nft_2", owner: "bob" }) },
		];

		async function applyAll(order: readonly StateRootDelta[]): Promise<Uint8Array> {
			let root = emptyStateRoot();
			for (const op of order) {
				root = await applyDelta(root, op);
			}
			return root;
		}

		const forwardRoot = await applyAll(ops);
		const reversedRoot = await applyAll([...ops].reverse());
		const shuffledRoot = await applyAll([ops[2]!, ops[0]!, ops[4]!, ops[1]!, ops[3]!]);

		expect(rootsEqual(forwardRoot, reversedRoot)).toBe(true);
		expect(rootsEqual(forwardRoot, shuffledRoot)).toBe(true);
	});
});

describe("reversibility — XORing an op out undoes it", () => {
	test("insert + delete of the same row returns to the prior root", async () => {
		const prior = await computeStateRootFullScan([
			makeRow({ id: "nft_1" }),
			makeRow({ id: "nft_2", owner: "bob" }),
		]);

		const ghost = makeRow({ id: "nft_ghost", owner: "mallory" });
		let root = prior;
		root = await applyDelta(root, { type: "insert", newRow: ghost });
		expect(rootsEqual(root, prior)).toBe(false);
		root = await applyDelta(root, { type: "delete", oldRow: ghost });
		expect(rootsEqual(root, prior)).toBe(true);
	});

	test("update is invertible (old ↔ new swap returns home)", async () => {
		const oldRow = makeRow({ id: "nft_1", owner: "alice" });
		const newRow = makeRow({
			id: "nft_1",
			owner: "dave",
			previous_owner: "alice",
			owner_action: "transfer",
			owner_operation_id: "op1",
			owner_block_num: 105_530_700,
		});
		const start = await computeStateRootFullScan([oldRow]);
		let root = start;
		root = await applyDelta(root, { type: "update", oldRow, newRow });
		root = await applyDelta(root, { type: "update", oldRow: newRow, newRow: oldRow });
		expect(rootsEqual(root, start)).toBe(true);
	});
});

describe("encoding round-trip", () => {
	test("formatStateRoot → parseStateRoot is identity", async () => {
		const row = makeRow({ owner_block_num: 123_456 });
		const root = await hashRow(row);
		const formatted = formatStateRoot(root);
		expect(formatted).toMatch(/^sha256:[0-9a-f]{64}$/);
		const parsed = parseStateRoot(formatted);
		expect(rootsEqual(parsed, root)).toBe(true);
	});

	test("parseStateRoot rejects malformed input", () => {
		expect(() => parseStateRoot("not-a-hash")).toThrow();
		expect(() => parseStateRoot("sha256:xyz")).toThrow();
		expect(() => parseStateRoot("sha256:" + "a".repeat(63))).toThrow();
		expect(() => parseStateRoot("md5:" + "a".repeat(64))).toThrow();
	});

	test("empty state formats to all zeros", () => {
		expect(formatStateRoot(emptyStateRoot())).toBe(`sha256:${"0".repeat(64)}`);
	});
});

describe("no-op invariants", () => {
	test("empty row set yields empty root", async () => {
		const root = await computeStateRootFullScan([]);
		expect(rootsEqual(root, emptyStateRoot())).toBe(true);
	});

	test("update with identical old and new rows is a no-op on the root", async () => {
		const row = makeRow();
		const start = await computeStateRootFullScan([row]);
		const afterNoop = await applyDelta(start, { type: "update", oldRow: row, newRow: row });
		expect(rootsEqual(afterNoop, start)).toBe(true);
	});
});

describe("field semantics are distinct (anti-symmetry)", () => {
	// If two NFTs have mirrored owner/previous_owner, the root MUST differ from
	// the root of the "unmirrored" pair. This guards against accidentally
	// symmetric canonical encodings that would let a reorg confuse direction.
	test("swapping owner and previous_owner across two rows yields a different root", async () => {
		const original = [
			makeRow({ id: "nft_1", owner: "alice", previous_owner: "bob" }),
			makeRow({ id: "nft_2", owner: "carol", previous_owner: "dave" }),
		];
		const swapped = [
			makeRow({ id: "nft_1", owner: "bob", previous_owner: "alice" }),
			makeRow({ id: "nft_2", owner: "dave", previous_owner: "carol" }),
		];
		const rootA = await computeStateRootFullScan(original);
		const rootB = await computeStateRootFullScan(swapped);
		expect(rootsEqual(rootA, rootB)).toBe(false);
	});

	test("null previous_owner is distinct from the string 'null'", async () => {
		const nullOwner = makeRow({ previous_owner: null });
		const stringNull = makeRow({ previous_owner: "null" });
		expect(rootsEqual(await hashRow(nullOwner), await hashRow(stringNull))).toBe(false);
	});
});

describe("integration-bug guards", () => {
	// Deleting a row whose hash was never XORed in must leave a divergent root.
	// This is exactly the failure mode an integration bug produces when a
	// handler passes a stale oldRow from a cached snapshot — divergence should
	// be loud, not silent.
	test("delete of a row never inserted leaves a divergent root", async () => {
		const real = [
			makeRow({ id: "nft_1" }),
			makeRow({ id: "nft_2", owner: "bob" }),
		];
		const baseline = await computeStateRootFullScan(real);

		const ghost = makeRow({ id: "nft_ghost", owner: "mallory" });
		const corrupted = await applyDelta(baseline, { type: "delete", oldRow: ghost });
		expect(rootsEqual(corrupted, baseline)).toBe(false);
	});
});

describe("scale smoke test", () => {
	// At 10k rows we can confirm no accumulator aliasing, no overflow, and
	// that order-independence holds at scale — all mathematically guaranteed,
	// but this pins the guarantee against any future refactor regression.
	test("10k rows: incremental == full-scan, and permuted insert order converges", async () => {
		const count = 10_000;
		const rows: NftStateRow[] = [];
		for (let i = 0; i < count; i++) {
			rows.push(makeRow({
				id: `nft_${i.toString().padStart(6, "0")}`,
				owner: `acct_${i % 137}`,
				owner_block_num: 105_530_500 + i,
				owner_operation_id: `${3_448_000_000_000 + i}`,
			}));
		}

		const fullScan = await computeStateRootFullScan(rows);

		// Forward insert.
		let forward = emptyStateRoot();
		for (const row of rows) {
			forward = await applyDelta(forward, { type: "insert", newRow: row });
		}
		expect(rootsEqual(forward, fullScan)).toBe(true);

		// Deterministic permutation (reverse, then every 7th). Avoids Math.random
		// so failures are reproducible.
		const permuted = [...rows].reverse();
		for (let i = 0; i < permuted.length; i += 7) {
			const j = (i * 13) % permuted.length;
			const tmp = permuted[i]!;
			permuted[i] = permuted[j]!;
			permuted[j] = tmp;
		}
		let shuffled = emptyStateRoot();
		for (const row of permuted) {
			shuffled = await applyDelta(shuffled, { type: "insert", newRow: row });
		}
		expect(rootsEqual(shuffled, fullScan)).toBe(true);
	}, { timeout: 30_000 });
});

describe("computeStateRootFullScan works with any Iterable", () => {
	test("accepts a generator, not only arrays", async () => {
		const rows = [
			makeRow({ id: "nft_1" }),
			makeRow({ id: "nft_2", owner: "bob" }),
			makeRow({ id: "nft_3", owner: "carol" }),
		];

		function* generate(): Generator<NftStateRow> {
			for (const row of rows) yield row;
		}

		const fromArray = await computeStateRootFullScan(rows);
		const fromGenerator = await computeStateRootFullScan(generate());
		expect(rootsEqual(fromArray, fromGenerator)).toBe(true);
	});

	test("direct order-independence of full-scan over a Set", async () => {
		const rows: NftStateRow[] = [
			makeRow({ id: "nft_a" }),
			makeRow({ id: "nft_b", owner: "bob" }),
			makeRow({ id: "nft_c", owner: "carol" }),
		];
		const forward = await computeStateRootFullScan(rows);
		const reversed = await computeStateRootFullScan([...rows].reverse());
		expect(rootsEqual(forward, reversed)).toBe(true);
	});
});
