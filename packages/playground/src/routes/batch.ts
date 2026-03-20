// Legacy batch minting routes
import {
	PROTOCOL_VERSION,
	generateOriginDnaSync,
	validateArtIdArray,
	type SeedNFTWithArtId,
} from "nftlox-sdk";
import {
	createTestCollection,
	createSeedMintOperations,
	createDeterministicCollection,
	createDeterministicSeedMintOperations,
	createDistributeOperations,
	loadSampleNFTs,
	loadSampleNFTsWithArtId,
	previewBatchMint,
	splitOperationsIntoBatches,
	validateOperationsVersion,
	type SeedNFT,
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
					nfts?: SeedNFT[];
					sampleFile?: string;
					collectionName: string;
				};

				let nfts: SeedNFT[];
				if (body.sampleFile) {
					nfts = await loadSampleNFTs(body.sampleFile);
				} else if (body.nfts) {
					nfts = body.nfts;
				} else {
					return json({ error: "Provide 'nfts' array or 'sampleFile' path" }, 400);
				}

				const preview = previewBatchMint(nfts, body.collectionName);
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
					image?: string;
					description?: string;
				};

				if (!body.creator || !body.name || !body.symbol) {
					return json({ error: "Missing required fields: creator, name, symbol" }, 400);
				}

				const { payload, operation } = createTestCollection(
					body.creator,
					body.name,
					body.symbol,
					body.totalPotential || 1000000,
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
					nfts?: SeedNFT[];
					sampleFile?: string;
					collectionId: string;
					owner: string;
				};

				if (!body.collectionId || !body.owner) {
					return json({ error: "Missing required fields: collectionId, owner" }, 400);
				}

				let nfts: SeedNFT[];
				if (body.sampleFile) {
					nfts = await loadSampleNFTs(body.sampleFile);
				} else if (body.nfts) {
					nfts = body.nfts;
				} else {
					return json({ error: "Provide 'nfts' array or 'sampleFile' path" }, 400);
				}

				const collectionOriginDna = generateOriginDnaSync(body.collectionId);
				const result = createSeedMintOperations(nfts, body.collectionId, collectionOriginDna, body.owner);
				const validation = validateOperationsVersion(result.seeds.map(s => s.operation));
				const batches = splitOperationsIntoBatches(result.seeds.map(s => s.operation));

				return json({
					protocolVersion: PROTOCOL_VERSION,
					...result,
					validation,
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

	"/api/batch/distribute": {
		POST: async (req: Request) => {
			try {
				const body = await req.json() as {
					seedId: string;
					recipients: string[];
					owner: string;
					startingInstanceNumber?: number;
				};

				if (!body.seedId || !body.recipients || !body.owner) {
					return json({ error: "Missing required fields: seedId, recipients, owner" }, 400);
				}

				const result = createDistributeOperations(body.seedId, body.recipients, body.owner, body.startingInstanceNumber || 1);
				const validation = validateOperationsVersion(result.instances.map(i => i.operation));
				const batches = splitOperationsIntoBatches(result.instances.map(i => i.operation));

				return json({
					protocolVersion: PROTOCOL_VERSION,
					...result,
					validation,
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

	"/api/batch/collection-deterministic": {
		POST: async (req: Request) => {
			try {
				const body = await req.json() as {
					creator: string;
					name: string;
					symbol: string;
					totalPotential: number;
					image?: string;
					description?: string;
				};

				if (!body.creator || !body.name || !body.symbol) {
					return json({ error: "Missing required fields: creator, name, symbol" }, 400);
				}

				const { payload, operation, collectionId } = createDeterministicCollection(
					body.creator,
					body.name,
					body.symbol,
					body.totalPotential || 1000000,
					{ image: body.image, description: body.description },
				);

				return json({
					protocolVersion: PROTOCOL_VERSION,
					collectionId,
					originDna: payload.data.originDna,
					operation,
					payload,
				});
			} catch (e) {
				return json({ error: String(e) }, 500);
			}
		},
	},

	"/api/batch/mint-seeds-deterministic": {
		POST: async (req: Request) => {
			try {
				const body = await req.json() as {
					nfts?: SeedNFTWithArtId[];
					sampleFile?: string;
					collectionId: string;
					owner: string;
				};

				if (!body.collectionId || !body.owner) {
					return json({ error: "Missing required fields: collectionId, owner" }, 400);
				}

				let nfts: SeedNFTWithArtId[];
				if (body.sampleFile) {
					nfts = await loadSampleNFTsWithArtId(body.sampleFile);
				} else if (body.nfts) {
					nfts = body.nfts;
				} else {
					return json({ error: "Provide 'nfts' array or 'sampleFile' path" }, 400);
				}

				const artIds = nfts.map(n => n.artId || "");
				const validation = validateArtIdArray(artIds);
				if (!validation.valid) {
					return json({
						error: "Invalid artIds",
						formatErrors: validation.formatErrors,
						duplicates: validation.duplicates,
					}, 400);
				}

				const collectionOriginDna = generateOriginDnaSync(body.collectionId);
				const result = createDeterministicSeedMintOperations(nfts, body.collectionId, collectionOriginDna, body.owner);
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
};
