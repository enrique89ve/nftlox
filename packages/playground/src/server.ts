import index from "../public/index.html";
import {
	buildRegisterOp,
	buildIssueOp,
	buildTransferOp,
	buildSetDataOp,
	buildSoulbindOp,
	buildModifyOp,
} from "./hive-nft-tracker";
import {
	getNFTsByOwner,
	getNFTById,
	getNFTHistory,
	getOwnershipHistory,
	fetchCollectionOperations,
	buildNFTState,
	buildFullState,
	getFilteringStats,
	collectionExists,
	checkSeedsExistence,
} from "./api";
import {
	PROTOCOL_VERSION,
	MIN_PROTOCOL_VERSION,
	HASH_VERSION,
	generateOriginDnaSync,
	validateArtIdArray,
	generateDeterministicCollectionId,
	generateDeterministicSeedId,
	PayloadBuilder,
	type SeedNFTWithArtId,
} from "nftlox-sdk";

const builder = new PayloadBuilder();
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
} from "./protocol";

const json = (data: unknown, status = 200) =>
	new Response(JSON.stringify(data, null, 2), {
		status,
		headers: { "Content-Type": "application/json" },
	});

const ALLOWED_SAMPLE_FILES = new Set([
	"sample-bulls.json",
	"sample-seeds.json",
	"sample-nfts.json",
	"sample-nfts-200.json",
]);

const server = Bun.serve({
	port: 3040,
	routes: {
		"/": index,

		// Serve sample JSON files
		"/playground/:filename": async (req) => {
			const filename = req.params.filename;
			if (!filename.endsWith(".json") || !ALLOWED_SAMPLE_FILES.has(filename)) {
				return new Response("Not Found", { status: 404 });
			}
			const file = Bun.file(`./data/${filename}`);
			if (!await file.exists()) {
				return new Response("File not found", { status: 404 });
			}
			return new Response(file, {
				headers: { "Content-Type": "application/json" },
			});
		},

		"/api/user/:username/collections": async (req) => {
			try {
				const username = req.params.username.toLowerCase();
				const cols = await fetchCollectionOperations();
				const userCollections = cols.filter(c => c.data.creator.toLowerCase() === username);
				return json({
					user: username,
					count: userCollections.length,
					collections: userCollections.map((c) => ({
						id: c.data.id,
						name: c.data.name,
						symbol: c.data.symbol,
						creator: c.data.creator,
						originDna: c.data.originDna,
						totalPotential: c.data.totalPotential,
					})),
				});
			} catch (e) {
				return json({ error: String(e) }, 500);
			}
		},

		"/api/user/:username": async (req) => {
			const username = req.params.username.toLowerCase();
			try {
				const nfts = await getNFTsByOwner(username);
				return json({ user: username, count: nfts.length, nfts });
			} catch (e) {
				return json({ error: String(e) }, 500);
			}
		},

		"/api/nft/:nftId/history": async (req) => {
			try {
				const [history, ownership] = await Promise.all([
					getNFTHistory(req.params.nftId),
					getOwnershipHistory(req.params.nftId),
				]);
				return json({ nftId: req.params.nftId, events: history, ownershipChain: ownership });
			} catch (e) {
				return json({ error: String(e) }, 500);
			}
		},

		// Debug endpoint to check all operations for a seed
		"/api/debug/seed/:seedId": async (req) => {
			try {
				const { nftMap } = await buildFullState();
				const seed = nftMap.get(req.params.seedId);

				if (!seed) {
					return json({ error: "Seed not found" }, 404);
				}

				// Find all instances distributed from this seed
				const instances = Array.from(nftMap.values())
					.filter(n => n.seedId === req.params.seedId)
					.map(n => ({
						id: n.id,
						instanceNumber: n.instanceNumber,
						owner: n.owner,
						mintedAt: n.mintedAt,
					}));

				return json({
					seed: {
						id: seed.id,
						name: seed.name,
						isSeed: seed.isSeed,
						maxSupply: seed.maxSupply,
						distributed: seed.distributed,
						mintedBy: seed.mintedBy,
						owner: seed.owner,
					},
					instances: instances,
					instanceCount: instances.length,
					message: `Found ${instances.length} instances. Seed says distributed=${seed.distributed}`,
				});
			} catch (e) {
				return json({ error: String(e) }, 500);
			}
		},

		"/api/nft/:nftId/details": async (req) => {
			try {
				const nftMap = await buildNFTState();
				const nft = nftMap.get(req.params.nftId);

				if (!nft) {
					return json({ error: "NFT not found" }, 404);
				}

				// Get replicas if this is an original
				const replicas = Array.from(nftMap.values())
					.filter(n => n.originalId === nft.id || n.seedId === nft.id);

				// Get original if this is a replica/instance
				let original = null;
				if (nft.originalId) {
					original = nftMap.get(nft.originalId);
				} else if (nft.seedId) {
					original = nftMap.get(nft.seedId);
				}

				// Get history
				const history = await getNFTHistory(req.params.nftId);
				const ownership = await getOwnershipHistory(req.params.nftId);

				return json({
					nft: {
						id: nft.id,
						name: nft.name,
						imageUrl: nft.imageUrl,
						owner: nft.owner,
						collectionId: nft.collectionId,
						edition: nft.edition,
						originDna: nft.originDna,
						instanceDna: nft.instanceDna,
						mintedAt: nft.mintedAt,
						mintedBy: nft.mintedBy,
						burned: nft.burned,
						listed: nft.listed,
						listingPrice: nft.listingPrice,
						isSeed: nft.isSeed,
						maxSupply: nft.maxSupply,
						distributed: nft.distributed,
						isReplica: nft.isReplica,
						originalId: nft.originalId,
						seedId: nft.seedId,
						instanceNumber: nft.instanceNumber,
					},
					original: original ? {
						id: original.id,
						name: original.name,
						imageUrl: original.imageUrl,
						owner: original.owner,
					} : null,
					replicas: {
						count: replicas.length,
						items: replicas.slice(0, 50).map(r => ({
							id: r.id,
							name: r.name,
							owner: r.owner,
							instanceNumber: r.instanceNumber,
						})),
					},
					history: history.slice(0, 20),
					ownershipChain: ownership,
				});
			} catch (e) {
				return json({ error: String(e) }, 500);
			}
		},

		"/api/nft/:nftId": async (req) => {
			try {
				const nft = await getNFTById(req.params.nftId);
				if (!nft) return json({ error: "Not found" }, 404);
				return json(nft);
			} catch (e) {
				return json({ error: String(e) }, 500);
			}
		},

		"/api/collections": async () => {
			try {
				const cols = await fetchCollectionOperations();
				return json({
					count: cols.length,
					collections: cols.map((c) => ({
						id: c.data.id,
						name: c.data.name,
						symbol: c.data.symbol,
						creator: c.data.creator,
						originDna: c.data.originDna,
						totalPotential: c.data.totalPotential,
					})),
				});
			} catch (e) {
				return json({ error: String(e) }, 500);
			}
		},

		"/api/collection/:id/nfts": async (req) => {
			try {
				const nftMap = await buildNFTState();
				const collectionNfts = Array.from(nftMap.values())
					.filter((nft) => nft.collectionId === req.params.id && !nft.burned);

				const seeds = collectionNfts.filter(nft => nft.isSeed);
				const instances = collectionNfts.filter(nft => nft.seedId);

				return json({
					collectionId: req.params.id,
					totalCount: collectionNfts.length,
					seeds: {
						count: seeds.length,
						items: seeds.map(nft => ({
							id: nft.id,
							name: nft.name,
							imageUrl: nft.imageUrl,
							owner: nft.owner,
							maxSupply: nft.maxSupply,
							distributed: nft.distributed || 0,
							originDna: nft.originDna,
							instanceDna: nft.instanceDna,
						})),
					},
					instances: {
						count: instances.length,
						items: instances.map(nft => ({
							id: nft.id,
							name: nft.name,
							imageUrl: nft.imageUrl,
							owner: nft.owner,
							seedId: nft.seedId,
							instanceNumber: nft.instanceNumber,
						})),
					},
				});
			} catch (e) {
				return json({ error: String(e) }, 500);
			}
		},

		"/api/seed/:seedId/instances": async (req) => {
			try {
				const nftMap = await buildNFTState();
				const instances = Array.from(nftMap.values())
					.filter((nft) => nft.seedId === req.params.seedId);
				return json({
					seedId: req.params.seedId,
					count: instances.length,
					instances,
				});
			} catch (e) {
				return json({ error: String(e) }, 500);
			}
		},

		"/api/debug/filtering": async () => {
			try {
				const stats = await getFilteringStats();
				return json(stats);
			} catch (e) {
				return json({ error: String(e) }, 500);
			}
		},

		// ============ BATCH MINTING ROUTES ============

		"/api/batch/preview": {
			POST: async (req) => {
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
					return json({
						protocolVersion: PROTOCOL_VERSION,
						preview,
					});
				} catch (e) {
					return json({ error: String(e) }, 500);
				}
			},
		},

		"/api/batch/collection": {
			POST: async (req) => {
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
			POST: async (req) => {
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
					const result = createSeedMintOperations(
						nfts,
						body.collectionId,
						collectionOriginDna,
						body.owner,
					);

					const validation = validateOperationsVersion(
						result.seeds.map((s) => s.operation),
					);

					const batches = splitOperationsIntoBatches(
						result.seeds.map((s) => s.operation),
					);

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
			POST: async (req) => {
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

					const result = createDistributeOperations(
						body.seedId,
						body.recipients,
						body.owner,
						body.startingInstanceNumber || 1,
					);

					const validation = validateOperationsVersion(
						result.instances.map((i) => i.operation),
					);

					const batches = splitOperationsIntoBatches(
						result.instances.map((i) => i.operation),
					);

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

		"/api/protocol/version": async () => {
			return json({
				protocolVersion: PROTOCOL_VERSION,
				minIndexerVersion: (await import("./api")).MIN_PROTOCOL_VERSION,
			});
		},

		// ============ PRE-MINT VALIDATION (Anti-Duplication) ============

		"/api/validate/pre-mint": {
			POST: async (req) => {
				try {
					const body = await req.json() as {
						creator: string;
						collectionName: string;
						collectionSymbol: string;
						nfts: SeedNFTWithArtId[];
					};

					if (!body.creator || !body.collectionName || !body.collectionSymbol) {
						return json({
							valid: false,
							stage: "format",
							error: "Missing required fields: creator, collectionName, collectionSymbol",
						}, 400);
					}

					if (!body.nfts || !Array.isArray(body.nfts) || body.nfts.length === 0) {
						return json({
							valid: false,
							stage: "format",
							error: "nfts array is required and must not be empty",
						}, 400);
					}

					// 1. Validate artId format for each item
					const artIds = body.nfts.map(n => n.artId || "");
					const artIdValidation = validateArtIdArray(artIds);

					if (artIdValidation.formatErrors.length > 0) {
						return json({
							valid: false,
							stage: "format",
							errors: artIdValidation.formatErrors.map(e => ({
								index: e.index,
								artId: e.artId,
								name: body.nfts[e.index]?.name || "Unknown",
								error: e.error,
							})),
						});
					}

					// 2. Check for duplicate artIds within the JSON
					if (artIdValidation.duplicates.length > 0) {
						return json({
							valid: false,
							stage: "uniqueness",
							duplicates: artIdValidation.duplicates,
							error: `Duplicate artIds found: ${artIdValidation.duplicates.join(", ")}`,
						});
					}

					// 3. Generate deterministic IDs
					const collectionId = generateDeterministicCollectionId(
						body.creator,
						body.collectionName,
						body.collectionSymbol,
					);
					const seedIds = body.nfts.map(nft =>
						generateDeterministicSeedId(collectionId, nft.artId),
					);

					// 4. Check blockchain for existing IDs
					const colExists = await collectionExists(collectionId);
					const seedExistence = await checkSeedsExistence(seedIds);

					const seedStatus = seedIds.map((seedId, i) => ({
						artId: body.nfts[i]!.artId,
						seedId,
						exists: seedExistence.get(seedId) || false,
						name: body.nfts[i]!.name,
					}));

					const newSeeds = seedStatus.filter(s => !s.exists);
					const existingSeeds = seedStatus.filter(s => s.exists);

					return json({
						valid: true,
						collectionId,
						collectionExists: colExists,
						summary: {
							total: body.nfts.length,
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

		"/api/collection/:id/exists": async (req) => {
			try {
				const exists = await collectionExists(req.params.id);
				return json({ collectionId: req.params.id, exists });
			} catch (e) {
				return json({ error: String(e) }, 500);
			}
		},

		"/api/seed/:id/exists": async (req) => {
			try {
				const nftMap = await buildNFTState();
				const nft = nftMap.get(req.params.id);
				const exists = nft !== undefined && nft.isSeed === true;
				return json({ seedId: req.params.id, exists });
			} catch (e) {
				return json({ error: String(e) }, 500);
			}
		},

		// ============ DETERMINISTIC BATCH MINTING ============

		"/api/batch/collection-deterministic": {
			POST: async (req) => {
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
			POST: async (req) => {
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

					// Validate artIds
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
					const result = createDeterministicSeedMintOperations(
						nfts,
						body.collectionId,
						collectionOriginDna,
						body.owner,
					);

					const opValidation = validateOperationsVersion(
						result.seeds.map((s) => s.operation),
					);

					const batches = splitOperationsIntoBatches(
						result.seeds.map((s) => s.operation),
					);

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

		// ============ PAYLOAD BUILDER API (Robust) ============

		"/api/build/collection": {
			POST: async (req) => {
				try {
					const body = await req.json() as {
						creator: string;
						name: string;
						symbol: string;
						totalPotential?: number;
						description?: string;
						image?: string;
						royaltyPct?: number;
					};

					const result = builder.buildCollection(body);

					if (!result.success) {
						return json({
							success: false,
							errors: result.errors,
						}, 400);
					}

					return json({
						success: true,
						protocolVersion: PROTOCOL_VERSION,
						hashVersion: HASH_VERSION,
						collectionId: result.generatedId,
						generatedIds: result.generatedIds,
						operation: result.operation,
						payload: result.payload,
						warnings: result.warnings,
					});
				} catch (e) {
					return json({ error: String(e) }, 500);
				}
			},
		},

		"/api/build/seeds": {
			POST: async (req) => {
				try {
					const body = await req.json() as {
						collectionId: string;
						owner: string;
						seeds: Array<{
							artId: string;
							name: string;
							imageUrl: string;
							maxSupply: number;
							brief?: string;
						}>;
					};

					const result = builder.buildSeedBatch(body);

					if (!result.success) {
						return json({
							success: false,
							errors: result.errors,
						}, 400);
					}

					// Build individual operations for each seed
					const operations = body.seeds.map((seed, i) => {
						const seedResult = builder.buildSeed({
							artId: seed.artId,
							collectionId: body.collectionId,
							name: seed.name,
							imageUrl: seed.imageUrl,
							maxSupply: seed.maxSupply,
							owner: body.owner,
							edition: 1,
							brief: seed.brief,
						});
						return {
							artId: seed.artId,
							seedId: seedResult.generatedId,
							operation: seedResult.operation,
						};
					});

					const batches = splitOperationsIntoBatches(
						operations.map(o => o.operation!),
					);

					return json({
						success: true,
						protocolVersion: PROTOCOL_VERSION,
						hashVersion: HASH_VERSION,
						collectionId: body.collectionId,
						generatedIds: result.generatedIds,
						seeds: operations,
						batches: batches.map((batch, i) => ({
							batchNumber: i + 1,
							operationCount: batch.length,
							operations: batch,
						})),
						warnings: result.warnings,
					});
				} catch (e) {
					return json({ error: String(e) }, 500);
				}
			},
		},

		"/api/build/distribute": {
			POST: async (req) => {
				try {
					const body = await req.json() as {
						seedId: string;
						recipients: string[];
						owner: string;
						startingInstanceNumber?: number;
					};

					if (!body.seedId || !body.recipients || !body.owner) {
						return json({
							success: false,
							errors: [{ field: "body", message: "Missing required fields", code: "MISSING_FIELDS" }],
						}, 400);
					}

					const startNum = body.startingInstanceNumber || 1;
					const instances = body.recipients.map((to, i) => {
						const result = builder.buildDistribute({
							seedId: body.seedId,
							to,
							instanceNumber: startNum + i,
							owner: body.owner,
						});
						return {
							recipient: to,
							instanceNumber: startNum + i,
							instanceId: result.generatedId,
							operation: result.operation,
							errors: result.errors,
						};
					});

					const errors = instances.filter(i => i.errors).flatMap(i => i.errors!);
					if (errors.length > 0) {
						return json({ success: false, errors }, 400);
					}

					const batches = splitOperationsIntoBatches(
						instances.map(i => i.operation!),
					);

					return json({
						success: true,
						protocolVersion: PROTOCOL_VERSION,
						hashVersion: HASH_VERSION,
						seedId: body.seedId,
						instances: instances.map(i => ({
							recipient: i.recipient,
							instanceNumber: i.instanceNumber,
							instanceId: i.instanceId,
						})),
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

		"/api/build/transfer": {
			POST: async (req) => {
				try {
					const body = await req.json() as {
						nftId: string;
						from: string;
						to: string;
					};

					const result = builder.buildTransfer(body);

					if (!result.success) {
						return json({ success: false, errors: result.errors }, 400);
					}

					return json({
						success: true,
						protocolVersion: PROTOCOL_VERSION,
						operation: result.operation,
						payload: result.payload,
					});
				} catch (e) {
					return json({ error: String(e) }, 500);
				}
			},
		},

		"/api/build/list": {
			POST: async (req) => {
				try {
					const body = await req.json() as {
						nftId: string;
						owner: string;
						price: { amount: string; currency: "HIVE" | "HBD" };
						expiresAt?: number;
					};

					const result = builder.buildList(body);

					if (!result.success) {
						return json({ success: false, errors: result.errors }, 400);
					}

					return json({
						success: true,
						protocolVersion: PROTOCOL_VERSION,
						operation: result.operation,
						payload: result.payload,
					});
				} catch (e) {
					return json({ error: String(e) }, 500);
				}
			},
		},

		"/api/build/unlist": {
			POST: async (req) => {
				try {
					const body = await req.json() as {
						nftId: string;
						owner: string;
					};

					const result = builder.buildUnlist(body);

					if (!result.success) {
						return json({ success: false, errors: result.errors }, 400);
					}

					return json({
						success: true,
						protocolVersion: PROTOCOL_VERSION,
						operation: result.operation,
						payload: result.payload,
					});
				} catch (e) {
					return json({ error: String(e) }, 500);
				}
			},
		},

		"/api/build/burn": {
			POST: async (req) => {
				try {
					const body = await req.json() as {
						nftId: string;
						owner: string;
					};

					const result = builder.buildBurn(body);

					if (!result.success) {
						return json({ success: false, errors: result.errors }, 400);
					}

					return json({
						success: true,
						protocolVersion: PROTOCOL_VERSION,
						operation: result.operation,
						payload: result.payload,
					});
				} catch (e) {
					return json({ error: String(e) }, 500);
				}
			},
		},

		"/api/build/buy": {
			POST: async (req) => {
				try {
					const body = await req.json() as {
						nftId: string;
						buyer: string;
						paymentTxId: string;
					};

					const result = builder.buildBuy(body);

					if (!result.success) {
						return json({ success: false, errors: result.errors }, 400);
					}

					return json({
						success: true,
						protocolVersion: PROTOCOL_VERSION,
						operation: result.operation,
						payload: result.payload,
					});
				} catch (e) {
					return json({ error: String(e) }, 500);
				}
			},
		},

		"/api/build/preview-ids": {
			POST: async (req) => {
				try {
					const body = await req.json() as {
						creator: string;
						name: string;
						symbol: string;
						seeds: Array<{ artId: string }>;
					};

					const preview = builder.previewIds(body);
					const seedIds: Record<string, string> = {};
					preview.seedIds.forEach((v, k) => seedIds[k] = v);

					return json({
						success: true,
						protocolVersion: PROTOCOL_VERSION,
						hashVersion: HASH_VERSION,
						collectionId: preview.collectionId,
						originDna: preview.originDna,
						seedIds,
					});
				} catch (e) {
					return json({ error: String(e) }, 500);
				}
			},
		},

		"/api/protocol/info": async () => {
			const versionInfo = builder.getVersionInfo();
			return json({
				...versionInfo,
				minProtocolVersion: MIN_PROTOCOL_VERSION,
			});
		},

		// ============ HIVE NFT TRACKER (BlockTrades Standard) ============

		"/api/nft-tracker/register": {
			POST: async (req) => {
				try {
					const body = await req.json() as {
						creator: string;
						symbol: string;
						name: string;
						maxCount?: number | null;
						issuers?: string[];
					};
					if (!body.creator || !body.symbol || !body.name) {
						return json({ error: "Missing required fields: creator, symbol, name" }, 400);
					}
					const result = buildRegisterOp(body);
					return json({ success: true, ...result });
				} catch (e) {
					return json({ error: String(e) }, 500);
				}
			},
		},

		"/api/nft-tracker/issue": {
			POST: async (req) => {
				try {
					const body = await req.json() as {
						issuer: string;
						symbol: string;
						holder: string;
						data?: Record<string, unknown>;
						tags?: string[];
						soulbound?: boolean;
					};
					if (!body.issuer || !body.symbol || !body.holder) {
						return json({ error: "Missing required fields: issuer, symbol, holder" }, 400);
					}
					const result = buildIssueOp(body);
					return json({ success: true, ...result });
				} catch (e) {
					return json({ error: String(e) }, 500);
				}
			},
		},

		"/api/nft-tracker/transfer": {
			POST: async (req) => {
				try {
					const body = await req.json() as {
						from: string;
						symbol: string;
						ids: number[];
						to: string;
					};
					if (!body.from || !body.symbol || !body.ids || !body.to) {
						return json({ error: "Missing required fields: from, symbol, ids, to" }, 400);
					}
					const result = buildTransferOp(body);
					return json({ success: true, ...result });
				} catch (e) {
					return json({ error: String(e) }, 500);
				}
			},
		},

		"/api/nft-tracker/set-data": {
			POST: async (req) => {
				try {
					const body = await req.json() as {
						issuer: string;
						symbol: string;
						ids: number[];
						data: Record<string, unknown>;
					};
					if (!body.issuer || !body.symbol || !body.ids || !body.data) {
						return json({ error: "Missing required fields: issuer, symbol, ids, data" }, 400);
					}
					const result = buildSetDataOp(body);
					return json({ success: true, ...result });
				} catch (e) {
					return json({ error: String(e) }, 500);
				}
			},
		},

		"/api/nft-tracker/soulbind": {
			POST: async (req) => {
				try {
					const body = await req.json() as {
						issuer: string;
						symbol: string;
						ids: number[];
					};
					if (!body.issuer || !body.symbol || !body.ids) {
						return json({ error: "Missing required fields: issuer, symbol, ids" }, 400);
					}
					const result = buildSoulbindOp(body);
					return json({ success: true, ...result });
				} catch (e) {
					return json({ error: String(e) }, 500);
				}
			},
		},

		"/api/nft-tracker/modify": {
			POST: async (req) => {
				try {
					const body = await req.json() as {
						owner: string;
						symbol: string;
						name?: string;
						newOwner?: string;
						maxCount?: number | null;
						issuers?: string[];
					};
					if (!body.owner || !body.symbol) {
						return json({ error: "Missing required fields: owner, symbol" }, 400);
					}
					const result = buildModifyOp(body);
					return json({ success: true, ...result });
				} catch (e) {
					return json({ error: String(e) }, 500);
				}
			},
		},
	},
	development: { hmr: true, console: true },
});

console.log(`
NFTLox Test Console - http://localhost:${server.port}

Query API:
  GET  /api/user/:username
  GET  /api/nft/:nftId
  GET  /api/nft/:nftId/history
  GET  /api/collections
  GET  /api/seed/:seedId/instances

Build API (PayloadBuilder - Robust):
  POST /api/build/collection     - Build collection payload
  POST /api/build/seeds          - Build batch seed payloads
  POST /api/build/distribute     - Build distribute payloads
  POST /api/build/transfer       - Build transfer payload
  POST /api/build/list           - Build list payload
  POST /api/build/unlist         - Build unlist payload
  POST /api/build/burn           - Build burn payload
  POST /api/build/buy            - Build buy payload
  POST /api/build/preview-ids    - Preview deterministic IDs

Validation API:
  POST /api/validate/pre-mint    - Validate NFTs before minting
  GET  /api/collection/:id/exists
  GET  /api/seed/:id/exists

Legacy Batch API:
  POST /api/batch/preview
  POST /api/batch/collection
  POST /api/batch/mint-seeds
  POST /api/batch/distribute
  POST /api/batch/collection-deterministic
  POST /api/batch/mint-seeds-deterministic

Protocol Info:
  GET  /api/protocol/version
  GET  /api/protocol/info
  GET  /api/debug/filtering
`);
