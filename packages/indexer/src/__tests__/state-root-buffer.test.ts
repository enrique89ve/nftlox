import { describe, it, expect } from "bun:test";
import { createStateRootBuffer } from "@/utils/state-root-buffer.ts";
import type { NftStateRow } from "@/utils/state-root-hash.ts";
import type { BufferedMutation, NetEntry } from "@/utils/state-root-buffer.ts";

const row = (id: string, owner: string, block = 100): NftStateRow => ({
	id,
	owner,
	previous_owner: null,
	owner_action: "mint",
	owner_operation_id: `op-${id}-${owner}`,
	owner_block_num: block,
});

describe("StateRootBuffer", () => {
	function applyReference(entries: Map<string, NetEntry>, mutation: BufferedMutation): void {
		const id = mutation.type === "delete" ? mutation.oldRow.id : mutation.newRow.id;
		const existing = entries.get(id);
		const incomingOld = mutation.type === "insert" ? null : mutation.oldRow;
		const incomingNew = mutation.type === "delete" ? null : mutation.newRow;
		if (!existing) {
			entries.set(id, { firstOld: incomingOld, lastNew: incomingNew, blockNum: mutation.blockNum });
			return;
		}
		entries.set(id, {
			firstOld: existing.firstOld,
			lastNew: incomingNew,
			blockNum: Math.max(existing.blockNum, mutation.blockNum),
		});
	}

	it("is empty initially", () => {
		const buf = createStateRootBuffer();
		expect(buf.isEmpty()).toBe(true);
		expect(buf.size()).toBe(0);
		expect(buf.maxBlockNum()).toBe(0);
	});

	it("records insert as firstOld=null, lastNew=row", () => {
		const buf = createStateRootBuffer();
		const r = row("nft-1", "alice");
		buf.queue({ type: "insert", newRow: r, blockNum: 100 });
		const [entry] = [...buf.iter()];
		expect(entry?.firstOld).toBeNull();
		expect(entry?.lastNew).toEqual(r);
		expect(entry?.blockNum).toBe(100);
	});

	it("records update as firstOld=old, lastNew=new", () => {
		const buf = createStateRootBuffer();
		const oldR = row("nft-1", "alice");
		const newR = row("nft-1", "bob");
		buf.queue({ type: "update", oldRow: oldR, newRow: newR, blockNum: 101 });
		const [entry] = [...buf.iter()];
		expect(entry?.firstOld).toEqual(oldR);
		expect(entry?.lastNew).toEqual(newR);
	});

	it("records delete as firstOld=old, lastNew=null", () => {
		const buf = createStateRootBuffer();
		const r = row("nft-1", "alice");
		buf.queue({ type: "delete", oldRow: r, blockNum: 102 });
		const [entry] = [...buf.iter()];
		expect(entry?.firstOld).toEqual(r);
		expect(entry?.lastNew).toBeNull();
	});

	it("merges insert + update: keeps firstOld=null, updates lastNew", () => {
		const buf = createStateRootBuffer();
		const inserted = row("nft-1", "alice", 100);
		const updated = row("nft-1", "bob", 100);
		buf.queue({ type: "insert", newRow: inserted, blockNum: 100 });
		buf.queue({ type: "update", oldRow: inserted, newRow: updated, blockNum: 100 });
		const [entry] = [...buf.iter()];
		expect(entry?.firstOld).toBeNull();
		expect(entry?.lastNew).toEqual(updated);
	});

	it("merges insert + delete: firstOld=null, lastNew=null (net no-op)", () => {
		const buf = createStateRootBuffer();
		const r = row("nft-1", "alice");
		buf.queue({ type: "insert", newRow: r, blockNum: 100 });
		buf.queue({ type: "delete", oldRow: r, blockNum: 100 });
		const [entry] = [...buf.iter()];
		expect(entry?.firstOld).toBeNull();
		expect(entry?.lastNew).toBeNull();
	});

	it("merges update + update: preserves original firstOld, keeps final lastNew", () => {
		const buf = createStateRootBuffer();
		const a = row("nft-1", "alice");
		const b = row("nft-1", "bob");
		const c = row("nft-1", "carol");
		buf.queue({ type: "update", oldRow: a, newRow: b, blockNum: 100 });
		buf.queue({ type: "update", oldRow: b, newRow: c, blockNum: 101 });
		const [entry] = [...buf.iter()];
		expect(entry?.firstOld).toEqual(a);
		expect(entry?.lastNew).toEqual(c);
		expect(entry?.blockNum).toBe(101);
	});

	it("tracks multiple NFTs independently", () => {
		const buf = createStateRootBuffer();
		buf.queue({ type: "insert", newRow: row("nft-1", "alice"), blockNum: 100 });
		buf.queue({ type: "insert", newRow: row("nft-2", "bob"), blockNum: 100 });
		expect(buf.size()).toBe(2);
	});

	it("maxBlockNum returns the highest observed block", () => {
		const buf = createStateRootBuffer();
		buf.queue({ type: "insert", newRow: row("nft-1", "a", 100), blockNum: 100 });
		buf.queue({ type: "insert", newRow: row("nft-2", "b", 150), blockNum: 150 });
		buf.queue({ type: "insert", newRow: row("nft-3", "c", 120), blockNum: 120 });
		expect(buf.maxBlockNum()).toBe(150);
	});

	it("preserves higher blockNum when a later same-nft mutation uses a lower block", () => {
		const buf = createStateRootBuffer();
		const a = row("nft-1", "alice");
		const b = row("nft-1", "bob");
		buf.queue({ type: "update", oldRow: a, newRow: b, blockNum: 105 });
		buf.queue({ type: "update", oldRow: b, newRow: a, blockNum: 100 });
		const [entry] = [...buf.iter()];
		expect(entry?.blockNum).toBe(105);
		expect(buf.maxBlockNum()).toBe(105);
	});

	it("iter() is independently re-iterable across calls", () => {
		const buf = createStateRootBuffer();
		buf.queue({ type: "insert", newRow: row("nft-1", "alice"), blockNum: 100 });
		buf.queue({ type: "insert", newRow: row("nft-2", "bob"), blockNum: 101 });
		const first = [...buf.iter()];
		const second = [...buf.iter()];
		expect(first).toHaveLength(2);
		expect(second).toHaveLength(2);
		expect(first).toEqual(second);
	});

	it("clear drains all queued mutations", () => {
		const buf = createStateRootBuffer();
		buf.queue({ type: "insert", newRow: row("nft-1", "alice"), blockNum: 100 });

		buf.clear();

		expect(buf.isEmpty()).toBe(true);
		expect(buf.size()).toBe(0);
		expect([...buf.iter()]).toEqual([]);
		expect(buf.maxBlockNum()).toBe(0);
	});

	it("rolls back only changes after a checkpoint", () => {
		const buf = createStateRootBuffer();
		const first = row("nft-1", "alice");
		const second = row("nft-2", "bob");
		buf.queue({ type: "insert", newRow: first, blockNum: 100 });
		const checkpoint = buf.checkpoint();
		buf.queue({ type: "insert", newRow: second, blockNum: 101 });
		buf.queue({ type: "update", oldRow: first, newRow: row("nft-1", "carol"), blockNum: 102 });

		buf.rollbackTo(checkpoint);

		expect([...buf.iter()]).toEqual([{
			firstOld: null,
			lastNew: first,
			blockNum: 100,
		}]);
	});

	it("matches a simple reference model across mixed mutations and rollback", () => {
		const buf = createStateRootBuffer();
		const reference = new Map<string, NetEntry>();
		const mutations: BufferedMutation[] = [
			{ type: "insert", newRow: row("nft-1", "alice"), blockNum: 100 },
			{ type: "insert", newRow: row("nft-2", "bob"), blockNum: 101 },
			{ type: "update", oldRow: row("nft-1", "alice"), newRow: row("nft-1", "carol"), blockNum: 102 },
			{ type: "delete", oldRow: row("nft-2", "bob"), blockNum: 103 },
		];

		for (const mutation of mutations) {
			buf.queue(mutation);
			applyReference(reference, mutation);
		}
		expect([...buf.iter()]).toEqual([...reference.values()]);

		const checkpoint = buf.checkpoint();
		const beforeRollback = new Map(reference);
		const rollbackMutations: BufferedMutation[] = [
			{ type: "update", oldRow: row("nft-1", "carol"), newRow: row("nft-1", "diana"), blockNum: 104 },
			{ type: "insert", newRow: row("nft-3", "erin"), blockNum: 105 },
		];
		for (const mutation of rollbackMutations) {
			buf.queue(mutation);
			applyReference(reference, mutation);
		}
		buf.rollbackTo(checkpoint);
		reference.clear();
		for (const [id, entry] of beforeRollback) reference.set(id, entry);
		expect([...buf.iter()]).toEqual([...reference.values()]);
	});
});
