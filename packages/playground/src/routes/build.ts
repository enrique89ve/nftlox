// Build routes — construct Hive operations via SDK builders
import {
	PROTOCOL_VERSION,
	HASH_VERSION,
	createExtendSchemaOperation,
	createExtendSchemaPayload,
	extendSchemaInputSchema,
	usernameSchema,
	// Builders
	buildCollection,
	buildArchiveCollection,
	buildSeedBatch,
	buildSeed,
	buildBulkDistribute,
	buildTransfer,
	buildList,
	buildUnlist,
	buildBurn,
	buildBuy,
	buildSetData,
	buildNftApprove,
	buildNftApproveAll,
	buildNftTransferFrom,
	buildDataOperatorApprove,
	buildSetDataFrom,
	buildNftLend,
	buildNftReturn,
	// For preview-ids (inline replacement)
	generateDeterministicCollectionId,
	generateOriginDna,
	generateDeterministicSeedId,
} from "nftlox-sdk";
import { splitOperationsIntoBatches } from "../protocol";

const json = (data: unknown, status = 200) =>
	new Response(JSON.stringify(data, null, 2), {
		status,
		headers: { "Content-Type": "application/json" },
	});

type RouteHandler = (req: Request) => Promise<Response>;

/** Derive keyType from the SDK operation — single source of truth */
function keyTypeFromOp(operation: unknown): "Active" | "Posting" {
	const op = operation as [string, { required_auths?: string[] }];
	return op[1]?.required_auths?.length ? "Active" : "Posting";
}

function buildRoute(handler: (body: any) => Response | Promise<Response>): { POST: RouteHandler } {
	return {
		POST: async (req: Request) => {
			try {
				const body = await req.json();
				return await handler(body);
			} catch (e) {
				return json({ error: String(e) }, 500);
			}
		},
	};
}

export const buildRoutes: Record<string, { POST: RouteHandler }> = {
	// ============ EXISTING BUILD ENDPOINTS ============

	"/api/build/collection": buildRoute(async (body) => {
		const result = await buildCollection(body);
		if (!result.success) return json({ success: false, errors: result.errors }, 400);
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
	}),

	"/api/build/seeds": buildRoute(async (body) => {
		const signer = body.signer ?? body.owner;
		const result = await buildSeedBatch({ ...body, signer });
		if (!result.success) return json({ success: false, errors: result.errors }, 400);

		const operations = await Promise.all(body.seeds.map(async (seed: any) => {
			const seedResult = await buildSeed({
				artId: seed.artId,
				collectionId: body.collectionId,
				name: seed.name,
				imageUrl: seed.imageUrl,
				maxSupply: seed.maxSupply,
				signer,
				owner: body.owner,
				edition: 1,
				brief: seed.brief,
			});
			if (!seedResult.success) return null;
			return {
				artId: seed.artId,
				seedId: seedResult.generatedId,
				operation: seedResult.operation,
			};
		}));
		const validOps = operations.filter(Boolean);

		const batches = splitOperationsIntoBatches(validOps.map((o: any) => o.operation!));

		return json({
			success: true,
			protocolVersion: PROTOCOL_VERSION,
			hashVersion: HASH_VERSION,
			collectionId: body.collectionId,
			generatedIds: result.generatedIds,
			seeds: validOps,
			batches: batches.map((batch, i) => ({
				batchNumber: i + 1,
				operationCount: batch.length,
				operations: batch,
			})),
			warnings: result.warnings,
		});
	}),

	"/api/build/bulk-distribute": buildRoute((body) => {
		const result = buildBulkDistribute(body);
		if (!result.success) return json({ success: false, errors: result.errors }, 400);
		return json({
			success: true,
			protocolVersion: PROTOCOL_VERSION,
			operation: result.operation,
			payload: result.payload,
			keyType: keyTypeFromOp(result.operation),
			warnings: result.warnings,
		});
	}),

	"/api/build/transfer": buildRoute(async (body) => {
		const result = await buildTransfer(body);
		if (!result.success) return json({ success: false, errors: result.errors }, 400);
		return json({
			success: true,
			protocolVersion: PROTOCOL_VERSION,
			operation: result.operation,
			payload: result.payload,
			keyType: keyTypeFromOp(result.operation),
		});
	}),

	"/api/build/list": buildRoute(async (body) => {
		const result = await buildList(body);
		if (!result.success) return json({ success: false, errors: result.errors }, 400);
		return json({
			success: true,
			protocolVersion: PROTOCOL_VERSION,
			operation: result.operation,
			payload: result.payload,
			keyType: keyTypeFromOp(result.operation),
		});
	}),

	"/api/build/unlist": buildRoute(async (body) => {
		const result = await buildUnlist(body);
		if (!result.success) return json({ success: false, errors: result.errors }, 400);
		return json({
			success: true,
			protocolVersion: PROTOCOL_VERSION,
			operation: result.operation,
			payload: result.payload,
			keyType: keyTypeFromOp(result.operation),
		});
	}),

	"/api/build/burn": buildRoute(async (body) => {
		const result = await buildBurn(body);
		if (!result.success) return json({ success: false, errors: result.errors }, 400);
		return json({
			success: true,
			protocolVersion: PROTOCOL_VERSION,
			operation: result.operation,
			payload: result.payload,
			keyType: keyTypeFromOp(result.operation),
		});
	}),

	"/api/build/buy": buildRoute((body) => {
		const result = buildBuy(body);
		if (!result.success) return json({ success: false, errors: result.errors }, 400);
		return json({
			success: true,
			protocolVersion: PROTOCOL_VERSION,
			hiveOperations: (result as any).hiveOperations,
			payload: result.payload,
			keyType: "Active",
		});
	}),

	"/api/build/preview-ids": buildRoute(async (body) => {
		const collectionId = await generateDeterministicCollectionId(
			body.creator,
			body.name,
			body.symbol,
		);
		const originDna = await generateOriginDna(collectionId);

		const seedIds: Record<string, string> = {};
		if (body.artIds && Array.isArray(body.artIds)) {
			for (const artId of body.artIds) {
				seedIds[artId] = await generateDeterministicSeedId(collectionId, artId);
			}
		}

		return json({
			success: true,
			protocolVersion: PROTOCOL_VERSION,
			hashVersion: HASH_VERSION,
			collectionId,
			originDna,
			seedIds,
		});
	}),

	// ============ NEW BUILD ENDPOINTS ============

	"/api/build/set-data": buildRoute((body) => {
		const result = buildSetData({ ...body, owner: body.issuer });
		if (!result.success) return json({ success: false, errors: result.errors }, 400);
		return json({
			success: true,
			protocolVersion: PROTOCOL_VERSION,
			operation: result.operation,
			payload: result.payload,
			keyType: keyTypeFromOp(result.operation),
		});
	}),

	"/api/build/archive-collection": buildRoute((body) => {
		const result = buildArchiveCollection(body);
		if (!result.success) return json({ success: false, errors: result.errors }, 400);
		return json({
			success: true,
			protocolVersion: PROTOCOL_VERSION,
			operation: result.operation,
			payload: result.payload,
			keyType: keyTypeFromOp(result.operation),
		});
	}),

	"/api/build/extend-schema": buildRoute((body) => {
		const parsedInput = extendSchemaInputSchema.safeParse(body);
		if (!parsedInput.success) return json({ success: false, errors: parsedInput.error.issues }, 400);
		const parsedCreator = usernameSchema.safeParse(body.creator);
		if (!parsedCreator.success) return json({ success: false, errors: parsedCreator.error.issues }, 400);

		const operation = createExtendSchemaOperation(parsedInput.data, parsedCreator.data);
		const payload = createExtendSchemaPayload(parsedInput.data);
		return json({
			success: true,
			protocolVersion: PROTOCOL_VERSION,
			operation,
			payload,
			keyType: keyTypeFromOp(operation),
		});
	}),

	// --- Allowances (3) ---

	"/api/build/nft-approve": buildRoute((body) => {
		const result = buildNftApprove(body);
		if (!result.success) return json({ success: false, errors: result.errors }, 400);
		return json({
			success: true,
			protocolVersion: PROTOCOL_VERSION,
			operation: result.operation,
			keyType: keyTypeFromOp(result.operation),
		});
	}),

	"/api/build/nft-approve-all": buildRoute((body) => {
		const result = buildNftApproveAll(body);
		if (!result.success) return json({ success: false, errors: result.errors }, 400);
		return json({
			success: true,
			protocolVersion: PROTOCOL_VERSION,
			operation: result.operation,
			keyType: keyTypeFromOp(result.operation),
		});
	}),

	"/api/build/nft-transfer-from": buildRoute((body) => {
		const result = buildNftTransferFrom({ ...body, operator: body.spender });
		if (!result.success) return json({ success: false, errors: result.errors }, 400);
		return json({
			success: true,
			protocolVersion: PROTOCOL_VERSION,
			operation: result.operation,
			keyType: keyTypeFromOp(result.operation),
		});
	}),

	// --- Lending (2) ---

	"/api/build/nft-lend": buildRoute((body) => {
		const result = buildNftLend(body);
		if (!result.success) return json({ success: false, errors: result.errors }, 400);
		return json({
			success: true,
			protocolVersion: PROTOCOL_VERSION,
			operation: result.operation,
			keyType: keyTypeFromOp(result.operation),
		});
	}),

	"/api/build/nft-return": buildRoute((body) => {
		const result = buildNftReturn({ ...body, owner: body.signer });
		if (!result.success) return json({ success: false, errors: result.errors }, 400);
		return json({
			success: true,
			protocolVersion: PROTOCOL_VERSION,
			operation: result.operation,
			keyType: keyTypeFromOp(result.operation),
		});
	}),

	// --- Data Operators (2) ---

	"/api/build/data-operator-approve": buildRoute((body) => {
		const result = buildDataOperatorApprove(body);
		if (!result.success) return json({ success: false, errors: result.errors }, 400);
		return json({
			success: true,
			protocolVersion: PROTOCOL_VERSION,
			operation: result.operation,
			keyType: keyTypeFromOp(result.operation),
		});
	}),

	"/api/build/set-data-from": buildRoute((body) => {
		const result = buildSetDataFrom(body);
		if (!result.success) return json({ success: false, errors: result.errors }, 400);
		return json({
			success: true,
			protocolVersion: PROTOCOL_VERSION,
			operation: result.operation,
			keyType: keyTypeFromOp(result.operation),
		});
	}),
};
