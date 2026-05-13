import type { NftStateRow } from "./state-root-hash.ts";

// Discriminated union of the three SPV-affecting row changes: insert, update,
// delete. Lives in memory until the tx commits.
export type BufferedMutation =
	| Readonly<{ type: "insert"; newRow: NftStateRow; blockNum: number }>
	| Readonly<{ type: "update"; oldRow: NftStateRow; newRow: NftStateRow; blockNum: number }>
	| Readonly<{ type: "delete"; oldRow: NftStateRow; blockNum: number }>;

// Net delta for a single NFT across a transaction. Merging rules:
//   insert → { firstOld: null,       lastNew: newRow }
//   update → { firstOld: oldRow,     lastNew: newRow }
//   delete → { firstOld: oldRow,     lastNew: null   }
// When a second mutation arrives for the same id, firstOld is preserved and
// lastNew is overwritten. This collapses N serial mutations into one net XOR
// pair (or a no-op if insert+delete cancel).
export type NetEntry = Readonly<{
	firstOld: NftStateRow | null;
	lastNew: NftStateRow | null;
	blockNum: number;
}>;

// Public shape consumed by callers. No class, no `this` — a frozen object
// of closure-bound pure methods over the captured `entries` Map.
export type StateRootBuffer = Readonly<{
	queue: (mutation: BufferedMutation) => void;
	size: () => number;
	isEmpty: () => boolean;
	iter: () => IterableIterator<NetEntry>;
	maxBlockNum: () => number;
	checkpoint: () => Map<string, NetEntry>;
	rollbackTo: (snap: Map<string, NetEntry>) => void;
	clear: () => void;
}>;

// Exhaustive narrowing of the discriminated union. The `never` default is a
// compile-time guard: adding a new variant to BufferedMutation without handling
// it here is a type error.
function narrow(
	m: BufferedMutation,
): Readonly<{ id: string; incomingOld: NftStateRow | null; incomingNew: NftStateRow | null }> {
	switch (m.type) {
		case "insert":
			return { id: m.newRow.id, incomingOld: null, incomingNew: m.newRow };
		case "update":
			return { id: m.newRow.id, incomingOld: m.oldRow, incomingNew: m.newRow };
		case "delete":
			return { id: m.oldRow.id, incomingOld: m.oldRow, incomingNew: null };
		default: {
			const _exhaustive: never = m;
			throw new Error(`Unreachable BufferedMutation variant: ${JSON.stringify(_exhaustive)}`);
		}
	}
}

export function createStateRootBuffer(): StateRootBuffer {
	const entries = new Map<string, NetEntry>();

	function queue(mutation: BufferedMutation): void {
		const { id, incomingOld, incomingNew } = narrow(mutation);
		const existing = entries.get(id);
		if (!existing) {
			entries.set(id, {
				firstOld: incomingOld,
				lastNew: incomingNew,
				blockNum: mutation.blockNum,
			});
			return;
		}
		entries.set(id, {
			firstOld: existing.firstOld,
			lastNew: incomingNew,
			blockNum: Math.max(existing.blockNum, mutation.blockNum),
		});
	}

	function size(): number {
		return entries.size;
	}

	function isEmpty(): boolean {
		return entries.size === 0;
	}

	function* iter(): IterableIterator<NetEntry> {
		yield* entries.values();
	}

	function maxBlockNum(): number {
		let max = 0;
		for (const e of entries.values()) {
			if (e.blockNum > max) max = e.blockNum;
		}
		return max;
	}

	function checkpoint(): Map<string, NetEntry> {
		return new Map(entries);
	}

	function rollbackTo(snap: Map<string, NetEntry>): void {
		entries.clear();
		for (const [k, v] of snap) {
			entries.set(k, v);
		}
	}

	function clear(): void {
		entries.clear();
	}

	return Object.freeze({ queue, size, isEmpty, iter, maxBlockNum, checkpoint, rollbackTo, clear });
}
