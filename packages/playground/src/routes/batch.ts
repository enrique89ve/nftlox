// Batch minting routes — all routes use deterministic ID generation
import {
	PROTOCOL_VERSION,
	validateArtIdArray,
	type SeedAssetWithArtId,
} from "nftlox-sdk";
import {
	createTestCollection,
	createDeterministicSeedMintOperations,
	loadSampleAssetsWithArtId,
	previewBatchMint,
	splitOperationsIntoBatches,
	validateOperationsVersion,
} from "../protocol";

const json = (data: unknown, status = 200) =>
	new Response(JSON.stringify(data, null, 2), {
		status,
		headers: { "Content-Type": "application/json" },
	});

type RouteHandler = (req: Request) => Promise<Response>;

export const batchRoutes: Record<string, { POST: RouteHandler }> = {
	"/api/batch/preview": {
		POST: async (req: Request) => {
			try {
				const body = await req.json() as {
					assets?: SeedAssetWithArtId[];
					sampleFile?: string;
					collectionName: string;
				};

				let assets: SeedAssetWithArtId[];
				if (body.sampleFile) {
					assets = await loadSampleAssetsWithArtId(body.sampleFile);
				} else if (body.assets) {
					assets = body.assets;
				} else {
					return json({ error: "Provide 'assets' array or 'sampleFile' path" }, 400);
				}

				const preview = previewBatchMint(assets, body.collectionName);
				return json({ protocolVersion: PROTOCOL_VERSION, preview });
			} catch (e) {
				return json({ error: String(e) }, 500);
			}
		},
	},

	"/api/batch/collection": {
		POST: async (req: Request) => {
			try {
				const body = await req.json() as {
					creator: string;
					name: string;
					symbol: string;
					totalPotential: number;
					nodeAccount: string;
					image?: string;
					description?: string;
				};

				if (!body.creator || !body.name || !body.symbol || !body.nodeAccount) {
					return json({ error: "Missing required fields: creator, name, symbol, nodeAccount" }, 400);
				}

				const { payload, operation } = await createTestCollection(
					body.creator,
					body.name,
					body.symbol,
					body.totalPotential || 1000000,
					body.nodeAccount,
					{ image: body.image, description: body.description },
				);

				return json({
					protocolVersion: PROTOCOL_VERSION,
					collectionId: payload.data.id,
					originDna: payload.data.originDna,
					operation,
					payload,
				});
			} catch (e) {
				return json({ error: String(e) }, 500);
			}
		},
	},

	"/api/batch/mint-seeds": {
		POST: async (req: Request) => {
			try {
				const body = await req.json() as {
					assets?: SeedAssetWithArtId[];
					sampleFile?: string;
					collectionId: string;
					owner: string;
				};

				if (!body.collectionId || !body.owner) {
					return json({ error: "Missing required fields: collectionId, owner" }, 400);
				}

				let assets: SeedAssetWithArtId[];
				if (body.sampleFile) {
					assets = await loadSampleAssetsWithArtId(body.sampleFile);
				} else if (body.assets) {
					assets = body.assets;
				} else {
					return json({ error: "Provide 'assets' array or 'sampleFile' path" }, 400);
				}

				const artIds = assets.map(n => n.artId || "");
				const validation = validateArtIdArray(artIds);
				if (!validation.valid) {
					return json({
						error: "Invalid artIds",
						formatErrors: validation.formatErrors,
						duplicates: validation.duplicates,
					}, 400);
				}

				const result = await createDeterministicSeedMintOperations(assets, body.collectionId, body.owner);
				const opValidation = validateOperationsVersion(result.seeds.map(s => s.operation));
				const batches = splitOperationsIntoBatches(result.seeds.map(s => s.operation));

				return json({
					protocolVersion: PROTOCOL_VERSION,
					...result,
					validation: opValidation,
					batches: batches.map((batch, i) => ({
						batchNumber: i + 1,
						operationCount: batch.length,
						operations: batch,
					})),
				});
			} catch (e) {
				return json({ error: String(e) }, 500);
			}
		},
	},

	// Aliases for backwards compatibility
	"/api/batch/collection-deterministic": {
		POST: async (req: Request) => batchRoutes["/api/batch/collection"]!.POST(req),
	},

	"/api/batch/mint-seeds-deterministic": {
		POST: async (req: Request) => batchRoutes["/api/batch/mint-seeds"]!.POST(req),
	},
};
