// Pre-mint validation routes
import {
	validateArtIdArray,
	generateDeterministicCollectionId,
	generateDeterministicSeedId,
	type SeedAssetWithArtId,
	IndexerError,
} from "nftlox-sdk";
import { indexer } from "../shared/indexer";

const json = (data: unknown, status = 200) =>
	new Response(JSON.stringify(data, null, 2), {
		status,
		headers: { "Content-Type": "application/json" },
	});

type RouteHandler = (req: Request) => Promise<Response>;

export const validationRoutes: Record<string, { POST: RouteHandler }> = {
	"/api/validate/pre-mint": {
		POST: async (req: Request) => {
			try {
				const body = await req.json() as {
					creator: string;
					collectionName: string;
					collectionSymbol: string;
					assets: SeedAssetWithArtId[];
				};

				if (!body.creator || !body.collectionName || !body.collectionSymbol) {
					return json({
						valid: false,
						stage: "format",
						error: "Missing required fields: creator, collectionName, collectionSymbol",
					}, 400);
				}

				if (!body.assets || !Array.isArray(body.assets) || body.assets.length === 0) {
					return json({
						valid: false,
						stage: "format",
						error: "assets array is required and must not be empty",
					}, 400);
				}

				// 1. Validate artId format
				const artIds = body.assets.map(n => n.artId || "");
				const artIdValidation = validateArtIdArray(artIds);

				if (artIdValidation.formatErrors.length > 0) {
					return json({
						valid: false,
						stage: "format",
						errors: artIdValidation.formatErrors.map(e => ({
							index: e.index,
							artId: e.artId,
							name: body.assets[e.index]?.name || "Unknown",
							error: e.error,
						})),
					});
				}

				// 2. Check for duplicates within JSON
				if (artIdValidation.duplicates.length > 0) {
					return json({
						valid: false,
						stage: "uniqueness",
						duplicates: artIdValidation.duplicates,
						error: `Duplicate artIds found: ${artIdValidation.duplicates.join(", ")}`,
					});
				}

				// 3. Generate deterministic IDs
				const collectionId = await generateDeterministicCollectionId(
					body.creator,
					body.collectionName,
					body.collectionSymbol,
				);
				const seedIds = await Promise.all(body.assets.map(asset =>
					generateDeterministicSeedId(collectionId, asset.artId),
				));

				// 4. Check indexer for existing IDs
				let colExists = false;
				try {
					await indexer.getCollection(collectionId);
					colExists = true;
				} catch (e) {
					if (e instanceof IndexerError && e.statusCode === 404) {
						colExists = false;
					} else {
						throw e;
					}
				}

				// Check seeds existence via individual getAsset calls
				const seedExistence = new Map<string, boolean>();
				const seedChecks = seedIds.map(async (seedId) => {
					try {
						await indexer.getAsset(seedId);
						seedExistence.set(seedId, true);
					} catch {
						seedExistence.set(seedId, false);
					}
				});
				await Promise.all(seedChecks);

				const seedStatus = seedIds.map((seedId, i) => ({
					artId: body.assets[i]!.artId,
					seedId,
					exists: seedExistence.get(seedId) || false,
					name: body.assets[i]!.name,
				}));

				const newSeeds = seedStatus.filter(s => !s.exists);
				const existingSeeds = seedStatus.filter(s => s.exists);

				return json({
					valid: true,
					collectionId,
					collectionExists: colExists,
					summary: {
						total: body.assets.length,
						new: newSeeds.length,
						existing: existingSeeds.length,
					},
					seeds: seedStatus,
					canProceed: newSeeds.length > 0 || !colExists,
				});
			} catch (e) {
				return json({ error: String(e) }, 500);
			}
		},
	},
};
