import { describe, expect, it } from "bun:test";
import {
	groupInstancesBySeed,
	type GroupableNft,
} from "./inventory-grouping";

const make = (overrides: Partial<GroupableNft>): GroupableNft => ({
	id: overrides.id ?? "id",
	collectionId: overrides.collectionId ?? "col",
	edition: overrides.edition ?? 1,
	name: overrides.name ?? "Card",
	imageUrl: overrides.imageUrl ?? "img",
	seedId: overrides.seedId ?? null,
	instanceNumber: overrides.instanceNumber ?? null,
	listingPrice: overrides.listingPrice ?? null,
	listingCurrency: overrides.listingCurrency ?? null,
	status: overrides.status ?? null,
	isSeed: overrides.isSeed ?? false,
});

describe("groupInstancesBySeed", () => {
	it("collapses N instances of the same seed into one group", () => {
		const a1 = make({ id: "a-1", seedId: "seed-A", name: "A" });
		const a2 = make({ id: "a-2", seedId: "seed-A", name: "A" });
		const a3 = make({ id: "a-3", seedId: "seed-A", name: "A" });

		const groups = groupInstancesBySeed([a1, a2, a3]);

		expect(groups).toHaveLength(1);
		expect(groups[0]!.seedId).toBe("seed-A");
		expect(groups[0]!.count).toBe(3);
		expect(groups[0]!.instances.map((n) => n.id)).toEqual(["a-1", "a-2", "a-3"]);
	});

	it("produces one group per distinct seedId", () => {
		const a = make({ id: "a-1", seedId: "seed-A", name: "Alpha" });
		const b1 = make({ id: "b-1", seedId: "seed-B", name: "Beta" });
		const b2 = make({ id: "b-2", seedId: "seed-B", name: "Beta" });

		const groups = groupInstancesBySeed([a, b1, b2]);

		expect(groups).toHaveLength(2);
		const beta = groups.find((g) => g.seedId === "seed-B");
		expect(beta?.count).toBe(2);
	});

	it("falls back to `${collectionId}::${edition}` when seedId missing", () => {
		const x1 = make({
			id: "x-1",
			seedId: null,
			collectionId: "col-X",
			edition: 5,
		});
		const x2 = make({
			id: "x-2",
			seedId: null,
			collectionId: "col-X",
			edition: 5,
		});

		const groups = groupInstancesBySeed([x1, x2]);

		expect(groups).toHaveLength(1);
		expect(groups[0]!.seedId).toBe("col-X::5");
		expect(groups[0]!.count).toBe(2);
	});

	it("orders groups by count desc, then name asc", () => {
		const single = make({ id: "z-1", seedId: "seed-Z", name: "Zulu" });
		const a1 = make({ id: "a-1", seedId: "seed-A", name: "Alpha" });
		const a2 = make({ id: "a-2", seedId: "seed-A", name: "Alpha" });
		const m1 = make({ id: "m-1", seedId: "seed-M", name: "Mike" });
		const m2 = make({ id: "m-2", seedId: "seed-M", name: "Mike" });

		const groups = groupInstancesBySeed([single, a1, a2, m1, m2]);

		expect(groups.map((g) => g.seedId)).toEqual([
			"seed-A",
			"seed-M",
			"seed-Z",
		]);
	});

	it("returns empty array for empty input", () => {
		expect(groupInstancesBySeed([])).toEqual([]);
	});

	it("returns count=1 group for a single instance", () => {
		const only = make({ id: "x", seedId: "seed-X", name: "Solo" });
		const groups = groupInstancesBySeed([only]);
		expect(groups).toHaveLength(1);
		expect(groups[0]!.count).toBe(1);
	});
});
