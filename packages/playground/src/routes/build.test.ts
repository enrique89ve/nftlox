import { describe, expect, test } from "bun:test";
import { buildRoutes } from "./build";

type CustomJsonOperation = readonly [
	"custom_json",
	{
		readonly json: string;
	},
];

type BuildSeedResponseItem = Readonly<{
	immutableData?: Record<string, unknown>;
	operation: CustomJsonOperation;
}>;

type BuildSeedsResponse = Readonly<{
	success: boolean;
	seeds?: readonly BuildSeedResponseItem[];
}>;

type SeedPayload = Readonly<{
	data: Readonly<{
		immutableData?: Record<string, unknown>;
	}>;
}>;

describe("POST /api/build/seeds", () => {
	test("preserves immutableData in generated seed operations", async () => {
		const immutableData = {
			card_id: 1001,
			rarity: "legendary",
			attack: 7,
			health: 5,
		};
		const route = buildRoutes["/api/build/seeds"];
		if (!route) throw new Error("Missing /api/build/seeds route");

		const response = await route.POST(new Request("http://localhost/api/build/seeds", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				collectionId: "col_playground_seed_builder",
				signer: "testcreator",
				seeds: [
					{
						artId: "play-seed-001",
						name: "Playground Seed",
						imageUrl: "https://example.com/playground-seed.png",
						maxSupply: 25,
						immutableData,
					},
				],
			}),
		}));

		expect(response.status).toBe(200);
		const body = await response.json() as BuildSeedsResponse;
		expect(body.success).toBe(true);
		const [seed] = body.seeds ?? [];
		if (!seed) throw new Error("Expected one built seed");

		expect(seed.immutableData).toEqual(immutableData);

		const payload = JSON.parse(seed.operation[1].json) as SeedPayload;
		expect(payload.data.immutableData).toEqual(immutableData);
	});
});
