import { describe, it, expect } from "bun:test";
import { createStateRootBuffer } from "@/utils/state-root-buffer.ts";
import type { NftStateRow } from "@/utils/state-root-hash.ts";

const row = (id: string, owner: string, block = 100): NftStateRow => ({
	id,
	owner,
	previous_owner: null,
	owner_action: "mint",
	owner_operation_id: `op-${id}-${owner}`,
	owner_block_num: block,
});

describe("StateRootBuffer", () => {
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
});
